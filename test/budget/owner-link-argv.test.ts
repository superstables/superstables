// The owner approval link is a capability, so it never goes on a command line, where every user on the machine can read it
// (ps, /proc/*/cmdline). The browser is given only the path of a launcher file that redirects to the link. The real
// dispatcher against a stub opener on PATH, and the launcher module on its own. Loopback only, no real key.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLink, removeLauncher, writeLauncher } from "../../src/core/owner-launcher.mjs";
import { startFakeSite, type FakeSite } from "../helpers/fake-site.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const posix = process.platform !== "win32";

let tmp: string;
let home: string;
let opened: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ss-owner-link-"));
  home = join(tmp, "home");
  mkdirSync(home);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  opened = join(tmp, "opener.log");
  // a stub opener: logs its argv, and the mode of its argument and of that argument's folder, then lingers like a browser
  const stub = `#!/bin/sh\n{ printf 'ARGC %s\\n' "$#"; for a in "$@"; do printf 'ARG %s\\n' "$a"; done\n  [ -f "$1" ] && { printf 'FILEMODE %s\\n' "$(stat -c %a "$1")"; printf 'DIRMODE %s\\n' "$(stat -c %a "$(dirname "$1")")"; cat "$1"; }\n} >> "$OPENER_LOG"\n`;
  for (const name of ["xdg-open", "open"]) writeFileSync(join(bin, name), stub, { mode: 0o755 });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

type Run = { code: number | null; stdout: string; stderr: string; opener: string };
/** Runs `budget <args>` with the stub opener first on PATH. `until` decides when to end the run: it gets the output so far. */
function budget(args: string[], opts: { env?: Record<string, string | undefined>; until?: (out: string, opener: string) => boolean; end?: (out: string, child: ReturnType<typeof spawn>) => Promise<void> | void } = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, SUPERSTABLES_HOME: home, PATH: `${join(tmp, "bin")}:${process.env.PATH}`, OPENER_LOG: opened };
    for (const k of ["VITEST", "SSH_CONNECTION", "SSH_TTY", "SUPERSTABLES_SITE", "SUPERSTABLES_BUDGET_APPROVAL_ID"]) delete env[k];
    Object.assign(env, opts.env);
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    let ended = false;
    const log = () => (existsSync(opened) ? readFileSync(opened, "utf8") : "");
    const poll = setInterval(() => {
      if (ended || !opts.until || !opts.until(stdout, log())) return;
      ended = true;
      void Promise.resolve(opts.end?.(stdout, child)).catch(fail);
    }, 50);
    const kill = setTimeout(() => child.kill("SIGKILL"), 25_000);
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      clearInterval(poll);
      clearTimeout(kill);
      done({ code, stdout, stderr, opener: log() });
    });
  });
}
const approveUrl = (out: string): string | undefined => {
  const line = out.split("\n").find((l) => l.startsWith("APPROVE "));
  return line ? JSON.parse(line.slice(8)).url : undefined;
};
const argsOf = (log: string) => log.split("\n").filter((l) => l.startsWith("ARG ")).map((l) => l.slice(4));

