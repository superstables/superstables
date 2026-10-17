// `superstables owner settings`: the owner's own command. The real CLI in a child process, the owner's account home made
// per case (SUPERSTABLES_TEST_ACCOUNT_HOME, test/account-guard.mjs). Changes need a terminal: test/helpers/budget-owner-terminal.mjs
// stands in for one, as it does for `budget unlock`.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyChange } from "../../src/cli/owner-settings.js";
import { defaultOwnerSettings, settingsPayload, settingsSignedAt, signatureRecord } from "../../src/core/owner-settings.js";
import { accountHomeWith } from "../helpers/owner-settings.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAIN = resolve(ROOT, "src/cli/main.ts");
const TERMINAL = resolve(ROOT, "test/helpers/budget-owner-terminal.mjs");
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const account = (s: object | null, opts?: { raw?: string }) => { const h = accountHomeWith(s, opts); homes.push(h); return h; };
const file = (h: string) => join(h, ".superstables", "owner", "settings.json");

function cli(args: string[], h: string, opts: { stdin?: string; terminal?: boolean; env?: Record<string, string> } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const env = { ...process.env, SUPERSTABLES_TEST_ACCOUNT_HOME: h, ...(opts.env ?? {}) };
    const imports = opts.terminal ? ["--import", TERMINAL] : [];
    const child = spawn(process.execPath, [...imports, "--import", "tsx", MAIN, "owner", "settings", ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => done({ code: code ?? 0, stdout, stderr }));
    child.stdin.end(opts.stdin ?? "");
  });
}

