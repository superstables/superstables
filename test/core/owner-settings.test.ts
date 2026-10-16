// The owner's settings (src/core/owner-settings.js): the approval site and the RPC endpoints that owner actions trust.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVM_CHAIN_KEYS } from "../../budget/evm/chains.mjs";
import { KNOWN_NETWORKS } from "../../src/core/chain.js";
import {
  OWNER_SETTINGS_UNREADABLE, RPC_CHAIN_KEYS, SETTINGS_FIELDS, budgetChainKey, defaultOwnerSettings, loopbackSellersAllowed,
  ownerSettingsPath, ownerSettingsProblem, parseOwnerSettings, readOwnerSettings, rpcFor, sameRpcUrl, shownUrl, siteFor, writeOwnerSettings,
} from "../../src/core/owner-settings.js";
import { sellerUrlProblem } from "../../src/core/seller-url.mjs";
import { accountHomeWith } from "../helpers/owner-settings.js";

const homes: string[] = [];
const saved = process.env.SUPERSTABLES_TEST_ACCOUNT_HOME;
function use(settings: object | null, opts?: { raw?: string; mode?: number }): string {
  const h = accountHomeWith(settings, opts);
  homes.push(h);
  process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = h;
  return h;
}
beforeEach(() => use(null));
afterEach(() => {
  if (saved === undefined) delete process.env.SUPERSTABLES_TEST_ACCOUNT_HOME;
  else process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = saved;
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const A = "https://a.example/key123";
const B = "https://b.example";

describe("reading the file", () => {
  it("absent file and absent folder: the defaults", () => {
    const s = readOwnerSettings();
    expect(s).toEqual(defaultOwnerSettings());
    expect(s.present).toBe(false);
    expect(s.site.origin).toBe("https://www.superstables.com");
    expect(ownerSettingsProblem()).toBe("");
  });

  const unusable: Array<[string, () => void]> = [
    ["not JSON", () => use(null, { raw: "{" })],
    ["an array", () => use(null, { raw: "[]" })],
    ["version 2", () => use({ version: 2 })],
    ["an unknown top-level field", () => use({ version: 1, extra: true })],
    ["an unknown field in site", () => use({ version: 1, site: { extra: 1 } })],
    ["allowStaging as text", () => use({ version: 1, site: { allowStaging: "yes" } })],
    ["a folder", () => { const h = use(null); mkdirSync(join(h, ".superstables", "owner", "settings.json"), { recursive: true, mode: 0o700 }); }],
    ["a symlink to a valid file", () => {
      const h = use({ version: 1 });
      const real = join(h, ".superstables", "owner", "real.json");
      writeFileSync(real, '{"version":1}\n', { mode: 0o600 });
      rmSync(join(h, ".superstables", "owner", "settings.json"));
      symlinkSync(real, join(h, ".superstables", "owner", "settings.json"));
    }],
    ["65537 bytes", () => use(null, { raw: `{"version":1,"signature":{"x":"${"a".repeat(65537)}"}}` })],
    ["mode 622", () => use({ version: 1 }, { mode: 0o622 })],
    ["an owner folder of mode 777", () => { const h = use({ version: 1 }); chmodSync(join(h, ".superstables", "owner"), 0o777); }],
    ["an unknown chain key", () => use({ version: 1, rpc: { base: { urls: [B] } } })],
    ["six URLs", () => use({ version: 1, rpc: { "base-sepolia": { urls: [1, 2, 3, 4, 5, 6].map((n) => `https://r${n}.example`) } } })],
    ["two URLs equal once parsed", () => use({ version: 1, rpc: { "base-sepolia": { urls: ["https://a.example/", "https://A.example"] } } })],
    ["plain http", () => use({ version: 1, rpc: { "base-sepolia": { urls: ["http://rpc.example"] } } })],
    ["user info in a URL", () => use({ version: 1, rpc: { "base-sepolia": { urls: ["https://u:p@rpc.example"] } } })],
    ["a fragment", () => use({ version: 1, rpc: { "base-sepolia": { urls: ["https://rpc.example/#x"] } } })],
    ["quorum 0", () => use({ version: 1, rpc: { "base-sepolia": { urls: [A, B], quorum: 0 } } })],
    ["quorum 6", () => use({ version: 1, rpc: { "base-sepolia": { urls: [A, B], quorum: 6 } } })],
    ["quorum 1.5", () => use({ version: 1, rpc: { "base-sepolia": { urls: [A, B], quorum: 1.5 } } })],
    ["quorum above the URLs", () => use({ version: 1, rpc: { "base-sepolia": { urls: [A, B], quorum: 3 } } })],
    ["a loopback site without allowLoopback", () => use({ version: 1, site: { origin: "http://127.0.0.1:3000" } })],
    ["a signature that is text", () => use({ version: 1, signature: "x" })],
  ];
  for (const [name, make] of unusable) {
    it(`refuses ${name}`, () => {
      make();
      let err: any;
      try { readOwnerSettings(); } catch (e) { err = e; }
      expect(err, name).toBeDefined();
      expect(err.code).toBe(OWNER_SETTINGS_UNREADABLE);
      expect(err.message).toContain("superstables owner settings show");
      expect(ownerSettingsProblem()).toBe(err.message);
    });
  }

  it("a FIFO at the path is refused and never blocks", () => {
    const h = use(null);
    const dir = join(h, ".superstables", "owner");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(join(h, ".superstables"), 0o700);
    execFileSync("mkfifo", [join(dir, "settings.json")]);
    const t = Date.now();
    expect(() => readOwnerSettings()).toThrow(/not a regular file/);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("normalises the quorum", () => {
    const q = (rpc: object) => parseOwnerSettings(JSON.stringify({ version: 1, rpc: { "base-sepolia": rpc } })).rpc["base-sepolia"].quorum;
    expect(q({ urls: [A], ownNode: true })).toBe(1);
    expect(q({ urls: [A, B] })).toBe(2);
    expect(q({ urls: [A, B], quorum: 1 })).toBe(2);
    expect(q({ urls: [A, B], ownNode: true, quorum: 2 })).toBe(2);
    expect(q({ urls: [A] })).toBe(2);
  });

  it("the chain keys agree with the client's chain table", () => {
    expect([...RPC_CHAIN_KEYS].sort()).toEqual(KNOWN_NETWORKS.map((n) => n.key).sort());
    expect([...RPC_CHAIN_KEYS].sort()).toEqual([...EVM_CHAIN_KEYS, "tempo-moderato", "solana-devnet"].sort());
    expect(budgetChainKey("tempo", "moderato")).toBe("tempo-moderato");
    expect(budgetChainKey("solana", "devnet")).toBe("solana-devnet");
    expect(budgetChainKey("evm", "base-sepolia")).toBe("base-sepolia");
    expect(SETTINGS_FIELDS).toEqual(["version", "site", "rpc", "rpcEnv", "sellers"]);
  });

  it("the module never reads process.env", () => {
    expect(readFileSync(new URL("../../src/core/owner-settings.js", import.meta.url), "utf8")).not.toMatch(/process\.env/);
  });
});

describe("siteFor", () => {
  const ok = (purpose: any, c: string, s?: any) => {
    const r: any = siteFor(purpose, c, s);
    expect(r.error, `${purpose} ${c}`).toBeUndefined();
    return r;
  };
  it("owner: production, the apex and spellings of both", () => {
    for (const c of ["https://www.superstables.com", "https://superstables.com", "HTTPS://WWW.SUPERSTABLES.COM", "https://www.superstables.com:443"]) {
      expect(ok("owner", c).origin).toBe("https://www.superstables.com");
    }
    expect(ok("owner", undefined as any)).toMatchObject({ origin: "https://www.superstables.com", source: "default" });
  });
  it("owner: everything else is refused with the command that would allow it", () => {
    const refused: Array<[string, RegExp]> = [
      ["https://staging.superstables.com", /allow-staging on/],
      ["https://superstables.com:8443", /owner settings site https:\/\/superstables\.com:8443/],
      ["https://www.superstables.com.", /owner settings site/],
      ["https://www.superstables.com.evil.example", /owner settings site/],
      ["https://pr-1.superstables.com", /owner settings site https:\/\/pr-1\.superstables\.com/],
      ["http://127.0.0.1:1", /allow-loopback site on/],
      ["http://localhost:1", /allow-loopback site on/],
      ["http://[::1]:1", /allow-loopback site on/],
    ];
    for (const [c, why] of refused) {
      for (const purpose of ["owner", "verdict"] as const) {
        const r: any = siteFor(purpose, c);
        expect(r.error, c).toMatch(/is not an approval site the owner allows/);
        expect(r.ownerCommand, c).toMatch(why);
      }
    }
  });
  it("read accepts staging, other superstables.com hosts and this computer, but not strangers", () => {
    for (const c of ["https://staging.superstables.com", "https://pr-1.superstables.com", "http://127.0.0.1:9", "http://localhost:9"]) ok("read", c);
    expect((siteFor("read", "https://evil.example") as any).error).toBeDefined();
    expect((siteFor("read", "https://www.superstables.com.evil.example") as any).error).toBeDefined();
  });
  it("the owner's settings widen the set", () => {
    use({ version: 1, site: { allowStaging: true } });
    expect(ok("owner", "https://staging.superstables.com").origin).toBe("https://staging.superstables.com");
    use({ version: 1, site: { origin: "https://x.example" } });
    expect(ok("owner", "https://x.example")).toMatchObject({ origin: "https://x.example", source: "candidate" });
    expect(ok("owner", undefined as any)).toMatchObject({ origin: "https://x.example", source: "settings" });
    use({ version: 1, site: { allowLoopback: true } });
    expect(ok("owner", "http://127.0.0.1:5").origin).toBe("http://127.0.0.1:5");
  });
  it("syntax errors keep their words", () => {
    expect((siteFor("owner", "nope") as any).error).toMatch(/not a URL/);
    expect((siteFor("owner", "https://u:p@www.superstables.com") as any).error).toMatch(/user name or password/);
    expect((siteFor("owner", "https://www.superstables.com/x") as any).error).toMatch(/origin only/);
    expect((siteFor("owner", "http://example.com") as any).error).toMatch(/https URL/);
  });
  it("an unusable file is an error, not the defaults", () => {
    use(null, { raw: "{" });
    expect((siteFor("owner", undefined as any) as any).error).toMatch(/cannot be used/);
  });
});

describe("rpcFor", () => {
  const OPTS = { fallback: "https://public.example", envName: "B4_RPC" };
  it("no variable, no settings: the built-in URL, or none", () => {
    expect(rpcFor("base-sepolia", "owner", undefined, OPTS)).toMatchObject({ url: "https://public.example", urls: ["https://public.example"], source: "default", ownNode: false, quorum: 2 });
    expect(rpcFor("base-sepolia", "read", "  ", {})).toMatchObject({ url: undefined, urls: [], source: "default" });
  });
  it("no variable, the owner's URLs: those", () => {
    use({ version: 1, rpc: { "base-sepolia": { urls: [A, B], ownNode: true } } });
    expect(rpcFor("base-sepolia", "owner", undefined, OPTS)).toMatchObject({ url: A, urls: [A, B], ownNode: true, quorum: 1, source: "settings" });
    expect(rpcFor("base-sepolia", "read", undefined, OPTS)).toMatchObject({ url: A, source: "settings" });
    expect(rpcFor("arc-testnet", "owner", undefined, OPTS)).toMatchObject({ url: "https://public.example", source: "default" });
  });
  it("a trailing slash does not matter on a built-in URL with a path", () => {
    const settings = { version: 1, site: { origin: "https://www.superstables.com", allowStaging: false, allowLoopback: false }, rpc: {}, rpcEnv: { allowLoopback: false }, sellers: { allowLoopback: false }, present: false, path: "x" } as any;
    for (const [key, builtin] of [
      ["arbitrum-sepolia", "https://sepolia-rollup.arbitrum.io/rpc"],
      ["skale-base-sepolia", "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha"],
    ]) {
      const r: any = rpcFor(key, "owner", `${builtin}/`, { fallback: builtin, envName: "B4_RPC", settings });
      expect(r.error).toBeUndefined();
      expect(r.allowedBy).toBe("builtin");
    }
    expect((rpcFor("arbitrum-sepolia", "owner", "https://sepolia-rollup.arbitrum.io/rpc2", { fallback: "https://sepolia-rollup.arbitrum.io/rpc", envName: "B4_RPC", settings }) as any).error).toMatch(/is not an RPC the owner set/);
  });
  it("a trailing slash does not matter on an owner URL with a path, a different path still does", () => {
    expect(sameRpcUrl("https://a.example/v2/KEY", "https://a.example/v2/KEY/")).toBe(true);
    expect(sameRpcUrl("https://a.example/v2/KEY//", "https://a.example/v2/KEY")).toBe(true);
    expect(sameRpcUrl("https://a.example/", "https://a.example")).toBe(true);
    expect(sameRpcUrl("https://a.example/v2/KEY", "https://a.example/v2/KEY2")).toBe(false);
    expect(sameRpcUrl("https://a.example/v2/KEY?x=1", "https://a.example/v2/KEY/?x=1")).toBe(true);
    use({ version: 1, rpc: { "base-sepolia": { urls: ["https://a.example/v2/KEY"] } } });
    expect((rpcFor("base-sepolia", "owner", "https://a.example/v2/KEY/", OPTS) as any).error).toBeUndefined();
    expect((rpcFor("base-sepolia", "owner", "https://a.example/v2/KEY2", OPTS) as any).error).toMatch(/is not an RPC the owner set/);
  });
  it("read: the variable as given, and the file is not read", () => {
    use(null, { raw: "{" });
    expect(rpcFor("base-sepolia", "read", "https://env.example", OPTS)).toMatchObject({ url: "https://env.example", source: "env", ownNode: false });
    expect((rpcFor("base-sepolia", "read", undefined, OPTS) as any).error).toMatch(/cannot be used/);
  });
  it("owner and verdict: only the owner's URLs or this computer with rpcEnv.allowLoopback", () => {
    use(null);
    for (const purpose of ["owner", "verdict"] as const) {
      expect((rpcFor("base-sepolia", purpose, "https://env.example/secret", OPTS) as any).error).toBe(
        "B4_RPC (https://env.example/…) is not an RPC the owner set for base-sepolia: owner actions and verdicts read only the owner's RPCs or the built-in ones",
      );
      expect((rpcFor("base-sepolia", purpose, "http://127.0.0.1:9", OPTS) as any).error).toMatch(/is not an RPC the owner set/);
    }
    use({ version: 1, rpcEnv: { allowLoopback: true } });
    expect(rpcFor("base-sepolia", "owner", "http://127.0.0.1:9", OPTS)).toMatchObject({ url: "http://127.0.0.1:9", source: "env", allowedBy: "loopback", ownNode: false });
    expect((rpcFor("base-sepolia", "owner", "https://env.example", OPTS) as any).error).toBeDefined();
  });
  it("a variable equal to the built-in URL is allowed for owner and verdict, slash aside", () => {
    for (const purpose of ["owner", "verdict"] as const) {
      expect(rpcFor("base-sepolia", purpose, "https://public.example/", OPTS)).toMatchObject({ url: "https://public.example/", source: "env", allowedBy: "builtin" });
    }
    expect(rpcFor("base-sepolia", "owner", "https://other.example/", { ...OPTS, builtin: ["https://other.example"] })).toMatchObject({ allowedBy: "builtin" });
  });
  it("a variable equal to an owner URL is used, written differently too; ownNode only for urls[0]", () => {
    use({ version: 1, rpc: { "base-sepolia": { urls: [A, B], ownNode: true } } });
    expect(rpcFor("base-sepolia", "owner", `${B}/`, OPTS)).toMatchObject({ url: `${B}/`, source: "env", allowedBy: "settings", ownNode: false });
    expect(rpcFor("base-sepolia", "verdict", "https://A.example/key123", OPTS)).toMatchObject({ source: "env", allowedBy: "settings", ownNode: true, quorum: 1 });
    expect((rpcFor("base-sepolia", "owner", "https://a.example/other", OPTS) as any).error).toBeDefined();
    expect((rpcFor("base-sepolia", "owner", "https://a.example", OPTS) as any).error).toBeDefined();
  });
  it("syntax backstop and unknown chain", () => {
    expect((rpcFor("base-sepolia", "read", "http://rpc.example", OPTS) as any).error).toMatch(/B4_RPC is refused/);
    expect((rpcFor("base-sepolia", "read", "https://u:p@rpc.example", OPTS) as any).error).toMatch(/B4_RPC is refused/);
    expect((rpcFor("base", "read", undefined, OPTS) as any).error).toMatch(/no such chain/);
  });
  it("sameRpcUrl and shownUrl", () => {
    expect(sameRpcUrl("https://a.example", "https://A.example/")).toBe(true);
    expect(sameRpcUrl("https://a.example/x", "https://a.example/y")).toBe(false);
    expect(sameRpcUrl("nope", "nope")).toBe(false);
    expect(shownUrl("https://a.example/key123?k=1")).toBe("https://a.example/…");
    expect(shownUrl("https://a.example:8545")).toBe("https://a.example:8545");
  });
});

describe("writing the file", () => {
  const next = () => ({ version: 1 as const, site: { origin: "https://www.superstables.com", allowStaging: true, allowLoopback: false },
    rpc: { "base-sepolia": { urls: [A, B], ownNode: false, quorum: 2 } }, rpcEnv: { allowLoopback: false }, sellers: { allowLoopback: false } });
  it("round-trips, mode 0600 in a 0700 folder, no temp file left", () => {
    writeOwnerSettings(next() as any);
    const s = readOwnerSettings();
    expect(s.present).toBe(true);
    expect(s.site.allowStaging).toBe(true);
    expect(s.rpc["base-sepolia"]).toMatchObject({ urls: [A, B], quorum: 2 });
    const dir = join(process.env.SUPERSTABLES_TEST_ACCOUNT_HOME!, ".superstables", "owner");
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    expect(((await_stat(join(dir, "settings.json"))) & 0o777)).toBe(0o600);
    expect((await_stat(dir) & 0o777)).toBe(0o700);
    expect(ownerSettingsPath()).toBe(join(dir, "settings.json"));
  });
  it("writes a signature it is given and none it is not", () => {
    writeOwnerSettings({ ...next(), signature: { by: "x" } } as any);
    expect((readOwnerSettings() as any).signature).toEqual({ by: "x" });
    writeOwnerSettings(next() as any);
    expect((readOwnerSettings() as any).signature).toBeUndefined();
  });
  it("never writes what the reader refuses, and leaves the old file as it was", () => {
    writeOwnerSettings(next() as any);
    const path = ownerSettingsPath();
    const before = readFileSync(path);
    expect(() => writeOwnerSettings({ ...next(), rpc: { base: { urls: [A], ownNode: false } } } as any)).toThrow(/cannot be used/);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
  it("a failed write (folder made read-only) leaves no temp file", () => {
    writeOwnerSettings(next() as any);
    const dir = join(process.env.SUPERSTABLES_TEST_ACCOUNT_HOME!, ".superstables", "owner");
    chmodSync(dir, 0o500);
    try {
      if (process.getuid?.() !== 0) expect(() => writeOwnerSettings({ ...next(), site: { origin: "https://www.superstables.com", allowStaging: false, allowLoopback: false } } as any)).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    expect(existsSync(dir)).toBe(true);
  });
});

import { statSync } from "node:fs";
function await_stat(p: string): number { return statSync(p).mode; }

describe("loopback sellers", () => {
  it("a seller on this computer on a chain that is not a testnet needs sellers.allowLoopback", () => {
    use(null);
    expect(sellerUrlProblem("http://127.0.0.1:1/x", { testnet: false })).toMatch(/owner settings allow-loopback sellers on/);
    expect(sellerUrlProblem("http://localhost:1/x", { testnet: false })).toBeDefined();
    expect(sellerUrlProblem("http://127.0.0.1:1/x", { testnet: true })).toBeUndefined();
    expect(sellerUrlProblem("http://127.0.0.1:1/x")).toBeUndefined();
    expect(sellerUrlProblem("https://seller.example/x", { testnet: false })).toBeUndefined();
    expect(loopbackSellersAllowed()).toBe(false);
    use({ version: 1, sellers: { allowLoopback: true } });
    expect(sellerUrlProblem("http://127.0.0.1:1/x", { testnet: false })).toBeUndefined();
    expect(loopbackSellersAllowed()).toBe(true);
    use(null, { raw: "{" });
    expect(loopbackSellersAllowed()).toBe(false);
    expect(sellerUrlProblem("http://127.0.0.1:1/x", { testnet: false })).toBeDefined();
  });
});


