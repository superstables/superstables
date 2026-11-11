import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

describe("Node version at startup", () => {
  for (const [entry, name, loader] of [
    ["src/cli/main.ts", "superstables", true],
    ["budget/cli.mjs", "superstables budget", false],
  ] as const) {
    it(`${name} stops before handling a command on Node 20`, () => {
      const dir = mkdtempSync(join(tmpdir(), "superstables-node-version-"));
      try {
        const preload = join(dir, "old-node.cjs");
        writeFileSync(preload, 'Object.defineProperty(process.versions, "node", { value: "20.0.0" });\n');
        const args = ["--require", preload, ...(loader ? ["--import", "tsx"] : []), resolve(root, entry), "--help"];
        const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(`${name} needs Node 22 or newer; this is Node 20.0.0.\n`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
