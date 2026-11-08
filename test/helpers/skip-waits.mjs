import { existsSync } from "node:fs";

// Preloaded into a client process under test (node --import, through NODE_OPTIONS) so that waiting for a Solana signature to
// reach `finalized`, for a Tempo payment or a sent value to show up, or for a hosted approval's poll gaps to pass does not take
// real time. `finalizedOf` (budget/solana/owner.ts) and `standing` (budget/solana/rotate.mjs) poll their signatures every two
// seconds, and `waitForOutcome` (budget/tempo/lib/resolve.ts) the chain every second, until a deadline, and report "not final"
// or "unknown" only when it has passed. HostedApprovals (budget/hosted.ts) sleeps about a second between reads of the site, and
// up to five after a failed read, until its deadline plus a 30 s quiet grace. `readUntil` (budget/evm/lib.ts) reads a value
// again every two seconds, up to eight times, until it shows what was sent. A test of "confirmed, not finalized" needs the
// whole wait to pass, not to be lived through. The child process is a separate node, so vitest's fake timers cannot reach it.
//
// A test that edits its fake site by hand after the command has started sets SUPERSTABLES_TEST_SKIP_WAITS_AFTER to a path and
// creates that file once its edits are done: no sleep is skipped before then (skipping earlier lets the deadline pass before
// the test has linked the request). Unset, the skip is on from the start.
//
// The client's code is unchanged and still polls. Only the sleeps of the lengths listed in WAITS, requested from the function
// named there (or a function it awaits), are skipped (the timer fires at once) and the clock `Date.now` reads moves forward by
// the time skipped, so its deadline arrives after about the same number of polls as in real time (fewer when polls take real
// time, or when two waits run at once in one process and share the skipped time). Every other timer runs in real time. In the
// process, `Date.now` runs ahead of `new Date()` by the time skipped. If one is renamed, its sleeps are no longer skipped: the
// test gets slow again, it does not break. Only a client process loads this file, never the test process: it replaces
// `Date.now` and `setTimeout` for the process.

// [sleep length in ms (or [min, max]), the function that asks for it (or awaits the function that does)]
const WAITS = [
  [2000, /\b(finalizedOf|standing)\b/],
  [1000, /\bwaitForOutcome\b/],
  [2000, /\breadUntil\b/],
  [[500, 5000], /\bHostedApprovals\.(pollBundle|poll)\b/],
];
const AFTER = process.env.SUPERSTABLES_TEST_SKIP_WAITS_AFTER;
const matches = (length, ms) => (Array.isArray(length) ? ms >= length[0] && ms <= length[1] : ms === length);

if (!globalThis.__skipWaits) {
  globalThis.__skipWaits = true;
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  let skippedMs = 0;
  Date.now = () => realNow() + skippedMs;
  globalThis.setTimeout = function (fn, ms, ...args) {
    const skip = typeof fn === "function" && WAITS.some(([length, caller]) => matches(length, ms) && caller.test(new Error().stack ?? ""));
    if (skip && (!AFTER || existsSync(AFTER))) {
      skippedMs += ms;
      return realSetTimeout(fn, 0, ...args);
    }
    return realSetTimeout.call(this, fn, ms, ...args);
  };
}
