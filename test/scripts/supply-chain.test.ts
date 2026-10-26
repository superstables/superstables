// The package's supply chain: what an install resolves, what the builds write, and the audit of what ships.
//
// - Runtime dependencies, the packages bundled into dist/budget and the build tools are pinned to the versions in
//   package-lock.json, and the packages that still float are a short list that only changes in review.
// - Two builds of one commit are identical: the build time is the commit's, the notices sort the same in every locale.
// - The build writes a CycloneDX SBOM of every package the client installs or bundles, and no source maps ship.
// - The audit of shipped packages fails closed: no answer from the registry is never "clean".
//
// Everything here stays offline: the audit's network paths are tested through its pure functions and with a registry
// that is not there.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8"));
const pkg = read("package.json");
const lock = read("package-lock.json").packages as Record<string, any>;
const EXACT = /^\d+\.\d+\.\d+$/;
const nameOf = (key: string) => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);

const temp: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "superstables-supply-chain-"));
  temp.push(d);
  return d;
};
afterAll(() => {
  for (const d of temp) rmSync(d, { recursive: true, force: true });
});

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const files = (dir: string) => readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile()).sort();

describe("pins", () => {
  it("the published shrinkwrap is written when the tarball is made: no npm-shrinkwrap.json is tracked, and dev entries are not published", async () => {
    // At the checkout root, npm reads npm-shrinkwrap.json as the lockfile of `npm ci`, so a production-only one would drop
    // the dev tools; scripts/prepare.mjs --pack writes it into the tarball's folder and `postpack` removes it.
    const tracked = spawnSync("git", ["ls-files", "npm-shrinkwrap.json"], { cwd: root, encoding: "utf8" });
    expect(tracked.stdout.trim()).toBe("");
    const { productionLock } = await import(pathToFileURL(join(root, "scripts", "shrinkwrap.mjs")).href);
    const lockfile = read("package-lock.json");
    const derived = productionLock(lockfile);
    expect(Object.keys(lockfile.packages).some((k) => lockfile.packages[k].dev), "this test needs a lock with dev entries").toBe(true);
    expect(Object.keys(derived.packages).length).toBeLessThan(Object.keys(lockfile.packages).length);
    for (const [key, entry] of Object.entries<any>(derived.packages)) {
      expect(entry.dev || entry.optional || entry.devOptional, key).toBeFalsy();
    }
    expect(derived.packages[""].devDependencies).toBeUndefined();
    expect(derived.packages[""].dependencies).toEqual(pkg.dependencies);
    for (const name of ["vitest", "typescript", "esbuild", "tsx", "@solana/web3.js", "mppx", "bs58", "@x402/fetch"]) {
      expect(derived.packages[`node_modules/${name}`], name).toBeUndefined();
    }
    // every runtime dependency stays, at the version the lock resolved
    for (const name of Object.keys(pkg.dependencies)) expect(derived.packages[`node_modules/${name}`]?.version, name).toBe(lockfile.packages[`node_modules/${name}`].version);
  });

  it("every runtime dependency is an exact version, and it is the version the lockfile resolved", () => {
    expect(Object.keys(pkg.dependencies).length).toBeGreaterThan(0);
    for (const [name, spec] of Object.entries<string>(pkg.dependencies)) {
      expect(spec, name).toMatch(EXACT);
      expect(lock[`node_modules/${name}`]?.version, name).toBe(spec);
    }
    expect(lock[""].dependencies).toEqual(pkg.dependencies);
  });

  it("the bundled packages and the build tools are exact too, and so is the override", async () => {
    const { BUDGET_ONLY_DEPENDENCIES } = await import("../../scripts/budget-build.mjs");
    for (const name of [...BUDGET_ONLY_DEPENDENCIES, "esbuild", "fflate", "typescript"]) {
      const spec = pkg.devDependencies[name];
      expect(spec, name).toMatch(EXACT);
      expect(lock[`node_modules/${name}`]?.version, name).toBe(spec);
    }
    expect(pkg.overrides.jayson).toMatch(EXACT);
    expect(lock[""].devDependencies).toEqual(pkg.devDependencies);
  });

  it("the packages no exact spec reaches are exactly the three that are known", () => {
    const production = Object.entries<any>(lock).filter(([key, v]) => key && !v.dev && !v.optional && !v.devOptional);
    const pinned = new Set<string>();
    for (const deps of [lock[""].dependencies, ...production.map(([, v]) => v.dependencies)]) {
      for (const [name, spec] of Object.entries<string>(deps ?? {})) if (EXACT.test(spec)) pinned.add(`${name}@${spec}`);
    }
    const floating = [...new Set(production.map(([key, v]) => `${nameOf(key)}@${v.version}`))].filter((id) => !pinned.has(id));
    expect([...new Set(floating.map((id) => id.slice(0, id.lastIndexOf("@"))))].sort()).toEqual(["@adraffy/ens-normalize", "@noble/ciphers", "@scure/base"]);
  });

  it("ships one zod, the root's, to x402 as well", () => {
    const zods = Object.entries<any>(lock).filter(([key, v]) => nameOf(key) === "zod" && !v.dev).map(([key, v]) => `${key}@${v.version}`);
    expect(zods).toEqual([`node_modules/zod@${pkg.dependencies.zod}`]);
  });
});

