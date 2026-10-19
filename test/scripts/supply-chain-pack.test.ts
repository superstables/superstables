// What `npm pack` puts in the package, and that the skill zip is the same bytes wherever it is built.
//
// Slow: each case builds in a copy of the checkout (the way scripts/install-check.mjs does), with node_modules linked
// from this one. The link puts the same absolute path in every build here, so these cases do not test path independence;
// scripts/repro-check.mjs does, with a real npm ci in each of two folders.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));

let copy: string;
beforeAll(() => {
  copy = mkdtempSync(join(tmpdir(), "superstables-supply-chain-pack-"));
  const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of tracked) {
    const from = join(root, f);
    if (!existsSync(from) || lstatSync(from).isDirectory()) continue;
    mkdirSync(dirname(join(copy, f)), { recursive: true });
    copyFileSync(from, join(copy, f));
  }
  symlinkSync(join(root, "node_modules"), join(copy, "node_modules"));
}, 60_000);
afterAll(() => {
  if (copy) rmSync(copy, { recursive: true, force: true });
});

describe("the npm package", () => {
  it("holds no source map, and holds the SBOM", () => {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: copy, env: cleanEnv, encoding: "utf8", timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    // npm 10 prints prepack's own output to stdout before the JSON
    const lines = r.stdout.split("\n");
    const start = lines.findIndex((l) => l === "[");
    expect(start).toBeGreaterThanOrEqual(0);
    const [packed] = JSON.parse(lines.slice(start).join("\n"));
    const paths: string[] = packed.files.map((f: { path: string }) => f.path);
    expect(paths.filter((p) => p.endsWith(".map"))).toEqual([]);
    expect(paths).toContain("dist/sbom.cdx.json");
  }, 150_000);
});

describe("the skill zip", () => {
  it("is the same bytes in another time zone and locale, and carries its SBOM", async () => {
    const sha = execFileSync("git", ["rev-parse", "--short=10", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const build = (extra: Record<string, string>) => {
      const r = spawnSync(process.execPath, [join(copy, "scripts", "skill.mjs")], {
        cwd: copy,
        env: { ...cleanEnv, SUPERSTABLES_SKILL_FROM_ARCHIVE: "1", SUPERSTABLES_BUILD_COMMIT: sha, SOURCE_DATE_EPOCH: "1700000000", ...extra },
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(r.status, r.stderr).toBe(0);
      const zips = readdirSync(join(copy, "build")).filter((f) => f.endsWith(".zip"));
      expect(zips).toHaveLength(1);
      return readFileSync(join(copy, "build", zips[0]));
    };
    const one = build({ TZ: "UTC" });
    const two = build({ TZ: "Pacific/Kiritimati", LC_ALL: "lt_LT.UTF-8", LANG: "lt_LT.UTF-8" });
    const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    expect(hash(two)).toBe(hash(one));
    const entries = unzipSync(one);
    expect(Object.keys(entries)).toContain("superstables-payments/scripts/sbom.cdx.json");
    // node_modules is a link here, so the bundled folders are outside the copy: the SBOM still names lockfile locations
    const bom = JSON.parse(Buffer.from(entries["superstables-payments/scripts/sbom.cdx.json"]).toString("utf8"));
    const { checkPaths } = await import("../../scripts/bundle-audit.mjs");
    expect(checkPaths([bom], JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages)).toEqual([]);
    for (const c of bom.components) {
      expect(c.hashes, c.name).toHaveLength(1);
      expect(c.externalReferences, c.name).toHaveLength(1);
    }
  }, 150_000);
});
