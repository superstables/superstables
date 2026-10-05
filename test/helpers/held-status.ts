// `superstables status` in a process of its own, held inside its receipt write: it runs recheckChain on the records in
// argv[2] for attempt argv[3] through the RPC argv[4], and when it is about to write the receipt (holding the
// reconciliation lock) it writes `<gate>.ready` and waits for `<gate>.go` before it writes. `<gate>.done` holds its
// result. Run with `node --import tsx`.
import { existsSync, writeFileSync } from "node:fs";
import { recheckChain } from "../../src/core/pay.js";
import { Records } from "../../src/core/records.js";

const [dir, id, rpc, gate] = process.argv.slice(2);
const records = new Records(dir);
const save = records.saveReceipt.bind(records);
records.saveReceipt = (receipt) => {
  writeFileSync(`${gate}.ready`, JSON.stringify({ pid: process.pid, chain: receipt.chain }));
  const until = Date.now() + 30_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(`${gate}.go`)) {
    if (Date.now() > until) throw new Error("the status write was never let go");
    Atomics.wait(pause, 0, 0, 10);
  }
  return save(receipt);
};
try {
  writeFileSync(`${gate}.done`, JSON.stringify(await recheckChain(records, id, rpc)));
} catch (err) {
  writeFileSync(`${gate}.error`, String(err));
  process.exitCode = 1;
}
