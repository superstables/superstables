// The client's own folders are private: real folders owned by this user that no other user can write to. A symlinked
// records folder is refused instead of written through, a folder others can only read is set back to 0700, and the
// wallet's agent token is read only from a regular file only this user can read.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/cli/doctor.js";
import { ensureDir } from "../../src/core/home.js";
import { Records } from "../../src/core/records.js";
import { SignRefused } from "../../src/core/signer/types.js";
import { walletStatus } from "../../src/core/signer/wallet.js";
import type { Quote } from "../../src/core/types.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const posix = process.platform !== "win32";
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

let tmp: string;
let home: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ss-home-dirs-"));
  home = join(tmp, "home");
  saved = { SUPERSTABLES_HOME: process.env.SUPERSTABLES_HOME, SUPERSTABLES_WALLET_AGENT_TOKEN: process.env.SUPERSTABLES_WALLET_AGENT_TOKEN, SUPERSTABLES_DOCTOR_OFFLINE: process.env.SUPERSTABLES_DOCTOR_OFFLINE };
  process.env.SUPERSTABLES_HOME = home;
  delete process.env.SUPERSTABLES_WALLET_AGENT_TOKEN;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

const aQuote = (id: string) => ({ id, createdAt: new Date().toISOString(), url: "https://example.com/x", status: "open" }) as unknown as Quote;

describe.skipIf(!posix)("private folders", () => {
  it("refuses a records folder that is a symlink, and writes nothing through it", () => {
    mkdirSync(home, { mode: 0o700 });
    const elsewhere = join(tmp, "elsewhere");
    mkdirSync(elsewhere);
    chmodSync(elsewhere, 0o777);
    symlinkSync(elsewhere, join(home, "records"));
    const records = new Records(join(home, "records"));
    expect(() => records.saveQuote(aQuote("q"))).toThrow(/is a symlink, not a folder/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses a folder that others can write to, and says how to fix it", () => {
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(join(home, "records"));
    chmodSync(join(home, "records"), 0o775);
    expect(() => new Records(join(home, "records")).saveQuote(aQuote("q"))).toThrow(/other users can write to .*records .*chmod 700/);
  });

  it("sets a folder others can only read back to 0700", () => {
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(join(home, "records"));
    chmodSync(join(home, "records"), 0o755);
    new Records(join(home, "records")).saveQuote(aQuote("q"));
    expect(mode(join(home, "records"))).toBe("700");
  });

  it("creates every missing level 0700, whatever the umask", () => {
    const old = process.umask(0);
    try {
      ensureDir(join(home, "records", "claims"));
    } finally {
      process.umask(old);
    }
    for (const dir of [home, join(home, "records"), join(home, "records", "claims")]) expect(mode(dir)).toBe("700");
  });

  it("refuses a folder that belongs to another user", () => {
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(join(home, "records"), { mode: 0o700 });
    vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(process.getuid!() + 1);
    expect(() => ensureDir(join(home, "records"))).toThrow(/belongs to another user/);
  });

  it("accepts a home that is a symlink to a private folder of ours, and leaves that folder's read bits alone", () => {
    const real = join(tmp, "real");
    mkdirSync(real, { mode: 0o750 });
    chmodSync(real, 0o750);
    symlinkSync(real, home);
    ensureDir(join(home, "records"));
    expect(mode(join(real, "records"))).toBe("700");
    expect(mode(real)).toBe("750");
  });

  it("refuses a home that is a symlink to a folder others can write to", () => {
    const real = join(tmp, "real");
    mkdirSync(real);
    chmodSync(real, 0o777);
    symlinkSync(real, home);
    expect(() => ensureDir(join(home, "records"))).toThrow(/other users can write to/);
    expect(readdirSync(real)).toEqual([]);
  });
});

describe.skipIf(!posix)("the wallet's agent token", () => {
  it("is not read from a FIFO: the command answers instead of waiting on it", async () => {
    mkdirSync(join(home, "wallet"), { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", ["-m", "600", join(home, "wallet", "agent-token")]);
    const script = `import { walletStatus } from ${JSON.stringify(resolve(ROOT, "src/core/signer/wallet.ts"))};
walletStatus({ url: "http://127.0.0.1:1" }).then(() => console.log("ok"), (e) => console.log("ERR " + e.message));`;
    const child = spawn(process.execPath, [TSX, "-e", script], { cwd: ROOT, env: { ...process.env, SUPERSTABLES_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += String(c)));
    const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
    const code = await new Promise<number | null>((done) => child.once("close", done));
    clearTimeout(timer);
    expect(code, out).toBe(0);
    expect(out).toMatch(/is not a regular file; the token was not sent/);
  }, 20_000);

  it("is not sent when other users can read the file", async () => {
    const seen: (string | undefined)[] = [];
    const server: Server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.setHeader("content-type", "application/json").end("{}");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      mkdirSync(join(home, "wallet"), { recursive: true, mode: 0o700 });
      const file = join(home, "wallet", "agent-token");
      writeFileSync(file, "secret-token\n", { mode: 0o644 });
      chmodSync(file, 0o644);
      const err = await walletStatus({ url }).catch((e) => e);
      expect(err).toBeInstanceOf(SignRefused);
      expect(String(err.message)).toMatch(/can be read by other users .*chmod 600/);
      expect(seen).toEqual([]);
      chmodSync(file, 0o600);
      await walletStatus({ url });
      expect(seen).toEqual(["Bearer secret-token"]);
    } finally {
      server.close();
    }
  });

  it("a missing token file is an empty token, as before", async () => {
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.setHeader("content-type", "application/json").end("{}");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      await walletStatus({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
      expect(seen).toEqual(["Bearer"]);
    } finally {
      server.close();
    }
  });
});

describe("doctor and unreadable record lines", () => {
  it("reports them as a check that does not change the exit status", async () => {
    process.env.SUPERSTABLES_DOCTOR_OFFLINE = "1";
    const records = new Records(join(home, "records"));
    records.saveQuote(aQuote("q"));
    const before = await runDoctor("browser");
    expect(before.checks.find((c) => c.name === "payment records")).toMatchObject({ ok: true, essential: false });
    appendFileSync(join(home, "records", "quotes.jsonl"), "not json {\n");
    const report = await runDoctor("browser");
    const check = report.checks.find((c) => c.name === "payment records");
    expect(check).toMatchObject({ ok: false, essential: false });
    expect(check?.detail).toMatch(/^1 unreadable line \(1 in quotes\.jsonl\)/);
    expect(report.ok).toBe(before.ok);
    expect(existsSync(join(home, "records"))).toBe(true);
  }, 20_000);
});
