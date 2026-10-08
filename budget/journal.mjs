import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function durableDirectory(path) {
  if (existsSync(path)) return;
  const parent = dirname(path);
  durableDirectory(parent);
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
  syncDirectory(path);
  syncDirectory(parent);
}

/** Return only after both the JSON contents and its directory entry survive power loss. */
export function writeJournalFile(path, text) {
  const directory = dirname(path);
  durableDirectory(directory);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    syncDirectory(directory);
  } finally {
    try { unlinkSync(tmp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}
