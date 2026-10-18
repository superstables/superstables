// Test-only: the account's own policy file (~/.superstables/policy.yaml, read from the home directory the operating system
// records for the user, see accountPolicyPath in src/core/home.ts) must not be the developer's real one. Loaded like
// test/fetch-guard.mjs: by test/setup-offline.ts in the test workers and, through NODE_OPTIONS, in every node process a
// test starts. os.userInfo() answers with the real user but a home directory that holds nothing, unless a test points
// SUPERSTABLES_TEST_ACCOUNT_HOME at a directory it prepared. The product never reads that variable, so it is not a
// setting an agent could use.
//
// With no variable set, the home is a path that cannot exist: a fresh, empty directory made for this run, removed again
// when the process ends, so another local user cannot plant a policy at a name known in advance. (A node process a test
// starts makes its own empty one.) SUPERSTABLES_LIVE runs skip this guard on purpose: they are the real thing.
//
// The same home holds the owner's settings (~/.superstables/owner/settings.json, src/core/owner-settings.js). The fresh
// empty home gets a development settings file, so the many tests that use a fake site or a fake RPC on this computer keep
// working. A test that needs the production defaults, or other settings, points SUPERSTABLES_TEST_ACCOUNT_HOME at a folder
// made by accountHomeWith() in test/helpers/owner-settings.ts.
import os from "node:os";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

if (!globalThis.__superstablesAccountGuard) {
  globalThis.__superstablesAccountGuard = true;
  const realUserInfo = os.userInfo;
  let empty;
  const emptyHome = () => {
    if (!empty) {
      empty = mkdtempSync(join(os.tmpdir(), "superstables-test-no-account-"));
      const dir = join(empty, ".superstables", "owner");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const d of [join(empty, ".superstables"), dir]) chmodSync(d, 0o700);
      writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ version: 1, site: { allowLoopback: true }, rpcEnv: { allowLoopback: true } })}\n`, { mode: 0o600 });
      const remove = () => rmSync(empty, { recursive: true, force: true });
      process.once("exit", remove);
      // a test runner that ends a worker without running exit handlers calls this itself (test/setup-offline.ts)
      globalThis.__superstablesRemoveNoAccountHome = remove;
    }
    return empty;
  };
  os.userInfo = function guardedUserInfo(options) {
    const info = realUserInfo.call(os, options);
    return { ...info, homedir: process.env.SUPERSTABLES_TEST_ACCOUNT_HOME ?? emptyHome() };
  };
  syncBuiltinESMExports();
}
