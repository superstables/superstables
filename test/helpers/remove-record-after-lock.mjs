// Test-only: an approval record's file disappears at a chosen moment, as if something removed it right after a command had read it.
//   REMOVE_RECORD_AFTER_LOCK: the moment the record's lock is released (a command read it under the lock)
//   REMOVE_RECORD_AFTER_READ: the moment the record file has been read for the Nth time, N being the number this variable holds ("1": a
//     command's first read)
//   REWRITE_RECORD_AFTER_READ: the same moment, but the file is rewritten with the text of the file this variable names; the number of the
//     read is in REWRITE_RECORD_AFTER_READ_N (1 when it is not set)
//   CHANGE_RECORD_AT: "<kind> <n>", any moment the events below name: right after the nth `read`, `write`, `chain` or `launch`. The file is
//     rewritten with the text of the file CHANGE_RECORD_TO names, or removed when that is not set
//   RECORD_ID: only the record of this approval counts, is changed and is logged (another approval's record, such as that of the approval
//     that holds the chain, is read as it is)
//   RECORD_EVENTS: a file that gets one line for each thing the command does to a record or a chain, in order: `read N locked|open` (the
//     Nth read of a record file, and whether this process held that record's lock then), `write N`, `chain N` and `launch N` (a record file
//     was replaced, a chain lock was created or removed, a worker was started: its log was opened for appending), each with `locked` or
//     `open` as well, `unlock` (this process released the record's lock) and `mutate <kind> N` (the hook changed the file right after that
//     event)
// Only the process the hook was loaded into first acts and counts: a worker that command starts inherits the hook, and does nothing.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const first = !process.env.RECORD_HOOK_PID || process.env.RECORD_HOOK_PID === String(process.pid);
process.env.RECORD_HOOK_PID ??= String(process.pid);
const unlink = fs.unlinkSync;
const read = fs.readFileSync;
const append = fs.appendFileSync;
const ID = process.env.RECORD_ID;
const RECORD = ID ? new RegExp(`[\\\\/]approvals[\\\\/]${ID}\\.json$`) : /[\\/]approvals[\\/]oa-[^\\/]+\.json$/;
const CHAIN = /[\\/]approvals[\\/]active-[^\\/.]+$/;
const LOG = ID ? new RegExp(`[\\\\/]approvals[\\\\/]${ID}\\.log$`) : /[\\/]approvals[\\/]oa-[^\\/]+\.log$/;
const events = first ? process.env.RECORD_EVENTS : undefined;
const event = (line) => { if (events) append.call(fs, events, `${line}\n`); };
/** Whether this process holds the lock of the record at `path` (its lock file names this pid). */
const holding = (path) => { try { return JSON.parse(read.call(fs, `${path}.lock`, "utf8")).pid === process.pid; } catch { return false; } };
if (first && process.env.REMOVE_RECORD_AFTER_LOCK) {
  fs.unlinkSync = function (path) {
    const out = unlink.apply(this, arguments);
    const m = /^(.*[\\/]approvals[\\/]oa-[^\\/]+\.json)\.lock$/.exec(String(path));
    if (m) { try { unlink.call(fs, m[1]); } catch { /* already gone */ } }
    return out;
  };
}
const legacy = process.env.REMOVE_RECORD_AFTER_READ || process.env.REWRITE_RECORD_AFTER_READ;
const at = !first ? null
  : process.env.CHANGE_RECORD_AT ? process.env.CHANGE_RECORD_AT.split(" ")
  : legacy ? ["read", process.env.REWRITE_RECORD_AFTER_READ ? process.env.REWRITE_RECORD_AFTER_READ_N : process.env.REMOVE_RECORD_AFTER_READ] : null;
const to = process.env.CHANGE_RECORD_AT ? process.env.CHANGE_RECORD_TO : process.env.REWRITE_RECORD_AFTER_READ;
if (at || events) {
  const count = { read: 0, write: 0, chain: 0, launch: 0 };
  // the record this command works on: the one it last read or wrote (a chain lock or a worker's log does not name its file)
  let record = null;
  /** Count one event of `kind`, and change the record right after the one CHANGE_RECORD_AT names. */
  const happened = (kind, line) => {
    count[kind]++;
    event(line ?? `${kind} ${count[kind]} ${record && holding(record) ? "locked" : "open"}`);
    if (at && at[0] === kind && (Number(at[1]) || 1) === count[kind] && record) {
      try {
        if (to) fs.writeFileSync(record, read.call(fs, to, "utf8"));
        else unlink.call(fs, record);
      } catch { /* already gone */ }
      event(`mutate ${kind} ${count[kind]}`);
    }
  };
  fs.readFileSync = function (path) {
    if (!RECORD.test(String(path))) return read.apply(this, arguments);
    // every attempt counts, one that finds no file included: a read that finds the file gone is a read
    record = String(path);
    const line = `read ${count.read + 1} ${holding(record) ? "locked" : "open"}`;
    let out;
    try { out = read.apply(this, arguments); } finally { happened("read", line); }
    return out;
  };
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) { const out = rename.apply(this, arguments); if (RECORD.test(String(to))) { record = String(to); happened("write"); } return out; };
  const link = fs.linkSync;
  fs.linkSync = function (from, to) { const out = link.apply(this, arguments); if (CHAIN.test(String(to))) happened("chain"); return out; };
  const remove = fs.unlinkSync;
  fs.unlinkSync = function (path) {
    const out = remove.apply(this, arguments);
    if (CHAIN.test(String(path))) happened("chain");
    // the record's lock released: what this process read or wrote under it is one locked step
    else if (/\.lock$/.test(String(path)) && RECORD.test(String(path).slice(0, -5))) event("unlock");
    return out;
  };
  const open = fs.openSync;
  fs.openSync = function (path, flags) { const out = open.apply(this, arguments); if (LOG.test(String(path)) && String(flags).startsWith("a")) happened("launch"); return out; };
}
// LOG_RECORD_LOCKS: a file that gets one line for every attempt, by this process, to create a record lock (a path holding `.json.lock`)
if (first && process.env.LOG_RECORD_LOCKS) {
  const log = process.env.LOG_RECORD_LOCKS;
  const note = (what, ...paths) => { for (const p of paths) if (/oa-[^\\/]*\.json\.lock/.test(String(p))) append.call(fs, log, `${what} ${p}\n`); };
  for (const name of ["openSync", "linkSync", "writeFileSync", "renameSync", "mkdirSync", "symlinkSync"]) {
    const real = fs[name];
    fs[name] = function (...args) { note(name, args[0], args[1]); return real.apply(this, args); };
  }
}
syncBuiltinESMExports();
