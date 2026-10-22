// Test-only: with FAIL_SYNC_AFTER_RENAME set, the first fsync of a directory after an approval record is renamed into place fails with
// EIO, as a disk fault after a write that has already landed would. Only an approval record's rename arms it, and it fires once.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

if (process.env.FAIL_SYNC_AFTER_RENAME) {
  const rename = fs.renameSync;
  const fsync = fs.fsyncSync;
  let armed = false;
  fs.renameSync = function (from, to) {
    rename.apply(this, arguments);
    if (/[\\/]approvals[\\/]oa-[^\\/]+\.json$/.test(String(to))) armed = true;
  };
  fs.fsyncSync = function (fd) {
    if (armed) {
      let directory = false;
      try { directory = fs.fstatSync(fd).isDirectory(); } catch { /* not a descriptor we can read */ }
      if (directory) { armed = false; throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO", syscall: "fsync" }); }
    }
    return fsync.apply(this, arguments);
  };
  syncBuiltinESMExports();
}
