// The build's guard for the npm package: the budget-only packages are devDependencies, so nothing an install of the
// client runs may import them, except dist/budget, which carries them bundled.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkClientImports, dynamicCjsImports } from "../../scripts/budget-build.mjs";

let dist: string;

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "superstables-dist-test-"));
  mkdirSync(join(dist, "cli"), { recursive: true });
  mkdirSync(join(dist, "budget", "lib"), { recursive: true });
  writeFileSync(join(dist, "cli", "main.js"), 'import { Command } from "commander";\n');
  writeFileSync(join(dist, "budget", "lib", "chunk.mjs"), 'import bs58 from "bs58";\nconst web3 = require("@solana/web3.js");\n');
});

afterEach(() => {
  rmSync(dist, { recursive: true, force: true });
});

describe("the client's imports after a build", () => {
  it("allows the budget-only packages inside dist/budget only", () => {
    expect(checkClientImports(dist)).toBe(1);
  });

  for (const [what, line] of [
    ["an import", 'import { Connection } from "@solana/web3.js";'],
    ["a subpath import", 'export * from "mppx/client";'],
    ["a dynamic import", 'const m = await import("@x402/fetch");'],
    ["a require call", 'const bs58 = require("bs58");'],
  ]) {
    it(`fails the build on ${what} of one elsewhere in dist/`, () => {
      writeFileSync(join(dist, "cli", "extra.js"), `${line}\n`);
      expect(() => checkClientImports(dist)).toThrow(/dist\/cli\/extra\.js imports/);
    });
  }
});

describe("the budget sources before a build", () => {
  it("import @solana/web3.js statically everywhere: a dynamic import of it is a wrapper once bundled", () => {
    expect(dynamicCjsImports()).toEqual([]);
  });

  it("are refused when one does", () => {
    const dir = mkdtempSync(join(tmpdir(), "superstables-budget-src-"));
    writeFileSync(join(dir, "setup.ts"), 'const { PublicKey } = await import("@solana/web3.js");\n');
    try {
      expect(dynamicCjsImports(dir)).toEqual([expect.stringContaining('setup.ts: import("@solana/web3.js")')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
