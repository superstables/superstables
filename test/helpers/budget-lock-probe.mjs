import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const { PROBE_ROOT: root, PROBE_PATH: path, PROBE_ACTION: action } = process.env;
const { lockFile } = await import(join(root, 'budget/op-lock.mjs'));
const lock = lockFile(path);
if (!lock.ok) throw new Error('probe did not acquire');
if (action === 'hidden-proc') {
  const read = fs.readFileSync;
  fs.readFileSync = function (path, ...args) {
    if (String(path) === `/proc/${process.pid}/stat`) throw Object.assign(new Error('proc entry hidden'), { code: 'ENOENT' });
    return read.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  const blocked = lockFile(path);
  fs.readFileSync = read; syncBuiltinESMExports();
  console.log(JSON.stringify({ protected: !blocked.ok }));
  if (blocked.ok) blocked.release();
  lock.release();
} else if (action === 'failed-child-write') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.on('exit', () => child.kill('SIGKILL'));
  const write = fs.writeFileSync;
  fs.writeFileSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  syncBuiltinESMExports();
  try { lock.holdAlso(child.pid); } catch {}
  fs.writeFileSync = write;
  syncBuiltinESMExports();
  lock.release();
  process.stdout.write(JSON.stringify({ retained: fs.existsSync(path), child: child.pid }) + '\n');
  child.once('exit', () => { lock.release(); process.exit(0); });
  process.stdin.once('data', () => child.kill('SIGKILL'));
} else {
  process.stdout.write('ready\n');
  setInterval(() => {}, 1000);
}
