// The rail journal writers (budget/evm/ops.ts, budget/tempo/lib/ops.ts, budget/solana/ops.mjs) bundled once per test file
// into a temporary folder as plain JavaScript, so a fault-injection helper can start with node alone instead of tsx.
// Node built-ins stay external: the helper patches `fs` before it imports the built module, and the module's own
// `import ... from "node:fs"` reads the patched exports exactly as it does from the sources.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll } from "vitest";

const ENTRIES: Record<string, string> = { evm: "budget/evm/ops.ts", tempo: "budget/tempo/lib/ops.ts", solana: "budget/solana/ops.mjs" };
const built = new Map<string, string>();
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); built.clear(); });

/** The folder holding `evm.mjs`, `tempo.mjs` and `solana.mjs`, built from the checkout at `root` (once per root). */
export function builtOps(root: string): string {
  const known = built.get(root);
  if (known) return known;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ss-journal-ops-"));
  dirs.push(dir);
  buildSync({
    absWorkingDir: root,
    entryPoints: ENTRIES,
    outdir: dir,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outExtension: { ".js": ".mjs" },
    banner: { js: 'import { createRequire as __budgetRequire } from "node:module"; const require = __budgetRequire(import.meta.url);' },
    external: ["bufferutil", "utf-8-validate", "encoding"],
    logLevel: "warning",
  });
  built.set(root, dir);
  return dir;
}
