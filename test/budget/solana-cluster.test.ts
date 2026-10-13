// Solana budget commands on an RPC that is not on Solana devnet: each is refused before a blockhash is fetched, a
// transaction is offered, signed or sent, or a delegate is read. The real dispatcher and rail scripts against a fake RPC
// on 127.0.0.1 that answers another cluster's genesis hash. No network, no real key.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeSolana, type FakeSolana } from "../helpers/fake-chains.js";
import { startFakeSite, type FakeSite } from "../helpers/fake-site.js";
import { MAINNET_GENESIS, randomAddress } from "../helpers/fake-solana-pay.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const kp = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const agentKp = kp(3);
const ownerA = kp(4);
const ownerB = kp(6);
const agent = agentKp.publicKey.toBase58();

let home: string;
let solana: FakeSolana;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-solana-cluster-"));
  solana = await startFakeSolana();
});
afterEach(async () => {
  await solana.close();
  rmSync(home, { recursive: true, force: true });
});

type Out = { code: number; stdout: string; stderr: string; result: any };
function budget(args: string[]): Promise<Out> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_SOLANA_RPC: solana.url };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 0, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}
const write = (path: string, text: string, mode = 0o600) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, { mode });
};
const files = () => ({
  agentFile: join(home, "keys", "budget", "solana-agent.env"),
  publicFile: join(home, "budget", "public", "solana-devnet.env"),
});
const ownerKey = (which: "A" | "B") => {
  const path = join(home, `owner-${which}.env`);
  write(path, `SOLANA_OWNER_SECRET_BASE58=${bs58.encode((which === "A" ? ownerA : ownerB).secretKey)}\n`);
  return path;
};
/** The agent key file bound to A, and the public file recording A, with A's budget live and both accounts funded. */
function recordOwnerA() {
  const f = files();
  write(f.agentFile, `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(agentKp.secretKey)}\nSOLANA_AGENT_ADDRESS=${agent}\nSOLANA_OWNER_ADDRESS=${ownerA.publicKey.toBase58()}\n`);
  write(f.publicFile, `SOLANA_OWNER_ADDRESS=${ownerA.publicKey.toBase58()}\nSOLANA_AGENT_ADDRESS=${agent}\n`, 0o644);
  solana.usdc.set(ownerA.publicKey.toBase58(), { amount: 5_000_000n, delegate: agent, delegated: 500_000n });
  solana.balances.set(ownerA.publicKey.toBase58(), 1_000_000_000n);
  solana.balances.set(agent, 100_000_000n);
}
const publicText = () => readFileSync(files().publicFile, "utf8");

/** What no case may show: a blockhash fetched, a transaction sent, or a result that says something happened. */
function expectNothingHappened(out: Out) {
  expect(solana.calls).not.toContain("getLatestBlockhash");
  expect(solana.calls).not.toContain("sendTransaction");
  expect(out.stdout).not.toMatch(/^APPROVE /m);
  expect(["ok", "settled", "revoked"]).not.toContain(out.result?.state);
  expect(out.result?.ok).not.toBe(true);
}

