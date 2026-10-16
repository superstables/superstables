// An overwrite that fails partway must never cost the owner the new key: the rename happens anyway.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ keyFds: new Set<number>(), failFsync: false }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    openSync: (path: string, flags: number, ...rest: number[]) => {
      const fd = (real.openSync as (...a: unknown[]) => number)(path, flags, ...rest);
      if (String(path).endsWith("/key") && (flags & real.constants.O_WRONLY) !== 0) state.keyFds.add(fd);
      return fd;
    },
    fsyncSync: (fd: number) => {
      if (state.failFsync && state.keyFds.has(fd)) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      return real.fsyncSync(fd);
    },
  };
});

import { encryptKeyFile, initKey, keyPath, loadAccount } from "../../src/wallet/keystore.js";

const PASS = "correct horse battery";
const OLD_KEY = `0x${"ab".repeat(32)}` as const;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "superstables-keystore-fail-test-"));
  state.keyFds.clear();
  state.failFsync = false;
});
afterEach(() => {
  state.failFsync = false;
  rmSync(dir, { recursive: true, force: true });
});

describe("when flushing the zeroed old key fails", () => {
  it("wallet encrypt still puts the new key in place and says the old one was not overwritten", () => {
    initKey({ dir, importKey: OLD_KEY });
    state.failFsync = true;
    const result = encryptKeyFile(dir, PASS);
    state.failFsync = false;
    expect(result.overwritten).toBe(false);
    expect(result.notOverwritten).toMatch(/EIO/);
    expect(loadAccount(dir, PASS).address).toBe(result.address);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("--force still puts the new key in place", () => {
    initKey({ dir, importKey: OLD_KEY });
    state.failFsync = true;
    const result = initKey({ dir, force: true, passphrase: PASS });
    state.failFsync = false;
    expect(result.overwritten).toBe(false);
    expect(result.notOverwritten).toMatch(/EIO/);
    expect(loadAccount(dir, PASS).address).toBe(result.address);
    expect(keyPath(dir)).toContain(dir);
  });
});
