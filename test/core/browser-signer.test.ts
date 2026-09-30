// The browser-wallet signer, driven by a simulated MetaMask.
//
// A real browser wallet cannot be automated here, so the test plays the part the extension
// plays: it fetches the approval page, reports an account, signs the typed data the server
// built with a throwaway key, and posts the signature back. Everything on the other side of
// that seam is the real thing — the server, the payment engine, a real x402 seller — so what
// these tests are really about is the two questions a person at that page is asking.
//
//   Is this the payment I think it is? The page must show the amount and the recipient the
//   server derived from the seller's requirement, and must never present what the agent
//   claimed as a fact of the same kind.
//   Can anything be signed that I did not sign? A signature from another key must be refused,
//   a rejection must leave nothing signed, and a request nobody answers must expire.

import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign as ed25519Sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { usdcRequirement } from "../../src/core/chain.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { DEFAULT_POLICY, type Policy } from "../../src/core/policy.js";
import { quote } from "../../src/core/quote.js";
import { Records } from "../../src/core/records.js";
import { APPROVAL_PAGE_SCRIPT } from "../../src/core/signer/approval-page.js";
import { BrowserWalletSigner } from "../../src/core/signer/browser.js";
import { SignRefused, type SignRequest } from "../../src/core/signer/types.js";
import { OWNER_PAGE_SCRIPT } from "../../src/core/signer/owner-approval-page.js";
import { OwnerApprovalServer, signInMessage, type OwnerActionInput, type SolanaTransactionPort } from "../../src/core/signer/owner-approval-server.js";
import { ownerApprovalPage } from "../../src/core/signer/owner-approval-page.js";
import bs58 from "bs58";
import { request as httpRequest } from "node:http";
import type { Attempt } from "../../src/core/types.js";
import { startFakeFacilitator, type FakeFacilitator } from "../helpers/fake-facilitator.js";
import { startPaidEndpoint, type PaidEndpoint } from "../helpers/paid-endpoint.js";

const PRICE = 0.01;
const SELLER = privateKeyToAccount(generatePrivateKey()).address;

let home: string;
let facilitator: FakeFacilitator;
let seller: PaidEndpoint;
/** Every signer a test starts, closed together so no port is left listening. */
const opened: BrowserWalletSigner[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "superstables-browser-test-"));
  facilitator = await startFakeFacilitator();
  seller = await startPaidEndpoint({ priceDecimal: PRICE, payTo: SELLER, facilitatorUrl: facilitator.url });
});

afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close();
});

afterAll(async () => {
  await seller.close();
  await facilitator.close();
  rmSync(home, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────────

/** A signer on an ephemeral port, with its own home, closed when the test ends. */
function newSigner(options: { policy?: Policy; timeoutMs?: number } = {}): BrowserWalletSigner {
  const signer = new BrowserWalletSigner({
    port: 0,
    home: mkdtempSync(join(home, "signer-")),
    policy: options.policy ?? DEFAULT_POLICY,
    timeoutMs: options.timeoutMs ?? 5_000,
    balance: false,
  });
  opened.push(signer);
  return signer;
}

function signRequest(context?: SignRequest["context"]): SignRequest {
  return { kind: "eip3009", requirements: usdcRequirement(PRICE, SELLER), x402Version: 2, context };
}

interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "TransferWithAuthorization";
  message: Record<string, string>;
}

async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/** A POST as the page itself makes it: from the page's own origin, with a JSON body (Node's fetch sends no Origin). */
async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(url).origin, ...headers },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: parsed };
}

/** The part a browser wallet plays: take the typed data the page was given, and sign it. */
async function connect(approvalUrl: string, account: PrivateKeyAccount): Promise<TypedData> {
  const answer = await postJson(`${approvalUrl}/account`, { address: account.address });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.typedData as unknown as TypedData;
}

async function signWith(account: PrivateKeyAccount, typedData: TypedData): Promise<string> {
  return account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  } as never);
}

/** Connect, sign and submit: one whole trip through the page, as MetaMask would make it. */
async function approveInWallet(
  approvalUrl: string,
  account: PrivateKeyAccount,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const typedData = await connect(approvalUrl, account);
  const signature = await signWith(account, typedData);
  return postJson(`${approvalUrl}/signature`, { address: account.address, signature });
}

/** Wait for the attempt to carry an approval link: the engine records it on awaiting_approval. */
function firstApprovalUrl(engine: PaymentEngine): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no approval link was ever recorded")), 10_000);
    const onTransition = (attempt: Attempt) => {
      if (!attempt.approvalUrl) return;
      clearTimeout(timer);
      engine.events.off("transition", onTransition);
      resolve(attempt.approvalUrl);
    };
    engine.events.on("transition", onTransition);
  });
}

// ── The tests ────────────────────────────────────────────────────────────────────────────

describe("the approval page a browser wallet signs on", () => {
  it("shows what the server verified, and keeps what the agent claimed apart from it", async () => {
    const signer = newSigner();
    let link = "";
    const pending = signer
      .sign(signRequest({ target: "http://127.0.0.1/paid", serviceName: "Market data", description: "a free lunch" }), {
        onPending: (_id, url) => {
          link = url ?? "";
        },
      })
      .catch(() => undefined);
    await waitFor(() => link !== "");

    const page = await fetch(link);
    expect(page.status).toBe(200);
    const html = await page.text();

    // The facts the server derived, in the words a person reads them in.
    expect(html).toContain(`${PRICE}`);
    expect(html).toContain("USDC");
    expect(html).toContain(SELLER);
    expect(html).toContain("Base Sepolia");

    // The agent's own account of the payment appears only under its warning.
    expect(html).toContain("Reported by the agent (not verified)");
    const claim = html.indexOf("a free lunch");
    expect(claim).toBeGreaterThan(html.indexOf("Reported by the agent (not verified)"));

    await postJson(`${link}/reject`, {});
    await pending;
  });

  it("answers an unknown approval id with 404 and no page to sign on", async () => {
    const signer = newSigner();
    await signer.start();
    const page = await fetch(`${signer.url}/approve/${"0".repeat(32)}`);
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("There is no payment waiting under this link");
    const state = await getJson(`${signer.url}/approve/${"0".repeat(32)}/state`);
    expect(state.status).toBe(404);
  });

  it("is plain ES2017 that a browser can run without a build step", async () => {
    const file = join(home, "approval-page-script.js");
    writeFileSync(file, APPROVAL_PAGE_SCRIPT);
    const checked = await new Promise<{ code: number; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, ["--check", file]);
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.once("error", fail);
      child.once("close", (code) => done({ code: code ?? 0, stderr }));
    });
    expect(checked.stderr).toBe("");
    expect(checked.code).toBe(0);
    // The two things the page must not lose: it never loads anything, and it names the wallet.
    expect(APPROVAL_PAGE_SCRIPT).toContain("eth_signTypedData_v4");
    expect(APPROVAL_PAGE_SCRIPT).toContain("You rejected in MetaMask; nothing was signed.");
  });

  it("loads nothing from another origin", async () => {
    const signer = newSigner();
    await signer.start();
    let link = "";
    const pending = signer.sign(signRequest(), { onPending: (_id, url) => (link = url ?? "") }).catch(() => undefined);
    await waitFor(() => link !== "");
    const html = await (await fetch(link)).text();
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    await postJson(`${link}/reject`, {});
    await pending;
  });
});

