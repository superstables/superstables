import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkPins, PINS, setVersion } from "../../scripts/version-set.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const dirs: string[] = [];

/** A clone of the checkout, with this working tree's script, so a test can change files freely. */
function copy() {
  const dir = mkdtempSync(join(tmpdir(), "version-pins-"));
  dirs.push(dir);
  execFileSync("git", ["clone", "-q", "--no-hardlinks", root, dir]);
  copyFileSync(join(root, "scripts/version-set.mjs"), join(dir, "scripts/version-set.mjs"));
  return dir;
}
const edit = (dir: string, file: string, f: (text: string) => string) => writeFileSync(join(dir, file), f(readFileSync(join(dir, file), "utf8")));
const versionOf = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version as string;

afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("version pins", { timeout: 120_000 }, () => {
  it("every shipped pin names package.json's version", () => {
    expect(checkPins(root)).toEqual([]);
  });

  it("names the file and the script when a pin is stale", () => {
    const dir = copy();
    const file = "budget/README.md";
    edit(dir, file, (t) => t.replace(versionOf(dir), "1.0.0"));
    const problems = checkPins(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(file);
    expect(problems[0]).toContain("npm run version:set");
  });

  it("names the plugin files when a generated pin is stale", () => {
    const dir = copy();
    edit(dir, "plugin/plugin.json", (t) => t.replace(versionOf(dir), "1.0.0"));
    expect(checkPins(dir).join("\n")).toContain("plugin/plugin.json");
  });

  it("leaves history prose alone, and a bump to the documented example version passes", () => {
    const dir = copy();
    const before = versionOf(dir);
    edit(dir, "docs/install.md", (t) => `${t}\nThe 1.0.0 release added this feature. The ${before} release added that one.\n`);
    expect(checkPins(dir)).toEqual([]);
    setVersion(dir, "1.2.3", { title: "Example" });
    expect(checkPins(dir)).toEqual([]);
    expect(readFileSync(join(dir, "docs/install.md"), "utf8")).toContain(`The 1.0.0 release added this feature. The ${before} release added that one.`);
  });

  it("a run with the current version repairs a pin that fell behind", () => {
    const dir = copy();
    const version = versionOf(dir);
    edit(dir, "budget/README.md", (t) => t.replace(version, "1.0.0"));
    expect(checkPins(dir)).not.toEqual([]);
    const { touched } = setVersion(dir, version);
    expect(touched).toEqual(["budget/README.md"]);
    expect(checkPins(dir)).toEqual([]);
  });

  it("takes the version with and without --title", () => {
    const dir = copy();
    const run = (...args: string[]) => spawnSync(process.execPath, [join(dir, "scripts/version-set.mjs"), ...args], { cwd: dir, encoding: "utf8" });
    expect(run("1.2.3").status).toBe(0);
    expect(versionOf(dir)).toBe("1.2.3");
    expect(run("--title", "Words", "1.2.4").status).toBe(0);
    expect(run("1.2.5", "--title", "More words").status).toBe(0);
    expect(versionOf(dir)).toBe("1.2.5");
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain("## [1.2.5] - More words");
    expect(run("--title", "Words").status).toBe(2);
    expect(run("--check").status).toBe(0);
  });

  it("--title after a run without it links from the last release, not from the version just set", () => {
    const dir = copy();
    const before = versionOf(dir);
    setVersion(dir, "1.2.3");
    setVersion(dir, "1.2.3", { title: "Example" });
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain(`[1.2.3]: https://github.com/superstables/superstables/compare/v${before}...v1.2.3\n`);
  });

  it("names the changelog links when they lag, and --title writes them", () => {
    const dir = copy();
    const version = versionOf(dir);
    edit(dir, "CHANGELOG.md", (t) => t.replace(`compare/v${version}...HEAD`, "compare/v1.0.0...HEAD"));
    expect(checkPins(dir).join("\n")).toContain("CHANGELOG.md: restore the `[Unreleased]` compare link");
    setVersion(dir, "1.2.3", { title: "Words" });
    const log = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(log).toContain("[Unreleased]: https://github.com/superstables/superstables/compare/v1.2.3...HEAD\n");
    expect(log).toContain(`[1.2.3]: https://github.com/superstables/superstables/compare/v${version}...v1.2.3\n`);
    expect(checkPins(dir)).toEqual([]);
  });

  it("registers every pin file as a pattern list", () => {
    for (const patterns of Object.values(PINS) as string[][]) for (const p of patterns) expect(p).toContain("VER");
  });
});
