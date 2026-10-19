// The slow half of a `pay` as its own process, for the quote-claim wait test: after a delay it writes the attempt record
// a claim file names, as the process that holds the claim does once its disk has caught up. Prints "ready" when it has
// loaded (the delay counts from then), and "written" when the record is on disk.
//
//   node --import tsx test/helpers/late-attempt.ts <records dir> <quote id> <attempt id> <delay ms>
import { Records } from "../../src/core/records.js";

const [dir, quoteId, attemptId, delay] = process.argv.slice(2);
const records = new Records(dir);
const quote = records.getQuote(quoteId);
if (!quote) throw new Error(`no quote ${quoteId}`);
console.log("ready");
await new Promise((done) => setTimeout(done, Number(delay)));
const at = new Date().toISOString();
records.saveAttempt({
  id: attemptId,
  quoteId,
  createdAt: at,
  updatedAt: at,
  state: "awaiting_approval",
  chainFinal: null,
  url: quote.url,
  terms: quote.terms,
  history: [{ at, state: "awaiting_approval" }],
});
console.log("written");
