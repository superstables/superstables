// Offline guard for tests: fetch reaches this computer only. Loaded by test/setup-offline.ts in the test workers and,
// through NODE_OPTIONS, in every node process a test starts (the CLI, the MCP server, the budget scripts). A request
// to any other host fails at once with a message naming it, so a test that would have used the network fails visibly
// instead of depending on it; the few third-party hosts the client's own code calls in ordinary tests get a local
// stand-in answer instead (STAND_INS). Live tests (SUPERSTABLES_LIVE=1) never load it.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/**
 * Third-party hosts the client's own code calls in ordinary tests, answered here instead: the built-in catalogue lists
 * a third-party coin price service, and `find` probes every listing. The stand-in answers 503, so the listing reads
 * as not answering right now, which is what a test without the network should see.
 */
const STAND_INS = new Map([["x402-coin-api.vercel.app", () => new Response("offline test stand-in", { status: 503 })]]);
const realFetch = globalThis.fetch;

if (realFetch && !globalThis.__superstablesFetchGuard) {
  globalThis.__superstablesFetchGuard = true;
  globalThis.fetch = function guardedFetch(input, init) {
    let host = "";
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      host = new URL(raw).hostname;
    } catch {
      return realFetch(input, init);
    }
    const standIn = STAND_INS.get(host);
    if (standIn) return Promise.resolve(standIn());
    if (!LOOPBACK.has(host)) {
      return Promise.reject(new TypeError(`offline test: a request to ${host} was blocked (set SUPERSTABLES_LIVE=1 for live tests)`));
    }
    return realFetch(input, init);
  };
}
