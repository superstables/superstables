// The prechecks every rail runs on a seller's payment terms before anything is signed or pulled (contract rule 4):
// a recipient that is the zero address, the token itself, the agent or the owner, and, on evm, an authorization
// lifetime that is missing, not a whole number of seconds, or outside 30 to 600. Pure: no chain, no key.

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { x402Client } from "@x402/core/client";
import { afterAll, describe, expect, it } from "vitest";
import { precheckCharge } from "../../budget/tempo/lib/precheck.mjs";
import { CHAIN_ID, TOKEN_ADDRESS } from "../../budget/tempo/lib/constants.mjs";
import { checkOffer } from "../../budget/solana/precheck.mjs";
import { USDC_MINT } from "../../budget/solana/lib.mjs";

// loaded by URL, so the type check does not follow the rail's own imports (it runs them with tsx)
const lib = await import(new URL("../../budget/evm/lib.ts", import.meta.url).href);
const { checkAccept, sameOption, onlyOption } = await import(new URL("../../budget/evm/purchase.ts", import.meta.url).href);

const SELLER = "0xFD24114C3981Aba78aE2441991B1BdB89329c556";
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ZERO = "0x0000000000000000000000000000000000000000";
const MAX = 10n ** 6n;
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

describe("evm: the terms of one payment option", () => {
  const option = (o: Record<string, unknown> = {}) => ({
    asset: lib.USDC, amount: "1000", payTo: SELLER, maxTimeoutSeconds: 60,
    extra: { name: lib.CFG.domain.name, version: lib.CFG.domain.version }, ...o,
  });
  const opts = { max: MAX, agent: AGENT, owner: OWNER };

  it("accepts a seller with a lifetime from 30 to 600 seconds", () => {
    for (const t of [30, 60, 600]) expect(checkAccept(option({ maxTimeoutSeconds: t }), opts), String(t)).toBeNull();
  });

  it("refuses a recipient that is the zero address, the token, the agent or the owner, in any letter case", () => {
    expect(checkAccept(option({ payTo: ZERO }), opts)).toBe("recipient is the zero address");
    expect(checkAccept(option({ payTo: lib.USDC }), opts)).toContain("token contract itself");
    expect(checkAccept(option({ payTo: lib.USDC.toLowerCase() }), opts)).toContain("token contract itself");
    expect(checkAccept(option({ payTo: AGENT }), opts)).toBe("recipient is this agent's own key");
    expect(checkAccept(option({ payTo: AGENT.toLowerCase() }), opts)).toBe("recipient is this agent's own key");
    expect(checkAccept(option({ payTo: OWNER }), opts)).toBe("recipient is the owner's wallet, which funds this budget");
    expect(checkAccept(option({ payTo: OWNER.toLowerCase() }), opts)).toBe("recipient is the owner's wallet, which funds this budget");
  });

  it("refuses a lifetime that is missing, not a whole number, or outside 30 to 600", () => {
    const missing = option();
    delete (missing as any).maxTimeoutSeconds;
    expect(checkAccept(missing, opts)).toContain("is not a whole number of seconds from 30 to 600");
    for (const t of [null, Number.NaN, -1, 0, 29, 601, 900, 3600, 3601, "60", 60.5]) {
      expect(checkAccept(option({ maxTimeoutSeconds: JSON.parse(JSON.stringify(t)) }), opts), String(t)).toContain("is not a whole number of seconds from 30 to 600");
    }
  });
});

