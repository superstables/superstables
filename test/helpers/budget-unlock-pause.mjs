// Test-only preload: pause an owner-confirmed unlock immediately before it unlinks the inspected operation lock.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const unlink = fs.unlinkSync;
let paused = false;
fs.unlinkSync = function (path, ...args) {
  if (!paused && String(path) === process.env.BUDGET_TEST_PAUSE_LOCK) {
    paused = true;
    console.log(JSON.stringify({ event: 'unlock-paused' }));
    process.kill(process.pid, 'SIGSTOP');
  }
  return unlink.call(this, path, ...args);
};
syncBuiltinESMExports();
