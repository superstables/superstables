// Real sellers, real testnets. Unpaid preflight runs with SUPERSTABLES_LIVE=1.
// Payments additionally require an explicit, dedicated home per rail; see README.md.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair } from "@solana/web3.js";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const live = process.env.SUPERSTABLES_LIVE === "1";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const sellers = [
  {
    rail: "tempo", chain: "moderato", homeEnv: "SUPERSTABLES_LIVE_TEMPO_HOME",
    url: "https://mpp.quicknode.com/tempo-testnet", price: "0.001",
    payTo: "0xFD24114C3981Aba78aE2441991B1BdB89329c556",
    request: ["--method", "POST", "--body", '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'],
  },
  {
    rail: "solana", chain: "devnet", homeEnv: "SUPERSTABLES_LIVE_SOLANA_HOME",
    url: "https://api.urbangametheory.xyz/agent/oracle/facts", price: "0.01",
    payTo: "AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ", request: [],
  },
] as const;
type Seller = typeof sellers[number];
interface Result {
  state: string;
  paid?: boolean;
  delivered?: boolean;
  amount: string | number | null;
  remaining?: string | null;
  owner?: string;
  revoked?: boolean;
  expired?: boolean;
  refillsAt?: string | null;
  payTo?: string;
  offer?: { token: string; network: string; feePayer: boolean };
  tx?: { settle?: string };
  reason?: string;
  responseFile?: string;
}

function cli(seller: Seller, home: string, command: string, args: string[] = []) {
  return new Promise<{ code: number; result: Result; diagnostic: string }>((resolve, reject) => {
    execFile(process.execPath, [join(ROOT, "budget/cli.mjs"), command, "--rail", seller.rail,
      "--chain", seller.chain, "--json", ...args], {
      cwd: ROOT, env: { ...process.env, SUPERSTABLES_HOME: home },
      timeout: 180_000, killSignal: "SIGTERM", maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== "number")) {
        reject(new Error(`${command} interrupted; inspect the operation journal before another buy. ${stderr}`));
        return;
      }
      try {
        resolve({ code: error ? Number(error.code) : 0, result: JSON.parse(stdout), diagnostic: `${stdout}\n${stderr}` });
      } catch {
        reject(new Error(`${command} did not return JSON: ${stdout}\n${stderr}`));
      }
    });
  });
}

const units = (value: string | number | null | undefined) => {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value));
  expect(match, `invalid six-decimal amount ${value}`).not.toBeNull();
  return BigInt(match![1]) * 1_000_000n + BigInt((match![2] ?? "").padEnd(6, "0"));
};
const journal = (s: Seller, home: string, op: string) => join(home, "budget/ops", `${s.rail}-${s.chain}`, `${op}.json`);

async function tempoRead(method: string, params: unknown[]) {
  const response = await fetch("https://rpc.moderato.tempo.xyz", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000),
  });
  expect(response.ok).toBe(true);
  const body = await response.json();
  expect(body.error).toBeUndefined();
  return body.result;
}

