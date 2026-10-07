// superstables budget used from its own output: a buy with no setup is a refusal that says what is missing and who runs
// what next, status says there is no budget first, every help says what the command does, and scripts get one RESULT
// and a final flag. Nothing here reaches a chain: the sellers are local, and a buy with no setup ends before its rail.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(REPO, "budget", "cli.mjs");

let home: string;

beforeEach(() => {
  // A path can contain the internal prefix without the guidance exposing internal variable names.
  home = mkdtempSync(join(tmpdir(), "superstables-budget-guidance-B4-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  result: Record<string, any>;
}

/** The budget CLI with a fresh home. stdout is a pipe, as it is for an agent's tool. */
function budget(args: string[]): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      // B4_RPC on this computer, where nothing listens: these commands stop before any chain is needed, and the ones
      // that look anyway get no answer instead of reaching Base Sepolia.
      env: { ...process.env, SUPERSTABLES_HOME: home, DISPLAY: "", B4_RPC: "http://127.0.0.1:9/" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", fail);
    child.once("close", (code) => {
      const last = stdout.trimEnd().split("\n").pop() ?? "";
      done({ code: code ?? 1, stdout, stderr, result: last.startsWith("RESULT {") ? JSON.parse(last.slice(7)) : {} });
    });
  });
}

const owners = { evm: "setup --rail evm", tempo: "setup --rail tempo", solana: "setup --rail solana" } as const;

describe("a buy with no budget set up here", () => {
  for (const rail of ["evm", "tempo", "solana"] as const) {
    it(`is refused on ${rail} before anything is signed, and names the owner's commands`, async () => {
      const r = await budget(["buy", "--rail", rail, "--url", "http://127.0.0.1:9/paid", "--max", "0.02"]);
      expect(r.code).toBe(3);
      expect(r.result).toMatchObject({ ok: false, command: "buy", rail, state: "refused_precheck", final: true, paid: false, delivered: false, amount: "0", tx: {} });
      expect(r.result.reason).toMatch(/^no budget has been set up here for /);
      expect(r.result.reason).toContain("Nothing was signed or paid");
      expect(r.result.next).toContain(`superstables budget ${owners[rail]}`);
      expect(r.result.next).toContain(`superstables budget grant --rail ${rail}`);
      expect(r.result.next).not.toMatch(/reconcile/);
      // no op id was made up, and nothing that looks like a purchase was written: no journal, no lock
      expect(r.result.op).toBeUndefined();
      expect(existsSync(join(home, "budget", "ops"))).toBe(false);
      expect(r.stdout.trim().split("\n")).toHaveLength(1);
    });
  }

  it("says what is still missing when setup stopped halfway (an agent key, no owner yet)", async () => {
    mkdirSync(join(home, "keys", "budget"), { recursive: true });
    writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=0x${"11".repeat(32)}\n`, { mode: 0o600 });
    const r = await budget(["buy", "--rail", "evm", "--chain", "arc-testnet", "--url", "http://127.0.0.1:9/paid", "--max", "0.02", "--op", "half-1"]);
    expect(r.code).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", op: "half-1", paid: false, amount: "0" });
    expect(r.result.reason).toContain("no owner has connected a wallet");
    expect(r.result.reason).not.toContain("no agent key");
    expect(r.result.next).toContain("superstables budget setup --rail evm --chain arc-testnet");
  });

  it("is a refusal, not an unknown, when the rail stops before it records a purchase", async () => {
    // setup files that pass the dispatcher's check, with an agent key the rail cannot load: it exits before any journal
    mkdirSync(join(home, "keys", "budget"), { recursive: true });
    mkdirSync(join(home, "budget", "public"), { recursive: true });
    writeFileSync(join(home, "keys", "budget", "evm-agent.env"), "B4_AGENT_KEY=not-a-key\n", { mode: 0o600 });
    writeFileSync(join(home, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=0x${"22".repeat(20)}\nB4_AGENT_ADDRESS=0x${"33".repeat(20)}\n`);
    const r = await budget(["buy", "--rail", "evm", "--url", "http://127.0.0.1:9/paid", "--max", "0.02", "--op", "broken-key"]);
    expect(r.code).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", op: "broken-key", paid: false, amount: "0" });
    expect(r.result.reason).toMatch(/stopped before it recorded a purchase: .*private key/);
    expect(existsSync(join(home, "budget", "ops", "evm-base-sepolia", "broken-key.json"))).toBe(false);
    expect(readdirSync(join(home, "budget", "ops", "evm-base-sepolia"))).toEqual([]); // the lock is gone too
  }, 60_000);
});