describe("evm: two options that differ only in their lifetime are two options", () => {
  const option = (maxTimeoutSeconds?: number, extra: Record<string, unknown> = {}) => ({
    scheme: "exact", network: lib.NETWORK, asset: lib.USDC, amount: "1000", payTo: SELLER, maxTimeoutSeconds,
    extra: { name: lib.CFG.domain.name, version: lib.CFG.domain.version, ...extra },
  });

  it("sameOption compares every field a signature depends on", () => {
    expect(sameOption(option(60), option(60))).toBe(true);
    expect(sameOption(option(60), option(1))).toBe(false);
    expect(sameOption(option(60), option(undefined))).toBe(false);
    expect(sameOption(option(60), { ...option(60), amount: "1001" })).toBe(false);
    expect(sameOption(option(60), { ...option(60), payTo: OWNER })).toBe(false);
    expect(sameOption(option(60), { ...option(60), asset: ZERO })).toBe(false);
    expect(sameOption(option(60), { ...option(60), network: "eip155:1" })).toBe(false);
    expect(sameOption(option(60), option(60, { name: "Other" }))).toBe(false);
    expect(sameOption(option(60), option(60, { version: "9" }))).toBe(false);
    expect(sameOption(option(60), option(60, { assetTransferMethod: "permit2" }))).toBe(false);
    expect(sameOption(option(60), null)).toBe(false);
  });

  it("the x402 client, given a seller that lists a 1 s option first and a 60 s one second, can only select the one that passed the prechecks", () => {
    const accepts = [option(1), option(60)];
    // the prechecks refuse the first and pick the second
    expect(checkAccept(accepts[0], { max: MAX })).toContain("is not a whole number of seconds from 30 to 600");
    expect(checkAccept(accepts[1], { max: MAX })).toBeNull();
    const clientFor = () => {
      const c = new x402Client().register(lib.NETWORK, { scheme: "exact", createPaymentPayload: async () => ({ x402Version: 2, payload: {} }) } as any);
      c.setSpendControls({ allowedAssets: [{ network: lib.NETWORK, asset: lib.USDC, maxAmountPerPayment: String(MAX) }] });
      c.registerPolicy((_v: number, reqs: any[]) => onlyOption(reqs, accepts[1]));
      return c;
    };
    const client = clientFor();
    const selected: any = (client as any).selectPaymentRequirements(2, accepts);
    expect(selected.maxTimeoutSeconds).toBe(60);
    expect(sameOption(selected, accepts[1])).toBe(true);
    // a selection that is not the checked option is what the pull is refused on
    expect(sameOption(accepts[0], accepts[1])).toBe(false);
    // a listing of the 1 s option alone leaves nothing to select: no pull
    expect(() => (clientFor() as any).selectPaymentRequirements(2, [accepts[0]])).toThrow();
  });
});

describe("solana: the terms of one offer", () => {
  const agent = new PublicKey("11111111111111111111111111111112");
  const owner = new PublicKey("SysvarRent111111111111111111111111111111111");
  const seller = new PublicKey("Vote111111111111111111111111111111111111111");
  const offer = (payTo: string) => ({ scheme: "exact", amount: "1000", asset: USDC_MINT.toBase58(), payTo, extra: { decimals: 6 } });
  const opts = { maxBase: MAX, payTo: undefined, agent, owner };

  it("accepts an ordinary recipient", () => {
    expect(checkOffer(offer(seller.toBase58()), opts).ok).toBe(true);
  });

  it("refuses the all-zero key, the mint, the agent and the owner", () => {
    expect(checkOffer(offer(PublicKey.default.toBase58()), opts).reasons).toContain("recipient is the all-zero address");
    expect(checkOffer(offer(USDC_MINT.toBase58()), opts).reasons).toContain("recipient is the USDC mint itself");
    expect(checkOffer(offer(agent.toBase58()), opts).reasons).toContain("recipient is this agent's own key");
    expect(checkOffer(offer(owner.toBase58()), opts).reasons).toContain("recipient is the owner's wallet, which funds this budget");
  });
});

