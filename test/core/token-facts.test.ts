// Every fact about the token a chain pays in comes from that chain's one table entry: its address, symbol, decimals,
// EIP-712 domain and whether a new allowance must start from 0. Nothing assumes six decimals. The table is replaced
// here by one that also names "Fake Eighteen", a testnet whose token entry states 18 decimals while the older `usdc`
// view of the entry it was copied from still says 6: what `quote` shows must follow the token entry.

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/chain.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/chain.js")>();
  const fake = { ...real.BASE_SEPOLIA, key: "fake-eighteen", caip2: "eip155:999018", chainId: 999018, v1Name: "", label: "Fake Eighteen (testnet)", token: { ...real.BASE_SEPOLIA.token, decimals: 18 } };
  const evm = [...real.EVM_NETWORKS, fake];
  const known = [...evm, real.TEMPO_MODERATO, real.SOLANA_DEVNET];
  const networkFor = (name: string) => (name ? known.find((n) => n.caip2 === name || (n.v1Name !== "" && n.v1Name === name)) : undefined);
  return { ...real, EVM_NETWORKS: evm, KNOWN_NETWORKS: known, networkFor, evmNetworkFor: (name: string) => { const f = networkFor(name); return f?.rail === "evm" ? f : undefined; } };
});

import * as chain from "../../src/core/chain.js";
import { EVM_NETWORKS, SOLANA_DEVNET, TEMPO_MODERATO, fromAtomic, toAtomic, type EvmNetwork } from "../../src/core/chain.js";
import { DEFAULT_POLICY, policyAmount } from "../../src/core/policy.js";
import { quote } from "../../src/core/quote.js";
import { Records } from "../../src/core/records.js";
import { money, termsMoney } from "../../src/cli/format.js";
import { messageFor } from "../../src/cli/views.js";
import { EVM_CHAINS } from "../../budget/evm/chains.mjs";
import { TOKEN_ADDRESS, TOKEN_DECIMALS, TOKEN_LABEL } from "../../budget/tempo/lib/constants.mjs";
import { ONCE_NETWORKS } from "../../budget/once.mjs";

const homes: string[] = [];
const servers: Server[] = [];
afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});
const FAKE = EVM_NETWORKS.find((n) => n.key === "fake-eighteen")!;
const PAY_TO = `0x${"22".repeat(20)}`;

/** A seller on this computer that asks `amount` (atomic) on Fake Eighteen. */
async function seller(amount: string): Promise<string> {
  const body = { x402Version: 2, error: "payment required", resource: { url: "http://127.0.0.1/", description: "eighteen", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: FAKE.caip2, asset: FAKE.token.address, amount, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }] };
  const server = createServer((_req, res) => {
    res.writeHead(402, { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(body)).toString("base64") });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
}
const records = () => { const h = mkdtempSync(join(tmpdir(), "token-facts-")); homes.push(h); return new Records(h); };