describe("the browser-wallet signer", () => {
  it("returns the credential the connected account signed, and nothing before that", async () => {
    const signer = newSigner();
    const account = privateKeyToAccount(generatePrivateKey());
    let link = "";
    const pending = signer.sign(signRequest(), { onPending: (_id, url) => (link = url ?? "") });
    await waitFor(() => link !== "");

    const state = await getJson(`${link}/state`);
    expect(state.body.status).toBe("pending");

    const answer = await approveInWallet(link, account);
    expect(answer.status).toBe(200);

    const result = await pending;
    expect(result.kind).toBe("eip3009");
    expect(result.signer).toBe(account.address);
    const authorization = result.payload.authorization as Record<string, string>;
    expect(authorization.from).toBe(account.address);
    expect(authorization.to.toLowerCase()).toBe(SELLER.toLowerCase());
    expect(authorization.value).toBe("10000");
    expect(authorization.validAfter).toBe("0");
    expect(Number(authorization.validBefore)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    // The signer remembers the account, so a later status() can name who would pay.
    expect(await signer.address("eip155:84532")).toBe(account.address);
  });

  it("refuses a signature from another key, and keeps waiting for the right one", async () => {
    const signer = newSigner();
    const account = privateKeyToAccount(generatePrivateKey());
    const impostor = privateKeyToAccount(generatePrivateKey());
    let link = "";
    const pending = signer.sign(signRequest(), { onPending: (_id, url) => (link = url ?? "") });
    await waitFor(() => link !== "");

    const typedData = await connect(link, account);
    const forged = await signWith(impostor, typedData);

    const rejected = await postJson(`${link}/signature`, { address: account.address, signature: forged });
    expect(rejected.status).toBe(400);
    expect(String(rejected.body.error)).toContain(account.address);
    expect((await getJson(`${link}/state`)).body.status).toBe("pending");

    const honest = await postJson(`${link}/signature`, {
      address: account.address,
      signature: await signWith(account, typedData),
    });
    expect(honest.status).toBe(200);
    expect((await pending).signer).toBe(account.address);
  });

  it("will not sign for an account other than the one the payment was prepared for", async () => {
    const signer = newSigner();
    const account = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    let link = "";
    const pending = signer.sign(signRequest(), { onPending: (_id, url) => (link = url ?? "") }).catch(() => undefined);
    await waitFor(() => link !== "");

    const typedData = await connect(link, account);
    const answer = await postJson(`${link}/signature`, {
      address: other.address,
      signature: await signWith(other, typedData),
    });
    expect(answer.status).toBe(400);
    expect((await getJson(`${link}/state`)).body.status).toBe("pending");

    await postJson(`${link}/reject`, {});
    await pending;
  });

  it("treats a rejection on the page as a denial, with nothing signed", async () => {
    const signer = newSigner();
    let link = "";
    // The catch is attached now, not after the await: the refusal lands the moment the page
    // posts its rejection, and an unhandled one would be noise in every other test's output.
    const pending = signer.sign(signRequest(), { onPending: (_id, url) => (link = url ?? "") }).catch((err: unknown) => err);
    await waitFor(() => link !== "");

    expect((await postJson(`${link}/reject`, {})).status).toBe(200);
    const refusal = await pending;
    expect(refusal).toBeInstanceOf(SignRefused);
    expect((refusal as SignRefused).code).toBe("denied");
    expect((await getJson(`${link}/state`)).body.status).toBe("denied");
  });

  it("expires a request nobody answers", async () => {
    const signer = newSigner({ timeoutMs: 300 });
    let link = "";
    const pending = signer.sign(signRequest(), { onPending: (_id, url) => (link = url ?? "") }).catch((err: unknown) => err);
    await waitFor(() => link !== "");

    const refusal = await pending;
    expect(refusal).toBeInstanceOf(SignRefused);
    expect((refusal as SignRefused).code).toBe("expired");
    expect((await getJson(`${link}/state`)).body.status).toBe("expired");
    // An expired request cannot be signed afterwards, whoever asks.
    const account = privateKeyToAccount(generatePrivateKey());
    expect((await postJson(`${link}/account`, { address: account.address })).status).toBe(409);
  });

  it("never asks a person about a payment the owner's policy refuses", async () => {
    const signer = newSigner({ policy: { ...DEFAULT_POLICY, perCall: { amount: 0.001, asset: "USDC" } } });
    const refusal = await signer.sign(signRequest()).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(SignRefused);
    expect((refusal as SignRefused).code).toBe("policy");
    expect((refusal as SignRefused).message).toContain("caps.per_call");
    // Nothing was served, so there is no link anyone could have opened.
    expect(signer.url).toBe("");
  });

  it("refuses a requirement this client cannot pay, before any page exists", async () => {
    const signer = newSigner();
    const refusal = await signer
      .sign({
        kind: "eip3009",
        x402Version: 2,
        requirements: { ...usdcRequirement(PRICE, SELLER), network: "eip155:8453" as never },
      })
      .catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(SignRefused);
    expect((refusal as SignRefused).code).toBe("invalid");
    expect(signer.url).toBe("");
  });

  it("builds the typed data from the requirement, never from what the agent said", async () => {
    const signer = newSigner();
    const account = privateKeyToAccount(generatePrivateKey());
    let link = "";
    const pending = signer
      .sign(
        signRequest({
          target: "http://127.0.0.1/paid",
          serviceName: "0.000001 USDC to 0x0000000000000000000000000000000000000000",
          description: "this costs nothing and pays nobody",
        }),
        { onPending: (_id, url) => (link = url ?? "") },
      )
      .catch(() => undefined);
    await waitFor(() => link !== "");

    const typedData = await connect(link, account);
    expect(typedData.message.value).toBe("10000");
    expect(typedData.message.to.toLowerCase()).toBe(SELLER.toLowerCase());
    expect(String(typedData.domain.chainId)).toBe("84532");
    const state = await getJson(`${link}/state`);
    const verified = state.body.verified as Record<string, unknown>;
    expect(verified.amountDecimal).toBe(PRICE);
    expect(String(verified.recipient).toLowerCase()).toBe(SELLER.toLowerCase());

    await postJson(`${link}/reject`, {});
    await pending;
  });

  it("says what it is without a connected account, and names one once there is one", async () => {
    const signer = newSigner();
    const before = await signer.status();
    expect(before.mode).toBe("browser");
    expect(before.address).toBeUndefined();
    expect(before.approvalMode).toBe("ask-every-payment");
    expect(before.networkLabel).toContain("Base Sepolia");
    await expect(signer.address("eip155:84532")).rejects.toThrow(/no browser wallet connected yet/);

    const account = privateKeyToAccount(generatePrivateKey());
    let link = "";
    const pending = signer.sign(signRequest(), { onPending: (_id, url) => (link = url ?? "") });
    await waitFor(() => link !== "");
    expect((await signer.status()).pending).toBe(1);
    await approveInWallet(link, account);
    await pending;

    const after = await signer.status();
    expect(after.address).toBe(account.address);
    expect(after.pending).toBe(0);
  });
});

describe("a whole payment, approved in the browser", () => {
  it("settles the seller's requirement with the account that signed on the page", async () => {
    const dir = mkdtempSync(join(home, "engine-"));
    const records = new Records(join(dir, "records"));
    const signer = newSigner();
    const engine = new PaymentEngine({ records, policy: DEFAULT_POLICY, signer });
    const account = privateKeyToAccount(generatePrivateKey());

    const taken = await quote({ url: seller.url }, { records, policy: DEFAULT_POLICY });
    expect(taken.terms.amountDecimal).toBe(PRICE);

    const linkSoon = firstApprovalUrl(engine);
    const started = engine.startPayment(taken.id);
    expect(started.state).toBe("awaiting_approval");

    const link = await linkSoon;
    expect(link).toContain("/approve/");
    // The attempt itself carries the link, which is what every surface passes on.
    expect(engine.getAttempt(started.id)?.approvalUrl).toBe(link);

    await approveInWallet(link, account);
    const finished = await engine.waitForAttempt(started.id, 15_000);

    expect(finished.state).toBe("settled");
    expect(finished.payer).toBe(account.address);
    const receipt = records.getReceipt(finished.receiptId as string);
    expect(receipt?.transaction).toBe(facilitator.transaction);

    // The credential the seller passed on is the one this account signed, field for field.
    const seen = facilitator.lastVerify?.payload.payload as { authorization: Record<string, string> } | undefined;
    expect(seen?.authorization.from).toBe(account.address);
    expect(seen?.authorization.to.toLowerCase()).toBe(SELLER.toLowerCase());
    expect(seen?.authorization.value).toBe("10000");
    expect(facilitator.calls.settle).toBeGreaterThan(0);
  });

  it("ends a denied attempt as denied, with no receipt and no settlement", async () => {
    const dir = mkdtempSync(join(home, "engine-denied-"));
    const records = new Records(join(dir, "records"));
    const signer = newSigner();
    const engine = new PaymentEngine({ records, policy: DEFAULT_POLICY, signer });
    const settlesBefore = facilitator.calls.settle;

    const taken = await quote({ url: seller.url }, { records, policy: DEFAULT_POLICY });
    const linkSoon = firstApprovalUrl(engine);
    const started = engine.startPayment(taken.id);
    const link = await linkSoon;

    await postJson(`${link}/reject`, {});
    const finished = await engine.waitForAttempt(started.id, 15_000);

    expect(finished.state).toBe("denied");
    expect(finished.receiptId).toBeUndefined();
    expect(records.listReceipts()).toHaveLength(0);
    expect(facilitator.calls.settle).toBe(settlesBefore);
  });
});

// ── The owner approval page ──────────────────────────────────────────────────────────────
//
// The budget's owner actions (connect a wallet, grant, revoke, send the agent gas) happen in the
// owner's own wallet on a loopback page. The test plays the wallet again: it reports an account,
// signs the sign-in message, and reports a transaction hash. What matters is what a person at that
// page relies on: the terms are the command's, only the owner's account can be asked to send, a
// rejection or an expiry leaves nothing sent, and a hash is only ever a pointer for the command.

const OWNER = privateKeyToAccount(generatePrivateKey());
const AGENT = privateKeyToAccount(generatePrivateKey()).address;
const USDC_TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const APPROVE_DATA = `0x095ea7b3${AGENT.slice(2).toLowerCase().padStart(64, "0")}${(10000).toString(16).padStart(64, "0")}`;
const ownerServers: OwnerApprovalServer[] = [];

afterEach(async () => {
  while (ownerServers.length > 0) await ownerServers.pop()?.close();
});

function ownerAction(overrides: Partial<OwnerActionInput> = {}): OwnerActionInput {
  return {
    kind: "evm-transaction",
    chain: { chainId: 84532, chainName: "Base Sepolia", rpcUrl: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, testnet: true },
    terms: {
      title: "give your agent a budget",
      amount: "0.01",
      unit: "USDC",
      summary: "Your agent may move up to 0.01 USDC from your wallet, in total.",
      rows: [{ label: "Agent", value: AGENT, mono: true }],
      enforced: ["A total cap of 0.01 USDC."],
      notEnforced: ["No expiry.", "No seller list."],
      notes: ["To end the budget at any time: superstables budget revoke --rail evm."],
    },
    account: OWNER.address,
    transaction: { to: USDC_TOKEN, data: APPROVE_DATA, value: "0x0" },
    timeoutMs: 5_000,
    ...overrides,
  };
}

async function ownerServer(): Promise<OwnerApprovalServer> {
  const server = new OwnerApprovalServer({ port: 0 });
  await server.start();
  ownerServers.push(server);
  return server;
}

const HASH = `0x${"ab".repeat(32)}`;

describe("the owner approval page", () => {
  it("shows the command's terms and asks the wallet for exactly the transaction the command built", async () => {
    const server = await ownerServer();
    const handle = server.request(ownerAction());
    const html = await (await fetch(handle.url)).text();
    expect(html).toContain("give your agent a budget");
    expect(html).toContain("0.01");
    expect(html).toContain(AGENT);
    expect(html).toContain("The chain enforces");
    expect(html).toContain("The chain does not enforce");
    expect(html).toContain("No seller list.");
    expect(html).toContain("Base Sepolia");
    expect(html).toContain(APPROVE_DATA);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
  });

  it("will not prepare the transaction for any account but the owner's", async () => {
    const server = await ownerServer();
    const handle = server.request(ownerAction());
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const wrong = await postJson(`${handle.url}/account`, { address: stranger });
    expect(wrong.status).toBe(403);
    expect(String(wrong.body.error)).toContain(OWNER.address);
    const right = await postJson(`${handle.url}/account`, { address: OWNER.address });
    expect(right.status).toBe(200);
    expect(right.body.transaction).toEqual({ to: USDC_TOKEN, data: APPROVE_DATA, value: "0x0" });
  });

  it("takes no transaction hash before the owner is connected and the wallet was asked", async () => {
    const server = await ownerServer();
    const handle = server.request(ownerAction());
    expect((await postJson(`${handle.url}/sent`, { address: OWNER.address, hash: HASH })).status).toBe(409);
    await postJson(`${handle.url}/account`, { address: OWNER.address });
    expect((await postJson(`${handle.url}/sent`, { address: OWNER.address, hash: HASH })).status).toBe(409);
    expect((await getJson(`${handle.url}/state`)).body.status).toBe("ready");
  });

  it("hands the reported hash to the command, and shows the command's verdict", async () => {
    const server = await ownerServer();
    const handle = server.request(ownerAction());
    await postJson(`${handle.url}/account`, { address: OWNER.address });
    expect((await postJson(`${handle.url}/sending`, { address: OWNER.address })).status).toBe(200);
    expect((await postJson(`${handle.url}/sent`, { address: OWNER.address, hash: HASH })).status).toBe(200);
    expect(await handle.settled).toEqual({ status: "sent", address: OWNER.address, hash: HASH });
    expect((await getJson(`${handle.url}/state`)).body.status).toBe("sent");
    handle.finish({ ok: true, message: "Done. The chain shows a budget of 0.01 USDC.", hash: HASH });
    const state = await getJson(`${handle.url}/state`);
    expect(state.body.status).toBe("confirmed");
    expect(state.body.message).toContain("0.01 USDC");
  });

  it("ends a rejection before the wallet was asked with nothing sent", async () => {
    const server = await ownerServer();
    const onPage = server.request(ownerAction());
    await postJson(`${onPage.url}/reject`, { by: "page" });
    expect(await onPage.settled).toMatchObject({ status: "rejected", sending: false });
    expect((await postJson(`${onPage.url}/account`, { address: OWNER.address })).status).toBe(409);

    const connected = server.request(ownerAction());
    await postJson(`${connected.url}/account`, { address: OWNER.address });
    await postJson(`${connected.url}/reject`, { by: "wallet" });
    expect(await connected.settled).toMatchObject({ status: "rejected", sending: false });
  });

  it("never turns a rejection after the wallet was asked to send into nothing sent", async () => {
    // anyone holding the link can post /reject {by: "wallet"}, and a wallet popup may still be open: only the chain can
    // say nothing landed, so the outcome keeps `sending` and the command reports unknown
    const server = await ownerServer();
    const handle = server.request(ownerAction());
    await postJson(`${handle.url}/account`, { address: OWNER.address });
    await postJson(`${handle.url}/sending`, { address: OWNER.address });
    await postJson(`${handle.url}/reject`, { by: "wallet" });
    const outcome = await handle.settled;
    expect(outcome).toMatchObject({ status: "rejected", sending: true });
    expect(outcome.status === "rejected" && outcome.reason).toContain("the chain must be checked");
  });

  it("takes state changes only from its own page's origin, as JSON (CSRF, not authentication)", async () => {
    const server = await ownerServer();
    const handle = server.request(ownerAction());
    await postJson(`${handle.url}/account`, { address: OWNER.address });
    await postJson(`${handle.url}/sending`, { address: OWNER.address });
    const foreign = await postJson(`${handle.url}/reject`, { by: "wallet" }, { origin: "https://untrusted.example" });
    expect(foreign.status).toBe(403);
    const noOrigin = await fetch(`${handle.url}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(noOrigin.status).toBe(403);
    const plain = await postJson(`${handle.url}/reject`, { by: "wallet" }, { "content-type": "text/plain" });
    expect(plain.status).toBe(415);
    expect((await getJson(`${handle.url}/state`)).body.status).toBe("sending");
  });

  it("cancels for a replacement only while the wallet was never asked, in one step", async () => {
    const server = await ownerServer();
    const idle = server.request(ownerAction());
    await postJson(`${idle.url}/account`, { address: OWNER.address });
    const cancelled = await postJson(`${idle.url}/cancel`, { replacedBy: "oa-20260930000000-00000000" });
    expect(cancelled.body).toMatchObject({ cancelled: true, status: "rejected" });
    expect(await idle.settled).toMatchObject({ status: "rejected", sending: false, reason: expect.stringContaining("replaced by oa-20260930000000-00000000") });
    // the page can no longer ask the wallet
    expect((await postJson(`${idle.url}/sending`, { address: OWNER.address })).status).toBe(409);

    const asked = server.request(ownerAction());
    await postJson(`${asked.url}/account`, { address: OWNER.address });
    await postJson(`${asked.url}/sending`, { address: OWNER.address });
    const kept = await postJson(`${asked.url}/cancel`, { replacedBy: "oa-20260930000000-00000000" });
    expect(kept.status).toBe(409);
    expect(kept.body).toMatchObject({ cancelled: false, sending: true });
    expect((await getJson(`${asked.url}/state`)).body.status).toBe("sending");
  });

  it("names the recorded owner on every owner page, and tells anyone else to stop", async () => {
    const server = await ownerServer();
    const grant = await (await fetch(server.request(ownerAction()).url)).text();
    expect(grant).toContain("Recorded owner wallet");
    expect(grant).toContain(OWNER.address);
    expect(grant).toContain("If this isn't your wallet, stop");
    const setup = await (await fetch(server.request(ownerAction({ kind: "connect", account: undefined, transaction: undefined, signIn: "record this wallet" })).url)).text();
    expect(setup).toContain("Only the owner should do this, or someone with the owner watching");
    const replace = await (await fetch(server.request(ownerAction({ kind: "connect", account: undefined, transaction: undefined, signIn: "record this wallet", recordedOwner: OWNER.address })).url)).text();
    expect(replace).toContain(OWNER.address);
    expect(replace).toContain("setup replaces it with the wallet you connect");
  });

  it("says a link that expired while the wallet was sending may have sent something", async () => {
    const server = new OwnerApprovalServer({ port: 0, sendingGraceMs: 100 });
    await server.start();
    ownerServers.push(server);
    const handle = server.request(ownerAction({ timeoutMs: 300 }));
    await postJson(`${handle.url}/account`, { address: OWNER.address });
    await postJson(`${handle.url}/sending`, { address: OWNER.address });
    expect(await handle.settled).toMatchObject({ status: "expired", sending: true });
  });

  it("expires a link nobody answers, with nothing sent", async () => {
    const server = await ownerServer();
    const handle = server.request(ownerAction({ timeoutMs: 200 }));
    const outcome = await handle.settled;
    expect(outcome).toMatchObject({ status: "expired", sending: false });
    expect((await getJson(`${handle.url}/state`)).body.status).toBe("expired");
    expect((await postJson(`${handle.url}/account`, { address: OWNER.address })).status).toBe(409);
  });

  it("believes a connect only with a signature from the address it names", async () => {
    const server = await ownerServer();
    const handle = server.request(ownerAction({ kind: "connect", account: undefined, transaction: undefined, signIn: "Superstables budget: record this wallet as the owner." }));
    const message = signInMessage("Superstables budget: record this wallet as the owner.", handle.id);
    const impostor = privateKeyToAccount(generatePrivateKey());
    const forged = await postJson(`${handle.url}/connect`, { address: OWNER.address, signature: await impostor.signMessage({ message }) });
    expect(forged.status).toBe(400);
    expect((await getJson(`${handle.url}/state`)).body.status).toBe("pending");
    const real = await postJson(`${handle.url}/connect`, { address: OWNER.address, signature: await OWNER.signMessage({ message }) });
    expect(real.status).toBe(200);
    expect(await handle.settled).toEqual({ status: "connected", address: OWNER.address });
  });

  it("answers only on 127.0.0.1, and nothing under an unknown link", async () => {
    const server = await ownerServer();
    const handle = server.request(ownerAction());
    const status = await new Promise<number>((done, fail) => {
      const req = httpRequest(handle.url, { headers: { host: `evil.example:${server.port}` } }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      });
      req.once("error", fail);
      req.end();
    });
    expect(status).toBe(421);
    const unknown = await fetch(`${server.url}/owner/${"0".repeat(32)}`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("This approval link is unavailable");
  });

  it("is plain ES2017 that a browser can run without a build step", async () => {
    const file = join(home, "owner-page-script.js");
    writeFileSync(file, OWNER_PAGE_SCRIPT);
    const checked = await new Promise<{ code: number; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, ["--check", file]);
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.once("error", fail);
      child.once("close", (code) => done({ code: code ?? 0, stderr }));
    });
    expect(checked.stderr).toBe("");
    expect(checked.code).toBe(0);
    // Nothing newer than ES2017: lowering it to ES2017 changes nothing.
    expect(transformSync(OWNER_PAGE_SCRIPT, { loader: "js", target: "es2017" }).code).toBe(transformSync(OWNER_PAGE_SCRIPT, { loader: "js", target: "esnext" }).code);
    expect(OWNER_PAGE_SCRIPT).toContain("eth_sendTransaction");
    expect(OWNER_PAGE_SCRIPT).toContain("wallet_addEthereumChain");
  });
});

// ── The owner approval page with a Solana wallet ─────────────────────────────────────────
//
// On solana the wallet only signs: the command builds the transaction when the owner presses
// Approve, and checks what the wallet signed before it sends anything itself. The test plays
// the wallet again (an ed25519 key) and stands in for the command's side with a port that
// records what it was asked to do. What a person relies on: only their own signature connects,
// only their account is asked, a transaction the command refuses is never sent, and the link
// says honestly whether anything may have gone out.

function ed25519Wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return { address: bs58.encode(raw), sign: (message: Uint8Array) => ed25519Sign(null, message, privateKey) };
}

const SOL_OWNER = ed25519Wallet();
const SOLANA_CHAIN = { family: "solana" as const, chainId: 0, chainName: "Solana devnet", rpcUrl: "https://api.devnet.solana.com", explorer: "https://explorer.solana.com", explorerQuery: "?cluster=devnet", walletChain: "solana:devnet", nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 }, testnet: true };

/** A port that builds "the transaction" as fixed bytes and answers submit as told; it records every broadcast. */
function fakePort(answer: "sent" | "refused" | "throw-after-send" = "sent") {
  const calls = { prepared: 0, broadcast: 0, signed: [] as string[] };
  const port: SolanaTransactionPort = {
    async prepare() {
      calls.prepared += 1;
      return Buffer.from(`tx-${calls.prepared}`).toString("base64");
    },
    async submit(signed, broadcasting) {
      calls.signed.push(signed);
      if (answer === "refused") return { status: "refused", reason: "Your wallet changed the transaction, so the command did not send it." };
      if (!broadcasting()) return { status: "refused", reason: "The link expired while the wallet was signing." };
      calls.broadcast += 1;
      if (answer === "throw-after-send") throw new Error("socket hang up");
      return { status: "sent", hash: "5".repeat(88) };
    },
  };
  return { port, calls };
}

function solanaAction(port: SolanaTransactionPort, overrides: Partial<OwnerActionInput> = {}): OwnerActionInput {
  return {
    ...ownerAction(),
    kind: "solana-transaction",
    chain: SOLANA_CHAIN,
    account: SOL_OWNER.address,
    transaction: undefined,
    solana: port,
    ...overrides,
  };
}

describe("the owner approval page with a Solana wallet", () => {
  it("believes a connect only with an ed25519 signature from the address it names, over the exact message", async () => {
    const server = await ownerServer();
    const handle = server.request({ ...ownerAction({ kind: "connect", account: undefined, transaction: undefined, signIn: "Superstables budget: record this wallet as the owner." }), chain: SOLANA_CHAIN });
    const message = Buffer.from(signInMessage("Superstables budget: record this wallet as the owner.", handle.id));
    const impostor = ed25519Wallet();
    const forged = await postJson(`${handle.url}/connect`, { address: SOL_OWNER.address, signature: impostor.sign(message).toString("base64"), signedMessage: message.toString("base64") });
    expect(forged.status).toBe(400);
    const other = Buffer.from("something else");
    const swapped = await postJson(`${handle.url}/connect`, { address: SOL_OWNER.address, signature: SOL_OWNER.sign(other).toString("base64"), signedMessage: other.toString("base64") });
    expect(swapped.status).toBe(400);
    expect((await getJson(`${handle.url}/state`)).body.status).toBe("pending");
    const real = await postJson(`${handle.url}/connect`, { address: SOL_OWNER.address, signature: SOL_OWNER.sign(message).toString("base64"), signedMessage: message.toString("base64") });
    expect(real.status).toBe(200);
    expect(await handle.settled).toEqual({ status: "connected", address: SOL_OWNER.address });
  });

  it("builds nothing before the owner's account is connected, and asks only that account", async () => {
    const { port, calls } = fakePort();
    const server = await ownerServer();
    const handle = server.request(solanaAction(port));
    expect((await postJson(`${handle.url}/prepare`, { address: SOL_OWNER.address })).status).toBe(409);
    expect((await postJson(`${handle.url}/account`, { address: "not-an-address" })).status).toBe(400);
    const stranger = await postJson(`${handle.url}/account`, { address: ed25519Wallet().address });
    expect(stranger.status).toBe(403);
    expect(String(stranger.body.error)).toContain(SOL_OWNER.address);
    expect(calls.prepared).toBe(0);
    expect((await postJson(`${handle.url}/account`, { address: SOL_OWNER.address })).status).toBe(200);
    // an EVM route is not a way around the checks
    expect((await postJson(`${handle.url}/sent`, { address: SOL_OWNER.address, hash: HASH })).status).toBe(404);
    // each Approve builds afresh (a blockhash lives about a minute, a link much longer)
    const first = await postJson(`${handle.url}/prepare`, { address: SOL_OWNER.address });
    const second = await postJson(`${handle.url}/prepare`, { address: SOL_OWNER.address });
    expect(first.body.transaction).not.toBe(second.body.transaction);
    expect(calls.prepared).toBe(2);
  });

  it("sends what the wallet signed only through the command, and hands the command its signature", async () => {
    const { port, calls } = fakePort();
    const server = await ownerServer();
    const handle = server.request(solanaAction(port));
    await postJson(`${handle.url}/account`, { address: SOL_OWNER.address });
    await postJson(`${handle.url}/prepare`, { address: SOL_OWNER.address });
    const answer = await postJson(`${handle.url}/signed`, { address: SOL_OWNER.address, signedTransaction: "c2lnbmVk" });
    expect(answer.status).toBe(200);
    expect(calls.signed).toEqual(["c2lnbmVk"]);
    expect(calls.broadcast).toBe(1);
    expect(await handle.settled).toEqual({ status: "sent", address: SOL_OWNER.address, hash: "5".repeat(88) });
    handle.finish({ ok: true, message: "Done. The chain shows a budget of 0.05 USDC." });
    expect((await getJson(`${handle.url}/state`)).body.status).toBe("confirmed");
  });

  it("keeps the link open and sends nothing when the command refuses what the wallet signed", async () => {
    const { port, calls } = fakePort("refused");
    const server = await ownerServer();
    const handle = server.request(solanaAction(port));
    await postJson(`${handle.url}/account`, { address: SOL_OWNER.address });
    await postJson(`${handle.url}/prepare`, { address: SOL_OWNER.address });
    const answer = await postJson(`${handle.url}/signed`, { address: SOL_OWNER.address, signedTransaction: "dGFtcGVyZWQ=" });
    expect(answer.status).toBe(409);
    expect(String(answer.body.error)).toContain("Nothing was sent");
    expect(calls.broadcast).toBe(0);
    expect((await getJson(`${handle.url}/state`)).body.status).toBe("ready");
    // the owner gives up: a rejection, and nothing was sent
    await postJson(`${handle.url}/reject`, { by: "page" });
    expect(await handle.settled).toMatchObject({ status: "rejected", sending: false });
  });

  it("sends nothing when the link expired while the wallet was signing", async () => {
    const { port, calls } = fakePort();
    const server = await ownerServer();
    const handle = server.request(solanaAction(port, { timeoutMs: 400 }));
    await postJson(`${handle.url}/account`, { address: SOL_OWNER.address });
    await postJson(`${handle.url}/prepare`, { address: SOL_OWNER.address });
    expect(await handle.settled).toMatchObject({ status: "expired", sending: false });
    expect((await postJson(`${handle.url}/signed`, { address: SOL_OWNER.address, signedTransaction: "c2lnbmVk" })).status).toBe(409);
    expect(calls.broadcast).toBe(0);
  });

  it("treats a wallet that would not sign as a rejection with nothing sent", async () => {
    const { port } = fakePort();
    const server = await ownerServer();
    const handle = server.request(solanaAction(port));
    await postJson(`${handle.url}/account`, { address: SOL_OWNER.address });
    await postJson(`${handle.url}/prepare`, { address: SOL_OWNER.address });
    await postJson(`${handle.url}/reject`, { by: "wallet" });
    const outcome = await handle.settled;
    expect(outcome).toMatchObject({ status: "rejected", sending: false });
    expect(outcome.status === "rejected" && outcome.reason).toContain("the wallet reported a rejection");
  });

  it("says it may have sent something when the command lost track after the broadcast", async () => {
    const { port, calls } = fakePort("throw-after-send");
    const server = await ownerServer();
    const handle = server.request(solanaAction(port));
    await postJson(`${handle.url}/account`, { address: SOL_OWNER.address });
    await postJson(`${handle.url}/prepare`, { address: SOL_OWNER.address });
    expect((await postJson(`${handle.url}/signed`, { address: SOL_OWNER.address, signedTransaction: "c2lnbmVk" })).status).toBe(502);
    expect(calls.broadcast).toBe(1);
    expect(await handle.settled).toMatchObject({ status: "expired", sending: true });
  });

  it("names Phantom and devnet on the page, and links the explorer to the right cluster", async () => {
    const { port } = fakePort();
    const server = await ownerServer();
    const handle = server.request(solanaAction(port));
    const html = await (await fetch(handle.url)).text();
    expect(html).toContain("Phantom (or another Solana wallet) is needed here");
    expect(html).toContain("Testnet Mode");
    expect(html).toContain("Solana devnet");
    expect(html).toContain('"walletChain":"solana:devnet"');
    expect(html).toContain('"explorerQuery":"?cluster=devnet"');
    expect(html).not.toMatch(/<script[^>]+src=/i);
    // an EVM page keeps naming MetaMask and has no devnet hint
    const evm = ownerApprovalPage({ id: "0".repeat(32), kind: "evm-transaction", chain: ownerAction().chain, chainIdHex: "0x14a34", expiresAt: Date.now() + 1000 }, ownerAction().terms);
    expect(evm).toContain("MetaMask (or another browser wallet) is needed here");
    expect(evm).not.toContain("Testnet Mode");
    // the page talks the Wallet Standard: it announces itself and listens for wallets
    expect(OWNER_PAGE_SCRIPT).toContain("wallet-standard:app-ready");
    expect(OWNER_PAGE_SCRIPT).toContain("wallet-standard:register-wallet");
    expect(OWNER_PAGE_SCRIPT).toContain("solana:signTransaction");
    expect(OWNER_PAGE_SCRIPT).toContain("solana:signMessage");
    expect(OWNER_PAGE_SCRIPT).not.toContain("solana:signAndSendTransaction");
  });

  it("refuses to register a Solana transaction without its port, or on an EVM chain", async () => {
    const server = await ownerServer();
    expect(() => server.request(solanaAction(undefined as unknown as SolanaTransactionPort, { solana: undefined }))).toThrow();
    expect(() => server.request(solanaAction(fakePort().port, { chain: ownerAction().chain }))).toThrow();
    expect(() => server.request(ownerAction({ chain: SOLANA_CHAIN }))).toThrow();
  });
});

// ── Choosing a wallet on the owner page ──────────────────────────────────────────────────
//
// With several wallets installed, the page asks which one to use, shows each wallet's name as
// text and its icon only as an image, and then talks to that wallet alone: connect, network and
// send. The page's own script runs here in node:vm against a small stand-in for the DOM, and the
// wallets are fakes that record what they were asked.

class FakeNode {
  hidden = false;
  className = "";
  disabled = false;
  readonly attrs = new Map<string, string>();
  readonly children: FakeNode[] = [];
  private text: string;
  constructor(readonly tag: string, text = "") {
    this.text = text;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.text = String(value);
    this.children.length = 0;
  }
  set src(value: string) {
    this.attrs.set("src", value);
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  appendChild(child: FakeNode) {
    this.children.push(child);
    return child;
  }
  closest(selector: string) {
    return selector === "button[data-act]" && this.tag === "button" && this.attrs.has("data-act") ? this : null;
  }
}

type PageWindow = EventTarget & { ethereum?: unknown };

/** The owner page's script, loaded in a stand-in browser with the given wallets installed first. */
function ownerPageInBrowser(facts: Record<string, unknown>, install: (window: PageWindow) => void) {
  const nodes = new Map<string, FakeNode>();
  const node = (id: string) => {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = new FakeNode("div")));
    return n;
  };
  node("owner-facts").textContent = JSON.stringify(facts);
  for (const act of ["connect", "send", "reject"]) {
    const button = new FakeNode("button");
    button.setAttribute("data-act", act);
    nodes.set(act, button);
  }
  for (const id of ["wallet-list", "no-wallet", "send", "say"]) node(id).hidden = true;
  let onClick: (event: { target: FakeNode }) => void = () => {};
  const timers: (() => void)[] = [];
  const posted: string[] = [];
  const document = {
    body: new FakeNode("body"),
    getElementById: node,
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => new FakeNode("#text", text),
    querySelectorAll: () => [node("connect"), node("send"), node("reject"), ...node("wallet-list").children],
    addEventListener: (type: string, fn: typeof onClick) => {
      if (type === "click") onClick = fn;
    },
  };
  const fetch = async (url: string, init?: { method?: string }) => {
    if (init?.method === "POST") posted.push(url.split("/").pop()!);
    return { ok: true, status: 200, json: async () => (url.endsWith("/state") ? { status: "pending" } : { transaction: "dHg=" }) };
  };
  const window = new EventTarget() as PageWindow;
  install(window);
  runInNewContext(OWNER_PAGE_SCRIPT, { window, document, fetch, setTimeout: (fn: () => void) => timers.push(fn), setInterval: () => 0, CustomEvent, Event, TextEncoder, btoa, atob });
  const settle = () => new Promise((done) => setTimeout(done, 20));
  return {
    window,
    node,
    posted,
    click: async (button: FakeNode) => {
      onClick({ target: button });
      await settle();
    },
    /** What the page does once slower wallets had their moment. */
    later: async () => {
      for (const fn of timers.splice(0)) fn();
      await settle();
    },
  };
}

const BASE_SEPOLIA_HEX = "0x14a34";
const SVG_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";

/** An EIP-1193 wallet that records every method it is asked for. */
function fakeProvider() {
  const calls: string[] = [];
  const provider = {
    calls,
    on() {},
    async request({ method }: { method: string }) {
      calls.push(method);
      if (method === "eth_requestAccounts") return [OWNER.address];
      if (method === "eth_chainId") return BASE_SEPOLIA_HEX;
      if (method === "eth_sendTransaction") return HASH;
      return null;
    },
  };
  return provider;
}

/** An EIP-6963 wallet: it answers every requestProvider with its announcement, as extensions do. */
function eip6963Wallet(name: string, icon: string) {
  const provider = fakeProvider();
  const info = { uuid: randomUUID(), name, icon, rdns: "test.wallet" };
  const announce = (window: PageWindow) => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  return {
    provider,
    announce,
    install(window: PageWindow) {
      window.addEventListener("eip6963:requestProvider", () => announce(window));
      announce(window);
    },
  };
}

function evmFacts() {
  const action = ownerAction();
  return { id: "0".repeat(32), kind: "evm-transaction", chain: action.chain, chainIdHex: BASE_SEPOLIA_HEX, account: OWNER.address, transaction: action.transaction, expiresAt: Date.now() + 60_000 };
}

describe("choosing a wallet on the owner page", () => {
  it("asks which EVM wallet to use when several announce, shows names as text and only image icons, and then uses that wallet alone", async () => {
    const hostile = eip6963Wallet('<img src=x onerror="alert(1)">Rabby', SVG_ICON);
    const other = eip6963Wallet("Other Wallet", "javascript:alert(1)");
    const injected = fakeProvider();
    const page = ownerPageInBrowser(evmFacts(), (window) => {
      window.ethereum = injected;
      hostile.install(window);
      other.install(window);
    });
    expect(page.node("connect").hidden).toBe(false);
    expect(page.node("connect").textContent).toBe("Connect wallet");

    await page.click(page.node("connect"));
    const list = page.node("wallet-list");
    expect(list.hidden).toBe(false);
    expect(list.children).toHaveLength(2);
    const [first, second] = list.children;
    // the icon is an <img> with its src and nothing else; the name is a text node, as given
    expect(first.children.map((c) => c.tag)).toEqual(["img", "#text"]);
    expect([...first.children[0].attrs]).toEqual([["src", SVG_ICON]]);
    expect(first.children[1].textContent).toBe('<img src=x onerror="alert(1)">Rabby');
    // an icon that is not an image data URI is not shown at all
    expect(second.children.map((c) => c.tag)).toEqual(["#text"]);
    expect(second.textContent).toBe("Other Wallet");
    expect(hostile.provider.calls).toEqual([]);

    await page.click(second);
    expect(list.hidden).toBe(true);
    expect(other.provider.calls).toEqual(["eth_requestAccounts", "wallet_switchEthereumChain", "eth_chainId"]);
    expect(page.posted).toEqual(["account"]);
    expect(page.node("send").hidden).toBe(false);

    await page.click(page.node("send"));
    expect(other.provider.calls.at(-1)).toBe("eth_sendTransaction");
    expect(page.posted).toEqual(["account", "sending", "sent"]);
    expect(hostile.provider.calls).toEqual([]);
    expect(injected.calls).toEqual([]);
  });

  it("uses one announced wallet directly, falls back to window.ethereum, and says to install one when there is none", async () => {
    const solo = eip6963Wallet("Solo", SVG_ICON);
    const injected = fakeProvider();
    const one = ownerPageInBrowser(evmFacts(), (window) => {
      window.ethereum = injected;
      solo.install(window);
    });
    expect(one.node("connect").textContent).toBe("Connect Solo");
    await one.click(one.node("connect"));
    expect(one.node("wallet-list").hidden).toBe(true);
    expect(solo.provider.calls[0]).toBe("eth_requestAccounts");
    expect(injected.calls).toEqual([]);

    const legacy = fakeProvider();
    const fallback = ownerPageInBrowser(evmFacts(), (window) => {
      window.ethereum = legacy;
    });
    expect(fallback.node("connect").textContent).toBe("Connect wallet");
    await fallback.click(fallback.node("connect"));
    expect(legacy.calls[0]).toBe("eth_requestAccounts");

    const none = ownerPageInBrowser(evmFacts(), () => {});
    expect(none.node("connect").hidden).toBe(true);
    await none.later();
    expect(none.node("no-wallet").hidden).toBe(false);
    expect(none.node("connect").hidden).toBe(true);
    // a wallet that loads after the page still gets its turn
    const late = eip6963Wallet("Late", SVG_ICON);
    late.announce(none.window);
    expect(none.node("no-wallet").hidden).toBe(true);
    expect(none.node("connect").textContent).toBe("Connect Late");
  });

  it("asks which Solana wallet to use when several register, and connects only that one", async () => {
    const made = (name: string) => {
      const calls: string[] = [];
      const wallet = {
        name,
        icon: SVG_ICON,
        version: "1.0.0",
        chains: ["solana:devnet"],
        accounts: [],
        features: {
          "standard:connect": { connect: async () => (calls.push("connect"), { accounts: [{ address: SOL_OWNER.address }] }) },
          "solana:signTransaction": { signTransaction: async () => (calls.push("signTransaction"), []) },
        },
      };
      return { wallet, calls };
    };
    const a = made("Phantom");
    const b = made("Solflare");
    const facts = { id: "0".repeat(32), kind: "solana-transaction", chain: SOLANA_CHAIN, chainIdHex: "", account: SOL_OWNER.address, expiresAt: Date.now() + 60_000 };
    const page = ownerPageInBrowser(facts, (window) => {
      window.addEventListener("wallet-standard:app-ready", (event) => (event as CustomEvent).detail.register(a.wallet, b.wallet));
    });
    expect(page.node("connect").textContent).toBe("Connect wallet");
    await page.click(page.node("connect"));
    const list = page.node("wallet-list");
    expect(list.hidden).toBe(false);
    expect(list.children.map((button) => button.textContent)).toEqual(["Phantom", "Solflare"]);
    expect([...list.children[0].children[0].attrs]).toEqual([["src", SVG_ICON]]);
    await page.click(list.children[1]);
    expect(b.calls).toEqual(["connect"]);
    expect(a.calls).toEqual([]);
    expect(page.posted).toEqual(["account"]);
  });
});

// ── Tempo: what the owner's wallet is asked to send ──────────────────────────────────────
//
// On tempo the owner's wallet calls the keychain precompile directly in a plain transaction.
// The calldata is the whole grant, so it must say exactly what the page says: the agent key,
// the limit, the expiry, the period, and the sellers only when there is a seller list.

describe("the tempo owner calldata", () => {
  it("grants with the current authorizeKey, scoped to the sellers only when there are sellers", async () => {
    const { decodeFunctionData } = await import("viem");
    const { Abis } = await import("viem/tempo");
    // budget/ is plain tsx, outside this project's type check: load it by path
    const tempo = await import(join(REPO, "budget", "tempo", "owner.ts"));
    const agent = privateKeyToAccount(generatePrivateKey()).address;
    const seller = privateKeyToAccount(generatePrivateKey()).address;
    const open = tempo.grantCalldata({ agent, limit: 50_000n, expiry: 1_790_000_000 });
    expect(open.slice(0, 10)).toBe("0x980a6025");
    const a = decodeFunctionData({ abi: Abis.accountKeychain, data: open }) as { args: readonly any[] };
    expect(a.args[0]).toBe(agent);
    expect(a.args[1]).toBe(0);
    expect(a.args[2]).toMatchObject({ expiry: 1_790_000_000n, enforceLimits: true, allowAnyCalls: true, allowedCalls: [] });
    expect(a.args[2].limits).toEqual([{ token: "0x20C0000000000000000000000000000000000000", amount: 50_000n, period: 0n }]);

    const scoped = tempo.grantCalldata({ agent, limit: 10_000n, expiry: 1_790_000_000, period: 3600, sellers: [seller] });
    const b = decodeFunctionData({ abi: Abis.accountKeychain, data: scoped }) as { args: readonly any[] };
    expect(b.args[2].allowAnyCalls).toBe(false);
    expect(b.args[2].limits[0].period).toBe(3600n);
    expect(b.args[2].allowedCalls).toEqual([{ target: "0x20C0000000000000000000000000000000000000", selectorRules: [{ selector: "0xa9059cbb", recipients: [seller] }, { selector: "0x95777d59", recipients: [seller] }] }]);
    expect(tempo.maxByExpiry(10_000n, 3 * 3600, 3600)).toEqual({ windows: 3, max: 30_000n });
    expect(tempo.revokeCalldata(agent).slice(0, 10)).toBe("0x5ae7ab32");
    // Moderato is added to MetaMask with 18 decimals: it refuses any other value
    expect(tempo.TEMPO_OWNER_CHAIN).toMatchObject({ chainId: 42431, nativeCurrency: { decimals: 18 } });
  });

  it("reads a grant back as matching only when every limit is the planned one", async () => {
    const tempo = await import(join(REPO, "budget", "tempo", "owner.ts"));
    const seller = privateKeyToAccount(generatePrivateKey()).address;
    const plan = { agent: AGENT, limit: 10_000n, expiry: 1_790_000_000, period: 3600, sellers: [seller] };
    const onChain = { signatureType: 0, expiry: 1_790_000_000, enforceLimits: true, revoked: false, remaining: 10_000n, periodEnd: 1_789_996_400, scoped: true, admin: false, scopes: [{ target: "0x20c0000000000000000000000000000000000000", selectorRules: [{ selector: "0xa9059cbb", recipients: [seller.toLowerCase()] }, { selector: "0x95777d59", recipients: [seller] }] }] };
    expect(tempo.grantProblems(onChain, plan)).toEqual([]);
    expect(tempo.grantProblems({ ...onChain, remaining: 20_000n }, plan).join()).toContain("limit");
    expect(tempo.grantProblems({ ...onChain, expiry: 1_790_000_001 }, plan).join()).toContain("expires");
    expect(tempo.grantProblems({ ...onChain, scoped: false, scopes: [] }, plan).join()).toContain("seller list");
    expect(tempo.grantProblems({ ...onChain, admin: true }, plan).join()).toContain("admin");
    expect(tempo.grantProblems(onChain, { ...plan, sellers: undefined }).join()).toContain("no seller list was planned");
    // a requested period must be exactly the planned one: the first window ends one period after the grant's block
    const authorizedAt = onChain.periodEnd - 3600;
    expect(tempo.grantProblems(onChain, plan, authorizedAt)).toEqual([]);
    expect(tempo.grantProblems({ ...onChain, periodEnd: authorizedAt + 60 }, plan, authorizedAt).join()).toContain("first period ends");
  });
});

// ── detached owner approvals ─────────────────────────────────────────────────────────────
//
// An agent's shell tool shows a command's output only when it exits, so an owner command run
// by an agent returns at once with its link and an approval id, while the page waits in a
// detached background process; `superstables budget wait --id` reports the state. The worker
// here stands in for the rail script and the dispatcher around it: it runs the real owner page
// in its own detached process and records its link and its outcome through the same functions
// the dispatcher uses. `wait` and the refusal of a second approval run through the real CLI.

const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(REPO, "budget", "cli.mjs");
const TSX = join(REPO, "node_modules", ".bin", "tsx");
type Approvals = typeof import("../../budget/approvals.mjs");
let approvals: Approvals;
let budgetHome: string;
let workerFile: string;
const workers: number[] = [];

beforeAll(async () => {
  budgetHome = mkdtempSync(join(tmpdir(), "superstables-detached-test-"));
  // paths.mjs reads the home once, when it is first imported
  process.env.SUPERSTABLES_HOME = budgetHome;
  approvals = await import("../../budget/approvals.mjs");
  workerFile = join(budgetHome, "worker.mts");
  writeFileSync(
    workerFile,
    `import { OwnerApprovalServer } from ${JSON.stringify(join(REPO, "src/core/signer/owner-approval-server.ts"))};
import { WORKER_ENV, recordLink, recordFinal } from ${JSON.stringify(join(REPO, "budget/approvals.mjs"))};
import { ownerApprovalsLog } from ${JSON.stringify(join(REPO, "budget/paths.mjs"))};
const id = process.env[WORKER_ENV]!;
const input = JSON.parse(process.env.OWNER_ACTION!);
const server = new OwnerApprovalServer({ auditPath: ownerApprovalsLog() });
await server.start();
const handle = server.request(input);
const t = input.terms;
recordLink(id, { action: "grant", url: handle.url, expires: new Date(handle.expiresAt).toISOString(), terms: { title: t.title, amount: t.amount, unit: t.unit, summary: t.summary } });
const outcome = await handle.settled;
if (outcome.status === "sent") handle.finish({ ok: true, message: "Done.", hash: outcome.hash });
await server.close();
const base = { command: "grant", rail: "evm", chain: "base-sepolia" };
const code = outcome.status === "sent" ? 0 : 3;
recordFinal(id, code, outcome.status === "sent"
  ? { ok: true, ...base, state: "settled", tx: { grant: outcome.hash }, id, url: handle.url, next: "none" }
  : { ok: false, ...base, state: "refused_precheck", id, url: handle.url, reason: outcome.reason });
process.exit(code);
`,
  );
});

afterEach(() => {
  while (workers.length > 0) {
    const pid = workers.pop()!;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

afterAll(() => {
  rmSync(budgetHome, { recursive: true, force: true });
});

/** Start one detached approval (on base-sepolia unless told otherwise), as the dispatcher does. */
async function detach(timeoutMs = 20_000, rail = "evm", chain = "base-sepolia") {
  const id = approvals.newApprovalId();
  expect(approvals.claim(rail, chain, id).ok).toBe(true);
  const started = await approvals.startDetached({
    id, command: "grant", rail, chain, cmd: TSX, args: [workerFile], cwd: REPO,
    env: { ...process.env, OWNER_ACTION: JSON.stringify(ownerAction({ timeoutMs })) }, timeoutS: Math.ceil(timeoutMs / 1000),
  });
  expect(started.kind).toBe("waiting");
  const record = started.record!;
  workers.push(record.pid);
  return record;
}

/** Run the real budget CLI with the test's home. stdout is a pipe, as it is for an agent. */
function budget(args: string[]): Promise<{ code: number; stdout: string; result: Record<string, any> }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, SUPERSTABLES_HOME: budgetHome } });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.resume();
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 1, stdout, result: line ? JSON.parse(line.slice(7)) : {} });
    });
  });
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && approvals.alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !approvals.alive(pid);
}

async function unreachable(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/state`, { signal: AbortSignal.timeout(1000) });
    return false;
  } catch {
    return true;
  }
}

describe("a detached owner approval", () => {
  it("returns with the link at once; wait says waiting_owner, then the final result, the same every time", async () => {
    const record = await detach();
    expect(record.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/owner\/[0-9a-f]{32}$/);
    expect(record.terms.title).toBe("give your agent a budget");
    expect(approvals.alive(record.pid)).toBe(true);

    const pending = await budget(["wait", "--id", record.id, "--timeout", "0"]);
    expect(pending.code).toBe(0);
    expect(pending.result).toMatchObject({ command: "grant", state: "waiting_owner", id: record.id, url: record.url, expires: record.expires });
    expect(pending.result.terms.amount).toBe("0.01");
    expect(pending.result.reason).toContain("waiting for the owner");
    expect(pending.result.next).toContain(`superstables budget wait --id ${record.id}`);

    // the owner approves in the wallet
    await postJson(`${record.url}/account`, { address: OWNER.address });
    const connected = await budget(["wait", "--id", record.id, "--timeout", "0"]);
    expect(connected.result.reason).toContain("the owner account is selected");
    await postJson(`${record.url}/sending`, { address: OWNER.address });
    await postJson(`${record.url}/sent`, { address: OWNER.address, hash: HASH });

    const settled = await budget(["wait", "--id", record.id, "--timeout", "10"]);
    expect(settled.code).toBe(0);
    expect(settled.result).toMatchObject({ command: "grant", state: "settled", id: record.id, tx: { grant: HASH } });
    const again = await budget(["wait", "--id", record.id]);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe(settled.stdout);

    // the worker ended, its page is closed, and the chain is free for the next owner command
    expect(await gone(record.pid)).toBe(true);
    expect(await unreachable(record.url)).toBe(true);
    expect(approvals.findPending("evm", "base-sepolia")).toBeNull();
  });

  it("ends a link nobody answers as expired, and its process exits and frees the chain", async () => {
    const record = await detach(1_500);
    const outcome = await approvals.waitFor(record.id, 10_000);
    expect(outcome).toMatchObject({ final: true, code: 3 });
    expect(outcome!.final && outcome!.result).toMatchObject({ state: "refused_precheck" });
    expect(String(outcome!.final && outcome!.result.reason)).toContain("without a completed approval");
    expect(await gone(record.pid)).toBe(true);
    expect(await unreachable(record.url)).toBe(true);
    expect(approvals.findPending("evm", "base-sepolia")).toBeNull();
    // and a later wait still says the same
    const later = await budget(["wait", "--id", record.id, "--timeout", "0"]);
    expect(later.code).toBe(3);
    expect(later.result.state).toBe("refused_precheck");
  });

  it("refuses a second owner command on the chain while one is pending, and points to it", async () => {
    const record = await detach();
    const second = await budget(["grant", "--rail", "evm", "--amount", "0.001"]);
    expect(second.code).toBe(3);
    expect(second.result).toMatchObject({ command: "grant", state: "refused_precheck", id: record.id, url: record.url });
    expect(second.result.next).toContain(`superstables budget wait --id ${record.id}`);
    expect(second.result.next).toContain("--replace");
    expect(approvals.findPending("evm", "base-sepolia")?.id).toBe(record.id);

    // the owner rejects on the page: the chain is free again, and wait says it was rejected
    await postJson(`${record.url}/reject`, { by: "page" });
    const rejected = await budget(["wait", "--id", record.id, "--timeout", "10"]);
    expect(rejected.code).toBe(3);
    expect(rejected.result.reason).toContain("rejected on the page");
    expect(await gone(record.pid)).toBe(true);
    expect(approvals.findPending("evm", "base-sepolia")).toBeNull();
  });

  it("replaces a pending approval only while the wallet has not been asked to send", async () => {
    const asked = await detach();
    await postJson(`${asked.url}/account`, { address: OWNER.address });
    await postJson(`${asked.url}/sending`, { address: OWNER.address });
    const kept = await approvals.replacePending(asked, "oa-20260930000000-00000000");
    expect(kept.ok).toBe(false);
    expect(approvals.alive(asked.pid)).toBe(true);
    await postJson(`${asked.url}/reject`, { by: "wallet" });
    await approvals.waitFor(asked.id, 10_000);

    const idle = await detach();
    expect((await approvals.replacePending(idle, "oa-20260930000000-00000000")).ok).toBe(true);
    expect(await gone(idle.pid)).toBe(true);
    const replaced = await budget(["wait", "--id", idle.id]);
    expect(replaced.code).toBe(3);
    expect(replaced.result.reason).toContain("replaced by oa-20260930000000-00000000");
    expect(approvals.findPending("evm", "base-sepolia")).toBeNull();
  });

  it("holds tempo and solana owner commands to the same gate: the wallet by default, one approval per chain", async () => {
    for (const [rail, chain] of [["tempo", "moderato"], ["solana", "devnet"]]) {
      // --yes only goes with a test owner key file; nothing is spawned
      const yes = await budget(["grant", "--rail", rail, "--amount", "0.01", "--yes"]);
      expect(yes.code).toBe(2);
      expect(yes.result.reason).toContain("show the approval link to the owner and poll wait");
      const record = await detach(20_000, rail, chain);
      const second = await budget(["revoke", "--rail", rail]);
      expect(second.code).toBe(3);
      expect(second.result).toMatchObject({ command: "revoke", rail, chain, state: "refused_precheck", id: record.id, url: record.url });
      expect(approvals.findPending(rail, chain)?.id).toBe(record.id);
      // another rail's chain is not held by it
      expect(approvals.findPending("evm", "base-sepolia")).toBeNull();
      await postJson(`${record.url}/reject`, { by: "page" });
      expect((await budget(["wait", "--id", record.id, "--timeout", "10"])).code).toBe(3);
      expect(await gone(record.pid)).toBe(true);
      expect(approvals.findPending(rail, chain)).toBeNull();
    }
    // tempo's agent needs no gas: there is nothing to fund
    const fund = await budget(["fund-agent", "--rail", "tempo"]);
    expect(fund.code).toBe(2);
    expect(fund.result.reason).toContain("needs no gas");
  });

  it("keeps the chain and no final result while the page outlives its worker, until the whole group is gone", async () => {
    const record = await detach();
    // kill the worker process only (tsx's wrapper): the page's process, in the same group, runs on
    process.kill(record.pid, "SIGKILL");
    expect(await gone(record.pid)).toBe(true);
    expect(await unreachable(record.url)).toBe(false);
    const pending = await budget(["wait", "--id", record.id, "--timeout", "0"]);
    expect(pending.code).toBe(0);
    expect(pending.result.state).toBe("waiting_owner");
    expect(pending.result.reason).toContain("still running");
    expect(approvals.findPending("evm", "base-sepolia")?.id).toBe(record.id);
    const second = await budget(["grant", "--rail", "evm", "--amount", "0.001"]);
    expect(second.code).toBe(3);
    expect(second.result.id).toBe(record.id);
    // once nothing of it is left, wait reports from what the page logged, and the chain is free
    process.kill(-record.pid, "SIGKILL");
    for (let i = 0; i < 50 && approvals.groupAlive(record.pid); i++) await new Promise((r) => setTimeout(r, 100));
    const ended = await budget(["wait", "--id", record.id, "--timeout", "0"]);
    expect(ended.code).toBe(3);
    expect(ended.result.reason).toContain("stopped without a recorded submission");
    expect(approvals.findPending("evm", "base-sepolia")).toBeNull();
  });

  it("reports unknown, never nothing sent, when the page had asked the wallet before everything stopped", async () => {
    const record = await detach();
    await postJson(`${record.url}/account`, { address: OWNER.address });
    await postJson(`${record.url}/sending`, { address: OWNER.address });
    process.kill(-record.pid, "SIGKILL");
    for (let i = 0; i < 50 && approvals.groupAlive(record.pid); i++) await new Promise((r) => setTimeout(r, 100));
    const outcome = await budget(["wait", "--id", record.id, "--timeout", "0"]);
    expect(outcome.code).toBe(5);
    expect(outcome.result.state).toBe("unknown");
  });

  it("makes a blocking owner command hold the same lock as a detached one", async () => {
    // setup in a terminal (--wait) blocks on its connect page; a second owner command on the chain is refused meanwhile
    const child = spawn(process.execPath, [CLI, "setup", "--rail", "evm", "--chain", "arc-testnet", "--wait", "--no-open", "--timeout", "30"], { env: { ...process.env, SUPERSTABLES_HOME: budgetHome } });
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.resume();
    const exited = new Promise<number>((done) => child.once("close", (code) => done(code ?? 1)));
    try {
      await waitFor(() => /APPROVE \{/.test(out), 30_000);
      const url = JSON.parse(out.split("\n").find((l) => l.startsWith("APPROVE "))!.slice(8)).url as string;
      const second = await budget(["grant", "--rail", "evm", "--chain", "arc-testnet", "--amount", "0.001"]);
      expect(second.code).toBe(3);
      expect(second.result).toMatchObject({ state: "refused_precheck", url });
      expect(second.result.reason).toContain("(setup) is still waiting");
      await postJson(`${url}/reject`, { by: "page" });
      expect(await exited).toBe(3);
      expect(approvals.findPending("evm", "arc-testnet")).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("reports an owner command stopped by a signal after its link existed as unknown, never failed", async () => {
    const child = spawn(process.execPath, [CLI, "setup", "--rail", "evm", "--chain", "arbitrum-sepolia", "--wait", "--no-open", "--timeout", "30"], { env: { ...process.env, SUPERSTABLES_HOME: budgetHome } });
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.resume();
    const exited = new Promise<number>((done) => child.once("close", (code) => done(code ?? 1)));
    try {
      await waitFor(() => /APPROVE \{/.test(out), 30_000);
      child.kill("SIGTERM");
      expect(await exited).toBe(5);
      const result = JSON.parse(out.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "))!.slice(7));
      expect(result).toMatchObject({ state: "unknown" });
      expect(approvals.findPending("evm", "arbitrum-sepolia")).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("never replaces a recorded owner silently: setup names it and points to --new-owner", async () => {
    const recorded = privateKeyToAccount(generatePrivateKey()).address;
    const keys = join(budgetHome, "keys", "budget");
    const pub = join(budgetHome, "budget", "public");
    for (const dir of [keys, pub]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // the agent key file may exist already (setup made it earlier in this home)
    const agentFile = join(keys, "evm-agent.env");
    if (!existsSync(agentFile)) {
      const key = generatePrivateKey();
      writeFileSync(agentFile, `B4_AGENT_KEY=${key}\nB4_AGENT_ADDRESS=${privateKeyToAccount(key).address}\n`, { mode: 0o600 });
    }
    const agentAddress = /B4_AGENT_ADDRESS=(\S+)/.exec(readFileSync(agentFile, "utf8"))![1];
    writeFileSync(join(pub, "evm-skale-base-sepolia.env"), `B4_OWNER_ADDRESS=${recorded}\nB4_AGENT_ADDRESS=${agentAddress}\n`);
    const other = generatePrivateKey();
    const ownerFile = join(budgetHome, "other-owner.env");
    writeFileSync(ownerFile, `B4_OWNER_KEY=${other}\n`, { mode: 0o600 });
    const refused = await budget(["setup", "--rail", "evm", "--chain", "skale-base-sepolia", "--owner-key-file", ownerFile]);
    expect(refused.code).toBe(3);
    expect(refused.result).toMatchObject({ state: "refused_precheck", owner: recorded });
    expect(refused.result.next).toContain("--new-owner");
    expect(readFileSync(join(pub, "evm-skale-base-sepolia.env"), "utf8")).toContain(`B4_OWNER_ADDRESS=${recorded}`);
  });

  it("reserves the chain in one exclusive step, and never takes over a fresh lock", () => {
    const [a, b] = [approvals.newApprovalId(), approvals.newApprovalId()];
    // two claims before either approval has a record or a worker: the second is refused
    expect(approvals.claim("evm", "polygon-amoy", a).ok).toBe(true);
    const second = approvals.claim("evm", "polygon-amoy", b);
    expect(second.ok).toBe(false);
    expect(second.pending?.id).toBe(a);
    approvals.release("evm", "polygon-amoy", a);

    // a lock whose claimer is gone: still held during the startup grace, taken over after it
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const lockPath = join(budgetHome, "budget", "approvals", "active-evm-polygon-amoy");
    writeFileSync(lockPath, JSON.stringify({ id: a, pid: dead, createdAt: Date.now() }));
    expect(approvals.claim("evm", "polygon-amoy", b).ok).toBe(false);
    writeFileSync(lockPath, JSON.stringify({ id: a, pid: dead, createdAt: Date.now() - approvals.STARTUP_GRACE_MS - 1000 }));
    expect(approvals.claim("evm", "polygon-amoy", b).ok).toBe(true);
    approvals.release("evm", "polygon-amoy", b);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reports a worker that died without a result from what its page last logged", async () => {
    const record = await detach();
    process.kill(-record.pid, "SIGKILL");
    expect(await gone(record.pid)).toBe(true);
    const outcome = await budget(["wait", "--id", record.id, "--timeout", "0"]);
    expect(outcome.code).toBe(3);
    expect(outcome.result).toMatchObject({ state: "refused_precheck", id: record.id });
    expect(outcome.result.reason).toContain("stopped without a recorded submission");
    expect(approvals.findPending("evm", "base-sepolia")).toBeNull();
  });
});

// ── what binds a chain result to this operation ─────────────────────────────────────────
//
// A seller's receipt names a transaction, but a seller can name any old one. The rails accept a
// transaction as this purchase's settlement only when the chain ties it to this operation, and a
// read that fails is never an answer.

describe("settlement binding and failed reads on the chain", () => {
  it("solana: settles only on a transaction that carries this operation's agent signature", async () => {
    const { assessOp } = await import(join(REPO, "budget", "solana", "ops.mjs"));
    const statuses = new Map<string, unknown>([["old-seller-tx", { confirmationStatus: "finalized", err: null, slot: 10 }]]);
    const txs = new Map<string, unknown>([["old-seller-tx", { slot: 10, transaction: { signatures: ["old-seller-tx", "someone-elses-sig"] }, meta: { err: null } }]]);
    const conn = {
      getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map((sig) => statuses.get(sig) ?? null) }),
      getTransaction: async (sig: string) => txs.get(sig) ?? null,
      getSignaturesForAddress: async () => [],
      getBlockHeight: async () => 100,
    };
    const rec = { agentSig: "our-agent-sig", sellerTx: "old-seller-tx", agent: SOL_OWNER.address, lastValidBlockHeight: 200, submittedAt: new Date().toISOString() };
    // an unrelated old success is not this purchase: still pending, never settled
    expect(await assessOp(conn, rec)).toMatchObject({ verdict: "pending" });
    // the facilitator's transaction that carries our signature is
    statuses.set("new-settle", { confirmationStatus: "confirmed", err: null, slot: 11 });
    txs.set("new-settle", { slot: 11, transaction: { signatures: ["facilitator-sig", "our-agent-sig"] }, meta: { err: null } });
    expect(await assessOp(conn, { ...rec, sellerTx: "new-settle" })).toMatchObject({ verdict: "settled", tx: "new-settle" });
    // a failed read is not "not found": it throws, and the caller keeps the purchase unknown
    await expect(assessOp({ ...conn, getSignatureStatuses: async () => { throw new Error("fetch failed"); } }, rec)).rejects.toThrow("fetch failed");
  });

  it("tempo: an old same-amount payment to the seller never settles a new purchase", async () => {
    const { judge } = await import(join(REPO, "budget", "tempo", "lib", "resolve.ts"));
    const pathUsd = "0x20C0000000000000000000000000000000000000";
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    const seller = privateKeyToAccount(generatePrivateKey()).address;
    const memo = `0x${"11".repeat(32)}`;
    const op = { op: "t-1", intent: { owner, recipient: seller, agent: AGENT, amount: "1000" }, memo, startBlock: "500" };
    const transfer = { token: pathUsd, from: owner, to: seller, value: 1000n };
    const old = { kind: "found", hash: `0x${"aa".repeat(32)}`, from: owner, receipt: { status: "success", blockNumber: 400n, transactionHash: `0x${"aa".repeat(32)}`, transfers: [transfer], memos: [] } };
    const unbound = judge(op, old, 1000n);
    expect(unbound.state).toBe("unknown");
    expect(unbound.note).toContain("before this operation started");
    expect(unbound.note).toContain("memo");
    expect(unbound.note).toContain("no access key");
    const ours = { kind: "found", hash: `0x${"bb".repeat(32)}`, from: owner, keyId: AGENT, receipt: { status: "success", blockNumber: 600n, transactionHash: `0x${"bb".repeat(32)}`, transfers: [transfer], memos: [{ token: pathUsd, from: owner, to: seller, memo }] } };
    expect(judge(op, ours, 1000n)).toMatchObject({ state: "settled", debit: 1000n });
    const otherKey = privateKeyToAccount(generatePrivateKey()).address;
    expect(judge(op, { ...ours, keyId: otherKey }, 1000n).state).toBe("unknown");
    expect(judge(op, { ...ours, from: otherKey }, 1000n).state).toBe("unknown");
  });

  it("solana: a read that fails is never 'never landed' or 'no account'", async () => {
    const { confirmSent } = await import(join(REPO, "budget", "solana", "owner.ts"));
    const { getAccountOrNull } = await import(join(REPO, "budget", "solana", "token.mjs"));
    const down = async () => { throw new Error("fetch failed"); };
    const sent = { signature: "sig", blockhash: "hash", lastValidBlockHeight: 10 };
    expect(await confirmSent({ getTransaction: down, getBlockHeight: async () => 1000, getSignatureStatus: down }, sent, 100)).toEqual({ status: "unknown" });
    expect(await confirmSent({ getTransaction: async () => null, getBlockHeight: async () => 1000, getSignatureStatus: down }, sent, 100)).toEqual({ status: "unknown" });
    // only a successful answer that the chain has no such signature, after its blockhash expired, is "expired"
    expect(await confirmSent({ getTransaction: async () => null, getBlockHeight: async () => 1000, getSignatureStatus: async () => ({ value: null }) }, sent, 100)).toEqual({ status: "expired" });
    const { PublicKey } = await import("@solana/web3.js");
    const address = new PublicKey(SOL_OWNER.address);
    expect(await getAccountOrNull({ getAccountInfo: async () => null }, address)).toBeNull();
    await expect(getAccountOrNull({ getAccountInfo: down }, address)).rejects.toThrow("fetch failed");
  });
});

/** Poll a condition on loopback. Everything here is local, so this is milliseconds. */
async function waitFor(ready: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the signer");
    await new Promise((done) => setTimeout(done, 10));
  }
}
