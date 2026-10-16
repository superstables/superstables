// The cap lock is on disk before it can become the lock: its temporary file is flushed (fsync) before it is linked into
// place, and a flush that fails stops the take, leaving no lock and no temporary file behind.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The budget's paths are fixed when they load, so its home is set before any import.
const io = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "superstables-lockdur-home-"));
  process.env.SUPERSTABLES_HOME = home;
  return { home, events: [] as string[], paths: new Map<number, string>(), failOn: null as RegExp | null };
});

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    const fd = actual.openSync(...args);
    io.paths.set(fd, String(args[0]));
    return fd;
  }) as typeof actual.openSync;
  const fsyncSync = ((fd: number) => {
    const path = io.paths.get(fd);
    if (path !== undefined) io.events.push(`fsync ${basename(path)}`);
    if (path !== undefined && io.failOn?.test(path)) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
    return actual.fsyncSync(fd);
  }) as typeof actual.fsyncSync;
  const linkSync = ((from: string, to: string) => {
    io.events.push(`link ${basename(from)} -> ${basename(to)}`);
    return actual.linkSync(from, to);
  }) as typeof actual.linkSync;
  return { ...actual, default: { ...actual, openSync, fsyncSync, linkSync }, openSync, fsyncSync, linkSync };
});

import { claim, release, saveApproval } from "../../budget/approvals.mjs";
import { withFileLock } from "../../src/core/lock.js";
import { withRecoveryMutex } from "../../src/core/owner-recovery.mjs";

const lockPath = () => join(mkdtempSync(join(tmpdir(), "superstables-lockdur-")), "cap.lock");

beforeEach(() => {
  io.events.length = 0;
  io.paths.clear();
  io.failOn = null;
});
afterAll(() => rmSync(io.home, { recursive: true, force: true }));

describe("the lock file is flushed before it is taken", () => {
  it("fsyncs the temporary file before linking it into place", async () => {
    const path = lockPath();
    await withFileLock(path, () => "done");
    const fsync = io.events.findIndex((e) => /^fsync cap\.lock\.\d+\.[0-9a-f]+\.tmp$/.test(e));
    const link = io.events.findIndex((e) => /^link cap\.lock\.\d+\.[0-9a-f]+\.tmp -> cap\.lock$/.test(e));
    expect(fsync).toBeGreaterThanOrEqual(0);
    expect(link).toBeGreaterThan(fsync);
  });

  it("stops, leaving no lock and no temporary file, when the flush fails", async () => {
    const path = lockPath();
    io.failOn = /\.tmp$/;
    let ran = false;
    await expect(
      withFileLock(path, () => {
        ran = true;
      }),
    ).rejects.toThrow(/EIO/);
    expect(ran).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(path, ".."))).toEqual([]);
  });
});

describe("the recovery mutex is flushed before it is taken", () => {
  it("fsyncs the temporary file before linking it into place", () => {
    const path = join(mkdtempSync(join(tmpdir(), "superstables-lockdur-")), "cap.lock.break");
    expect(withRecoveryMutex(path, () => "done", {})).toBe("done");
    const fsync = io.events.findIndex((e) => /^fsync cap\.lock\.break\.[0-9a-f-]+\.tmp$/.test(e));
    const link = io.events.findIndex((e) => /^link cap\.lock\.break\.[0-9a-f-]+\.tmp -> cap\.lock\.break$/.test(e));
    expect(fsync).toBeGreaterThanOrEqual(0);
    expect(link).toBeGreaterThan(fsync);
  });

  it("stops, leaving no mutex and no temporary file, when the flush fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "superstables-lockdur-"));
    io.failOn = /\.tmp$/;
    let ran = false;
    expect(() =>
      withRecoveryMutex(join(dir, "cap.lock.break"), () => {
        ran = true;
      }, {}),
    ).toThrow(/EIO/);
    expect(ran).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("the approval record lock is flushed before it is taken", () => {
  const id = "oa-20261016120000-abcdef12";
  const dir = () => join(io.home, "budget", "approvals");
  beforeEach(() => rmSync(dir(), { recursive: true, force: true }));

  it("fsyncs the temporary file before linking it into place", () => {
    saveApproval({ id, rail: "evm", chain: "base-sepolia" });
    const tmp = `${id}\\.json\\.lock\\.\\d+\\.[0-9a-f]+\\.tmp`;
    const fsync = io.events.findIndex((e) => new RegExp(`^fsync ${tmp}$`).test(e));
    const link = io.events.findIndex((e) => new RegExp(`^link ${tmp} -> ${id}\\.json\\.lock$`).test(e));
    expect(fsync).toBeGreaterThanOrEqual(0);
    expect(link).toBeGreaterThan(fsync);
  });

  it("stops, leaving no lock, no temporary file and no record, when the flush fails", () => {
    // only the lock's own file fails, so the record's own write cannot be what stops it
    io.failOn = /\.json\.lock\.\d+\.[0-9a-f]+\.tmp$/;
    expect(() => saveApproval({ id, rail: "evm", chain: "base-sepolia" })).toThrow(/EIO/);
    expect(readdirSync(dir())).toEqual([]);
  });
});

describe("the chain claim is flushed before it is taken", () => {
  beforeEach(() => rmSync(join(io.home, "budget", "approvals"), { recursive: true, force: true }));

  it("fsyncs the temporary file before linking it into place", () => {
    expect(claim("evm", "base-sepolia", "oa-20261016120000-abcdef12")).toEqual({ ok: true });
    release("evm", "base-sepolia", "oa-20261016120000-abcdef12");
    const tmp = "active-evm-base-sepolia\\.\\d+\\.[0-9a-f]+\\.tmp";
    const fsync = io.events.findIndex((e) => new RegExp(`^fsync ${tmp}$`).test(e));
    const link = io.events.findIndex((e) => new RegExp(`^link ${tmp} -> active-evm-base-sepolia$`).test(e));
    expect(fsync).toBeGreaterThanOrEqual(0);
    expect(link).toBeGreaterThan(fsync);
  });

  it("stops, leaving no claim and no temporary file, when the flush fails", () => {
    io.failOn = /active-evm-base-sepolia\.\d+\.[0-9a-f]+\.tmp$/;
    expect(() => claim("evm", "base-sepolia", "oa-20261016120000-abcdef12")).toThrow(/EIO/);
    expect(readdirSync(join(io.home, "budget", "approvals"))).toEqual([]);
  });
});
