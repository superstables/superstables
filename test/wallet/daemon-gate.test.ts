// The local wallet as a gate: the policy it applies at the moment it signs, the spending it counts, what it does when
// its audit log fails, who may call it, and what it refuses to hand out after the client stopped waiting. Everything
// runs over HTTP on a throwaway loopback port, with a throwaway key and no network.

import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { closeSync, constants, chmodSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usdcRequirement } from "../../src/core/chain.js";
import { evaluatePolicy } from "../../src/core/policy.js";
import type { WalletRequestView } from "../../src/core/types.js";
import { startWallet, type StartWalletOptions, type WalletHandle } from "../../src/wallet/daemon.js";

vi.mock("../../src/core/policy.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/policy.js")>();
  return { ...real, evaluatePolicy: vi.fn(real.evaluatePolicy) };
});

const PAYEE = "0x2222222222222222222222222222222222222222";
const ROOMY = "caps:\n  per_call: 1\n  per_day: 100\n";

interface Gate {
  wallet: WalletHandle;
  dir: string;
  policyFile: string;
  accountFile: string;
  address: string;
}

const gates: Gate[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ["SUPERSTABLES_POLICY", "SUPERSTABLES_TEST_ACCOUNT_HOME"] as const;

beforeEach(() => {
  for (const name of ENV) saved[name] = process.env[name];
});

afterEach(async () => {
  while (gates.length > 0) {
    const gate = gates.pop()!;
    await gate.wallet.close();
    rmSync(gate.dir, { recursive: true, force: true });
  }
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.mocked(evaluatePolicy).mockClear();
});

/** A wallet that reads its policy from files in its own folder. `policyText` is the selected policy. */
async function start(policyText: string, overrides: Partial<StartWalletOptions> = {}, accountText?: string): Promise<Gate> {
  const dir = mkdtempSync(join(tmpdir(), "superstables-gate-test-"));
  const policyFile = join(dir, "policy.yaml");
  const accountFile = join(dir, "account-policy.yaml");
  writeFileSync(policyFile, policyText);
  if (accountText !== undefined) writeFileSync(accountFile, accountText);
  // The base wallet reads the policy named here, once; the gated one is handed the files below.
  process.env.SUPERSTABLES_POLICY = policyFile;
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = await startWallet({
    port: 0,
    // these tests call the agent's routes over TCP; test/wallet/socket.test.ts covers the socket
    tcp: true,
    dir,
    account,
    policyFile,
    accountPolicyFile: accountFile,
    quiet: true,
    openBrowser: false,
    balance: false,
    launcherDir: join(dir, "open"),
    ...overrides,
  });
  const gate = { wallet, dir, policyFile, accountFile, address: account.address };
  gates.push(gate);
  return gate;
}

function call(w: WalletHandle, path: string, token: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${w.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface Asked { http: number; v: WalletRequestView & { error?: string } }

async function ask(w: WalletHandle, requirements: Record<string, unknown>, extra: { waitMs?: number; headers?: Record<string, string> } = {}): Promise<Asked> {
  const res = await call(w, "/requests", w.agentToken, "POST", {
    sign: { kind: "eip3009", x402Version: 2, requirements, context: { target: "https://seller.example/x" } },
    ...(extra.waitMs === undefined ? {} : { waitMs: extra.waitMs }),
  }, extra.headers);
  return { http: res.status, v: (await res.json()) as Asked["v"] };
}

const pay = (amount: number, payTo = PAYEE): Record<string, unknown> => usdcRequirement(amount, payTo);
/** Approves the way the owner's page does: confirming the amount, recipient and chain the request showed. */
const approve = async (w: WalletHandle, id: string) => {
  const list = (await (await call(w, "/owner/requests", w.ownerSecret)).json()) as { requests: WalletRequestView[] };
  const shown = list.requests.find((r) => r.id === id)?.verified;
  const body = shown ? { amountAtomic: shown.amountAtomic, recipient: shown.recipient, network: shown.network } : {};
  return call(w, `/owner/requests/${id}/approve`, w.ownerSecret, "POST", body);
};
const cancel = (w: WalletHandle, id: string) => call(w, `/requests/${id}/cancel`, w.agentToken, "POST");
const read = async (w: WalletHandle, id: string) => (await (await call(w, `/requests/${id}`, w.agentToken)).json()) as WalletRequestView;
const pendingCount = async (w: WalletHandle) => ((await (await call(w, "/owner/requests", w.ownerSecret)).json()) as { requests: WalletRequestView[] }).requests.filter((r) => r.status === "pending").length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const todayLine = (id: string, status: string, amountAtomic: string, network = "eip155:84532") =>
  `${JSON.stringify({ at: new Date().toISOString(), id, status, verified: { asset: "USDC", amountAtomic, network } })}\n`;

describe("requests waiting for the owner count toward the day", () => {
  it("1. six 0.04 requests against a 0.05 daily cap: one waits, five are denied, 40000 units are signed", async () => {
    const { wallet } = await start("caps:\n  per_call: 0.05\n  per_day: 0.05\n");
    const statuses: string[] = [];
    let signed = 0n;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { v } = await ask(wallet, pay(0.04));
      statuses.push(v.status);
      if (v.status === "denied") expect(v.reason).toMatch(/caps\.per_day/);
      if (v.status === "pending") ids.push(v.id);
    }
    for (const id of ids) {
      const answer = (await (await approve(wallet, id)).json()) as WalletRequestView;
      if (answer.status === "signed") signed += BigInt(answer.verified.amountAtomic);
    }
    expect(statuses).toEqual(["pending", "denied", "denied", "denied", "denied", "denied"]);
    expect(signed).toBe(40000n);
  });

  it("an approved request still counts: a second one is denied", async () => {
    const { wallet } = await start("caps:\n  per_call: 0.05\n  per_day: 0.05\n");
    const first = await ask(wallet, pay(0.04));
    expect((await approve(wallet, first.v.id)).status).toBe(200);
    const second = await ask(wallet, pay(0.04));
    expect(second.v.status).toBe("denied");
  });
});

describe("the policy is read again when the owner approves", () => {
  it("2. a kill switch written between create and approve refuses the approval, and nothing is served", async () => {
    const g = await start(ROOMY);
    const { v } = await ask(g.wallet, pay(0.01));
    expect(v.status).toBe("pending");
    writeFileSync(g.policyFile, "kill_switch: true\n");
    const res = await approve(g.wallet, v.id);
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(409);
    expect(body.error).toBe("the spend policy now refuses this payment: kill_switch is on");
    const after = await read(g.wallet, v.id);
    expect(after.status).toBe("rejected");
    expect(after.result).toBeUndefined();
  });

  it("3. the account's own policy applies when the selected one is another file", async () => {
    const g = await start("", {}, "kill_switch: true\n");
    const { v } = await ask(g.wallet, pay(0.01));
    expect(v.status).toBe("denied");
    expect(v.reason).toContain(`(in ${g.accountFile})`);
  });

  it("3b. by default that file is the account's ~/.superstables/policy.yaml", async () => {
    const home = mkdtempSync(join(tmpdir(), "superstables-gate-account-"));
    try {
      mkdirSync(join(home, ".superstables"));
      writeFileSync(join(home, ".superstables", "policy.yaml"), "kill_switch: true\n");
      process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = home;
      const g = await start("", { accountPolicyFile: undefined });
      const { v } = await ask(g.wallet, pay(0.01));
      expect(v.status).toBe("denied");
      expect(v.reason).toContain(join(home, ".superstables", "policy.yaml"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("4. a policy that becomes unusable after the wallet started refuses the next request", async () => {
    const g = await start(ROOMY);
    writeFileSync(g.policyFile, "caps:\n  per_call: 0x10\n");
    const { v } = await ask(g.wallet, pay(0.01));
    expect(v.status).toBe("denied");
    expect(v.reason).toMatch(/cannot be used/);
  });

  it("18. GET /status carries the account's policy as `also`", async () => {
    const g = await start(ROOMY, {}, "kill_switch: true\n");
    const status = (await (await call(g.wallet, "/status", g.wallet.agentToken)).json()) as { also?: { file: string; policy: { killSwitch: boolean } } };
    expect(status.also?.file).toBe(g.accountFile);
    expect(status.also?.policy.killSwitch).toBe(true);
  });
});

describe("the audit log", () => {
  it("5. a log that cannot be written stops the request: 503, and nothing waits", async () => {
    let n = 0;
    const g = await start(ROOMY, {
      auditIo: {
        writeSync: ((...args: Parameters<typeof import("node:fs").writeSync>) => {
          n++;
          throw new Error("disk full");
        }) as never,
      },
    });
    const res = await call(g.wallet, "/requests", g.wallet.agentToken, "POST", { sign: { kind: "eip3009", x402Version: 2, requirements: pay(0.01) } });
    const body = (await res.json()) as { error?: string };
    expect(res.status).toBe(503);
    expect(body.error).toMatch(/could not write its audit log/);
    expect(await pendingCount(g.wallet)).toBe(0);
    expect(n).toBeGreaterThan(0);
  });

  it("5b. an audit log that is a folder refuses to sign: nothing waits", async () => {
    const g = await start(ROOMY);
    mkdirSync(join(g.dir, "audit.jsonl"));
    const { v } = await ask(g.wallet, pay(0.01));
    expect(v.status).toBe("denied");
    expect(v.reason).toMatch(/cannot be read from the audit log/);
    expect(await pendingCount(g.wallet)).toBe(0);
  });

  it("6. a log that cannot be read refuses to sign", async () => {
    if (process.getuid?.() === 0) return;
    const g = await start(ROOMY);
    const file = join(g.dir, "audit.jsonl");
    writeFileSync(file, "");
    chmodSync(file, 0o000);
    try {
      const { v } = await ask(g.wallet, pay(0.01));
      expect(v.status).toBe("denied");
      expect(v.reason).toMatch(/cannot be read from the audit log/);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("6b. a log with a line that is not JSON refuses to sign", async () => {
    const g = await start(ROOMY);
    writeFileSync(join(g.dir, "audit.jsonl"), "{nope\n");
    const { v } = await ask(g.wallet, pay(0.01));
    expect(v.status).toBe("denied");
    expect(v.reason).toMatch(/cannot be read from the audit log/);
  });

  it("7. a log that is a FIFO is never waited on", async () => {
    const g = await start(ROOMY);
    const file = join(g.dir, "audit.jsonl");
    expect(spawnSync("mkfifo", [file]).status).toBe(0);
    // a reader, so that a blocking open of the FIFO would not hang the test on the code before this fix
    const reader = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const started = Date.now();
      const res = await call(g.wallet, "/requests", g.wallet.agentToken, "POST", { sign: { kind: "eip3009", x402Version: 2, requirements: pay(0.01) } });
      const body = (await res.json()) as WalletRequestView;
      expect(Date.now() - started).toBeLessThan(2000);
      expect(res.status === 503 || body.status === "denied").toBe(true);
    } finally {
      closeSync(reader);
    }
  });

  it("8. a `signed` line that cannot be written discards the signature, and the approval still counts", async () => {
    let writes = 0;
    const real = (await import("node:fs")).writeSync;
    const g = await start("caps:\n  per_call: 0.05\n  per_day: 0.05\n", {
      auditIo: {
        writeSync: ((fd: number, ...rest: unknown[]) => {
          writes++;
          if (writes === 3) throw new Error("disk full");
          return (real as (...a: unknown[]) => number)(fd, ...rest);
        }) as never,
      },
    });
    const { v } = await ask(g.wallet, pay(0.04));
    expect(v.status).toBe("pending");
    const res = await approve(g.wallet, v.id);
    expect(res.status).toBe(503);
    const after = await read(g.wallet, v.id);
    expect(after.status).toBe("rejected");
    expect(after.result).toBeUndefined();
    const next = await ask(g.wallet, pay(0.04));
    expect(next.v.status).toBe("denied");
    expect(next.v.reason).toMatch(/caps\.per_day/);
  });
  it("8b. an `approved` line that cannot be written says the wallet did not sign, and why", async () => {
    let writes = 0;
    const real = (await import("node:fs")).writeSync;
    const g = await start(ROOMY, {
      auditIo: {
        writeSync: ((fd: number, ...rest: unknown[]) => {
          writes++;
          if (writes === 2) throw new Error("disk full");
          return (real as (...a: unknown[]) => number)(fd, ...rest);
        }) as never,
      },
    });
    const { v } = await ask(g.wallet, pay(0.01));
    const res = await approve(g.wallet, v.id);
    expect(res.status).toBe(503);
    const { error } = (await res.json()) as { error: string };
    expect(error).toBe("the wallet could not write its audit log, so it did not sign (disk full)");
    expect((await read(g.wallet, v.id)).result).toBeUndefined();
  });

  it("8c. a `signed` line that cannot be written says the signature was discarded, and why", async () => {
    let writes = 0;
    const real = (await import("node:fs")).writeSync;
    const g = await start(ROOMY, {
      auditIo: {
        writeSync: ((fd: number, ...rest: unknown[]) => {
          writes++;
          if (writes === 3) throw new Error("disk full");
          return (real as (...a: unknown[]) => number)(fd, ...rest);
        }) as never,
      },
    });
    const { v } = await ask(g.wallet, pay(0.01));
    const res = await approve(g.wallet, v.id);
    expect(res.status).toBe(503);
    const { error } = (await res.json()) as { error: string };
    expect(error).toBe("the wallet signed, but could not record it in its audit log, so the signature was discarded; nothing can be paid with it (disk full)");
    expect(error).not.toMatch(/nothing was asked or signed/);
  });
});

describe("a request the client stopped waiting for", () => {
  it("9. cancelled, it cannot be approved late and nothing is served", async () => {
    const { wallet } = await start(ROOMY);
    const { v } = await ask(wallet, pay(0.01));
    const cancelled = await cancel(wallet, v.id);
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as WalletRequestView).status).toBe("expired");
    const late = await approve(wallet, v.id);
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toMatch(/is expired/);
    expect((await read(wallet, v.id)).result).toBeUndefined();
  });

  it("10. a client killed without cancelling is not served after its wait plus the grace", async () => {
    const { wallet } = await start(ROOMY, { resultGraceMs: 200 });
    const { v } = await ask(wallet, pay(0.01), { waitMs: 1000 });
    expect((await approve(wallet, v.id)).status).toBe(200);
    await sleep(1400);
    const got = (await read(wallet, v.id)) as WalletRequestView & { withheld?: boolean };
    expect(got.status).toBe("signed");
    expect(got.withheld).toBe(true);
    expect(got.result).toBeUndefined();
  });

  it("10b. an approval after the client's wait has ended is refused", async () => {
    const { wallet } = await start(ROOMY, { resultGraceMs: 200 });
    const { v } = await ask(wallet, pay(0.01), { waitMs: 1000 });
    await sleep(1100);
    expect((await approve(wallet, v.id)).status).toBe(409);
  });

  it("10c. a wait outside what the wallet accepts is a 400", async () => {
    const { wallet } = await start(ROOMY);
    const res = await call(wallet, "/requests", wallet.agentToken, "POST", { sign: { kind: "eip3009", x402Version: 2, requirements: pay(0.01) }, waitMs: 5 });
    expect(res.status).toBe(400);
  });

  it("11. cancelling after the owner signed, before it was fetched, withholds the signature", async () => {
    const { wallet } = await start(ROOMY);
    const { v } = await ask(wallet, pay(0.01));
    expect((await approve(wallet, v.id)).status).toBe(200);
    const res = await cancel(wallet, v.id);
    const body = (await res.json()) as WalletRequestView & { served?: boolean };
    expect(res.status).toBe(200);
    expect(body.served).toBe(false);
    expect((await read(wallet, v.id)).result).toBeUndefined();
  });

  it("11b. cancelling after the signature was fetched says so", async () => {
    const { wallet } = await start(ROOMY);
    const { v } = await ask(wallet, pay(0.01));
    expect((await approve(wallet, v.id)).status).toBe(200);
    expect((await read(wallet, v.id)).result).toBeDefined();
    const body = (await (await cancel(wallet, v.id)).json()) as { served?: boolean };
    expect(body.served).toBe(true);
  });

  it("11c. cancelling while the approval is being signed withholds the signature", async () => {
    const real = privateKeyToAccount(generatePrivateKey());
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const signing = new Promise<void>((resolve) => { entered = resolve; });
    const account = {
      ...real,
      signTypedData: (async (args: Parameters<typeof real.signTypedData>[0]) => {
        entered();
        await held;
        return real.signTypedData(args);
      }) as typeof real.signTypedData,
    };
    const { wallet } = await start(ROOMY, { account });
    const { v } = await ask(wallet, pay(0.01));
    const approving = approve(wallet, v.id);
    await signing;
    const res = await cancel(wallet, v.id);
    const body = (await res.json()) as WalletRequestView & { served?: boolean };
    expect(res.status).toBe(200);
    expect(body.status).toBe("approved");
    expect(body.withheld).toBe(true);
    expect(body.served).toBe(false);
    expect(body.reason).toMatch(/withheld/);
    release();
    await approving;
    const got = await read(wallet, v.id);
    expect(got.result).toBeUndefined();
    expect(got.withheld).toBe(true);
  });

  it("an unknown id cannot be cancelled", async () => {
    const { wallet } = await start(ROOMY);
    expect((await cancel(wallet, "nope")).status).toBe(404);
  });
});

describe("who may call, and how", () => {
  it("12. at most three requests wait; the fourth gets 429 and leaves no record", async () => {
    const { wallet } = await start(ROOMY);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await ask(wallet, pay(0.01))).http);
    expect(codes).toEqual([200, 200, 200, 429]);
    const list = ((await (await call(wallet, "/owner/requests", wallet.ownerSecret)).json()) as { requests: unknown[] }).requests;
    expect(list).toHaveLength(3);
  });

  it("12b. requests whose bodies arrive after their headers still meet the cap: exactly three wait", async () => {
    const { wallet } = await start(ROOMY);
    const url = new URL(wallet.url);
    const body = JSON.stringify({ sign: { kind: "eip3009", x402Version: 2, requirements: pay(0.01), context: { target: "https://seller.example/x" } } });
    const opened = Array.from({ length: 5 }, () => {
      const req = httpRequest({
        host: url.hostname,
        port: url.port,
        path: "/requests",
        method: "POST",
        headers: { authorization: `Bearer ${wallet.agentToken}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      });
      const status = new Promise<number>((resolve, reject) => {
        req.on("response", (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on("error", reject);
      });
      req.flushHeaders();
      return { req, status };
    });
    // Every request has passed the wallet's first look before any body arrives.
    await sleep(200);
    for (const { req } of opened) req.end(body);
    const codes = (await Promise.all(opened.map((o) => o.status))).sort();
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect(await pendingCount(wallet)).toBe(3);
  });

  it("13. an Origin that is not the wallet's own is refused, on every route", async () => {
    const { wallet } = await start(ROOMY);
    expect((await ask(wallet, pay(0.01), { headers: { origin: "https://evil.example" } })).http).toBe(403);
    expect((await ask(wallet, pay(0.01), { headers: { origin: "null" } })).http).toBe(403);
    expect((await call(wallet, "/status", wallet.agentToken, "GET", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await call(wallet, "/owner/requests", wallet.ownerSecret, "GET", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await ask(wallet, pay(0.01), { headers: { origin: wallet.url } })).http).toBe(200);
    expect((await ask(wallet, pay(0.01))).http).toBe(200);
  });

  it("14. a body that is not declared JSON is refused", async () => {
    const { wallet } = await start(ROOMY);
    const body = JSON.stringify({ sign: { kind: "eip3009", x402Version: 2, requirements: pay(0.01) } });
    const plain = await fetch(`${wallet.url}/requests`, { method: "POST", headers: { authorization: `Bearer ${wallet.agentToken}`, "content-type": "text/plain" }, body });
    expect(plain.status).toBe(415);
    const none = await fetch(`${wallet.url}/requests`, { method: "POST", headers: { authorization: `Bearer ${wallet.agentToken}` }, body });
    expect(none.status).toBe(415);
  });
});

describe("what is signed", () => {
  it("15. a payment to the wallet's own address is refused", async () => {
    const g = await start(ROOMY);
    const { v } = await ask(g.wallet, pay(0.01, g.address));
    expect(v.status).toBe("rejected");
    expect(v.reason).toMatch(/own address/);
  });

  it("16. a direct request for an hour is signed for ten minutes", async () => {
    const { wallet } = await start(ROOMY);
    const { v } = await ask(wallet, { ...pay(0.01), maxTimeoutSeconds: 3600 });
    const now = Math.floor(Date.now() / 1000);
    expect((await approve(wallet, v.id)).status).toBe(200);
    const got = await read(wallet, v.id);
    const left = Number((got.result!.payload.authorization as { validBefore: string }).validBefore) - now;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(601);
  });
});

describe("17. the daily total is compared in whole units, never as a float", () => {
  it("a total of 2^53 + 1 units against a cap of exactly that total refuses one more unit", async () => {
    const g = await start("caps:\n  per_call: 1\n  per_day: 9007199254.740993\n");
    appendFileSync(join(g.dir, "audit.jsonl"), todayLine("seed", "signed", "9007199254740993"));
    const { v } = await ask(g.wallet, { ...pay(0.01), amount: "1" });
    expect(v.status).toBe("denied");
    expect(v.reason).toContain("9007199254.740993");
  });

  it("a total one unit short of the cap lets the last unit through", async () => {
    const g = await start("caps:\n  per_call: 1\n  per_day: 8589934592.000002\n");
    appendFileSync(join(g.dir, "audit.jsonl"), todayLine("seed", "signed", "8589934592000001"));
    const { v } = await ask(g.wallet, { ...pay(0.01), amount: "1" });
    expect(v.status).toBe("pending");
  });

  it("passes the policy the amount and the total as bigints, and no decimals", async () => {
    const g = await start(ROOMY);
    appendFileSync(join(g.dir, "audit.jsonl"), todayLine("seed", "signed", "250000"));
    const { v } = await ask(g.wallet, pay(0.04));
    expect(v.status).toBe("pending");
    expect((await approve(g.wallet, v.id)).status).toBe(200);
    const calls = vi.mocked(evaluatePolicy).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [, attempt] of calls) {
      expect(typeof attempt.amountAtomic).toBe("bigint");
      expect(typeof attempt.spentTodayAtomic).toBe("bigint");
      expect(attempt).not.toHaveProperty("amountDecimal");
      expect(attempt).not.toHaveProperty("spentTodayDecimal");
    }
    expect(calls[0][1].spentTodayAtomic).toBe(250000n);
    expect(calls[0][1].amountAtomic).toBe(40000n);
  });
});