describe("a Solana RPC on another cluster", () => {
  beforeEach(() => {
    solana.genesis = MAINNET_GENESIS;
  });

  it("fund-agent, approved in the owner's wallet: refused before the approval page is offered", async () => {
    recordOwnerA();
    const out = await budget(["fund-agent", "--rail", "solana", "--no-open"]);
    expect(out.code, out.stdout + out.stderr).toBe(3);
    expect(out.result).toMatchObject({ command: "fund-agent", state: "refused_precheck" });
    expect(out.result.reason).toMatch(/not on Solana devnet/);
    expectNothingHappened(out);
    expect(solana.calls.filter((c) => c !== "getGenesisHash")).toEqual([]);
  }, 60_000);

  it("fund-agent with an owner key file: refused before it signs", async () => {
    recordOwnerA();
    const out = await budget(["fund-agent", "--rail", "solana", "--owner-key-file", ownerKey("A"), "--yes"]);
    expect(out.code, out.stdout + out.stderr).toBe(3);
    expect(out.result.state).toBe("refused_precheck");
    expectNothingHappened(out);
  }, 60_000);

  it("grant with an owner key file: refused, nothing sent", async () => {
    recordOwnerA();
    const out = await budget(["grant", "--rail", "solana", "--amount", "0.01", "--owner-key-file", ownerKey("A"), "--yes"]);
    expect(out.code, out.stdout + out.stderr).toBe(3);
    expect(out.result.state).toBe("refused_precheck");
    expect(out.result.reason).toMatch(/not on Solana devnet/);
    expectNothingHappened(out);
  }, 60_000);

  it("revoke with an owner key file: never revoked, and never 'nothing to revoke'", async () => {
    recordOwnerA();
    // like a real mainnet RPC, the fake shows no delegate: only the cluster check stops the "already revoked" answer
    solana.usdc.set(ownerA.publicKey.toBase58(), { amount: 5_000_000n, delegate: null, delegated: 0n });
    const out = await budget(["revoke", "--rail", "solana", "--owner-key-file", ownerKey("A"), "--yes"]);
    expect(out.code, out.stdout + out.stderr).toBe(3);
    expect(out.result.state).toBe("refused_precheck");
    expect(out.stdout + out.stderr).not.toMatch(/already revoked|nothing to (send|revoke)/i);
    expectNothingHappened(out);
  }, 60_000);

  it("setup --new-owner: refused, and the public file is unchanged", async () => {
    recordOwnerA();
    const before = publicText();
    const out = await budget(["setup", "--rail", "solana", "--new-owner", "--owner-key-file", ownerKey("B")]);
    expect(out.code, out.stdout + out.stderr).toBe(3);
    expect(out.result).toMatchObject({ state: "refused_precheck" });
    expect(out.result.reason).toMatch(/not on Solana devnet/);
    expect(publicText()).toBe(before);
    expectNothingHappened(out);
  }, 60_000);

  it("an RPC that cannot say which cluster it is on is refused too", async () => {
    recordOwnerA();
    solana.genesis = null;
    const out = await budget(["fund-agent", "--rail", "solana", "--owner-key-file", ownerKey("A"), "--yes"]);
    expect(out.code, out.stdout + out.stderr).toBe(3);
    expect(out.result.state).toBe("refused_precheck");
    expect(out.result.reason).toMatch(/could not read which Solana cluster/);
    expectNothingHappened(out);
  }, 60_000);

  for (const flags of [["--grant", "0.05", "--fund"], ["--fund"], ["--grant", "0.05"]]) {
    it(`setup --hosted ${flags.join(" ")}: refused before the site is asked`, async () => {
      const site: FakeSite = await startFakeSite();
      try {
        write(files().agentFile, `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(agentKp.secretKey)}\nSOLANA_AGENT_ADDRESS=${agent}\n`);
        const out = await budget(["setup", "--rail", "solana", "--hosted", "--site", site.url, ...flags]);
        expect(out.code, out.stdout + out.stderr).toBe(3);
        expect(out.result.state).toBe("refused_precheck");
        expect(out.result.reason).toMatch(/not on Solana devnet/);
        expect(site.requests).toEqual([]);
        expectNothingHappened(out);
      } finally {
        await site.close();
      }
    }, 60_000);
  }

  it("buy: refused before the agent key is signed with, and the journal holds no signature", async () => {
    recordOwnerA();
    const payTo = randomAddress();
    let seller: Server | undefined;
    try {
      seller = createServer((req, res) => {
        const url = `http://127.0.0.1:${(seller!.address() as AddressInfo).port}/`;
        const body = { x402Version: 2, resource: { url }, accepts: [{ scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: USDC, amount: "10000", payTo, maxTimeoutSeconds: 60, extra: {} }] };
        res.writeHead(402, { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(body)).toString("base64") });
        res.end(JSON.stringify(body));
      });
      await new Promise<void>((ok) => seller!.listen(0, "127.0.0.1", ok));
      const url = `http://127.0.0.1:${(seller.address() as AddressInfo).port}/`;
      const out = await budget(["buy", "--rail", "solana", "--url", url, "--max", "0.01", "--op", "c1"]);
      expect(out.code, out.stdout + out.stderr).toBe(3);
      expect(out.result.state).toBe("refused_precheck");
      expect(out.result.reason).toMatch(/not on Solana devnet/);
      expectNothingHappened(out);
      const journal = join(home, "budget", "ops", "solana-devnet", "c1.json");
      expect(existsSync(journal)).toBe(true);
      expect(readFileSync(journal, "utf8")).not.toContain("agentSig");
    } finally {
      seller?.close();
    }
  }, 60_000);
});

describe("control: the same commands on devnet", () => {
  it("fund-agent with an owner key file reaches the send", async () => {
    recordOwnerA();
    // the fake has no websocket to confirm on, so the command waits there: stop it once the transfer has been sent
    const child = spawn(process.execPath, [CLI, "fund-agent", "--rail", "solana", "--owner-key-file", ownerKey("A"), "--yes"], {
      cwd: ROOT,
      env: { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_SOLANA_RPC: solana.url },
      stdio: "ignore",
    });
    try {
      for (let i = 0; i < 300 && !solana.calls.includes("sendTransaction"); i++) await new Promise((r) => setTimeout(r, 100));
    } finally {
      child.kill("SIGKILL");
    }
    expect(solana.calls).toContain("getGenesisHash");
    expect(solana.calls).toContain("getLatestBlockhash");
    expect(solana.calls).toContain("sendTransaction");
  }, 60_000);

  it("fund-agent in the owner's wallet offers the approval page", async () => {
    recordOwnerA();
    const out = await budget(["fund-agent", "--rail", "solana", "--no-open", "--timeout", "10"]);
    expect(out.stdout).toMatch(/^APPROVE /m);
    expect(solana.calls).toContain("getGenesisHash");
  }, 60_000);
});
