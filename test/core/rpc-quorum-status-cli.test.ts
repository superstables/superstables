// `superstables status <id> --json` as a process, reading the production code's endpoint table (a copy that names loopback
// fakes): a primary that lies is contradicted by an honest confirmer, an RPC named only in the environment never decides, and
// agreeing operators release the payment with the agreement in the JSON. No payment code is told which RPC to trust.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { encodeFunctionResult } from "viem";
import { BASE_SEPOLIA } from "../../src/core/chain.js";
import { Records } from "../../src/core/records.js";
import type { Attempt } from "../../src/core/types.js";
import { endpointTree } from "../helpers/endpoint-tree.js";
import { startFakeBaseSepolia, type FakeBaseSepolia } from "../helpers/fake-base-sepolia.js";
import { accountHomeWith } from "../helpers/owner-settings.js";
import type { TestServer } from "../helpers/servers.js";

const PAYER = `0x${"11".repeat(20)}`;
const RECIPIENT = `0x${"22".repeat(20)}`;
const NONCE = `0x${"44".repeat(32)}`;
const UNUSED = encodeFunctionResult({ abi: [{ type: "function", name: "authorizationState", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }], functionName: "authorizationState", result: false });
const tree = endpointTree();
const homes: string[] = [];
const opened: TestServer[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});
afterAll(() => {
  tree.close();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const chain = async (): Promise<FakeBaseSepolia> => {
  const c = await startFakeBaseSepolia();
  opened.push(c);
  return c;
};
const mirror = async (c: FakeBaseSepolia, lie?: Parameters<FakeBaseSepolia["mirror"]>[0]) => {
  const m = await c.mirror(lie);
  opened.push(m);
  return m;
};

/** An expired, uncertain attempt in a fresh home. */
function home(c: FakeBaseSepolia): string {
  const dir = mkdtempSync(join(tmpdir(), "ss-quorum-cli-"));
  homes.push(dir);
  const r = new Records(join(dir, "records"));
  const at = new Date().toISOString();
  const attempt: Attempt = {
    id: "a", quoteId: "q", createdAt: at, updatedAt: at, state: "uncertain", url: "https://seller.example/x",
    terms: { network: BASE_SEPOLIA.caip2, networkLabel: BASE_SEPOLIA.label, asset: "USDC", assetAddress: BASE_SEPOLIA.usdc.address, amountAtomic: "10000", amountDecimal: 0.01, recipient: RECIPIENT, scheme: "exact" },
    payer: PAYER, authorizationNonce: NONCE, authorizationValidBefore: new Date((c.head.timestamp - 3_600) * 1000).toISOString(),
    history: [{ at, state: "approved" }, { at, state: "uncertain" }],
  };
  r.saveAttempt(attempt);
  return dir;
}

function status(dir: string, env: Record<string, string> = {}): Promise<{ code: number; body: any }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(tree.root, "src/cli/main.ts"), "status", "a", "--json"], {
      cwd: tree.root,
      env: { ...process.env, SUPERSTABLES_HOME: dir, SUPERSTABLES_DOCTOR_OFFLINE: "1", ...env } as NodeJS.ProcessEnv,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.once("error", fail);
    child.once("close", (code) => done({ code: code ?? 0, body: JSON.parse(out) }));
  });
}

describe("superstables status reads the endpoint table, not one RPC", () => {
  it("a lying first endpoint is contradicted by the second: uncertain, told not to pay again", async () => {
    const honest = await chain();
    honest.settle({ from: PAYER, to: RECIPIENT, value: "10000", nonce: NONCE });
    const lying = await mirror(honest, (m) => (m === "eth_call" ? UNUSED : undefined));
    tree.set({ "base-sepolia": [lying.url, honest.url] });
    const r = await status(home(honest), { SUPERSTABLES_RPC_URL: "" });
    expect(r.body).toMatchObject({ state: "uncertain", chain_reason: expect.stringMatching(/the RPC endpoints disagree/), next: expect.stringMatching(/^Do not pay again/) });
    expect(r.body.chain).not.toBe("unpaid");
    expect(r.code).not.toBe(1);
  }, 60_000);

  it("two honest operators release it, and the JSON says how it was agreed", async () => {
    const a = await chain();
    const b = await mirror(a);
    tree.set({ "base-sepolia": [a.url, b.url] });
    const r = await status(home(a), { SUPERSTABLES_RPC_URL: "" });
    expect(r).toMatchObject({ code: 1, body: { state: "failed", chain: "unpaid", chain_agreement: "quorum", chain_agreed_at: { operators: ["fake-a", "fake-b"] } } });
    expect(r.body.chain_agreed_at.block_hash).toMatch(/^0x[0-9a-f]{64}$/);
  }, 60_000);

  for (const [name, accountHome] of [["production defaults (loopback RPCs refused)", accountHomeWith(null)], ["the default test account (loopback RPCs allowed)", undefined]] as const) {
    it(`an RPC variable naming a lying endpoint does not decide, ${name}`, async () => {
      const honest = await chain();
      honest.settle({ from: PAYER, to: RECIPIENT, value: "10000", nonce: NONCE });
      const lying = await mirror(honest, (m) => (m === "eth_call" ? UNUSED : undefined));
      tree.set({ "base-sepolia": [honest.url, (await mirror(honest)).url] });
      const r = await status(home(honest), { SUPERSTABLES_RPC_URL: lying.url, ...(accountHome ? { SUPERSTABLES_TEST_ACCOUNT_HOME: accountHome } : {}) });
      expect(r.body.state).toBe("uncertain");
      expect(r.body.chain).not.toBe("unpaid");
      expect(r.body.chain_reason).toMatch(accountHome ? /SUPERSTABLES_RPC_URL.*unset the variable/ : /the RPC endpoints disagree/);
    }, 60_000);
  }
});
