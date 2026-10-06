// Identity reads denied by a sandbox. PID probes deliberately remain real.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const code = process.env.BUDGET_TEST_IDENTITY_ERROR ?? 'EPERM';
for (const name of ['readFileSync', 'readlinkSync']) {
  const read = fs[name];
  fs[name] = function (path, ...args) {
    if (String(path).startsWith('/proc/')) throw Object.assign(new Error(`sandbox denies ${path}`), { code });
    return read.call(this, path, ...args);
  };
}
const run = childProcess.execFileSync;
childProcess.execFileSync = function (command, ...args) {
  if (command === 'ps' || command === 'sysctl') throw Object.assign(new Error(`sandbox denies ${command}`), { code, status: 1 });
  return run.call(this, command, ...args);
};
syncBuiltinESMExports();
if (process.env.BUDGET_TEST_DENY_LISTEN === '1') {
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    if (!args.includes('127.0.0.1')) return listen.apply(this, args);
    queueMicrotask(() => this.emit('error', Object.assign(new Error('sandbox denies listen'), { code: 'EPERM' })));
    return this;
  };
}
