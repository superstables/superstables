// Installers such as `npx skills add` parse SKILL.md front matter as strict YAML and skip a skill whose front matter fails.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skills = execFileSync("git", ["ls-files", "*SKILL.md"], { cwd: root, encoding: "utf8" }).trim().split("\n");

describe("SKILL.md front matter", () => {
  it.each(skills)("%s parses as YAML with its folder's name and a description", (path) => {
    const front = readFileSync(resolve(root, path), "utf8").match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    expect(front, "front matter").toBeDefined();
    const meta = parse(front!, { strict: true, uniqueKeys: true });
    expect(meta.name).toBe(path.split("/").at(-2));
    expect(typeof meta.description).toBe("string");
  });
});
