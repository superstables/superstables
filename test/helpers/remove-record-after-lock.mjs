// Test-only: with REMOVE_RECORD_AFTER_LOCK set, an approval record's file disappears the moment its lock is released, as if
// something removed it right after a command had read it under the lock.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

if (process.env.REMOVE_RECORD_AFTER_LOCK) {
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (path) {
    const out = unlink.apply(this, arguments);
    const m = /^(.*[\\/]approvals[\\/]oa-[^\\/]+\.json)\.lock$/.exec(String(path));
    if (m) { try { unlink.call(fs, m[1]); } catch { /* already gone */ } }
    return out;
  };
  syncBuiltinESMExports();
}