// budget/solana/buy.mjs, the whole script. The owner is the one the agent key file names (the public file records none), and the
// recipient is that owner, or the agent key itself: refused once the key file has been read, before any balance or delegation read or signature.
describe("solana buy: the recipient is the owner or agent this purchase runs with", () => {
  const BUY = join(import.meta.dirname, "..", "..", "budget", "solana", "buy.mjs");
  const homes: string[] = [];
  const servers: Server[] = [];
  afterAll(() => {
    for (const h of homes) rmSync(h, { recursive: true, force: true });
    for (const s of servers) s.close();
  });
  const listen = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };

  async function buyPaying(who: "owner" | "agent") {
    const agent = Keypair.generate();
    const owner = Keypair.generate();
    const home = mkdtempSync(join(tmpdir(), "superstables-solana-recipient-"));
    homes.push(home);
    const keys = join(home, "keys", "budget");
    mkdirSync(keys, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "budget", "public"), { recursive: true, mode: 0o700 });
    // only the key file names the owner; there is no public file, so step 3 cannot know it
    writeFileSync(join(keys, "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(agent.secretKey)}\nSOLANA_AGENT_ADDRESS=${agent.publicKey.toBase58()}\nSOLANA_OWNER_ADDRESS=${owner.publicKey.toBase58()}\n`, { mode: 0o600 });
    const payTo = (who === "owner" ? owner : agent).publicKey.toBase58();
    // the node answers only which cluster it is (the pinned devnet genesis); every method it is asked is recorded
    const rpcMethods: string[] = [];
    const rpc = await listen((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += String(c)));
      req.on("end", () => {
        let id: unknown = 1;
        try { const body = JSON.parse(raw); id = body.id; rpcMethods.push(String(body.method)); } catch { rpcMethods.push("(unreadable)"); }
        if (rpcMethods.at(-1) === "getGenesisHash") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: DEVNET_GENESIS }));
        else res.writeHead(500).end("{}");
      });
    });
    const seller = await listen((_req, res) => {
      const body = { x402Version: 2, accepts: [{ scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: USDC_MINT.toBase58(), amount: "1000", payTo, maxTimeoutSeconds: 60, extra: { feePayer: Keypair.generate().publicKey.toBase58(), decimals: 6 } }] };
      res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    const op = `recipient-${who}`;
    const run = await new Promise<{ code: number; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, [BUY, "--url", `${seller}/paid`, "--max", "0.01", "--op", op], { env: { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_SOLANA_RPC: rpc } });
      let stdout = "", stderr = "";
      child.stdout.on("data", (c) => (stdout += String(c)));
      child.stderr.on("data", (c) => (stderr += String(c)));
      child.once("error", fail);
      child.once("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    });
    const line = run.stdout.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "));
    return { ...run, rpcMethods, op, home, result: line ? JSON.parse(line.slice(7)) : {} };
  }

  for (const [who, words] of [["owner", "the owner's wallet, which funds this budget"], ["agent", "this agent's own key"]] as const) {
    it(`refuses a seller that pays ${who === "owner" ? "the owner the key file names" : "the loaded agent key"}: exit 3, nothing signed, no balance or delegation read`, async () => {
      const r = await buyPaying(who);
      expect(r.code, r.stderr).toBe(3);
      expect(r.result).toMatchObject({ state: "refused_precheck", tx: null });
      expect(r.result.reason).toContain(`recipient is ${words}`);
      expect(r.stderr).toContain("Refused (nothing signed)");
      expect(r.stdout).not.toMatch(/SENDING|signature/i);
      // no balance, delegation or blockhash read, and nothing sent: at most the cluster check
      expect(r.rpcMethods.filter((m) => m !== "getGenesisHash")).toEqual([]);
      expect(readdirSync(join(r.home, "budget", "ops", "solana-devnet")).filter((f) => f.startsWith(r.op))).toHaveLength(1);
    });
  }
});

describe("tempo: the terms of one charge", () => {
  const charge = (recipient: string, splits: { recipient: string; amount: string }[] = []) => ({
    amount: "1000", currency: TOKEN_ADDRESS, recipient, methodDetails: { chainId: CHAIN_ID, ...(splits.length ? { splits } : {}) },
  });
  const opts = { maxBase: 10_000n, agent: AGENT, owner: OWNER };

  it("accepts an ordinary recipient", () => {
    expect(precheckCharge(charge(SELLER), opts)).toMatchObject({ ok: true });
  });

  it("refuses the zero address, the token, the agent and the owner", () => {
    expect(precheckCharge(charge(ZERO), opts)).toMatchObject({ ok: false, code: "bad_recipient", reason: "the recipient is the zero address" });
    expect(precheckCharge(charge(TOKEN_ADDRESS.toLowerCase()), opts)).toMatchObject({ ok: false, code: "bad_recipient" });
    expect(precheckCharge(charge(AGENT.toLowerCase()), opts)).toMatchObject({ ok: false, code: "bad_recipient", reason: "the recipient is this agent's own key" });
    expect(precheckCharge(charge(OWNER), opts)).toMatchObject({ ok: false, code: "bad_recipient", reason: "the recipient is the owner's wallet, which funds this budget" });
  });

  it("holds each split to the same rule", () => {
    expect(precheckCharge(charge(SELLER, [{ recipient: ZERO, amount: "100" }]), opts)).toMatchObject({ ok: false, code: "bad_recipient" });
    expect(precheckCharge(charge(SELLER, [{ recipient: OWNER, amount: "100" }]), opts)).toMatchObject({ ok: false, code: "bad_recipient" });
    expect(precheckCharge(charge(SELLER, [{ recipient: OTHER_SELLER, amount: "100" }]), opts)).toMatchObject({ ok: true });
  });
});

const OTHER_SELLER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