// Read the public RPC independently of the CLI's settlement/reconciliation code.
async function verifyTransfer(s: Seller, tx: string, op: string, record: any) {
  if (s.rail === "tempo") {
    expect(BigInt(await tempoRead("eth_chainId", []))).toBe(42431n);
    const receipt = await tempoRead("eth_getTransactionReceipt", [tx]);
    expect(receipt?.status).toBe("0x1");
    expect(receipt.transactionHash.toLowerCase()).toBe(tx.toLowerCase());
    const movement = receipt.logs.find((log: any) =>
      log.address.toLowerCase() === PATH_USD && log.topics[0] === TRANSFER &&
      `0x${log.topics[1]?.slice(-40)}`.toLowerCase() === record.intent.owner.toLowerCase() &&
      `0x${log.topics[2]?.slice(-40)}`.toLowerCase() === s.payTo.toLowerCase());
    expect(movement, "owner-to-seller pathUSD Transfer").toBeDefined();
    expect(BigInt(movement.data)).toBe(units(s.price));
    expect(receipt.logs.some((log: any) => log.address.toLowerCase() === PATH_USD &&
      log.topics[3]?.toLowerCase() === record.memo?.toLowerCase())).toBe(true);
    const transaction = await tempoRead("eth_getTransactionByHash", [tx]);
    expect(transaction.signature?.keyId?.toLowerCase()).toBe(record.intent.agent.toLowerCase());
  } else {
    const conn = new Connection("https://api.devnet.solana.com", "confirmed");
    let transaction = await conn.getParsedTransaction(tx, { maxSupportedTransactionVersion: 0 });
    for (let i = 0; !transaction && i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      transaction = await conn.getParsedTransaction(tx, { maxSupportedTransactionVersion: 0 });
    }
    expect(transaction, "confirmed Solana transaction").not.toBeNull();
    expect(transaction!.meta?.err).toBeNull();
    const message = transaction!.transaction.message;
    expect(message.accountKeys.some((key) => key.signer && key.pubkey.toBase58() === record.agent)).toBe(true);
    const instructions = message.instructions.filter((ix) => "parsed" in ix).map((ix: any) => ix.parsed);
    expect(instructions).toContain(`rb:${op}`);
    expect(instructions).toContainEqual(expect.objectContaining({ type: "transferChecked", info: expect.objectContaining({
      source: record.ownerAta, destination: record.sellerAta, authority: record.agent, mint: USDC_MINT,
      tokenAmount: expect.objectContaining({ amount: units(s.price).toString(), decimals: 6 }),
    }) }));
    const balance = (balances: any[], ata: string) => balances.find((b) =>
      message.accountKeys[b.accountIndex].pubkey.toBase58() === ata && b.mint === USDC_MINT)?.uiTokenAmount.amount ?? "0";
    const meta = transaction!.meta!;
    expect(BigInt(balance(meta.preTokenBalances ?? [], record.ownerAta)) -
      BigInt(balance(meta.postTokenBalances ?? [], record.ownerAta))).toBe(units(s.price));
    expect(BigInt(balance(meta.postTokenBalances ?? [], record.sellerAta)) -
      BigInt(balance(meta.preTokenBalances ?? [], record.sellerAta))).toBe(units(s.price));
  }
}

