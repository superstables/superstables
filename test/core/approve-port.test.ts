// The browser approval page's port is chosen once per home, kept in <home>/approve-port (mode 0600), and tried first by
// every pay; a busy one gives way to a free port, and SUPERSTABLES_APPROVE_PORT still wins.
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signerFor } from "../../src/cli/signer.js";
import * as home from "../../src/core/home.js";
import { BrowserWalletSigner } from "../../src/core/signer/browser.js";

const posix = process.platform !== "win32";
const mode = (path: string) => statSync(path).mode & 0o777;
// Called through the module, so that on a client without it the test fails rather than the file not loading.
const approvePort = (dir: string, random?: () => number): number =>
  (home as unknown as { approvePort: (home?: string, random?: () => number) => number }).approvePort(dir, random);

let tmp: string;
let saved: Record<string, string | undefined>;
const ENV = ["SUPERSTABLES_HOME", "SUPERSTABLES_APPROVE_PORT", "SUPERSTABLES_WALLET"];
const signers: BrowserWalletSigner[] = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ss-approve-port-"));
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
});
afterEach(async () => {
  while (signers.length > 0) await signers.pop()!.close();
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function occupy(): Promise<{ port: number; close: () => Promise<void> }> {
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const address = holder.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: () => new Promise<void>((resolve) => holder.close(() => resolve())),
  };
}

async function freePort(): Promise<number> {
  const held = await occupy();
  await held.close();
  return held.port;
}

describe("approvePort: one port per home", () => {
  it("is chosen in 20000-29999 on first use, kept at mode 0600, and stable across calls", () => {
    const dir = join(tmp, "home");
    const first = approvePort(dir);
    expect(first).toBeGreaterThanOrEqual(20_000);
    expect(first).toBeLessThanOrEqual(29_999);
    expect(readFileSync(join(dir, "approve-port"), "utf8").trim()).toBe(String(first));
    if (posix) expect(mode(join(dir, "approve-port"))).toBe(0o600);
    expect(approvePort(dir, () => 25_555)).toBe(first);
  });

  it("gives two homes their own ports", () => {
    expect(approvePort(join(tmp, "a"), () => 21_000)).toBe(21_000);
    expect(approvePort(join(tmp, "b"), () => 22_000)).toBe(22_000);
    expect(approvePort(join(tmp, "a"), () => 23_000)).toBe(21_000);
  });

  it.runIf(posix)("replaces a file other users can read with a fresh one at 0600", () => {
    const dir = join(tmp, "home");
    approvePort(dir, () => 21_000);
    const file = join(dir, "approve-port");
    chmodSync(file, 0o644);
    expect(approvePort(dir, () => 24_000)).toBe(24_000);
    expect(mode(file)).toBe(0o600);
  });

  it("replaces a file that does not hold a port", () => {
    for (const [i, contents] of ["99999\n", "abc\n", "", "20000 20001\n"].entries()) {
      const dir = join(tmp, `home-${i}`);
      approvePort(dir, () => 21_000);
      const file = join(dir, "approve-port");
      writeFileSync(file, contents, { mode: 0o600 });
      expect(approvePort(dir, () => 26_000)).toBe(26_000);
      expect(readFileSync(file, "utf8").trim()).toBe("26000");
      if (posix) expect(mode(file)).toBe(0o600);
    }
  });

  it.runIf(posix)("refuses a symlinked file and leaves it, and what it points to, alone", () => {
    const dir = join(tmp, "home");
    approvePort(dir, () => 21_000);
    const file = join(dir, "approve-port");
    const elsewhere = join(tmp, "elsewhere");
    writeFileSync(elsewhere, "27000\n", { mode: 0o600 });
    rmSync(file);
    symlinkSync(elsewhere, file);
    expect(() => approvePort(dir, () => 28_000)).toThrow(/symlink/);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(elsewhere, "utf8")).toBe("27000\n");
  });
});

describe("signerFor() in browser mode", () => {
  it("tries the home's own port first", async () => {
    process.env.SUPERSTABLES_HOME = join(tmp, "home");
    const preferred = await freePort();
    approvePort(join(tmp, "home"));
    writeFileSync(join(tmp, "home", "approve-port"), `${preferred}\n`, { mode: 0o600 });
    const signer = signerFor("browser") as BrowserWalletSigner;
    signers.push(signer);
    await signer.start();
    expect(Number(new URL(signer.url).port)).toBe(preferred);
    expect(signer.movedFrom).toBeUndefined();
  });

  it("writes the home's port on first use", async () => {
    process.env.SUPERSTABLES_HOME = join(tmp, "home");
    const signer = signerFor("browser") as BrowserWalletSigner;
    signers.push(signer);
    await signer.start();
    const kept = Number(readFileSync(join(tmp, "home", "approve-port"), "utf8").trim());
    expect(kept).toBeGreaterThanOrEqual(20_000);
    expect(kept).toBeLessThanOrEqual(29_999);
    // the kept port, or a free one when something else held it
    expect(signer.movedFrom === undefined ? Number(new URL(signer.url).port) : signer.movedFrom).toBe(kept);
  });

  it("takes any free port with SUPERSTABLES_APPROVE_PORT=0", async () => {
    process.env.SUPERSTABLES_HOME = join(tmp, "home");
    const preferred = await freePort();
    approvePort(join(tmp, "home"));
    writeFileSync(join(tmp, "home", "approve-port"), `${preferred}\n`, { mode: 0o600 });
    process.env.SUPERSTABLES_APPROVE_PORT = "0";
    const signer = signerFor("browser") as BrowserWalletSigner;
    signers.push(signer);
    await signer.start();
    expect(Number(new URL(signer.url).port)).not.toBe(preferred);
    expect(signer.movedFrom).toBeUndefined();
  });

  it("moves to a free port when the home's port is busy, and says which one was", async () => {
    process.env.SUPERSTABLES_HOME = join(tmp, "home");
    const holder = await occupy();
    try {
      approvePort(join(tmp, "home"));
      writeFileSync(join(tmp, "home", "approve-port"), `${holder.port}\n`, { mode: 0o600 });
      const signer = signerFor("browser") as BrowserWalletSigner;
      signers.push(signer);
      await signer.start();
      expect(Number(new URL(signer.url).port)).not.toBe(holder.port);
      expect(signer.movedFrom).toBe(holder.port);
    } finally {
      await holder.close();
    }
  });
});
