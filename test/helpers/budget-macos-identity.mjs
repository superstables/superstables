// Run the process fault matrix in macOS mode on Linux:
// node --import ./test/helpers/budget-macos-identity.mjs test/helpers/budget-lock-faults.mjs single
// Node forks inherit this preload. ps and PID probes use real processes; sysctl
// supplies a fixed boot identity because the test host has no kern.bootsessionuuid.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'darwin' });
const read = fs.readFileSync;
fs.readFileSync = function (path, ...args) {
  // The fault runner's stale fixture predates platform-aware boot records.
  if (String(path) === '/proc/sys/kernel/random/boot_id') return 'b0aaaeab-5578-4a8d-bb24-2fa546301f7a';
  return read.call(this, path, ...args);
};
const run = childProcess.execFileSync;
childProcess.execFileSync = function (command, ...args) {
  if (command === 'sysctl') return 'B0AAAEAB-5578-4A8D-BB24-2FA546301F7A';
  return run.call(this, command, ...args);
};
syncBuiltinESMExports();
