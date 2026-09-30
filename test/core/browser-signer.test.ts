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

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { OwnerApprovalServer, signInMessage, type OwnerActionInput } from "../../src/core/signer/owner-approval-server.js";
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

async function postJson(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

  it("ends a rejection with nothing sent, and says whether the wallet had been asked", async () => {
    const server = await ownerServer();
    const onPage = server.request(ownerAction());
    await postJson(`${onPage.url}/reject`, { by: "page" });
    expect(await onPage.settled).toMatchObject({ status: "rejected", sending: false });
    expect((await postJson(`${onPage.url}/account`, { address: OWNER.address })).status).toBe(409);

    const inWallet = server.request(ownerAction());
    await postJson(`${inWallet.url}/account`, { address: OWNER.address });
    await postJson(`${inWallet.url}/sending`, { address: OWNER.address });
    await postJson(`${inWallet.url}/reject`, { by: "wallet" });
    const outcome = await inWallet.settled;
    // the wallet said no (code 4001): it sent nothing, even though it had been asked
    expect(outcome).toMatchObject({ status: "rejected", sending: false });
    expect(outcome.status === "rejected" && outcome.reason).toContain("in the wallet");
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
    expect(await unknown.text()).toContain("Nothing is waiting under this link");
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
    expect(OWNER_PAGE_SCRIPT).toContain("eth_sendTransaction");
    expect(OWNER_PAGE_SCRIPT).toContain("wallet_addEthereumChain");
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

/** Start one detached approval on base-sepolia, as the dispatcher does. */
async function detach(timeoutMs = 20_000) {
  const id = approvals.newApprovalId();
  expect(approvals.claim("evm", "base-sepolia", id).ok).toBe(true);
  const started = await approvals.startDetached({
    id, command: "grant", rail: "evm", chain: "base-sepolia", cmd: TSX, args: [workerFile], cwd: REPO,
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
    expect(connected.result.reason).toContain("connected their wallet");
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
    expect(String(outcome!.final && outcome!.result.reason)).toContain("Nothing was sent");
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
    expect(rejected.result.reason).toContain("rejected it on the page");
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

  it("reports a worker that died without a result from what its page last logged", async () => {
    const record = await detach();
    process.kill(-record.pid, "SIGKILL");
    expect(await gone(record.pid)).toBe(true);
    const outcome = await budget(["wait", "--id", record.id, "--timeout", "0"]);
    expect(outcome.code).toBe(3);
    expect(outcome.result).toMatchObject({ state: "refused_precheck", id: record.id });
    expect(outcome.result.reason).toContain("stopped before anything was sent");
    expect(approvals.findPending("evm", "base-sepolia")).toBeNull();
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