describe("buildTime", () => {
  it("takes SOURCE_DATE_EPOCH, then the commit's time, then the export's, and the clock last", async () => {
    const { buildTime } = await import("../../scripts/budget-build.mjs");
    expect(buildTime(root, { SOURCE_DATE_EPOCH: "1700000000" })).toBe("2023-11-14T22:13:20Z");
    expect(() => buildTime(root, { SOURCE_DATE_EPOCH: "soon" })).toThrow(/SOURCE_DATE_EPOCH/);

    const commit = spawnSync("git", ["log", "-1", "--format=%ct", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    expect(buildTime(root, {})).toBe(new Date(Number(commit) * 1000).toISOString().replace(/\.\d+Z$/, "Z"));

    const archive = scratch();
    writeFileSync(join(archive, "package.json"), "{}\n");
    utimesSync(join(archive, "package.json"), 1600000000, 1600000000);
    expect(buildTime(archive, { SUPERSTABLES_SKILL_FROM_ARCHIVE: "1" })).toBe("2020-09-13T12:26:40Z");

    const bare = scratch();
    expect(Math.abs(Date.parse(buildTime(bare, {})) - Date.now())).toBeLessThan(5000);
  });
});

// One standalone build (about a second), shared by the cases that read it.
const env = { ...process.env, SOURCE_DATE_EPOCH: "1700000000" };
let built: { a: string; b: string; sbomA: string; sbomB: string } | undefined;
function twoBuilds() {
  if (built) return built;
  const dir = scratch();
  const run = (name: string, extra: Record<string, string>) => {
    const r = spawnSync(process.execPath, [join(root, "scripts", "budget-build.mjs"), "--outdir", join(dir, name), "--sbom", join(dir, `${name}.cdx.json`)], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
    expect(r.stderr + r.stdout, name).not.toMatch(/Error/);
    expect(r.status, name).toBe(0);
  };
  run("a", {});
  const later = Date.now() + 1100;
  while (Date.now() < later) { /* the clock moves on between the builds */ }
  run("b", { LC_ALL: "lt_LT.UTF-8", LANG: "lt_LT.UTF-8" });
  built = { a: join(dir, "a"), b: join(dir, "b"), sbomA: join(dir, "a.cdx.json"), sbomB: join(dir, "b.cdx.json") };
  return built;
}

describe("two builds of one commit", () => {
  it("write the same bytes, a second later and under another locale", () => {
    const { a, b, sbomA, sbomB } = twoBuilds();
    expect(JSON.parse(readFileSync(join(a, "VERSION.json"), "utf8")).builtAt).toBe("2023-11-14T22:13:20Z");
    expect(files(b)).toEqual(files(a));
    for (const f of files(a)) expect(sha256(join(b, f)), f).toBe(sha256(join(a, f)));
    expect(sha256(sbomB)).toBe(sha256(sbomA));
  });
}, 60_000);

describe("the order of the bundled packages", () => {
  it("is the same in every locale, though a bare localeCompare is not", () => {
    // Lithuanian puts y with i, Czech puts ch after h. None of today's package names shows it, so the comparator is tested on names that do.
    const sorted = (locale: string) => {
      const code = `
        import { byNameVersion } from ${JSON.stringify(pathToFileURL(join(root, "scripts", "budget-build.mjs")).href)};
        const names = ["y", "j", "i", "h", "ch"];
        console.log(JSON.stringify({
          ours: names.map((name) => ({ name, version: "1.0.0" })).sort(byNameVersion).map((p) => p.name),
          bare: [...names].sort((a, b) => a.localeCompare(b)),
        }));`;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env: { ...process.env, LC_ALL: locale, LANG: locale, LANGUAGE: locale }, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout) as { ours: string[]; bare: string[] };
    };
    const en = sorted("en_US.UTF-8");
    const lt = sorted("lt_LT.UTF-8");
    expect(lt.ours).toEqual(en.ours);
    expect(en.ours).toEqual(["ch", "h", "i", "j", "y"]);
    expect(lt.bare).not.toEqual(en.bare); // the environment really does change a bare sort here
  }, 30_000);
});

describe("the SBOM", () => {
  it("is CycloneDX 1.5, lists what is installed and what is bundled, and holds nothing from this machine", () => {
    const bom = JSON.parse(readFileSync(twoBuilds().sbomA, "utf8"));
    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe("1.5");
    expect(bom).not.toHaveProperty("serialNumber");
    expect(bom.metadata.timestamp).toBe("2023-11-14T22:13:20Z");

    const byRef = new Map<string, any>(bom.components.map((c: any) => [c["bom-ref"], c]));
    const prop = (ref: string, name: string) => (byRef.get(ref)?.properties ?? []).filter((p: any) => p.name === name).map((p: any) => p.value);
    const web3 = `pkg:npm/%40solana/web3.js@${pkg.devDependencies["@solana/web3.js"]}`;
    expect(prop(web3, "superstables:delivery")).toEqual(["bundled"]);
    expect(prop(`pkg:npm/mppx@${pkg.devDependencies.mppx}`, "superstables:delivery")).toEqual(["bundled"]);
    expect(prop(`pkg:npm/viem@${pkg.dependencies.viem}`, "superstables:delivery")).toEqual(["bundled", "installed"]);
    expect(prop("pkg:npm/bs58@4.0.1", "superstables:path")).toHaveLength(2);

    for (const c of bom.components) {
      for (const h of c.hashes ?? []) expect(h.content, c.name).toMatch(/^[0-9a-f]{128}$/);
      for (const p of c.properties ?? []) expect(p.value, c.name).not.toMatch(/^\//);
      // every path is a location in the lockfile, for that version, and every bundled component says where it came from
      for (const p of c.properties.filter((p: any) => p.name === "superstables:path")) expect(lock[p.value]?.version, `${c.name} ${p.value}`).toBe(c.version);
      if (c.properties.some((p: any) => p.name === "superstables:delivery" && p.value === "bundled")) {
        expect(c.hashes, c.name).toHaveLength(1);
        expect(c.hashes[0].content, c.name).toMatch(/^[0-9a-f]{128}$/);
        expect(c.externalReferences?.[0]?.url, c.name).toMatch(/^https:\/\/.+\.tgz$/);
      }
    }
    const names = bom.components.map((c: any) => c.name);
    expect(names).not.toContain("bufferutil");
    expect(names).not.toContain("utf-8-validate");
    expect(bom.components.map((c: any) => c["bom-ref"])).toEqual([...byRef.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
  });
}, 60_000);

describe("source maps", () => {
  it("tsc no longer writes them, and the budget bundle has none", () => {
    const { compilerOptions } = read("tsconfig.build.json");
    expect(compilerOptions.sourceMap).toBe(false);
    expect(compilerOptions.inlineSourceMap).toBeUndefined();
    expect(compilerOptions.declarationMap).toBeUndefined();
    const { a } = twoBuilds();
    expect(files(a).filter((f) => f.endsWith(".map"))).toEqual([]);
    for (const f of files(a).filter((f) => f.endsWith(".mjs"))) expect(readFileSync(join(a, f), "utf8"), f).not.toContain("sourceMappingURL");
  });
}, 60_000);

describe("the audit of shipped packages", () => {
  const bom = {
    components: [
      { "bom-ref": "pkg:npm/bs58@4.0.1", name: "bs58", version: "4.0.1", properties: [{ name: "superstables:delivery", value: "bundled" }, { name: "superstables:path", value: "node_modules/@solana/web3.js/node_modules/bs58" }] },
      { "bom-ref": "pkg:npm/viem@2.56.6", name: "viem", version: "2.56.6", properties: [{ name: "superstables:delivery", value: "bundled" }, { name: "superstables:delivery", value: "installed" }, { name: "superstables:path", value: "node_modules/viem" }] },
    ],
  };

  it("calls an advisory shipped when its node is a shipped path, and dev-only otherwise", async () => {
    const { shippedPaths, classify } = await import("../../scripts/bundle-audit.mjs");
    const { paths, packages } = shippedPaths([bom]);
    expect([...paths].sort()).toEqual(["node_modules/@solana/web3.js/node_modules/bs58", "node_modules/viem"]);
    expect([...(packages.get("viem@2.56.6") ?? [])].sort()).toEqual(["bundled", "installed"]);
    const report = {
      vulnerabilities: {
        bs58: { severity: "high", range: "<4.0.2", nodes: ["node_modules/@solana/web3.js/node_modules/bs58"], via: [{ url: "https://example.test/a" }] },
        tinypool: { severity: "critical", range: "<2.1.2", nodes: ["node_modules/tinypool"], via: ["vitest", { url: "https://example.test/b" }] },
      },
    };
    const { shipped, devOnly } = classify(report, paths);
    expect(shipped.map((s: any) => s.name)).toEqual(["bs58"]);
    expect(shipped[0].urls).toEqual(["https://example.test/a"]);
    expect(devOnly.map((s: any) => s.name)).toEqual(["tinypool"]);
  });

  it("refuses an SBOM whose paths are not locations in the lockfile, or are for another version", async () => {
    const { checkPaths } = await import("../../scripts/bundle-audit.mjs");
    const comp = (name: string, version: string, path: string) => ({ name, version, properties: [{ name: "superstables:path", value: path }] });
    const packages = { "node_modules/a": { version: "1.0.0" }, "node_modules/a/node_modules/b": { version: "2.0.0" } };
    expect(checkPaths([{ components: [comp("a", "1.0.0", "node_modules/a"), comp("b", "2.0.0", "node_modules/a/node_modules/b")] }], packages)).toEqual([]);
    // built with node_modules linked from another folder
    expect(checkPaths([{ components: [comp("a", "1.0.0", "../x/work/y/node_modules/a")] }], packages)).toEqual([expect.stringContaining("../x/work/y/node_modules/a is not a location")]);
    expect(checkPaths([{ components: [comp("a", "1.0.1", "node_modules/a")] }], packages)).toEqual([expect.stringContaining("node_modules/a is 1.0.0 in package-lock.json")]);
    expect(checkPaths([{ components: [comp("toString", "1.0.0", "toString")] }], packages)).toHaveLength(1);
  });

  it("refuses an SBOM with no components, an empty list, or a component without a path", async () => {
    const { checkPaths } = await import("../../scripts/bundle-audit.mjs");
    const packages = { "node_modules/a": { version: "1.0.0" } };
    const ok = { components: [{ name: "a", version: "1.0.0", properties: [{ name: "superstables:path", value: "node_modules/a" }] }] };
    expect(checkPaths([ok], packages)).toEqual([]);
    expect(checkPaths([{}], packages)).toEqual([expect.stringContaining("SBOM 1 has no list of components")]);
    expect(checkPaths([{ components: [] }], packages)).toEqual([expect.stringContaining("SBOM 1 has no list of components")]);
    expect(checkPaths([{ components: "a" }, null] as any[], packages)).toHaveLength(2);
    // the second of two SBOMs is the broken one
    expect(checkPaths([ok, {}], packages)).toEqual([expect.stringContaining("SBOM 2 has no list of components")]);
    expect(checkPaths([{ components: [{ name: "a", version: "1.0.0" }] }], packages)).toEqual([expect.stringContaining("SBOM 1: a@1.0.0 has no superstables:path")]);
    expect(checkPaths([{ components: [{ name: "a", version: "1.0.0", properties: [{ name: "superstables:delivery", value: "bundled" }] }] }], packages)).toHaveLength(1);
    expect(checkPaths([{ components: [{ name: "a", version: "1.0.0", properties: [{ name: "superstables:path", value: "" }] }] }], packages)).toHaveLength(1);
  });

  it("does not classify an advisory as development-only when the SBOM lists nothing", async () => {
    const { checkPaths, shippedPaths, classify } = await import("../../scripts/bundle-audit.mjs");
    const report = { vulnerabilities: { viem: { severity: "high", range: "<1", nodes: ["node_modules/viem"], via: [] } } };
    const lock = { "node_modules/viem": { version: "2.0.0" } };
    for (const bom of [{}, { components: [] }, { components: [{ name: "viem", version: "2.0.0" }] }]) {
      // what the classifier alone would say, and why that must never be reached: the check refuses the SBOM first
      expect(classify(report, shippedPaths([bom]).paths).devOnly.map((d: any) => d.name)).toEqual(["viem"]);
      expect(checkPaths([bom], lock), JSON.stringify(bom)).not.toEqual([]);
    }
  });

  it("never reads an answer that did not come from the registry as clean", async () => {
    const { auditVerdict } = await import("../../scripts/bundle-audit.mjs");
    const clean = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} });
    const asked = "npm http fetch POST 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk 212ms\n";
    // npm --offline prints this and exits 0
    expect(auditVerdict({ status: 0, stdout: clean, stderr: "" }).problem).toMatch(/no answer from the registry/);
    expect(auditVerdict({ status: 1, stdout: JSON.stringify({ message: "request to http://127.0.0.1:9/ failed" }), stderr: "" }).problem).toMatch(/could not complete/);
    expect(auditVerdict({ status: 1, stdout: JSON.stringify({ error: { summary: "audit endpoint returned an error" } }), stderr: asked }).problem).toMatch(/could not complete/);
    expect(auditVerdict({ status: 1, stdout: "", stderr: "npm ERR! boom\n" }).problem).toMatch(/printed no report/);
    const ok = auditVerdict({ status: 0, stdout: clean, stderr: asked });
    expect(ok.problem).toBeUndefined();
    expect(ok.report?.vulnerabilities).toEqual({});
  });

  it("exits 2 when it cannot audit: a missing SBOM, or a registry that is not there", () => {
    const script = join(root, "scripts", "bundle-audit.mjs");
    const missing = spawnSync(process.execPath, [script, "--sbom", "/nonexistent/sbom.cdx.json"], { cwd: root, env: process.env, encoding: "utf8" });
    expect(missing.status).toBe(2);
    expect(missing.stderr + missing.stdout).toMatch(/npm run build first/);

    const stale = scratch();
    const other = join(stale, "other.cdx.json");
    writeFileSync(other, JSON.stringify({ components: [{ name: "viem", version: "1.0.0", properties: [{ name: "superstables:path", value: "../w/node_modules/viem" }] }] }));
    const mismatch = spawnSync(process.execPath, [script, "--sbom", other], { cwd: root, env: process.env, encoding: "utf8" });
    expect(mismatch.status).toBe(2);
    expect(mismatch.stderr).toMatch(/does not match this checkout's package-lock\.json/);

    const registry = { ...process.env, npm_config_registry: "http://127.0.0.1:9/", npm_config_fetch_retries: "0", npm_config_fetch_retry_mintimeout: "1", npm_config_fetch_retry_maxtimeout: "1" };
    const down = spawnSync(process.execPath, [script, "--sbom", twoBuilds().sbomA], { cwd: root, env: registry, encoding: "utf8", timeout: 50_000 });
    expect(down.status).toBe(2);
    expect(down.stderr + down.stdout).toMatch(/could not complete|no answer/);
  }, 60_000);
});
