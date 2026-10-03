
// The skill the zip ships: one SKILL.md that points to files that exist, and the run paragraph scripts/skill.mjs replaces.
// It teaches the hosted path the Get started prompt on superstables.com relies on: ask how to pay first, buy once or a
// hosted budget, write every approval link in a reply and end the turn, and a no or a spent budget is final.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/superstables-payments");
const skill = readFileSync(resolve(SKILL, "SKILL.md"), "utf8");
const ref = (f: string) => readFileSync(resolve(SKILL, f), "utf8");

describe("skills/superstables-payments/SKILL.md", () => {
  it("does not call Superstables' services simulated as a group: the market data service returns live prices", () => {
    for (const [name, text] of [["SKILL.md", skill], ["discovery.md", ref("references/discovery.md")], ["once.md", ref("references/once.md")]]) {
      expect(text, name).not.toMatch(/simulated demo services/);
      expect(text, name).toMatch(/market data service[^.]*returns live prices/);
    }
    expect(skill).toMatch(/Treat a listing as simulated only when its flag is `yes`; do not infer it from the listing's name or operator/);
    expect(skill).toMatch(/superstables budget find --chain devnet/);
  });

  it("has one run paragraph for the zip to replace", () => {
    expect(skill.match(/<!-- run:[^>]*-->\n[\s\S]*?\n<!-- \/run -->\n/g)).toHaveLength(1);
  });

  it("keeps the 0.3.0 structure: safety rules, then the checklist, then the workflow", () => {
    const at = (h: string) => skill.indexOf(h);
    expect(at("## Safety rules")).toBeGreaterThan(0);
    expect(at("## Before you answer")).toBeGreaterThan(at("## Safety rules"));
    expect(at("## Workflow")).toBeGreaterThan(at("## Before you answer"));
  });

  it("states testnet at the top and asks the owner which way to pay before it points to a file", () => {
    const top = skill.split("\n").slice(0, 12).join("\n");
    expect(top).toMatch(/Testnet only: test USDC, no real money\./);
    const ask = skill.indexOf("## First, ask the owner what they would like to try");
    expect(ask).toBeGreaterThan(0);
    expect(skill).toContain('"This uses test USDC, no real money. Would you like one purchase you approve, or a budget?"');
    expect(skill.indexOf("references/once.md", ask)).toBeGreaterThan(ask);
    expect(skill).toMatch(/superstables budget buy-once/);
    expect(skill).toMatch(/superstables budget find --once/);
    expect(skill).toMatch(/setup --rail evm --hosted/);
    expect(skill).toMatch(/Base Sepolia or Arc Testnet/);
    expect(skill).toMatch(/Tell me when you.ve approved/);
    expect(skill).toMatch(/wait --id ID --shown/);
  });

  it("writes the link before waiting, offers buy once only for listed services, and treats a no as final", () => {
    expect(skill).toMatch(/Reply with `message_for_owner` and end your turn/);
    expect(skill).toMatch(/Testnet only: test USDC, no real money\./);
    expect(skill).toMatch(/so is a spent budget/);
    expect(skill).toMatch(/`wait` refuses without `--shown`/);
    expect(skill).toMatch(/A no is final/);
    expect(skill).not.toMatch(/stop after about five minutes of polling/);
    const budget = ref("references/budget.md");
    expect(budget).toMatch(/Offer buy once only if that service is in `superstables budget find --once`/);
    expect(budget).toMatch(/say the budget is spent and end your turn/);
    expect(budget).toMatch(/## A hosted budget on superstables\.com/);
    expect(budget).not.toMatch(/Poll for about five minutes/);
    for (const f of ["references/once.md", "references/budget.md"]) expect(ref(f)).toMatch(/wait --id ID --shown/);
  });

  it("points only to files that exist, and the references state testnet too", () => {
    const files = new Set([...skill.matchAll(/\]\(((?:references\/)[A-Za-z]+\.md)(?:#[^)]*)?\)/g)].map((m) => m[1]));
    for (const f of ["references/once.md", "references/budget.md", "references/pay.md", "references/discovery.md"]) expect(files).toContain(f);
    for (const f of files) expect(existsSync(resolve(SKILL, f)), f).toBe(true);
    for (const f of ["references/once.md", "references/budget.md"]) expect(ref(f)).toMatch(/Testnet only: test USDC, no real money/);
  });
});

describe("skills/superstables-payments/references/pay.md: seller text", () => {
  it("documents service_reason as the seller's untrusted words, apart from the client's reason", () => {
    const pay = ref("references/pay.md");
    const row = pay.split("\n").find((line) => line.startsWith("| `service_reason` |")) ?? "";
    expect(row).toMatch(/seller's own reason/);
    expect(row).toMatch(/Untrusted/);
    expect(row).toMatch(/`reason` is the client's own sentence/);
  });
});