describe("the owner link in a real command", () => {
  it.skipIf(!posix)("gives the opener a launcher file path, never the link", async () => {
    const run = await budget(["setup", "--rail", "evm", "--wait", "--timeout", "10"], {
      until: (out, log) => approveUrl(out) !== undefined && log.includes("</script>"),
      end: async (out) => {
        const url = approveUrl(out)!;
        await fetch(`${url}/reject`, { method: "POST", headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: "{}" });
      },
    });
    expect(run.code, run.stderr).toBe(3);
    const url = approveUrl(run.stdout)!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/owner\/[0-9a-f]{32}$/);
    const args = argsOf(run.opener);
    expect(args, run.opener).toHaveLength(1);
    expect(args[0].startsWith(join(home, "Superstables-budget-open", "link-"))).toBe(true);
    const id = url.split("/").pop()!;
    for (const needle of ["/owner/", id, "#", "127.0.0.1"]) expect(args[0]).not.toContain(needle);
    expect(run.opener).toContain("FILEMODE 600");
    expect(run.opener).toContain("DIRMODE 700");
    // the file did send the browser to the link
    expect(run.opener).toContain(`location.replace(${JSON.stringify(url)})`);
    // and nothing is left behind once the command has ended
    expect(existsSync(join(home, "Superstables-budget-open"))).toBe(false);
  }, 40_000);

  it("--no-open runs no opener, and the APPROVE line is the same", async () => {
    const run = await budget(["setup", "--rail", "evm", "--wait", "--timeout", "10", "--no-open"], {
      until: (out) => approveUrl(out) !== undefined,
      end: async (out) => {
        const url = approveUrl(out)!;
        await fetch(`${url}/reject`, { method: "POST", headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: "{}" });
      },
    });
    expect(run.code, run.stderr).toBe(3);
    expect(approveUrl(run.stdout)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/owner\/[0-9a-f]{32}$/);
    expect(existsSync(opened)).toBe(false);
    expect(existsSync(join(home, "Superstables-budget-open"))).toBe(false);
  }, 40_000);

  it("opens no browser under a test run (VITEST set), without --no-open", async () => {
    const run = await budget(["setup", "--rail", "evm", "--wait", "--timeout", "10"], {
      env: { VITEST: "true" },
      until: (out) => approveUrl(out) !== undefined,
      end: async (out) => {
        const url = approveUrl(out)!;
        await new Promise((r) => setTimeout(r, 500));
        await fetch(`${url}/reject`, { method: "POST", headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: "{}" });
      },
    });
    expect(run.code, run.stderr).toBe(3);
    expect(existsSync(opened)).toBe(false);
  }, 40_000);
});

describe.skipIf(!posix)("the hosted link", () => {
  let site: FakeSite;
  beforeEach(async () => {
    site = await startFakeSite();
    site.approvalUrl = (id) => `${site.url}/approve/budget/${id}#ssba_test_owner0001`;
  });
  afterEach(() => site.close());

  it("keeps the fragment token out of argv too", async () => {
    const run = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--wait", "--timeout", "10"], {
      until: (out, log) => approveUrl(out) !== undefined && log.includes("</script>"),
      end: (_out, child) => void child.kill("SIGTERM"),
    });
    const args = argsOf(run.opener);
    expect(args, run.opener + run.stderr).toHaveLength(1);
    expect(args[0].startsWith(join(home, "Superstables-budget-open", "link-"))).toBe(true);
    for (const needle of ["#", "ssba_", "/approve/", "127.0.0.1"]) expect(args[0]).not.toContain(needle);
    expect(approveUrl(run.stdout)).toMatch(/#ssba_test_owner0001$/);
    // the launcher carries the whole link, fragment included
    expect(run.opener).toContain(`location.replace(${JSON.stringify(approveUrl(run.stdout))})`);
  }, 40_000);
});

