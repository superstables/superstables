// The budget CLI built the way the npm package ships it (scripts/budget-build.mjs), once per test file, into a temporary
// folder. Its rail scripts run with node alone, where the sources start each one through tsx, about a second a process.
// Test files that run the CLI many times use it; the rest keep running the sources. Call it at the top of the file.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The folder of the built CLI: `<dir>/cli.mjs`, and each rail script at `<dir>/<rail>/<name>.mjs`. */
export function budgetBundle(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ss-budget-bundle-"));
  try {
    execFileSync(process.execPath, [resolve(ROOT, "scripts/budget-build.mjs"), "--outdir", dir], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
