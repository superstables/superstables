// Account homes for tests that need specific owner settings (src/core/owner-settings.js). The product reads the settings from the
// home directory the operating system records for the user; test/account-guard.mjs answers with SUPERSTABLES_TEST_ACCOUNT_HOME
// when it is set. Point that variable at the folder this returns.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/** What the default test account home holds (test/account-guard.mjs): loopback fake sites and fake RPCs are the owner's. */
export const DEV_SETTINGS = { version: 1 as const, site: { allowLoopback: true as const }, rpcEnv: { allowLoopback: true as const } };

const made = new Set<string>();
// the test process removes every home it made, whether or not the test file did
const sweep = () => { for (const h of made) rmSync(h, { recursive: true, force: true }); made.clear(); };
process.on("exit", sweep);
afterAll(sweep);

/**
 * A fresh account home for SUPERSTABLES_TEST_ACCOUNT_HOME. `null`: no settings file (the production defaults).
 * `raw`: write this text as is. `mode`: the file's mode (default 0o600).
 */
export function accountHomeWith(settings: object | null, opts: { raw?: string; mode?: number } = {}): string {
  const home = mkdtempSync(join(tmpdir(), "superstables-test-account-"));
  made.add(home);
  if (settings === null && opts.raw === undefined) return home;
  const state = join(home, ".superstables");
  const dir = join(state, "owner");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  chmodSync(dir, 0o700);
  const file = join(dir, "settings.json");
  writeFileSync(file, opts.raw ?? `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, opts.mode ?? 0o600);
  return home;
}