describe("changes", () => {
  it("need the owner's own terminal", async () => {
    const h = account(null);
    const r = await cli(["allow-staging", "on"], h, { stdin: "yes\n" });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("superstables owner settings: refused: changing the owner settings needs the owner's own terminal (stdin is not a terminal). Nothing was written.");
    expect(existsSync(file(h))).toBe(false);
  }, 60_000);

  it("write after yes, atomically, mode 0600", async () => {
    const h = account(null);
    const r = await cli(["allow-staging", "on"], h, { terminal: true, stdin: "yes\n" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("Type yes to write this change:");
    expect(r.stdout + r.stderr).toContain(`Wrote ${file(h)}.`);
    expect(JSON.parse(readFileSync(file(h), "utf8")).site.allowStaging).toBe(true);
    expect(statSync(file(h)).mode & 0o777).toBe(0o600);
  }, 60_000);

  it("warn, before and after, that a change breaks the signature on the settings", async () => {
    const h = account({ version: 1 });
    const payload = settingsPayload(defaultOwnerSettings(), { policyPath: join(h, "none"), retiredPath: join(h, "none") });
    writeFileSync(file(h), `${JSON.stringify({ version: 1, signature: signatureRecord({ scheme: "eip712", signer: "0x1111111111111111111111111111111111111111", signedAt: settingsSignedAt(), payload, value: `0x${"1".repeat(130)}` }) })}\n`, { mode: 0o600 });
    const r = await cli(["allow-staging", "on"], h, { terminal: true, stdin: "yes\n" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("this breaks your settings signature");
    expect(r.stderr).toContain("superstables owner settings sign");
    expect(r.stdout).toContain("it was removed. Run superstables owner settings sign to sign again.");
    expect(JSON.parse(readFileSync(file(h), "utf8")).signature).toBeUndefined();
  }, 60_000);

  it("write nothing for any other answer", async () => {
    const h = account({ version: 1 });
    const before = readFileSync(file(h), "utf8");
    const r = await cli(["allow-staging", "on"], h, { terminal: true, stdin: "no\n" });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("Confirmation did not match. Nothing was written.");
    expect(readFileSync(file(h), "utf8")).toBe(before);
  }, 60_000);

  it("show only hosts, never a path or key; --json too", async () => {
    const h = account(null);
    const w = await cli(["rpc", "base-sepolia", "https://a.example/key123", "https://b.example", "--quorum", "2"], h, { terminal: true, stdin: "yes\n" });
    expect(w.code, w.stderr).toBe(0);
    expect(w.stdout + w.stderr).not.toContain("key123");
    const s = await cli(["show"], h);
    expect(s.code).toBe(0);
    expect(s.stdout).toContain("rpc base-sepolia:");
    expect(s.stdout).toContain("https://a.example/…");
    expect(s.stdout + s.stderr).not.toContain("key123");
    const j = await cli(["show", "--json"], h);
    expect(j.stdout).not.toContain("key123");
    expect(JSON.parse(j.stdout)).toMatchObject({ present: true, rpc: { "base-sepolia": { hosts: ["https://a.example/…", "https://b.example"], quorum: 2 } } });
    expect(JSON.parse(readFileSync(file(h), "utf8")).rpc["base-sepolia"].urls[0]).toBe("https://a.example/key123");
  }, 60_000);

  it("show with no file says the defaults apply; the old variable is noted", async () => {
    const h = account(null);
    const s = await cli([], h, { env: { SUPERSTABLES_ALLOW_SITE: "https://x.example" } });
    expect(s.code).toBe(0);
    expect(s.stdout).toContain("(missing: built-in defaults apply)");
    expect(s.stdout).toContain("approval site: https://www.superstables.com (built-in)");
    expect(s.stdout).toContain("rpc: built-in for every chain");
    expect(s.stdout).toContain("SUPERSTABLES_ALLOW_SITE is set in this environment; it is no longer read");
  }, 60_000);

  it("refuse what is not allowed, and write nothing", async () => {
    const h = account(null);
    const a = await cli(["rpc", "base-sepolia", "http://rpc.example"], h, { terminal: true, stdin: "yes\n" });
    expect(a.code).toBe(2);
    const b = await cli(["rpc", "base", "https://x.example"], h, { terminal: true, stdin: "yes\n" });
    expect(b.code).toBe(2);
    expect(b.stderr).toContain("base-sepolia");
    const c = await cli(["site", "http://127.0.0.1:3000"], h, { terminal: true, stdin: "yes\n" });
    expect(c.code).toBe(2);
    expect(existsSync(file(h))).toBe(false);
  }, 60_000);

  it("a malformed file: show says why (exit 1); a change leaves it alone", async () => {
    const h = account(null, { raw: "{" });
    const s = await cli(["show"], h);
    expect(s.code).toBe(1);
    expect(s.stdout + s.stderr).toMatch(/cannot be used: it is not JSON/);
    const c = await cli(["allow-staging", "on"], h, { terminal: true, stdin: "yes\n" });
    expect(c.code).toBe(1);
    expect(readFileSync(file(h), "utf8")).toBe("{");
  }, 60_000);
});

describe("applyChange", () => {
  const base = () => defaultOwnerSettings();
  const next = (action: string, args: string[], opts: any = {}) => { const r: any = applyChange(base(), action, args, opts); expect(r.error, `${action} ${args}`).toBeUndefined(); return r; };
  it("covers every action", () => {
    expect(next("allow-staging", ["on"]).next.site.allowStaging).toBe(true);
    expect(next("allow-loopback", ["site", "on"]).next.site.allowLoopback).toBe(true);
    expect(next("allow-loopback", ["site", "on"]).warning).toContain("Use it on a development machine only.");
    expect(next("allow-loopback", ["rpc", "on"]).next.rpcEnv.allowLoopback).toBe(true);
    expect(next("allow-loopback", ["sellers", "on"]).next.sellers.allowLoopback).toBe(true);
    expect(next("allow-loopback", ["sellers", "off"]).warning).toBeUndefined();
    expect(next("site", ["https://x.example"]).next.site.origin).toBe("https://x.example");
    expect(next("site", [], { clear: true }).next.site.origin).toBe("https://www.superstables.com");
    const r = next("rpc", ["base-sepolia", "https://a.example", "https://b.example"], { ownNode: true, quorum: 2 });
    expect(r.next.rpc["base-sepolia"]).toEqual({ urls: ["https://a.example", "https://b.example"], ownNode: true, quorum: 2 });
    expect(next("rpc", ["moderato", "https://a.example"]).next.rpc["tempo-moderato"].urls).toEqual(["https://a.example"]);
    expect(next("rpc", ["devnet", "https://a.example"]).next.rpc["solana-devnet"].urls).toEqual(["https://a.example"]);
    const withRpc: any = { ...base(), rpc: { "base-sepolia": { urls: ["https://a.example"], ownNode: false, quorum: 2 } } };
    expect((applyChange(withRpc, "rpc", ["base-sepolia"], { clear: true }) as any).next.rpc).toEqual({});
    expect(next("allow-staging", ["on"]).before).not.toBe(next("allow-staging", ["on"]).after);
  });
  it("refuses the rest", () => {
    for (const [a, args] of [["bogus", []], ["allow-staging", ["maybe"]], ["allow-loopback", ["x", "on"]], ["rpc", ["base-sepolia"]], ["site", ["not a url"]], ["site", ["http://127.0.0.1:1"]]] as const) {
      expect((applyChange(base(), a, [...args], {}) as any).error, `${a} ${args}`).toBeDefined();
    }
  });
});
