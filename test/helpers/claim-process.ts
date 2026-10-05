// One `pay` as its own process, for the quote-claim test: a PaymentEngine over the records directory given starts a
// payment for the quote given, but only once the other process has read the same quote too (both wait at a barrier
// in the barrier directory after reading it), so both see it open. Prints one JSON line: {"started": attemptId} or
// {"used": attemptId-or-null}, then exits.
//
//   node --import tsx test/helpers/claim-process.ts <records dir> <quote id> <barrier dir>
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { PaymentEngine, QuoteUsedError } from "../../src/core/pay.js";
import { Records } from "../../src/core/records.js";
import type { Signer } from "../../src/core/signer/types.js";

const [dir, quoteId, barrier] = process.argv.slice(2);
const records = new Records(dir);
const read = records.getQuote.bind(records);
let waited = false;
records.getQuote = (id: string) => {
  const quote = read(id);
  if (!waited) {
    waited = true;
    writeFileSync(join(barrier, String(process.pid)), "");
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const until = Date.now() + 10_000;
    while (readdirSync(barrier).length < 2 && Date.now() < until) Atomics.wait(pause, 0, 0, 5);
  }
  return quote;
};
// The owner is never asked here: the test is about who gets the quote.
const signer: Signer = { kind: "browser", address: async () => `0x${"11".repeat(20)}`, sign: () => new Promise(() => {}) };
const engine = new PaymentEngine({ records, policy: DEFAULT_POLICY, signer, fetchImpl: () => new Promise(() => {}) });
try {
  console.log(JSON.stringify({ started: engine.startPayment(quoteId).id }));
} catch (err) {
  console.log(JSON.stringify(err instanceof QuoteUsedError ? { used: err.attempt?.id ?? null } : { error: String(err) }));
}
process.exit(existsSync(dir) ? 0 : 1);
