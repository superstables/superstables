// A --import preload: the Nth rename onto <FAULT_OP>.json (1-based; FAIL_RENAMES is a comma list) throws ENOSPC, once each.
// Every journal write ends in such a rename (budget/journal.mjs), so this is a disk that fills up at one chosen write.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const fail = new Set(String(process.env.FAIL_RENAMES || '').split(',').filter(Boolean).map(Number));
let n = 0;
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (String(to).endsWith(`/${process.env.FAULT_OP}.json`) && fail.has(++n)) {
    throw Object.assign(new Error(`ENOSPC: no space left on device, rename (write ${n})`), { code: 'ENOSPC' });
  }
  return rename.call(this, from, to);
};
syncBuiltinESMExports();
