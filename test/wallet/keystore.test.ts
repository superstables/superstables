// The key file: created once, never overwritten by accident, readable by nobody else.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initKey, keyExists, keyPath, loadAccount, readOrCreateSecret, readSecretFile, writeSecretFile } from "../../src/wallet/keystore.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "superstables-keystore-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ownerOnly = (path: string) => (statSync(path).mode & 0o777) === 0o600;

describe("initKey", () => {
  it("generates a key only the owner can read", () => {
    expect(keyExists(dir)).toBe(false);
    const created = initKey({ dir });
    expect(created.created).toBe(true);
    expect(created.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(keyExists(dir)).toBe(true);
    expect(ownerOnly(keyPath(dir))).toBe(true);
    expect(loadAccount(dir).address).toBe(created.address);
  });

  it("imports a key, with or without the 0x prefix", () => {
    const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const imported = initKey({ dir, importKey: key.slice(2) });
    expect(imported.created).toBe(false);
    expect(imported.address).toBe(privateKeyToAccount(key as `0x${string}`).address);
  });

  it("refuses to overwrite an existing key unless asked twice", () => {
    const first = initKey({ dir });
    expect(() => initKey({ dir })).toThrow(/already exists/);
    expect(loadAccount(dir).address).toBe(first.address);
    const replaced = initKey({ dir, force: true });
    expect(replaced.address).not.toBe(first.address);
  });

  it("refuses something that is not a private key", () => {
    expect(() => initKey({ dir, importKey: "hunter2" })).toThrow(/not a private key/);
  });
});

describe("loadAccount", () => {
  it("says what to do when there is no key yet", () => {
    expect(() => loadAccount(dir)).toThrow("no wallet key yet: run `superstables wallet init`");
  });

  it("refuses to sign with a key other users on this machine can read", () => {
    const created = initKey({ dir });
    // Mode 600 is a fact about the moment it was written. A restore, a `cp` without -p or an editor can
    // undo it, and the signature after that is made with a key the machine no longer keeps to itself.
    chmodSync(keyPath(dir), 0o644);
    expect(() => loadAccount(dir)).toThrow(/can be read by other users on this machine: chmod 600/);
    // and it says so rather than quietly tightening it, so a copied key file is visible
    expect(statSync(keyPath(dir)).mode & 0o777).toBe(0o644);
    chmodSync(keyPath(dir), 0o600);
    expect(loadAccount(dir).address).toBe(created.address);
  });
});

describe("initKey --force over a key file others can read", () => {
  it("puts the new key in a new 0600 file renamed into place, never into the old file", () => {
    const old = keyPath(dir);
    writeFileSync(old, `0x${"11".repeat(32)}\n`, { mode: 0o644 });
    chmodSync(old, 0o644); // whatever the umask: a key restored from a backup, readable by everyone
    const before = statSync(old).ino;
    const created = initKey({ dir, force: true });
    // Writing into the old file would leave the new key readable by others until a chmod after it. A rename
    // gives the path a new inode that was 0600 from its first byte.
    expect(statSync(old).ino).not.toBe(before);
    expect(ownerOnly(old)).toBe(true);
    expect(readFileSync(old, "utf8")).not.toContain("11".repeat(32));
    expect(loadAccount(dir).address).toBe(created.address);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("writeSecretFile", () => {
  it("keeps writing after a short write, and a write that stops short leaves the original key untouched", () => {
    const path = keyPath(dir);
    const trickle = ((fd: number, buf: Buffer, off: number, len: number) => writeSync(fd, buf, off, Math.min(4, len))) as unknown as typeof writeSync;
    const key = `0x${"33".repeat(32)}\n`;
    writeSecretFile(path, key, { writeSync: trickle });
    expect(readFileSync(path, "utf8")).toBe(key);

    let calls = 0;
    const stuck = ((fd: number, buf: Buffer, off: number, len: number) => (calls++ === 0 ? writeSync(fd, buf, off, Math.min(5, len)) : 0)) as unknown as typeof writeSync;
    expect(() => writeSecretFile(path, `0x${"44".repeat(32)}\n`, { writeSync: stuck })).toThrow(/short write: 5 of 67 bytes/);
    expect(readFileSync(path, "utf8")).toBe(key);
    expect(readdirSync(dir)).toEqual(["key"]);
  });
});

describe("readSecretFile", () => {
  it("reads a 0600 regular file, also through a symlink, and checks the file it opened", () => {
    const real = join(dir, "real");
    writeFileSync(real, "secret\n", { mode: 0o600 });
    const link = join(dir, "link");
    symlinkSync(real, link);
    expect(readSecretFile(link, "the key file")).toBe("secret\n");
    chmodSync(real, 0o644);
    expect(() => readSecretFile(link, "the key file")).toThrow(/can be read by other users on this machine: chmod 600/);
  });

  it("refuses a FIFO at once instead of waiting for a writer, and a directory", () => {
    const fifo = join(dir, "fifo");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    expect(() => readSecretFile(fifo, "the key file")).toThrow(/is not a regular file/);
    const sub = join(dir, "sub");
    mkdirSync(sub, { mode: 0o700 });
    expect(() => readSecretFile(sub, "the key file")).toThrow(/is not a regular file/);
  });

  it("refuses a file far larger than a key", () => {
    const big = join(dir, "big");
    writeFileSync(big, "0".repeat(65 * 1024), { mode: 0o600 });
    expect(() => readSecretFile(big, "the key file")).toThrow(/larger than a key file/);
  });
});

describe("readOrCreateSecret", () => {
  it("creates a 32-byte secret once and reads the same one back", () => {
    const path = join(dir, "agent-token");
    const first = readOrCreateSecret(path);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(ownerOnly(path)).toBe(true);
    expect(readOrCreateSecret(path)).toBe(first);
  });

  it("makes a new secret when the file is deleted: how the owner replaces one (docs/security.md)", () => {
    const path = join(dir, "owner-secret");
    const first = readOrCreateSecret(path);
    rmSync(path);
    const second = readOrCreateSecret(path);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(ownerOnly(path)).toBe(true);
  });

  it("tightens the permissions of a secret that was left readable", () => {
    const path = join(dir, "owner-secret");
    writeFileSync(path, "abc123\n", { mode: 0o644 });
    expect(readOrCreateSecret(path)).toBe("abc123");
    expect(ownerOnly(path)).toBe(true);
  });
});
