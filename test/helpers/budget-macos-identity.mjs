// Run the process fault matrix in macOS mode on Linux:
// node --import ./test/helpers/budget-macos-identity.mjs test/helpers/budget-lock-faults.mjs single
// Node forks inherit this preload. ps and PID probes use real processes; sysctl
// supplies a fixed boot identity because the test host has no kern.bootsessionuuid.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'darwin' });
// Fail even when production code catches a denied read, so the portable fixture check cannot hide one.
if (process.env.BUDGET_TEST_DENY_PROC === '1') {
  let attempts = 0;
  for (const name of ['readFileSync', 'readlinkSync']) {
    const real = fs[name];
    fs[name] = function (path, ...args) {
      if (String(path).startsWith('/proc/')) { attempts++; throw new Error(`unexpected macOS proc read: ${path}`); }
      return real.call(this, path, ...args);
    };
  }
  process.on('exit', () => { if (attempts) { console.error(`unexpected macOS proc reads: ${attempts}`); process.exitCode = 1; } });
}
const run = childProcess.execFileSync;
childProcess.execFileSync = function (command, ...args) {
  if (command === 'sysctl') return 'B0AAAEAB-5578-4A8D-BB24-2FA546301F7A';
  return run.call(this, command, ...args);
};
syncBuiltinESMExports();
