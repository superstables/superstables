// Preloaded into a client process under test (node --import, through NODE_OPTIONS) so that waiting for a Solana signature to
// reach `finalized` does not take real time. `finalizedOf` (budget/solana/owner.ts) polls the signature every two seconds for a
// minute and reports `final: false` only when that minute has passed. A test of "confirmed, not finalized" needs the whole
// minute to pass, not to be lived through. The child process is a separate node, so vitest's fake timers cannot reach it.
//
// The client's code is unchanged and still polls. Only the two-second sleeps requested from `finalizedOf` (or a function it
// awaits) are skipped (the timer fires at once) and the clock `Date.now` reads moves forward by the time skipped, so its
// deadline arrives after about the same number of polls as in real time (fewer when polls take real time, or when two waits run
// at once in one process and share the skipped time). Every other timer runs in real time. In the process, `Date.now` runs
// ahead of `new Date()` by the time skipped. If `finalizedOf` is renamed, nothing is skipped: the test gets slow again, it does
// not break.
// Only a client process loads this file, never the test process: it replaces `Date.now` and `setTimeout` for the process.

if (!globalThis.__skipFinalityWait) {
  globalThis.__skipFinalityWait = true;
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  let skippedMs = 0;
  Date.now = () => realNow() + skippedMs;
  globalThis.setTimeout = function (fn, ms, ...args) {
    if (ms === 2000 && typeof fn === "function" && new Error().stack?.includes("finalizedOf")) {
      skippedMs += ms;
      return realSetTimeout(fn, 0, ...args);
    }
    return realSetTimeout.call(this, fn, ms, ...args);
  };
}
