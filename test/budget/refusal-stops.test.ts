// A refused budget purchase (revoked, nothing left, over the per-purchase limit) is the answer. An agent that
// reads only these files must not switch to a single purchase on its own.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f: string) => readFileSync(resolve(ROOT, f), "utf8");
const RULE = /refused[\s\S]{0,120}(revoked|nothing left)[\s\S]{0,600}say so and stop[\s\S]{0,400}only as a question[\s\S]{0,200}only when the owner says yes/i;

describe("a refused budget purchase stops the agent", () => {
  for (const file of [
    "skills/superstables-payments/SKILL.md",
    "plugin/skills/superstables/SKILL.md",
    "skills/superstables-payments/references/budget.md",
    "plugin/skills/superstables/references/budget.md",
  ]) {
    it(`${file} says to report the refusal, ask before a single purchase and request it only on a yes`, () => {
      expect(read(file)).toMatch(RULE);
    });
  }
});
