// Test-only: an approval record's file disappears at a chosen moment, as if something removed it right after a command had read it.
//   REMOVE_RECORD_AFTER_LOCK: the moment the record's lock is released (a command read it under the lock)
//   REMOVE_RECORD_AFTER_READ: the moment the record file has been read for the first time (a command's first read)
//   REWRITE_RECORD_AFTER_READ: the same moment, but the file is rewritten with the text of the file this variable names
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const unlink = fs.unlinkSync;
const read = fs.readFileSync;
const RECORD = /[\\/]approvals[\\/]oa-[^\\/]+\.json$/;
if (process.env.REMOVE_RECORD_AFTER_LOCK) {
  fs.unlinkSync = function (path) {
    const out = unlink.apply(this, arguments);
    const m = /^(.*[\\/]approvals[\\/]oa-[^\\/]+\.json)\.lock$/.exec(String(path));
    if (m) { try { unlink.call(fs, m[1]); } catch { /* already gone */ } }
    return out;
  };
}
if (process.env.REMOVE_RECORD_AFTER_READ || process.env.REWRITE_RECORD_AFTER_READ) {
  let done = false;
  fs.readFileSync = function (path) {
    const out = read.apply(this, arguments);
    if (!done && RECORD.test(String(path))) {
      done = true;
      try {
        if (process.env.REWRITE_RECORD_AFTER_READ) fs.writeFileSync(String(path), read.call(fs, process.env.REWRITE_RECORD_AFTER_READ, "utf8"));
        else unlink.call(fs, String(path));
      } catch { /* already gone */ }
    }
    return out;
  };
}
// LOG_RECORD_LOCKS: a file that gets one line for every attempt, by this process, to create a record lock (a path holding `.json.lock`)
if (process.env.LOG_RECORD_LOCKS) {
  const log = process.env.LOG_RECORD_LOCKS;
  const append = fs.appendFileSync;
  const note = (what, ...paths) => { for (const p of paths) if (/oa-[^\\/]*\.json\.lock/.test(String(p))) append.call(fs, log, `${what} ${p}\n`); };
  for (const name of ["openSync", "linkSync", "writeFileSync", "renameSync", "mkdirSync", "symlinkSync"]) {
    const real = fs[name];
    fs[name] = function (...args) { note(name, args[0], args[1]); return real.apply(this, args); };
  }
}
syncBuiltinESMExports();
