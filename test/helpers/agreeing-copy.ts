// A copy of the client (budget/, src/) whose Base Sepolia endpoint table names one fake RPC twice, as two operators, so a verdict
// that needs two agreeing endpoints can be reached against a single fake chain. The copy is edited on disk, as a later change to
// the table would be: no production switch is involved. Scratch lives under ~/.cache, never /tmp.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
let tree: string | undefined;

/** The dispatcher of the copy, with Base Sepolia's endpoints set to `url` (twice). One copy per process; call `removeAgreeingCopy` at the end. */
export function agreeingCopy(url: string): string {
  if (!tree) {
    mkdirSync(join(homedir(), ".cache", "superstables-tests"), { recursive: true });
    tree = mkdtempSync(join(homedir(), ".cache", "superstables-tests", "agreeing-copy-"));
    for (const dir of ["budget", "src"]) cpSync(join(ROOT, dir), join(tree, dir), { recursive: true });
    for (const file of ["package.json", "tsconfig.json"]) cpSync(join(ROOT, file), join(tree, file));
    symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"), "dir");
  }
  const text = readFileSync(join(ROOT, "src/core/rpc-endpoints.mjs"), "utf8");
  const from = /"base-sepolia": \[[^\]]*\],/s;
  if (!from.test(text)) throw new Error("the endpoint table has no base-sepolia entry to rewrite");
  writeFileSync(join(tree, "src/core/rpc-endpoints.mjs"), text.replace(from, `"base-sepolia": [{ url: "${url}", operator: "op-a" }, { url: "${url}/", operator: "op-b" }],`));
  return join(tree, "budget/cli.mjs");
}
export function removeAgreeingCopy() {
  if (tree) rmSync(tree, { recursive: true, force: true });
  tree = undefined;
}
