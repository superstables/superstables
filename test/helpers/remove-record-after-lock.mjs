// Test-only: an approval record's file disappears at a chosen moment, as if something removed it right after a command had read it.
//   REMOVE_RECORD_AFTER_LOCK: the moment the record's lock is released (a command read it under the lock)
//   REMOVE_RECORD_AFTER_READ: the moment the record file has been read for the Nth time, N being the number this variable holds ("1": a
//     command's first read)
//   REWRITE_RECORD_AFTER_READ: the same moment, but the file is rewritten with the text of the file this variable names; the number of the
//     read is in REWRITE_RECORD_AFTER_READ_N (1 when it is not set)
//   RECORD_EVENTS: a file that gets one line for each thing the command does to a record or a chain, in order: `read N locked|open` (the
//     Nth read of a record file, and whether this process held that record's lock then), `mutate N` (the hook changed the file after read
//     N), `write` (a record file was replaced), `chain` (a chain lock was created or removed) and `launch` (a worker was started: its log
//     was opened for appending)
// Only the process the hook was loaded into first acts and counts: a worker that command starts inherits the hook, and does nothing.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const first = !process.env.RECORD_HOOK_PID || process.env.RECORD_HOOK_PID === String(process.pid);
process.env.RECORD_HOOK_PID ??= String(process.pid);
const unlink = fs.unlinkSync;
const read = fs.readFileSync;
const append = fs.appendFileSync;
const RECORD = /[\\/]approvals[\\/]oa-[^\\/]+\.json$/;
const CHAIN = /[\\/]approvals[\\/]active-[^\\/.]+$/;
const LOG = /[\\/]approvals[\\/]oa-[^\\/]+\.log$/;
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
const mutating = first && (process.env.REMOVE_RECORD_AFTER_READ || process.env.REWRITE_RECORD_AFTER_READ);
if (mutating || events) {
  const nth = mutating ? Number(process.env.REWRITE_RECORD_AFTER_READ ? process.env.REWRITE_RECORD_AFTER_READ_N : process.env.REMOVE_RECORD_AFTER_READ) || 1 : 0;
  let reads = 0;
  fs.readFileSync = function (path) {
    const out = read.apply(this, arguments);
    if (RECORD.test(String(path))) {
      reads++;
      event(`read ${reads} ${holding(String(path)) ? "locked" : "open"}`);
      if (reads === nth) {
        try {
          if (process.env.REWRITE_RECORD_AFTER_READ) fs.writeFileSync(String(path), read.call(fs, process.env.REWRITE_RECORD_AFTER_READ, "utf8"));
          else unlink.call(fs, String(path));
        } catch { /* already gone */ }
        event(`mutate ${reads}`);
      }
    }
    return out;
  };
}
if (events) {
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) { const out = rename.apply(this, arguments); if (RECORD.test(String(to))) event("write"); return out; };
  const link = fs.linkSync;
  fs.linkSync = function (from, to) { const out = link.apply(this, arguments); if (CHAIN.test(String(to))) event("chain"); return out; };
  const remove = fs.unlinkSync;
  fs.unlinkSync = function (path) { const out = remove.apply(this, arguments); if (CHAIN.test(String(path))) event("chain"); return out; };
  const open = fs.openSync;
  fs.openSync = function (path, flags) { const out = open.apply(this, arguments); if (LOG.test(String(path)) && String(flags).startsWith("a")) event("launch"); return out; };
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
