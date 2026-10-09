import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: process.env.LIVENESS_PLATFORM ?? 'darwin' });
const run = childProcess.execFileSync;
childProcess.execFileSync = function (command, args, options) {
  if (command === 'ioreg') return '"IOPlatformUUID" = "11111111-2222-3333-4444-555555555555"';
  if (command === 'sysctl') return 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  if (command === 'ps') {
    if (process.env.LIVENESS_PS === 'fail') throw Object.assign(Error('denied'), { status: 2, code: 'EPERM' });
    if (process.env.LIVENESS_PS === 'missing') throw Object.assign(Error('missing'), { status: 1 });
    return 'Wed Oct  7 01:00:00 2026';
  }
  return run.call(this, command, args, options);
};
syncBuiltinESMExports();
