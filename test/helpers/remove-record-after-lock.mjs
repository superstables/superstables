// Test-only: an approval record's file disappears at a chosen moment, as if something removed it right after a command had read it.
//   REMOVE_RECORD_AFTER_LOCK: the moment the record's lock is released (a command read it under the lock)
//   REMOVE_RECORD_AFTER_READ: the moment the record file has been read for the first time (a command's first read)
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
if (process.env.REMOVE_RECORD_AFTER_READ) {
  let done = false;
  fs.readFileSync = function (path) {
    const out = read.apply(this, arguments);
    if (!done && RECORD.test(String(path))) { done = true; try { unlink.call(fs, String(path)); } catch { /* already gone */ } }
    return out;
  };
}
syncBuiltinESMExports();
