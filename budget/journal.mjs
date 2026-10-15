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
 * The journal at `path`, parsed, or null when there is none. A file that is there but is not a journal of operation `op`
 * (cut short, edited, unreadable, another operation's, or without the fields its rail writes into every journal: `problem`)
 * is never "no purchase": that purchase may have paid. The command stops here, signs and sends nothing, keeps the file, and
 * answers unknown (exit 5), as a held lock does (op-lock.mjs requireRecordLock).
 * @param {string} path
 * @param {string} op
 * @param {(value: Record<string, any>, op: string) => string} problem the rail's check: "" for a journal of `op`, else why not
 */
export function readJournalFile(path, op, problem) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (err) { if (err?.code === 'ENOENT') return null; unreadableJournal(path, op, `it could not be read (${/^[A-Z0-9_]+$/.test(String(err?.code)) ? err.code : 'error'})`); }
  let value;
  try { value = JSON.parse(text); } catch { unreadableJournal(path, op, 'it is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) unreadableJournal(path, op, 'it does not hold a journal');
  const why = problem(value, op);
  if (why) unreadableJournal(path, op, `it does not hold a journal of this operation (${why})`);
  return value;
}
function unreadableJournal(path, op, why) {
  const rail = basename(dirname(path)).split('-')[0];
  console.error(`The journal of operation ${op} (${path}) cannot be used: ${why}. Nothing was signed or sent now. That purchase may already have paid, so it is never read as no purchase: do not pay for it again under another --op.`);
  console.log('RESULT ' + JSON.stringify({ rail, op, state: 'unknown', paid: null, debit: null, delivered: null, reason: `journal_unreadable: ${why}`, next: "the owner checks this journal file and the agent's payments on chain; never pay again for this op" }));
  process.exit(5);
}

// The states each rail records in its journals: OpState in evm/ops.ts and tempo/lib/ops.ts, and the list at the top of
// solana/ops.mjs. A journal in any other state was not written by this client.
const PURCHASE_STATES = ['quoted', 'submitted', 'settled', 'failed', 'refused_precheck', 'refused_chain', 'unknown', 'not_found'];
const SOLANA_STATES = ['intent', 'refused_precheck', 'submitted', 'unknown', 'settled', 'failed', 'refused_chain', 'not_found'];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** What every rail's journal holds from its first write on: this operation's id, and a state that rail records. */
function opProblem(j, op, states) {
  if (typeof j.op !== 'string') return 'it names no operation';
  if (j.op !== op) return 'it names another operation';
  if (!states.includes(j.state)) return 'its state is missing or is not one this rail records';
  return '';
}

/** Why `j` is not an evm purchase journal of `op`, or "". evm/ops.ts newJournal writes all of these in the first write. */
export function evmJournalProblem(j, op) {
  return opProblem(j, op, PURCHASE_STATES)
    || (j.path !== 'approve' ? 'it is not an evm purchase journal' : '')
    || (typeof j.owner !== 'string' || !ADDRESS.test(j.owner) || typeof j.agent !== 'string' || !ADDRESS.test(j.agent) ? 'its owner or agent is not an address' : '')
    || (typeof j.createdAt !== 'string' ? 'it has no creation time' : '')
    || (!Array.isArray(j.notes) ? 'it has no notes' : '');
}

/** Why `j` is not a tempo purchase journal of `op`, or "". tempo/buy.ts baseOp writes all of these in the first write. */
export function tempoOpProblem(j, op) {
  return opProblem(j, op, PURCHASE_STATES)
    || (j.rail !== 'tempo' ? 'it is not a tempo purchase journal' : '')
    || (typeof j.createdAt !== 'string' ? 'it has no creation time' : '')
    || (!isRecord(j.intent) ? 'it has no purchase intent' : '')
    || (!Array.isArray(j.history) ? 'it has no history' : '');
}

/**
 * Why `j` is not a solana purchase journal of `op`, or "". Only what solana/ops.mjs updateOp writes every time: a refusal
 * before the agent key is read (solana/buy.mjs step 4) records no agent, rail or creation time.
 */
export function solanaOpProblem(j, op) {
  return opProblem(j, op, SOLANA_STATES) || (!Array.isArray(j.history) ? 'it has no history' : '');
}

/** Why `value` is not a journal of `op` on `rail`, in words, or "": for a reader that serves every rail (budget/cli.mjs). */
export function journalProblem(rail, value, op) {
  const problem = { evm: evmJournalProblem, tempo: tempoOpProblem, solana: solanaOpProblem }[rail];
  return problem ? problem(value, op) : 'it is not a journal of a rail this client knows';
}
