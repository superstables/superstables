// The wallet key at rest: encrypted with a passphrase, replaced keys overwritten in place, secrets read through the
// checked reader.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptKey,
  encryptKey,
  encryptKeyFile,
  initKey,
  keyFileAddress,
  keyPath,
  keyStorage,
  loadAccount,
  parseKeyFile,
  readOrCreateSecret,
} from "../../src/wallet/keystore.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PASS = "correct horse battery";
const OLD_KEY = `0x${"ab".repeat(32)}` as const;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "superstables-keystore-enc-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("an encrypted key file", () => {
  it("holds an envelope that does not contain the key, and loads with the passphrase", () => {
    const made = initKey({ dir, importKey: OLD_KEY, passphrase: PASS });
    expect(made.encrypted).toBe(true);
    const text = readFileSync(keyPath(dir), "utf8");
    expect(text).not.toContain("ab".repeat(32));
    const parsed = parseKeyFile(text);
    expect(parsed.kind).toBe("encrypted");
    expect(loadAccount(dir, PASS).address).toBe(made.address);
    expect(made.address).toBe(privateKeyToAccount(OLD_KEY).address);
    expect(keyStorage(dir)).toBe("encrypted");
    expect((statSync(keyPath(dir)).mode & 0o777)).toBe(0o600);
  });

  it("asks for the passphrase when there is none, and refuses a wrong one, also when the address or the ciphertext was edited", () => {
    initKey({ dir, importKey: OLD_KEY, passphrase: PASS });
    expect(() => loadAccount(dir)).toThrow(/the wallet key is encrypted: start `superstables wallet serve` in a terminal/);
    expect(() => loadAccount(dir, "not the passphrase")).toThrow(/the passphrase is not right/);

    const parsed = parseKeyFile(readFileSync(keyPath(dir), "utf8"));
    if (parsed.kind !== "encrypted") throw new Error("expected an envelope");
    const other = encryptKey(`0x${"cd".repeat(32)}`, PASS);

    const edited = { ...parsed.envelope, address: other.address };
    expect(() => decryptKey(edited, PASS)).toThrow(/the passphrase is not right/);
    const swapped = { ...parsed.envelope, ct: other.ct };
    expect(() => decryptKey(swapped, PASS)).toThrow(/the passphrase is not right/);
    // the genuine envelope still opens
    expect(decryptKey(parsed.envelope, PASS)).toBe(OLD_KEY);
  });

  it("refuses planted parameters before it runs scrypt", () => {
    const good = encryptKey(OLD_KEY, PASS);
    const huge = { ...good, kdf: { ...good.kdf, N: 2 ** 30 } };
    const started = Date.now();
    expect(() => decryptKey(huge, PASS)).toThrow(/not a key file this client wrote|parameters/);
    expect(Date.now() - started).toBeLessThan(50);
    expect(() => decryptKey({ ...good, kdf: { ...good.kdf, r: 1 } }, PASS)).toThrow();
    expect(() => parseKeyFile(JSON.stringify({ ...good, kdf: { ...good.kdf, N: 2 ** 30 } }))).toThrow();
    expect(() => parseKeyFile(JSON.stringify({ ...good, extra: 1 }))).toThrow();
    expect(() => parseKeyFile(JSON.stringify({ ...good, address: "0x12" }))).toThrow();
    expect(() => parseKeyFile(JSON.stringify({ ...good, ct: Buffer.alloc(31).toString("base64") }))).toThrow();
  });

  it("gives the address without a passphrase", () => {
    const made = initKey({ dir, passphrase: PASS });
    expect(keyFileAddress(dir)).toBe(made.address);
    const plain = mkdtempSync(join(tmpdir(), "superstables-keystore-plain-test-"));
    try {
      const p = initKey({ dir: plain });
      expect(keyFileAddress(plain)).toBe(p.address);
      expect(keyStorage(plain)).toBe("plaintext");
      expect(keyStorage(join(plain, "nowhere"))).toBe("absent");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("replacing a key overwrites the old bytes in place", () => {
  it("--force leaves nothing of the old key in a hard link to the old file", () => {
    initKey({ dir, importKey: OLD_KEY });
    const link = join(dir, "old-link");
    linkSync(keyPath(dir), link);
    expect(readFileSync(link, "utf8")).toContain("ab".repeat(32));
    const result = initKey({ dir, force: true, passphrase: PASS });
    expect(result.overwritten).toBe(true);
    const left = readFileSync(link);
    expect(left.toString("utf8")).not.toContain("ab");
    expect(left.every((byte) => byte === 0)).toBe(true);
    expect(loadAccount(dir, PASS).address).toBe(result.address);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("--force over a symlink writes nothing through it", () => {
    const target = join(dir, "target");
    writeFileSync(target, "keep me", { mode: 0o600 });
    symlinkSync(target, keyPath(dir));
    const result = initKey({ dir, force: true });
    expect(result.overwritten).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("keep me");
    expect(statSync(keyPath(dir)).isSymbolicLink()).toBe(false);
  });

  it("encrypts an existing plaintext key and zeroes the old file", () => {
    const made = initKey({ dir, importKey: OLD_KEY });
    const link = join(dir, "old-link");
    linkSync(keyPath(dir), link);
    const result = encryptKeyFile(dir, PASS);
    expect(result.address).toBe(made.address);
    expect(result.overwritten).toBe(true);
    expect(keyStorage(dir)).toBe("encrypted");
    expect(loadAccount(dir, PASS).address).toBe(made.address);
    expect(readFileSync(link).every((byte) => byte === 0)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(() => encryptKeyFile(dir, PASS)).toThrow(/already encrypted/);
    expect(() => encryptKeyFile(join(dir, "nowhere"), PASS)).toThrow(/no wallet key yet/);
  });
});

describe("readOrCreateSecret reads through the checked reader", () => {
  it("answers at once for a FIFO instead of waiting for a writer", () => {
    const fifo = join(dir, "owner-secret");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    const code = `import { readOrCreateSecret } from ${JSON.stringify(resolve(ROOT, "src/wallet/keystore.ts"))};
try { readOrCreateSecret(${JSON.stringify(fifo)}); console.log("returned"); } catch (err) { console.log(String(err.message)); }`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: ROOT, timeout: 10_000, encoding: "utf8" });
    expect(child.error).toBeUndefined();
    expect(child.stdout).toContain("is not a regular file");
  });

  it("refuses a secret other users can read instead of quietly tightening it", () => {
    const path = join(dir, "owner-secret");
    writeFileSync(path, "abc123\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(() => readOrCreateSecret(path)).toThrow(/chmod 600/);
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });
});

describe("a key that cannot be overwritten is still replaced, and reported", () => {
  it("--force and encrypt replace a read-only (0400) key and zero its hard link", () => {
    initKey({ dir, importKey: OLD_KEY });
    const link = join(dir, "old-link");
    linkSync(keyPath(dir), link);
    chmodSync(keyPath(dir), 0o400);
    const forced = initKey({ dir, force: true, passphrase: PASS });
    expect(forced.overwritten).toBe(true);
    expect(readFileSync(link).every((byte) => byte === 0)).toBe(true);
    expect(loadAccount(dir, PASS).address).toBe(forced.address);

    rmSync(link);
    initKey({ dir, importKey: OLD_KEY, force: true });
    linkSync(keyPath(dir), link);
    chmodSync(keyPath(dir), 0o400);
    const encrypted = encryptKeyFile(dir, PASS);
    expect(encrypted.overwritten).toBe(true);
    expect(readFileSync(link).every((byte) => byte === 0)).toBe(true);
    expect(loadAccount(dir, PASS).address).toBe(encrypted.address);
  });

  it("names the symlink and its target when the old key was one", () => {
    const vault = join(dir, "vault");
    writeFileSync(vault, `${OLD_KEY}\n`, { mode: 0o600 });
    symlinkSync(vault, keyPath(dir));
    const result = encryptKeyFile(dir, PASS);
    expect(result.overwritten).toBe(false);
    expect(result.notOverwritten).toContain(keyPath(dir));
    expect(result.notOverwritten).toContain(vault);
    expect(readFileSync(vault, "utf8")).toBe(`${OLD_KEY}\n`);
    expect(loadAccount(dir, PASS).address).toBe(result.address);

    const forced = initKey({ dir: join(dir, "b"), force: true });
    expect(forced.notOverwritten).toBeUndefined(); // nothing there to overwrite
  });

  it("no old key, no warning", () => {
    expect(initKey({ dir, force: true }).notOverwritten).toBeUndefined();
  });
});

describe("what a crash leaves behind is pointed out wherever the key is read", () => {
  it("a zeroed key next to a .tmp says how to finish", () => {
    initKey({ dir, importKey: OLD_KEY });
    writeFileSync(join(dir, ".key.123.abcd1234.tmp"), "{}", { mode: 0o600 });
    writeFileSync(keyPath(dir), Buffer.alloc(67), { mode: 0o600 });
    expect(() => keyFileAddress(dir)).toThrow(/mv .*\.key\.123\.abcd1234\.tmp/);
  });
});

describe("the associated data does not depend on the order of the kdf keys", () => {
  it("opens an envelope whose kdf keys were reordered, and one written by v1 as before", () => {
    const good = encryptKey(OLD_KEY, PASS);
    const { salt, N, r, p, name } = good.kdf;
    const reordered = { ...good, kdf: { salt, p, r, N, name } };
    expect(decryptKey(reordered as typeof good, PASS)).toBe(OLD_KEY);
    expect(Object.keys(good.kdf)).toEqual(["name", "N", "r", "p", "salt"]);
  });
});
