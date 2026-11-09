// Installers such as `npx skills add` parse SKILL.md front matter as strict YAML and skip a skill whose front matter fails.
// There is exactly one skill, `superstables`: the plugin's, which the skill zip ships too. A second SKILL.md would be listed
// as a second skill by skills.sh, which scans every SKILL.md in the public repository.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skills = execFileSync("git", ["ls-files", "*SKILL.md"], { cwd: root, encoding: "utf8" }).trim().split("\n");

describe("SKILL.md front matter", () => {
  it("is the one skill, plugin/skills/superstables/SKILL.md", () => {
    expect(skills).toEqual(["plugin/skills/superstables/SKILL.md"]);
  });

  it.each(skills)("%s parses as YAML, is named superstables and has a description", (path) => {
    const front = readFileSync(resolve(root, path), "utf8").match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    expect(front, "front matter").toBeDefined();
    const meta = parse(front!, { strict: true, uniqueKeys: true });
    expect(meta.name).toBe("superstables");
    expect(path.split("/").at(-2)).toBe(meta.name);
    expect(typeof meta.description).toBe("string");
  });
});
