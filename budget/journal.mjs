import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

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

/**
 * The journal at `path`, parsed, or null when there is none. A file that is there but is not a journal (cut short, edited,
 * unreadable) is never "no purchase": that purchase may have paid. The command stops here, signs and sends nothing, keeps
 * the file, and answers unknown (exit 5), as a held lock does (op-lock.mjs requireRecordLock).
 */
export function readJournalFile(path, op) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (err) { if (err?.code === 'ENOENT') return null; unreadableJournal(path, op, `it could not be read (${/^[A-Z0-9_]+$/.test(String(err?.code)) ? err.code : 'error'})`); }
  let value;
  try { value = JSON.parse(text); } catch { unreadableJournal(path, op, 'it is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) unreadableJournal(path, op, 'it does not hold a journal');
  return value;
}
function unreadableJournal(path, op, why) {
  const rail = basename(dirname(path)).split('-')[0];
  console.error(`The journal of operation ${op} (${path}) cannot be used: ${why}. Nothing was signed or sent now. That purchase may already have paid, so it is never read as no purchase: do not pay for it again under another --op.`);
  console.log('RESULT ' + JSON.stringify({ rail, op, state: 'unknown', paid: null, debit: null, delivered: null, reason: `journal_unreadable: ${why}`, next: "the owner checks this journal file and the agent's payments on chain; never pay again for this op" }));
  process.exit(5);
}
