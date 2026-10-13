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
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

if (!globalThis.__superstablesAccountGuard) {
  globalThis.__superstablesAccountGuard = true;
  const realUserInfo = os.userInfo;
  let empty;
  const emptyHome = () => {
    if (!empty) {
      empty = mkdtempSync(join(os.tmpdir(), "superstables-test-no-account-"));
      process.once("exit", () => rmSync(empty, { recursive: true, force: true }));
    }
    return empty;
  };
  os.userInfo = function guardedUserInfo(options) {
    const info = realUserInfo.call(os, options);
    return { ...info, homedir: process.env.SUPERSTABLES_TEST_ACCOUNT_HOME ?? emptyHome() };
  };
  syncBuiltinESMExports();
}