describe("the chain table states every token fact", () => {
  it("builds an entry only when its token states address, symbol, decimals, domain and approveReset", () => {
    const build = (chain as unknown as { evmNetwork: (input: unknown) => EvmNetwork }).evmNetwork;
    const base = { key: "t", chainId: 1234, label: "T (testnet)", testnet: true, rpc: "https://rpc.example", explorer: "https://x.example", chainName: "T", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockSeconds: 2 };
    const token = { address: `0x${"ab".repeat(20)}`, symbol: "TKN", decimals: 18, domain: { name: "Token", version: "1" }, approveReset: true };
    const built = build({ ...base, token });
    expect(built.token).toEqual(token);
    expect(built.usdc).toEqual({ address: token.address, decimals: 18, eip712: token.domain });
    for (const [what, bad] of [
      ["decimals", { ...token, decimals: undefined }], ["decimals", { ...token, decimals: 6.5 }], ["decimals", { ...token, decimals: 78 }],
      ["EIP-712 domain", { ...token, domain: undefined }], ["EIP-712 domain", { ...token, domain: { name: "", version: "1" } }],
      ["approveReset", { ...token, approveReset: undefined }], ["approveReset", { ...token, approveReset: "false" }],
      ["address", { ...token, address: "0x12" }],
    ] as const) {
      expect(() => build({ ...base, token: bad }), `${what} ${JSON.stringify(bad)}`).toThrow(new RegExp(`^chain table: t: .*${what}`));
    }
  });

  it("has every shipped EVM entry state its facts once: the older usdc view is built from the token entry", () => {
    for (const n of EVM_NETWORKS.filter((x) => x.key !== "fake-eighteen")) {
      expect(n.token, n.key).toMatchObject({ decimals: 6, approveReset: false });
      expect(n.usdc, n.key).toEqual({ address: n.token.address, decimals: n.token.decimals, eip712: n.token.domain });
      expect((EVM_CHAINS as Record<string, any>)[n.key].token, n.key).toEqual(n.token);
    }
  });

  it("agrees with the budget's Tempo and Solana token facts (pin)", async () => {
    expect(TEMPO_MODERATO.token).toEqual({ symbol: TOKEN_LABEL, address: TOKEN_ADDRESS, decimals: TOKEN_DECIMALS });
    const solana = await import("../../budget/solana/lib.mjs");
    expect(SOLANA_DEVNET.token).toMatchObject({ address: solana.USDC_MINT.toBase58(), decimals: solana.USDC_DECIMALS });
    expect(ONCE_NETWORKS[SOLANA_DEVNET.caip2]).toMatchObject({ asset: SOLANA_DEVNET.token.address, decimals: SOLANA_DEVNET.token.decimals });
    expect(ONCE_NETWORKS[TEMPO_MODERATO.caip2]).toMatchObject({ asset: TEMPO_MODERATO.token.address, decimals: TEMPO_MODERATO.token.decimals });
  });

  it("has no default number of decimals for the rounding helpers", () => {
    expect(() => (toAtomic as (a: number) => string)(0.01)).toThrow(/not a number of decimals/);
    expect(() => (fromAtomic as (a: string) => number)("10000")).toThrow(/not a number of decimals/);
    expect(toAtomic(0.01, 18)).toBe("10000000000000000");
  });
});

describe("quote on a chain whose token has 18 decimals", () => {
  it("reads the amount at the token entry's decimals, and the cap check and the printed price agree", async () => {
    const q = await quote({ url: await seller("10000000000000000") }, { records: records(), policy: DEFAULT_POLICY });
    expect(q.terms).toMatchObject({ network: FAKE.caip2, amountAtomic: "10000000000000000", amountDecimal: 0.01 });
    expect(q.policy.allowed).toBe(true);
    expect(termsMoney(q.terms)).toBe("0.01 USDC");
  });

  it("prints a price below a millionth exactly, where six-place rounding shows 0", async () => {
    const q = await quote({ url: await seller("1") }, { records: records(), policy: DEFAULT_POLICY });
    expect(q.terms.amountDecimal).toBe(1e-18);
    expect(termsMoney(q.terms)).toBe("0.000000000000000001 USDC");
    expect(money(q.terms.amountDecimal, q.terms.asset)).toBe("0 USDC");
    expect(messageFor({ id: "a1", state: "awaiting_approval", terms: q.terms } as never)).toContain("approve 0.000000000000000001 USDC");
  });

  it("refuses a price above the per-call cap at 18 decimals (adversarial: 0.06 written in 18-decimal units)", async () => {
    const q = await quote({ url: await seller("60000000000000000") }, { records: records(), policy: DEFAULT_POLICY });
    expect(q.terms.amountDecimal).toBe(0.06);
    expect(q.policy.allowed).toBe(false);
  });
});

describe("terms on a chain the table does not name", () => {
  it("give no amount, so a cap refuses instead of reading them at six decimals", async () => {
    expect(policyAmount({ amountAtomic: "10000", network: "eip155:1" })).toEqual({});
    expect(policyAmount({ amountAtomic: "10000", network: "eip155:999018" })).toEqual({ amountAtomic: 10000n, decimals: 18 });
  });

  it("make today's total unknown when a stored receipt names one, so quote refuses the cap", async () => {
    const store = records();
    const terms = { network: "eip155:1", asset: "USDC", amountAtomic: "10000", payTo: PAY_TO };
    store.saveReceipt({ id: "r1", attemptId: "r1", quoteId: "q1", at: new Date().toISOString(), url: "http://127.0.0.1/", terms, payer: `0x${"11".repeat(20)}`, transaction: `0x${"cd".repeat(32)}`, transactionKind: "hash", transactionUrl: "", network: "eip155:1", settlement: { success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:1" }, chain: "verified", serviceOutcome: "ok", ms: 0 } as never);
    expect(store.spentTodayAtomic("USDC")).toBeUndefined();
    const q = await quote({ url: await seller("10000000000000000") }, { records: store, policy: DEFAULT_POLICY });
    expect(q.policy.allowed).toBe(false);
    expect(q.policy.reason).toMatch(/today's spending is unknown/);
  });
});