describe("writeLauncher and openLink", () => {
  const dirIn = () => join(tmp, "Superstables-budget-open");

  it("writes a hosted link, fragment and all, verbatim into location.replace", () => {
    const url = "https://www.superstables.com/approve/budget/x#tok";
    const path = writeLauncher(dirIn(), url);
    const html = readFileSync(path, "utf8");
    expect(html).toContain(`location.replace(${JSON.stringify(url)});`);
    expect(html).toContain("<title>Superstables approval</title>");
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain("<p>Opening the approval page&hellip;</p>");
    if (posix) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirIn()).mode & 0o777).toBe(0o700);
    }
  });

  it("escapes < so a link cannot close the script element", () => {
    const path = writeLauncher(dirIn(), "http://127.0.0.1:1/owner/a</script><script>alert(1)</script>");
    const html = readFileSync(path, "utf8");
    expect(html).toContain("\\u003c/script>");
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it.skipIf(!posix)("refuses a symlinked folder and writes nothing in its target", () => {
    const target = join(tmp, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, dirIn());
    expect(() => writeLauncher(dirIn(), "http://127.0.0.1:1/owner/x")).toThrow(/is a symlink/);
    expect(readdirSync(target)).toEqual([]);
  });

  it.skipIf(!posix)("refuses a folder other users can write to, and never calls the opener", () => {
    mkdirSync(dirIn(), { mode: 0o777 });
    chmodSync(dirIn(), 0o777);
    expect(() => writeLauncher(dirIn(), "http://127.0.0.1:1/owner/x")).toThrow(/other users can write/);
    expect(readdirSync(dirIn())).toEqual([]);
    const calls: string[] = [];
    const r = openLink("http://127.0.0.1:1/owner/x", { dir: dirIn(), opener: (p: string) => calls.push(p) });
    expect(r).toEqual({ problem: expect.stringMatching(/other users can write/) });
    expect(calls).toEqual([]);
  });

  it.skipIf(!posix)("returns a problem for an unwritable folder, and the opener is not called", () => {
    mkdirSync(dirIn(), { mode: 0o500 });
    chmodSync(dirIn(), 0o500);
    const calls: string[] = [];
    const r = openLink("http://127.0.0.1:1/owner/x", { dir: dirIn(), opener: (p: string) => calls.push(p) });
    chmodSync(dirIn(), 0o700);
    // as root a folder is always writable
    if (process.getuid?.() === 0) return;
    expect(r).toHaveProperty("problem");
    expect(calls).toEqual([]);
  });

  it("hands the opener only the file path", () => {
    const calls: string[] = [];
    const r = openLink("https://www.superstables.com/approve/budget/x#tok", { dir: dirIn(), opener: (p: string) => calls.push(p) });
    expect(r).toEqual({ path: expect.stringContaining("link-") });
    expect(calls).toEqual([(r as { path: string }).path]);
    expect(calls[0]).not.toContain("#");
  });

  it("removes a launcher left by a dead command, and keeps one of this process", () => {
    mkdirSync(dirIn(), { mode: 0o700 });
    const dead = join(dirIn(), "link-999999999-abcdef0123456789.html");
    const mine = join(dirIn(), `link-${process.pid}-abcdef0123456789.html`);
    const other = join(dirIn(), "notes.txt");
    for (const p of [dead, mine, other]) writeFileSync(p, "x", { mode: 0o600 });
    const fresh = writeLauncher(dirIn(), "http://127.0.0.1:1/owner/x");
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  it("removeLauncher removes the file, then the empty folder", () => {
    const path = writeLauncher(dirIn(), "http://127.0.0.1:1/owner/x");
    expect(removeLauncher(path, dirIn())).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirIn())).toBe(false);
    // already gone is fine
    expect(removeLauncher(path, dirIn())).toBe(true);
  });

  it("removeLauncher keeps a folder that still holds another file", () => {
    const a = writeLauncher(dirIn(), "http://127.0.0.1:1/owner/a");
    const b = writeLauncher(dirIn(), "http://127.0.0.1:1/owner/b");
    removeLauncher(a, dirIn());
    expect(existsSync(b)).toBe(true);
    expect(existsSync(dirIn())).toBe(true);
  });

  it("leaves no file behind when the flush fails", () => {
    const io = { fsyncSync: () => { throw Object.assign(new Error("EIO: flush failed"), { code: "EIO" }); } };
    expect(() => writeLauncher(dirIn(), "http://127.0.0.1:1/owner/x", io)).toThrow(/EIO/);
    expect(existsSync(dirIn()) ? readdirSync(dirIn()) : []).toEqual([]);
    const r = openLink("http://127.0.0.1:1/owner/x", { dir: dirIn(), opener: () => { throw new Error("opener must not run"); }, io });
    expect(r).toHaveProperty("problem");
  });
});
