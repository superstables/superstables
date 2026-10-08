// Exercise the production journal writers with a disk that loses un-fsynced data.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.BUDGET_DURABILITY_ROOT;
const [rail, checkpoint, stopAt = 'returned', failAt] = process.argv.slice(2);
const home = process.env.SUPERSTABLES_HOME;
const op = 'durability-test';
const dir = join(home, 'budget/ops', rail === 'evm' ? 'evm-base-sepolia' : rail === 'tempo' ? 'tempo-moderato' : 'solana-devnet');
const path = join(dir, `${op}.json`);
fs.mkdirSync(dir, { recursive: true });
const now = new Date().toISOString();
const previous = { op, rail, path: 'approve', state: rail === 'solana' ? 'intent' : 'quoted', signed: false, delivered: null, createdAt: now, updatedAt: now, notes: [], history: [] };
fs.writeFileSync(path, JSON.stringify(previous));
let durable = fs.readFileSync(path, 'utf8');
const originals = { ...fs };
const descriptors = new Map();
const synced = new Set();
const files = new Set();
const events = [];
let renamed;
let killed = false;
const event = step => { events.push(step); if (stopAt === step) { killed = true; throw new Error('simulated power loss'); } };
const journalFile = p => p === path || p.startsWith(path + '.');
const source = p => typeof p === 'number' ? descriptors.get(p) : String(p);
fs.openSync = function (p, flags, mode) {
  const fd = originals.openSync(p, flags, mode);
  descriptors.set(fd, String(p));
  if (journalFile(String(p))) { files.add(String(p)); event('file-open'); }
  else if (String(p) === dir && renamed) event('directory-open');
  return fd;
};
fs.writeFileSync = function (p, ...args) {
  const result = originals.writeFileSync(p, ...args);
  const name = source(p);
  if (name && journalFile(name)) { files.add(name); synced.delete(name); event('write'); }
  return result;
};
fs.fsyncSync = function (fd) {
  const name = descriptors.get(fd);
  if ((failAt === 'file-fsync' && name && journalFile(name)) || (failAt === 'directory-fsync' && name === dir && renamed)) {
    throw Object.assign(new Error('injected fsync failure'), { code: 'EIO' });
  }
  originals.fsyncSync(fd);
  if (name && journalFile(name)) { synced.add(name); event('file-fsync'); }
  else if (name === dir && renamed) {
    if (synced.has(path)) durable = originals.readFileSync(path, 'utf8');
    event('directory-fsync');
  }
};
fs.closeSync = function (fd) {
  originals.closeSync(fd);
  const name = descriptors.get(fd); descriptors.delete(fd);
  if (name && journalFile(name)) event('file-close');
  else if (name === dir && renamed) event('directory-close');
};
fs.renameSync = function (from, to) {
  const result = originals.renameSync(from, to);
  if (String(to) === path) {
    if (synced.has(String(from))) synced.add(path);
    renamed = true; event('rename');
  }
  return result;
};
syncBuiltinESMExports();
const module = await import(pathToFileURL(join(root, rail === 'evm' ? 'budget/evm/ops.ts' : rail === 'tempo' ? 'budget/tempo/lib/ops.ts' : 'budget/solana/ops.mjs')).href);
const record = { ...previous, checkpoint, state: checkpoint === 'quote' ? 'quoted' : checkpoint === 'intent' ? 'intent' : 'submitted',
  ...(checkpoint === 'pull-hash' ? { pullTx: `0x${'ab'.repeat(32)}`, pullNonce: 7 } : {}),
  ...(checkpoint === 'authorization' ? { signed: true, auth: { nonce: `0x${'cd'.repeat(32)}`, validBefore: 1500 } } : {}),
  ...(checkpoint === 'push-intent' ? { memo: `0x${'ef'.repeat(32)}`, startBlock: '10' } : {}),
  ...(checkpoint === 'cancel-hash' ? { cancelTx: `0x${'de'.repeat(32)}`, cancelNonce: 8 } : {}),
  ...(checkpoint === 'return-hash' ? { returnTx: `0x${'fa'.repeat(32)}`, returnNonce: 9 } : {}),
  ...(checkpoint === 'pull-submitted' ? { signedHash: `0x${'12'.repeat(32)}`, validBefore: 1500 } : {}),
  ...(checkpoint === 'push-submitted' ? { expectedTx: `0x${'34'.repeat(32)}` } : {}),
  ...(checkpoint === 'signature' ? { agentSig: 'test-signature', lastValidBlockHeight: 1500 } : {}),
};
let mayPay = false;
let error;
try {
  if (rail === 'evm') module.writeJournal(record);
  else if (rail === 'tempo') module.writeOp(record);
  else module.writeOp(op, record);
  event('returned');
  // The caller may sign or broadcast only after the production writer returned.
  mayPay = true;
} catch (err) { if (!killed && !failAt) throw err; error = err.code ?? err.message; }
// A power cut keeps only the file data and rename committed by directory fsync.
for (const p of files) if (p !== path) { try { originals.unlinkSync(p); } catch {} }
originals.writeFileSync(path, durable);
console.log(JSON.stringify({ rail, checkpoint, stopAt, killed, mayPay, error, events, recovered: JSON.parse(originals.readFileSync(path, 'utf8')) }));
