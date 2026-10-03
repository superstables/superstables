// budget/secret-file.mjs: how every rail reads and rewrites a file that holds a private key.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UNSAFE_SECRET_FILE, readSecretFile, replaceSecretFile } from "../../budget/secret-file.mjs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ss-secret-file-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code;
  }
  return undefined;
};

describe("readSecretFile", () => {
  it("reads a 0600 file, also through a symlink, and refuses one others can read", () => {
    const real = join(dir, "agent.env");
    writeFileSync(real, "K=v\n", { mode: 0o600 });
    const link = join(dir, "link.env");
    symlinkSync(real, link);
    expect(readSecretFile(link, "the agent key file")).toBe("K=v\n");
    chmodSync(real, 0o640);
    expect(() => readSecretFile(link, "the agent key file")).toThrow(/can be read by other users on this machine: chmod 600/);
    expect(codeOf(() => readSecretFile(link, "the agent key file"))).toBe(UNSAFE_SECRET_FILE);
  });

  it("refuses a FIFO without waiting for a writer; a missing file is ENOENT", () => {
    const fifo = join(dir, "agent.fifo");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    expect(() => readSecretFile(fifo, "the agent key file")).toThrow(/is not a regular file/);
    expect(codeOf(() => readSecretFile(join(dir, "none"), "the agent key file"))).toBe("ENOENT");
  });
});

describe("replaceSecretFile", () => {
  it("replaces a file others could read with a new 0600 file, never writing into the old one", () => {
    const path = join(dir, "agent.env");
    writeFileSync(path, "OLD=1\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    const before = statSync(path).ino;
    replaceSecretFile(path, "NEW=2\n");
    expect(statSync(path).ino).not.toBe(before);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("NEW=2\n");
    expect(readdirSync(dir)).toEqual(["agent.env"]);
  });

  it("keeps writing after a short write, so the whole key lands", () => {
    const path = join(dir, "agent.env");
    // a writeSync that never writes more than 3 bytes at a time, as a nearly full disk might
    const trickle = ((fd: number, buf: Buffer, off: number, len: number) => writeSync(fd, buf, off, Math.min(3, len))) as unknown as typeof writeSync;
    replaceSecretFile(path, "KEY=0123456789abcdef\n", { writeSync: trickle });
    expect(readFileSync(path, "utf8")).toBe("KEY=0123456789abcdef\n");
  });

  it("a write that stops short leaves the original key file untouched and no temporary file behind", () => {
    const path = join(dir, "agent.env");
    writeFileSync(path, "OLD=the only copy\n", { mode: 0o600 });
    let calls = 0;
    // writes 5 bytes, then nothing: what a file-size limit does
    const stuck = ((fd: number, buf: Buffer, off: number, len: number) => (calls++ === 0 ? writeSync(fd, buf, off, Math.min(5, len)) : 0)) as unknown as typeof writeSync;
    expect(() => replaceSecretFile(path, "NEW=a much longer key line\n", { writeSync: stuck })).toThrow(/short write: 5 of/);
    expect(readFileSync(path, "utf8")).toBe("OLD=the only copy\n");
    expect(readdirSync(dir)).toEqual(["agent.env"]);
  });
});
