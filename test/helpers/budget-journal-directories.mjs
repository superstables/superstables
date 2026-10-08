import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
const original = { ...fs };
const home = process.env.SUPERSTABLES_HOME;
const root = process.env.BUDGET_DURABILITY_ROOT;
const dir = join(home, 'new/budget/ops/rail');
const created = [], parents = [], synced = [], openedAncestors = [];
const descriptors = new Map();
fs.mkdirSync = (path, options) => {
  const result = original.mkdirSync(path, options);
  created.push(path); parents.push(dirname(path)); return result;
};
fs.openSync = (path, ...args) => {
  const fd = original.openSync(path, ...args); descriptors.set(fd, path);
  if (!String(path).startsWith(home)) openedAncestors.push(path);
  return fd;
};
fs.closeSync = fd => { descriptors.delete(fd); return original.closeSync(fd); };
fs.fsyncSync = fd => { synced.push(descriptors.get(fd)); return original.fsyncSync(fd); };
syncBuiltinESMExports();
const kind = process.argv[2];
if (kind === 'journal') {
  const { writeJournalFile } = await import(join(root, 'budget/journal.mjs'));
  writeJournalFile(join(dir, 'test.json'), '{"state":"submitted"}');
} else {
  const { lockOp } = await import(join(root, 'budget/buy-guard.mjs'));
  const { lockRecord } = await import(join(root, 'budget/op-lock.mjs'));
  const lock = (kind === 'dispatcher' ? lockOp : lockRecord)(dir, 'test');
  if (!lock.ok) throw new Error('lock acquisition failed');
  lock.release();
}
console.log(JSON.stringify({ created, parents, synced, openedAncestors }));