describe.skipIf(!live).each(sellers)("$rail live seller", (seller) => {
  // This home has no keys. Preflight must work before setup, without touching any wallet.
  let emptyHome: string;
  afterAll(() => { if (emptyHome) rmSync(emptyHome, { recursive: true, force: true }); });

  it("reads the pinned testnet price and recipient without a wallet", async () => {
    emptyHome = mkdtempSync(join(tmpdir(), `superstables-live-${seller.rail}-`));
    const run = await cli(seller, emptyHome, "preflight", ["--url", seller.url, ...seller.request]);
    expect(run.code, run.diagnostic).toBe(0);
    expect(run.result.state).toBe("ok");
    expect(units(run.result.amount)).toBe(units(seller.price));
    expect(run.result.payTo).toBe(seller.payTo);
    expect(run.result.offer?.token).toBe(seller.rail === "tempo" ? "pathUSD" : "USDC");
    expect(run.result.offer?.network).toBe(seller.rail === "tempo" ? "tempo-moderato" : "solana-devnet");
    expect(existsSync(join(emptyHome, "keys"))).toBe(false);
  }, 180_000);

  it.skipIf(!process.env[seller.homeEnv]?.trim())("refuses bad terms, settles once, and reconciles without a second debit", async () => {
    const home = process.env[seller.homeEnv]!.trim();
    expect(isAbsolute(home), `${seller.homeEnv} must be an absolute path to a dedicated test home`).toBe(true);
    expect(existsSync(join(home, "keys/budget", `${seller.rail}-agent.env`)), "set up the dedicated agent first").toBe(true);
    const ops = join(home, "budget/ops", `${seller.rail}-${seller.chain}`);
    if (existsSync(ops)) {
      for (const name of readdirSync(ops).filter((name) => name.startsWith("live-") && name.endsWith(".json"))) {
        const previous = JSON.parse(readFileSync(join(ops, name), "utf8"));
        expect(["submitted", "unknown"].includes(previous.state),
          `Reconcile ${name.slice(0, -5)} before another purchase: superstables budget reconcile --rail ${seller.rail} --op ${name.slice(0, -5)}`).toBe(false);
      }
    }
    // Exercise the entire accepted Solana id length: the memo's cost grows with it.
    // This regresses the former 20,000-CU cap, which failed even with a UUID id.
    const id = seller.rail === "solana" ? `live-solana-${randomUUID()}`.padEnd(64, "x") : `live-tempo-${randomUUID()}`;
    console.log(`${seller.rail}: home ${home}; purchase op ${id}. Journals are retained; never retry an uncertain purchase with a new id.`);
    const request = ["--url", seller.url, ...seller.request];
    const quote = await cli(seller, home, "preflight", request);
    expect(quote.code, quote.diagnostic).toBe(0);
    expect(units(quote.result.amount)).toBe(units(seller.price));
    expect(quote.result.payTo).toBe(seller.payTo);
    // Exact remaining-budget checks below assume the seller sponsors Tempo's fees.
    if (seller.rail === "tempo") expect(quote.result.offer?.feePayer).toBe(true);
    const before = await cli(seller, home, "status");
    expect(before.code, before.diagnostic).toBe(0);
    expect(before.result.revoked).toBe(false);
    expect(before.result.expired ?? false).toBe(false);
    expect(before.result.refillsAt ?? null, "use a one-time budget, without period refills").toBeNull();
    expect(units(before.result.remaining)).toBeGreaterThanOrEqual(units(seller.price));

    for (const [suffix, max, payTo, reason] of [
      ["price", "0.000001", seller.payTo, /(?:exceeds|above) --max/],
      ["recipient", seller.price, seller.rail === "tempo" ? "0x1111111111111111111111111111111111111111" : Keypair.generate().publicKey.toBase58(), /recipient/],
    ] as const) {
      const refused = await cli(seller, home, "buy", [...request, "--max", max, "--pay-to", payTo, "--op", `${id.slice(0, 48)}-${suffix}`]);
      expect(refused.code, refused.diagnostic).toBe(3);
      expect(refused.result).toMatchObject({ state: "refused_precheck", paid: false, amount: "0", tx: {} });
      expect(refused.result.reason).toMatch(reason);
    }
    const unchanged = await cli(seller, home, "status");
    expect(unchanged.code, unchanged.diagnostic).toBe(0);
    expect(units(unchanged.result.remaining)).toBe(units(before.result.remaining));

    const buy = [...request, "--max", seller.price, "--pay-to", seller.payTo, "--op", id];
    const paid = await cli(seller, home, "buy", buy);
    expect(paid.code, paid.diagnostic).toBe(0);
    expect(paid.result).toMatchObject({ state: "settled", paid: true, delivered: true });
    expect(units(paid.result.amount)).toBe(units(seller.price));
    const tx = paid.result.tx?.settle;
    expect(tx).toMatch(seller.rail === "tempo" ? /^0x[0-9a-fA-F]{64}$/ : /^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    console.log(`${seller.rail}: settled ${id}, tx ${tx}`);
    expect(paid.result.responseFile).toBeDefined();
    const response = JSON.parse(readFileSync(paid.result.responseFile!, "utf8"));
    if (seller.rail === "tempo") expect(BigInt(response.result)).toBe(42431n);
    else expect(response).toBeTruthy();
    const record = JSON.parse(readFileSync(journal(seller, home, id), "utf8"));
    expect(record.state).toBe("settled");
    expect(record.tx).toBe(tx);
    const publicState = readFileSync(join(home, "budget/public", `${seller.rail}-${seller.chain}.env`), "utf8");
    const agent = new RegExp(`^${seller.rail === "tempo" ? "AGENT_ADDRESS" : "SOLANA_AGENT_ADDRESS"}=(.+)$`, "m").exec(publicState)?.[1].trim();
    expect(agent, "primary agent in the dedicated home's public state").toBeDefined();
    if (seller.rail === "tempo") {
      expect(record.intent.owner.toLowerCase()).toBe(before.result.owner!.toLowerCase());
      expect(record.intent.agent.toLowerCase()).toBe(agent!.toLowerCase());
      expect(record.intent.recipient.toLowerCase()).toBe(seller.payTo.toLowerCase());
    } else {
      expect(record.owner).toBe(before.result.owner);
      expect(record.agent).toBe(agent);
      expect(record.payTo).toBe(seller.payTo);
    }
    await verifyTransfer(seller, tx!, id, record);

    const after = await cli(seller, home, "status");
    expect(after.code, after.diagnostic).toBe(0);
    expect(units(before.result.remaining) - units(after.result.remaining)).toBe(units(seller.price));
    const replay = await cli(seller, home, "buy", buy);
    expect(replay.code, replay.diagnostic).toBe(3);
    expect(replay.result.reason).toBe("op_already_settled");
    expect(replay.result.tx?.settle).toBe(tx);
    const reconciled = await cli(seller, home, "reconcile", ["--op", id]);
    expect(reconciled.code, reconciled.diagnostic).toBe(0);
    expect(reconciled.result).toMatchObject({ state: "settled", paid: true, delivered: true, tx: { settle: tx } });
    expect(units(reconciled.result.amount)).toBe(units(seller.price));
    const final = await cli(seller, home, "status");
    expect(final.code, final.diagnostic).toBe(0);
    expect(units(final.result.remaining)).toBe(units(after.result.remaining));
  }, 600_000);
});