describe("status with no budget set up here", () => {
  it("says so first, with the owner's next commands", async () => {
    const r = await budget(["status", "--rail", "evm"]);
    expect(r.code).toBe(1);
    expect(r.stderr.split("\n")[0]).toContain("no budget has been set up here for evm on base-sepolia");
    expect(r.result.reason).toBe("no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet");
    expect(r.result.next).toContain("superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A");
    expect(`${r.stderr}${r.stdout}`.replaceAll(home, "<home>")).not.toMatch(/B4/);
  });

  const hosted = {
    evm: "superstables budget setup --rail evm --chain arc-testnet --hosted --grant A --fund",
    tempo: "superstables budget setup --rail tempo --hosted --grant A",
    solana: "superstables budget setup --rail solana --hosted --grant A --fund",
  } as const;
  for (const rail of ["evm", "tempo", "solana"] as const) {
    it(`offers the one-link set-up on superstables.com on ${rail} when no owner is on record`, async () => {
      const r = await budget(["status", "--rail", rail, ...(rail === "evm" ? ["--chain", "arc-testnet"] : [])]);
      expect(r.result.next).toContain(`; or, with one approval link on superstables.com (the owner needs an account there): ${hosted[rail]}.`);
      expect(r.stderr).toContain(hosted[rail]);
    });
  }

  it("names only the steps on this machine once an owner is on record", async () => {
    mkdirSync(join(home, "budget", "public"), { recursive: true });
    writeFileSync(join(home, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=0x${"22".repeat(20)}\n`);
    const r = await budget(["status", "--rail", "evm"]);
    expect(r.result.reason).toBe("no budget has been set up here for evm on base-sepolia: no agent key on this machine");
    expect(r.result.next).toContain("superstables budget setup --rail evm, superstables budget fund-agent --rail evm");
    expect(r.result.next).not.toContain("--hosted");
  });

  it("names the home it checked, and says to ask the user for the path when the budget is elsewhere", async () => {
    const r = await budget(["status", "--rail", "evm"]);
    expect(r.result.home).toBe(home);
    expect(r.stderr).toContain(`Checked the home ${home} (SUPERSTABLES_HOME), chain base-sepolia.`);
    expect(r.stderr).toContain("If the budget is elsewhere, ask the user for the path");
    expect(r.result.next).toContain(`no budget yet in ${home}`);
    expect(r.result.next).toContain("do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included");
  });
});

/** A seller on loopback that answers every request with a 402 carrying `headers` (and `body`). */
async function seller402(headers: Record<string, string>, body = "{}"): Promise<{ url: string; close: () => void; seen: { method?: string; body: string }[] }> {
  const seen: { method?: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += String(c)));
    req.on("end", () => {
      seen.push({ method: req.method, body: b });
      res.writeHead(402, { "content-type": "application/json", ...headers }).end(body);
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/paid`, close: () => server.close(), seen };
}
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tempoChallenge = (request: Record<string, unknown>) => `Payment id="c1", realm="seller.example", method="tempo", intent="charge", request="${b64url(request)}"`;
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const TEMPO_SELLER = "0xFD24114C3981Aba78aE2441991B1BdB89329c556";

describe("preflight on tempo and solana", () => {
  it("prints a tempo seller's price and payee on Moderato with no setup, signing nothing, and the buy command with its method and body", async () => {
    const s = await seller402({ "www-authenticate": [tempoChallenge({ amount: "1000", currency: PATH_USD, recipient: TEMPO_SELLER, methodDetails: { chainId: 4217 } }), tempoChallenge({ amount: "1000", currency: PATH_USD, recipient: TEMPO_SELLER, methodDetails: { chainId: 42431, feePayer: true } })].join(", ") });
    try {
      const r = await budget(["preflight", "--rail", "tempo", "--url", s.url, "--method", "POST", "--body", '{"id":1}']);
      expect(r.code).toBe(0);
      expect(r.result).toMatchObject({ ok: true, command: "preflight", rail: "tempo", state: "ok", amount: "0.001", payTo: TEMPO_SELLER, offer: { token: "pathUSD", network: "tempo-moderato", feePayer: true } });
      expect(r.result.next).toContain("the seller asks 0.001 pathUSD");
      expect(r.result.next).toContain(`superstables budget buy --rail tempo --chain moderato --url '${s.url}' --method POST --body '{"id":1}' --max <your ceiling> --pay-to ${TEMPO_SELLER}`);
      expect(s.seen).toEqual([{ method: "POST", body: '{"id":1}' }]);
      expect(existsSync(join(home, "keys"))).toBe(false);
    } finally {
      s.close();
    }
  });

  it("fails on tempo when the seller offers Moderato nothing it can pay", async () => {
    const mainnet = await seller402({ "www-authenticate": tempoChallenge({ amount: "1000", currency: PATH_USD, recipient: TEMPO_SELLER, methodDetails: { chainId: 4217 } }) });
    const memo = await seller402({ "www-authenticate": tempoChallenge({ amount: "1000", currency: PATH_USD, recipient: TEMPO_SELLER, methodDetails: { chainId: 42431, memo: `0x${"ab".repeat(32)}` } }) });
    try {
      const a = await budget(["preflight", "--rail", "tempo", "--url", mainnet.url]);
      expect(a.code).toBe(1);
      expect(a.result).toMatchObject({ ok: false, state: "failed", amount: null });
      expect(a.result.reason).toContain("no tempo.charge offer on Moderato");
      const b = await budget(["preflight", "--rail", "tempo", "--url", memo.url]);
      expect(b.code).toBe(1);
      expect(b.result.reason).toContain("a payment memo of its own");
    } finally {
      mainnet.close();
      memo.close();
    }
  });

  it("prints a solana seller's devnet price and payee with no setup, from its x402 v2 header", async () => {
    const payTo = "AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ";
    const accepts = [{ scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", amount: "10000", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", payTo, maxTimeoutSeconds: 60, extra: { feePayer: "D6ZhtNQ5nT9ZnTHUbqXZsTx5MH2rPFiBBggX4hY1WePM" } }];
    const s = await seller402({ "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") });
    try {
      const r = await budget(["preflight", "--rail", "solana", "--url", s.url]);
      expect(r.code).toBe(0);
      expect(r.result).toMatchObject({ ok: true, rail: "solana", state: "ok", amount: "0.01", payTo, offer: { token: "USDC", network: "solana-devnet", feePayer: true } });
      expect(r.result.next).toContain(`superstables budget buy --rail solana --chain devnet --url '${s.url}' --max <your ceiling> --pay-to ${payTo}`);
      expect(existsSync(join(home, "keys"))).toBe(false);
    } finally {
      s.close();
    }
  });

  it("keeps evm preflight GET only", async () => {
    const r = await budget(["preflight", "--rail", "evm", "--url", "http://127.0.0.1:9/paid", "--method", "POST"]);
    expect(r.code).toBe(2);
    expect(r.result.reason).toBe("evm preflight is GET only (no --method)");
  });
});

describe("--json", () => {
  const json = (r: Run) => {
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith("{")).toBe(true);
    return JSON.parse(lines[0]);
  };

  it("is accepted by every command, and stdout is the RESULT object alone", async () => {
    const r = await budget(["status", "--rail", "evm", "--json"]);
    expect(r.code).toBe(1);
    expect(json(r)).toMatchObject({ ok: false, command: "status", state: "failed", final: true, home });
    expect(r.stderr).toContain("no budget has been set up here for evm on base-sepolia");
  });

  it("keeps the exit code and the fields of a refusal", async () => {
    const r = await budget(["buy", "--rail", "solana", "--url", "http://127.0.0.1:9/paid", "--max", "0.02", "--json"]);
    expect(r.code).toBe(3);
    expect(json(r)).toMatchObject({ command: "buy", rail: "solana", state: "refused_precheck", paid: false, amount: "0" });
  });

  it("prints bad input as the same object", async () => {
    const r = await budget(["grant", "--rail", "evm", "--amount", "1", "--yes", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r)).toMatchObject({ ok: false, command: "grant", state: "failed" });
    const w = await budget(["wait", "--id", "oa-20260930120000-1a2b3c4d", "--json"]);
    expect(w.code).toBe(2);
    expect(json(w)).toMatchObject({ ok: false, command: "wait", state: "failed" });
  });

  it("changes nothing without it: stdout still ends with the RESULT line", async () => {
    const r = await budget(["status", "--rail", "evm"]);
    expect(r.stdout.trim().split("\n").pop()).toMatch(/^RESULT \{/);
  });

  it("is in every command's help", async () => {
    for (const cmd of ["status", "buy", "grant", "wait"]) {
      const r = await budget([cmd, "--help"]);
      expect(r.stdout).toContain("--json: stdout is that RESULT object alone, as JSON");
    }
    expect((await budget(["grant", "--help"])).stdout).toContain("the APPROVE line goes to stderr");
    expect((await budget(["--help"])).stdout).toContain("--json (every command): stdout is only that object");
  });
});

describe("help", () => {
  const commands = ["setup", "fund-agent", "doctor", "preflight", "grant", "status", "buy", "reconcile", "recover", "wait", "revoke"];

  for (const cmd of commands) {
    it(`${cmd} --help says what it does, whether it moves money, who runs it, an example, what it prints and the exit codes`, async () => {
      const r = await budget([cmd, "--help"]);
      expect(r.code).toBe(0);
      for (const part of ["Moves money: ", "Run by: ", "Example:\n  $ superstables budget " + cmd, "Prints: ", "Exit codes: "]) expect(r.stdout).toContain(part);
      if (r.stdout.split("\n")[0].includes("--chain")) expect(r.stdout).toContain("--chain C: evm base-sepolia (default), arc-testnet");
    });
  }

  it("budget --help starts the owner and the agent, maps chains to rails, and lists exit codes and paths", async () => {
    const r = await budget(["--help"]);
    expect(r.code).toBe(0);
    for (const part of [
      "Start here, the owner",
      "Start here, the agent",
      "base-sepolia (Base Sepolia, default)",
      "Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia and Ethereum Sepolia are evm",
      "Tempo Moderato is tempo; Solana devnet is solana",
      "evm     setup, fund-agent, doctor, grant.",
      "ssh -L PORT:127.0.0.1:PORT",
      "4  paid, not delivered",
      "keys/budget/<rail>-agent.env",
    ]) expect(r.stdout).toContain(part);
  });

  it("buy --help says what --max is and what a buy needs first", async () => {
    const r = await budget(["buy", "--help"]);
    expect(r.stdout).toContain("--max 0.02 means 0.02 USDC");
    expect(r.stdout).toContain("the owner has run setup and grant (on evm and solana also fund-agent)");
    expect(r.stdout).toContain("superstables budget status --rail R");
  });

  it("wait --help documents command completion", async () => {
    const r = await budget(["wait", "--help"]);
    expect(r.stdout).toContain("final false");
    expect(r.stdout).toContain("Scripts test final, not the exit code");
  });

  it("names the build on --version only: doctor does not print it", async () => {
    const r = await budget(["doctor", "--rail", "evm"]);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/superstables budget \S+ \((checkout|standalone)/);
  }, 60_000);
});

describe("one RESULT line", () => {
  it("preflight prints the rail's result once, as its own", async () => {
    // a seller that is not there: the rail prints a RESULT of its own, which the dispatcher replaces
    const r = await budget(["preflight", "--rail", "evm", "--url", "http://127.0.0.1:9/paid"]);
    expect(r.code).toBe(1);
    expect(r.result).toMatchObject({ command: "preflight", state: "failed", final: true });
    expect(`${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.startsWith("RESULT "))).toHaveLength(1);
  }, 60_000);
});

describe("an owner approval an agent started", () => {
  it("prints its link once, reports final false while it waits, and ends refused once the link expires", async () => {
    const setup = await budget(["setup", "--rail", "evm", "--no-open", "--timeout", "10"]);
    expect(setup.code).toBe(0);
    expect(setup.result).toMatchObject({ command: "setup", state: "waiting_owner", final: false });
    const { id, url } = setup.result;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/owner\//);
    const port = new URL(url).port;
    expect(setup.result.next).toContain(`ssh -L ${port}:127.0.0.1:${port}`);
    // reply with the link and end the turn; wait --shown once the owner says they've approved
    expect(setup.result.next).toContain("reply to the owner with message_for_owner, word for word (it has the approval link and the amount), and end your turn there");
    expect(setup.result.next).toContain(`superstables budget wait --id ${id} --shown`);
    // the link once: one APPROVE line on stdout, none repeated on stderr
    expect(`${setup.stdout}\n${setup.stderr}`.split("\n").filter((l) => l.startsWith("APPROVE "))).toHaveLength(1);
    expect(setup.stdout.split("\n")[0]).toMatch(/^APPROVE \{/);

    // wait reads nothing until the caller says the owner can read the link
    const unshown = await budget(["wait", "--id", id, "--timeout", "1"]);
    expect(unshown.code).toBe(2);
    expect(unshown.result).toMatchObject({ state: "show_owner_first", id });

    const waiting = await budget(["wait", "--id", id, "--shown", "--timeout", "1"]);
    expect(waiting.code).toBe(0);
    expect(waiting.result).toMatchObject({ state: "waiting_owner", final: false, id });

    // nobody approves: the link expires, nothing was sent, and the next step is to run it again
    const ended = await budget(["wait", "--id", id, "--shown", "--timeout", "40"]);
    expect(ended.code).toBe(3);
    expect(ended.result).toMatchObject({ command: "setup", state: "refused_precheck", final: true, id });
    expect(ended.result.reason).toMatch(/expired/);
    expect(ended.result.next).toContain("run the same command again for a new one (setup reuses the agent key it created)");
  }, 90_000);

  it("with --json: stdout is the waiting_owner object alone, and the APPROVE line goes to stderr", async () => {
    const setup = await budget(["setup", "--rail", "evm", "--no-open", "--timeout", "10", "--json"]);
    expect(setup.code).toBe(0);
    const lines = setup.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]);
    expect(out).toMatchObject({ command: "setup", state: "waiting_owner", final: false });
    expect(setup.stderr.split("\n").filter((l) => l.startsWith("APPROVE "))).toHaveLength(1);
    expect(JSON.parse(setup.stderr.split("\n").find((l) => l.startsWith("APPROVE "))!.slice(8)).url).toBe(out.url);

    const ended = await budget(["wait", "--id", out.id, "--shown", "--timeout", "40", "--json"]);
    expect(ended.code).toBe(3);
    expect(JSON.parse(ended.stdout.trim())).toMatchObject({ command: "setup", state: "refused_precheck", final: true, id: out.id });
  }, 90_000);
});
