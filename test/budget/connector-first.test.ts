// A reference that walks through a CLI route for something the connector can do must say, before its first CLI
// command, that signed-in tools come first. An agent that reads only that file would otherwise run the CLI.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f: string) => readFileSync(resolve(ROOT, f), "utf8");
const FIRST_CLI = /`superstables [a-z]/;

describe("connector-first routing in the references", () => {
  for (const base of ["skills/superstables-payments/references", "plugin/skills/superstables/references"]) {
    it(`${base}/once.md names request_purchase and get_purchase_status before its first CLI command`, () => {
      const text = read(`${base}/once.md`);
      const cli = text.search(FIRST_CLI);
      expect(cli).toBeGreaterThan(0);
      const before = text.slice(0, cli);
      expect(before).toMatch(/signed in/);
      expect(before).toMatch(/`request_purchase`/);
      expect(before).toMatch(/`get_purchase_status`/);
      expect(before).toMatch(/Do not run the `buy-once` command/);
      expect(before).toMatch(/missing|declined|signed out/);
    });

    it(`${base} tells a chat app to decline local-signature operations without running commands`, () => {
      const text = read(base.startsWith("plugin") ? "plugin/skills/superstables/SKILL.md" : "skills/superstables-payments/SKILL.md");
      expect(text).toMatch(/In a chat app[\s\S]*?don.t run\s+commands to check[\s\S]*?decline/);
      expect(text).toMatch(/signature/);
      expect(text).not.toMatch(/temporary sandbox is not enough/);
    });

    it(`${base}/budget.md sends a signed-in evm hosted setup through submit_budget_request before the direct command`, () => {
      const text = read(`${base}/budget.md`);
      const step = text.indexOf("2. **One approval link.**");
      const direct = text.indexOf("`superstables budget setup --rail evm --hosted", step);
      expect(step).toBeGreaterThan(0);
      expect(text.slice(step, direct)).toMatch(/`submit_budget_request`[\s\S]*--sign-only/);
    });
  }
});
