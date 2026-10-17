// Searching a chain's event logs (eth_getLogs) in block windows its RPC accepts. Public RPCs cap how many blocks one
// request may span, and the cap changes without notice (Base Sepolia's went to 200 blocks in October 2026), so a search
// starts at the chain's known range, halves the window each time the RPC refuses a range, and never skips a block. It
// reads at most a day of the chain's blocks from where it starts, and at most MAX_LOG_CALLS requests; after an RPC says it
// is limiting requests, it waits as long as asked and keeps a pace. A search that did not read every block it was given
// says so (`covered: false`): what it did not find there decides nothing. Shared by `status` (src/core/settlement.ts) and
// the budget's EVM rail (budget/evm/ops.ts, budget/evm/owner.ts).

/** The narrowest window a search narrows to; a range refused at this width ends the search, incomplete. */
export const LOG_WINDOW_FLOOR = 10;
/** The most eth_getLogs requests one search makes, refused and limited ones included. */
export const MAX_LOG_CALLS = 400;
/** How much chain time one search covers from its first block: what it looks for lands within minutes of that block. */
export const LOG_SPAN_SECONDS = 86_400;
/** After this long, a search starts no new request (a read already sent finishes or times out), waits included. */
export const LOG_SEARCH_MS = 120_000;
/** Once the RPC has limited the search's rate: at least this long between requests. */
export const LOG_PACE_MS = 2_000;
/** The longest wait a Retry-After is honoured for. */
export const LOG_RETRY_MAX_MS = 30_000;

const RANGE_CODES = new Set([-32614, -32005, -32602]);
const RANGE_WORDS = /block range|range (?:is )?too (?:large|wide|big)|limited to (?:a )?\d+ ?(?:block )?range|max(?:imum)? (?:block )?range|query returned more than|too many (?:blocks|results|logs)|exceeds? (?:the )?(?:max(?:imum)? )?(?:block )?range|response size/i;
/** Words of a rate limit: the RPC is limiting how often this client asks, not how wide. */
const RATE_WORDS = /rate.?limit|too many requests|request limit|daily request count|requests? per (?:second|minute)|capacity|throttl/i;

/**
 * Does a JSON-RPC error read as a refusal of the block range asked for? -32614 (Base's "eth_getLogs is limited to a 200
 * range"), -32005 (limit exceeded), -32602 (invalid params), or words that say so ("block range too large").
 * @param {unknown} code
 * @param {unknown} message
 * @returns {boolean}
 */
export function rangeRefusal(code, message) {
  // "rate limit exceeded" under -32005 is a rate limit: waiting helps, narrowing the window does not
  if (typeof message === "string" && RATE_WORDS.test(message)) return false;
  return (typeof code === "number" && RANGE_CODES.has(code)) || (typeof message === "string" && RANGE_WORDS.test(message));
}

/**
 * Does an RPC error read as a rate limit: HTTP or JSON-RPC 429, or words that say the RPC limits how often it is asked?
 * @param {unknown} code
 * @param {unknown} message
 * @returns {boolean}
 */
export function rateRefusal(code, message) {
  return code === 429 || (typeof message === "string" && RATE_WORDS.test(message));
}

/** @param {any} err */
const limited = (err) => err?.status === 429 || err?.code === 429 || err?.rateLimited === true || rateRefusal(err?.code, err?.details ?? err?.message);
/** @param {any} err */
const refusedRange = (err) => !limited(err) && (err?.rangeRefused === true || rangeRefusal(err?.code, err?.details));
/** @param {any} err @returns {number} */
function retryAfterMs(err) {
  if (typeof err?.retryAfterMs === "number") return err.retryAfterMs;
  const header = typeof err?.headers?.get === "function" ? String(err.headers.get("retry-after") ?? "").trim() : "";
  return /^\d{1,4}$/.test(header) ? Number(header) * 1000 : 0;
}

/**
 * @typedef {{ paceMs?: number, maxCalls?: number, searchMs?: number, now?: () => number, pause?: (ms: number) => Promise<unknown> }} LogSearchOptions
 */

/**
 * Read the logs of blocks `from` to `to` (inclusive) in windows, oldest first, and hand each window's logs to `visit`;
 * the first answer `visit` gives ends the search. `covered` is true only when every block from `from` to `to` was read.
 * Never throws for a read: an RPC error that is not a range refusal or a rate limit ends the search, incomplete. Errors
 * `visit` throws are the caller's.
 * @template L, T
 * @param {(fromBlock: bigint, toBlock: bigint) => Promise<readonly L[]>} read
 * @param {{ from: bigint, to: bigint, window: number, blockSeconds: number }} span
 * @param {(logs: readonly L[]) => Promise<T | undefined>} visit
 * @param {LogSearchOptions} [options]
 * @returns {Promise<{ found?: T, covered: boolean, searchedTo: bigint, calls: number }>}
 */
export async function searchLogs(read, span, visit, options = {}) {
  const now = options.now ?? Date.now;
  const pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const paceMs = options.paceMs ?? LOG_PACE_MS;
  const maxCalls = options.maxCalls ?? MAX_LOG_CALLS;
  const deadline = now() + (options.searchMs ?? LOG_SEARCH_MS);
  const reach = BigInt(Math.ceil(LOG_SPAN_SECONDS / Math.max(span.blockSeconds, 0.01)));
  const last = span.to - span.from + 1n > reach ? span.from + reach - 1n : span.to;
  let window = BigInt(Math.max(Math.floor(span.window), LOG_WINDOW_FLOOR));
  let from = span.from;
  let calls = 0;
  let paced = false;
  let next = 0;
  // searchedTo is the last block read; before block 0 is read, it is 0 rather than -1.
  const stop = () => ({ covered: false, searchedTo: from > 0n ? from - 1n : 0n, calls });
  while (from <= last) {
    if (calls >= maxCalls || Math.max(next, now()) >= deadline) return stop();
    if (next > now()) await pause(next - now());
    const to = from + window - 1n < last ? from + window - 1n : last;
    const started = now();
    calls += 1;
    let logs;
    try {
      logs = await read(from, to);
      if (paced) next = started + paceMs;
    } catch (err) {
      if (limited(err)) {
        paced = true;
        next = Math.max(started + paceMs, now() + Math.min(retryAfterMs(err), LOG_RETRY_MAX_MS));
        continue;
      }
      if (refusedRange(err) && window > BigInt(LOG_WINDOW_FLOOR)) {
        const half = window / 2n;
        window = half < BigInt(LOG_WINDOW_FLOOR) ? BigInt(LOG_WINDOW_FLOOR) : half;
        continue;
      }
      return stop();
    }
    const found = await visit(Array.isArray(logs) ? logs : []);
    if (found !== undefined) return { found, covered: false, searchedTo: to, calls };
    from = to + 1n;
  }
  return { covered: last === span.to, searchedTo: last, calls };
}
