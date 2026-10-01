// The skill the zip ships: one SKILL.md that points to files that exist, and the run paragraph scripts/skill.mjs replaces.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BUDGET = resolve(dirname(fileURLToPath(import.meta.url)), "../../budget");
const skill = readFileSync(resolve(BUDGET, "SKILL.md"), "utf8");

describe("budget/SKILL.md", () => {
  it("has one run paragraph for the zip to replace", () => {
    expect(skill.match(/<!-- run:[^>]*-->\n[\s\S]*?\n<!-- \/run -->\n/g)).toHaveLength(1);
  });

  it("states testnet at the top and asks the owner which way to pay before it points to a file", () => {
    const top = skill.split("\n").slice(0, 12).join("\n");
    expect(top).toMatch(/Testnet only: test USDC, no real money\./);
    expect(skill.indexOf("## First, ask the owner what they would like to try")).toBeGreaterThan(0);
    expect(skill.indexOf("references/once.md")).toBeGreaterThan(skill.indexOf("## First, ask the owner"));
    expect(skill).toMatch(/Tell me when you.ve approved\./);
    expect(skill).toMatch(/wait --id ID --shown/);
  });

  it("shows the link before polling, offers buy once only for listed services, and treats a no as final", () => {
    expect(skill).toMatch(/Write the link in a reply and end your turn/);
    expect(skill).toMatch(/so is a spent budget/);
    expect(skill).toMatch(/`wait` refuses without `--shown`/);
    expect(skill).toMatch(/A no is final/);
    const budget = readFileSync(resolve(BUDGET, "references/budget.md"), "utf8");
    expect(budget).toMatch(/Offer buy once only if that service is in `superstables budget find --once`/);
    expect(budget).toMatch(/say the budget is spent and end your turn/);
    for (const f of ["references/once.md", "references/budget.md"]) expect(readFileSync(resolve(BUDGET, f), "utf8")).toMatch(/wait --id ID --shown/);
  });

  it("points only to files that exist, and the references state testnet too", () => {
    const files = new Set([...skill.matchAll(/`((?:references\/)?[A-Za-z]+\.md)`/g)].map((m) => m[1]));
    expect(files).toContain("references/once.md");
    expect(files).toContain("references/budget.md");
    for (const f of files) expect(existsSync(resolve(BUDGET, f)), f).toBe(true);
    for (const f of ["references/once.md", "references/budget.md"]) expect(readFileSync(resolve(BUDGET, f), "utf8")).toMatch(/Testnet only: test USDC, no real money/);
  });
});
