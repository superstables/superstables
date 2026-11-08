import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module
import { checkPins, PIN_FILES } from "../../scripts/version-set.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("version pins", () => {
  it("every shipped pin names package.json's version", () => {
    expect(checkPins(root)).toEqual([]);
  });

  it("names the file and the script when a pin is stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "version-pins-"));
    try {
      execFileSync("git", ["clone", "-q", "--no-hardlinks", root, dir]);
      const file = join(dir, PIN_FILES[0]);
      const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
      const released = readFileSync(join(dir, "CHANGELOG.md"), "utf8").match(/^## \[(\d+\.\d+\.\d+)\]/gm)!.map((h) => h.slice(4, -1)).find((v) => v !== version)!;
      writeFileSync(file, readFileSync(file, "utf8").replaceAll(version, released));
      const problems = checkPins(dir);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(PIN_FILES[0]);
      expect(problems[0]).toContain("npm run version:set");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
