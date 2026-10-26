// Deciding whether several RPC endpoints agree. A negative answer ("never paid", "expired", "failed") is believed only
// when endpoints run by different operators, each on the right chain, show the same final block and the same value
// there; any contradiction leaves it unknown. The caller supplies the transport, so one engine serves every rail.
// Plain JS, shared by the core and the budget build.

import { maxFinalizedSpread } from "./finality-policy.js";

/** @typedef {(url: string, method: string, params: unknown[]) => Promise<unknown>} Call */
/** @typedef {{ kind: "evm", chainId: number } | { kind: "solana", genesis: string }} Identity */
/** @typedef {{ url: string, operator: string, source?: string }} Member */
/** @typedef {"quorum"|"owner-node"|"single"|"caller"} Agreement */
/** @typedef {{ verdict: Member[], quorum: number, agreement: Agreement } | { error: string }} VerdictSet */
/** @typedef {{ agreed: false, why: "missing"|"disagree"|"not_final_yet"|"unreadable", reason: string, left?: string[] }} Failed */

/** Solana final slots further apart than this are a disagreement, not a lowest head to follow. */
export const DEFAULT_MAX_SPREAD = 1000n;

const verified = new Set();

const hostOf = (/** @type {string} */ url) => {
  try {
    return new URL(url).host;
  } catch {
    return "an RPC endpoint";
  }
};

/**
 * Fixed words for what went wrong with an endpoint. Text the RPC (or a caller's read) chose is never quoted: it would
 * reach agent-visible reasons.
 * @param {unknown} err
 */
function whatWentWrong(err) {
  const e = /** @type {any} */ (err);
  if (e && ["DeadlineError", "TimeoutError", "AbortError"].includes(e.name)) return "timed out";
  if (e && e.name === "RpcError" && (e.status !== undefined || e.code !== undefined)) return "refused the request";
  return "gave an unreadable answer";
}

/** A JSON-RPC quantity: 0x then hex digits. Anything else (decimal, empty, "0xzz") throws without quoting its input. */
function quantity(/** @type {unknown} */ v) {
  if (typeof v !== "string" || !/^0x[0-9a-f]+$/i.test(v)) throw new Error("not a quantity");
  return BigInt(v);
}

/**
 * "" when `url` answers this chain, else why not. Success is cached per process; failure is not.
 * @param {string} url
 * @param {Identity} identity
 * @param {Call} call
 */
export async function checkIdentity(url, identity, call) {
  const key = `${url}\n${identity.kind === "evm" ? identity.chainId : identity.genesis}`;
  if (verified.has(key)) return "";
  const host = hostOf(url);
  try {
    if (identity.kind === "evm") {
      const got = await call(url, "eth_chainId", []);
      const n = typeof got === "string" && /^0x[0-9a-fA-F]+$/.test(got) ? Number(BigInt(got)) : NaN;
      if (!Number.isFinite(n)) return `the RPC ${host} could not be asked which chain it is on`;
      if (n !== identity.chainId) return `the RPC ${host} answers chain id ${n}, not ${identity.chainId}`;
    } else {
      const got = await call(url, "getGenesisHash", []);
      if (typeof got !== "string") return `the RPC ${host} could not be asked which chain it is on`;
      if (got !== identity.genesis) return `the RPC ${host} answers another genesis`;
    }
  } catch {
    return `the RPC ${host} could not be asked which chain it is on`;
  }
  verified.add(key);
  return "";
}
/** Tests only. */
export function forgetIdentities() {
  verified.clear();
}

/**
 * Stable JSON for comparing values: bigint as decimal string, 0x-strings lower case, bytes as hex, keys sorted.
 * Only plain data is comparable: null, booleans, finite numbers, strings, bigints, arrays, Uint8Array and plain
 * objects. Anything else (Map, Set, Date, class instances, NaN, undefined, cycles) throws, so two unlike values are
 * never equal.
 * @param {unknown} value
 * @returns {string}
 */
export function canonical(value) {
  /** @type {unknown[]} */
  const path = [];
  const norm = (/** @type {any} */ v) => {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("not comparable");
      return v;
    }
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") return /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v;
    if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString("hex")}`;
    if (typeof v !== "object") throw new Error("not comparable");
    if (path.includes(v)) throw new Error("not comparable");
    path.push(v);
    try {
      if (Array.isArray(v)) return v.map(norm);
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error("not comparable");
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
    } finally {
      path.pop();
    }
  };
  return JSON.stringify(norm(value));
}

/** @param {number | bigint} n */
const hex = (n) => `0x${BigInt(n).toString(16)}`;

/**
 * The endpoints of a set that answer the right chain, and why the others were left out.
 * @param {Set} set @param {Identity} identity @param {Call} call
 * @returns {Promise<{ members: Member[], left: string[] } | Failed>}
 */
async function usable(set, identity, call) {
  if ("error" in set) return { agreed: false, why: "unreadable", reason: set.error };
  const checks = await Promise.all(set.verdict.map((m) => checkIdentity(m.url, identity, call)));
  const members = set.verdict.filter((_, i) => checks[i] === "");
  const left = checks.filter((c) => c !== "");
  return { members, left };
}

/**
 * The operators that count toward a quorum: an endpoint an RPC variable added (source "env") may disagree, never stand in
 * for one of the set's own operators.
 * @param {Member[]} members
 */
export const deciding = (members) => new Set(members.filter((m) => m.source !== "env").map((m) => m.operator));

/**
 * @param {Member[]} members @param {{ quorum: number }} set @param {string[]} left @param {boolean} [answered] whether any endpoint got as far as answering
 * @returns {Failed | undefined}
 */
function short(members, set, left, answered = members.length > 0) {
  if (members.length === 0) return { agreed: false, why: answered ? "missing" : "unreadable", reason: left.join("; ") || "no endpoint answered", left };
  const deciders = deciding(members);
  if (deciders.size < set.quorum) {
    return { agreed: false, why: "missing", reason: `${members.length} endpoint(s) from ${deciders.size} operator(s) answered; ${set.quorum} needed`, left };
  }
  return undefined;
}

/**
 * EVM and Tempo: agree on a value read at one final block.
 *   1. identity on every verdict endpoint; wrong or unreadable ones are left out, with their reason
 *   2. each one's final head (`finalized`, or `latest` when finality is "instant"), strictly 0x-hex
 *   3. the highest head may be at most `maxSpread` blocks above the lowest (chain policy by default), else "disagree": a lagging
 *      or lying endpoint can delay a verdict but cannot drag the block to an old one
 *   4. F = the lowest; every one's block F must have the same hash and the same time (else "disagree")
 *   5. `read(url, hexF, hash)` on each (pass `{ blockHash: hash }` to eth_call to bind the value to the block); the
 *      returned plain data must be equal (else "disagree"); Map, Set, class instances and the like leave that
 *      endpoint out
 *      Each endpoint also reads at its own final head; a different value above F is not_final_yet, never agreed.
 *   6. answering operators >= quorum (else "missing")
 *   7. `atLeast` given and F < atLeast: "not_final_yet"
 * A verdict of ABSENCE (allowance 0, not found, delegate absent, unused) is trivially true at an old block, so such a
 * caller must pass `atLeast`: the block at which the absence has to be proven.
 * Never throws: a failed leading read fails closed; other failed reads leave the endpoint out, with fixed words (never the RPC's own text).
 * @param {{ set: VerdictSet, call: Call, chainId: number, finality: "finalized"|"instant",
 *   read: (url: string, block: string, hash: string) => Promise<unknown>, atLeast?: bigint, maxSpread?: bigint }} a
 * @returns {Promise<{ agreed: true, value: unknown, block: { number: bigint, hash: string, timestamp: number, highest: bigint },
 *   agreement: Agreement, operators: string[] } | Failed>}
 */
export async function agreeAtFinalEvm({ set, call, chainId, finality, read, atLeast, maxSpread = maxFinalizedSpread(chainId) }) {
  const first = await usable(set, { kind: "evm", chainId }, call);
  if ("agreed" in first) return first;
  const vset = /** @type {Exclude<VerdictSet, { error: string }>} */ (set);
  /** @type {string[]} */
  const left = [...first.left];
  const tag = finality === "instant" ? "latest" : "finalized";
  const heads = await Promise.all(first.members.map(async (m) => {
    try {
      const b = /** @type {any} */ (await call(m.url, "eth_getBlockByNumber", [tag, false]));
      if (!b) throw new Error("no block");
      if (typeof b.hash !== "string") throw new Error("no hash");
      return { m, number: quantity(b.number), hash: b.hash.toLowerCase(), timestamp: quantity(b.timestamp) };
    } catch (err) {
      left.push(`the RPC ${hostOf(m.url)} did not give its ${tag} block (${whatWentWrong(err)})`);
      return undefined;
    }
  }));
  const withHead = /** @type {{ m: Member, number: bigint, hash: string, timestamp: bigint }[]} */ (heads.filter(Boolean));
  const early = short(withHead.map((h) => h.m), vset, left, first.members.length > 0 && withHead.length > 0);
  if (early) return early;
  const F = withHead.reduce((lo, h) => (h.number < lo ? h.number : lo), withHead[0].number);
  const highest = withHead.reduce((hi, h) => (h.number > hi ? h.number : hi), withHead[0].number);
  if (highest - F > maxSpread) return { agreed: false, why: "disagree", reason: `the endpoints' final heads are ${highest - F} blocks apart`, left };
  let leadingReadFailed = false;
  const rows = await Promise.all(withHead.map(async ({ m, number, hash: headHash, timestamp: headTime }) => {
    try {
      const b = /** @type {any} */ (await call(m.url, "eth_getBlockByNumber", [hex(F), false]));
      if (!b || typeof b.hash !== "string" || quantity(b.number) !== F) throw new Error("no such block");
      const timestamp = quantity(b.timestamp);
      const hash = b.hash.toLowerCase();
      const value = await read(m.url, hex(F), hash);
      const key = canonical(value);
      let headKey = key;
      if (number !== F) {
        try { headKey = canonical(await read(m.url, hex(number), headHash)); }
        catch (err) {
          left.push(`the RPC ${hostOf(m.url)} could not be read at its own final head (${whatWentWrong(err)})`);
          headKey = null;
        }
      }
      const changed = number === F && (hash !== headHash || timestamp !== headTime);
      return { m, hash, timestamp, value, key, headKey, changed };
    } catch (err) {
      if (number > F) leadingReadFailed = true;
      left.push(`the RPC ${hostOf(m.url)} could not be read at block ${F} (${whatWentWrong(err)})`);
      return undefined;
    }
  }));
  const ok = /** @type {NonNullable<(typeof rows)[number]>[]} */ (rows.filter(Boolean));
  if (ok.some((r) => r.changed)) return { agreed: false, why: "disagree", reason: "an endpoint gives a different value or block at its own final head", left };
  if (new Set(ok.map((r) => r.hash)).size > 1) return { agreed: false, why: "disagree", reason: `the endpoints name different blocks at ${F}`, left };
  if (new Set(ok.map((r) => r.timestamp)).size > 1) return { agreed: false, why: "disagree", reason: `the endpoints give block ${F} different times`, left };
  if (new Set(ok.map((r) => r.key)).size > 1) return { agreed: false, why: "disagree", reason: `the endpoints read different values at block ${F}`, left };
  if (leadingReadFailed || ok.some((r) => r.headKey === null)) return { agreed: false, why: "unreadable", reason: "an endpoint could not be read at its own final head", left };
  const missing = short(ok.map((r) => r.m), vset, left, withHead.length > 0);
  if (missing) return missing;
  if (atLeast !== undefined && F < atLeast) return { agreed: false, why: "not_final_yet", reason: `final head ${F} is below block ${atLeast}`, left };
  if (ok.some((r) => r.key !== r.headKey)) return { agreed: false, why: "not_final_yet", reason: "the value changed above the common final block", left };
  return {
    agreed: true,
    value: ok[0].value,
    block: { number: F, hash: ok[0].hash, timestamp: Number(ok[0].timestamp), highest },
    agreement: vset.agreement,
    operators: [...deciding(ok.map((r) => r.m))],
  };
}

/**
 * Solana: agree on a value read at `finalized` with minContextSlot S on every endpoint. `read(url, S)` returns
 * { slot, value } (slot = the answer's context.slot, plain data for the value); a slot below S leaves that endpoint
 * out as unreadable. S = `minSlot`, or the lowest getSlot({commitment:"finalized"}) across the answering endpoints;
 * then the highest may be at most `maxSpread` slots above it (default 1000), else "disagree". `highest` is the
 * highest finalized slot seen (undefined when `minSlot` is given). A verdict of ABSENCE (not found, delegate absent)
 * must pass `atLeast`: S below it is "not_final_yet".
 * @param {{ set: VerdictSet, call: Call, genesis: string, read: (url: string, minSlot: bigint) => Promise<{ slot: number | bigint, value: unknown }>,
 *   minSlot?: bigint, atLeast?: bigint, maxSpread?: bigint }} a
 * @returns {Promise<{ agreed: true, value: unknown, slot: bigint, highest: bigint | undefined, agreement: Agreement, operators: string[] } | Failed>}
 */
export async function agreeAtFinalSolana({ set, call, genesis, read, minSlot, atLeast, maxSpread = DEFAULT_MAX_SPREAD }) {
  const first = await usable(set, { kind: "solana", genesis }, call);
  if ("agreed" in first) return first;
  const vset = /** @type {Exclude<VerdictSet, { error: string }>} */ (set);
  const left = [...first.left];
  let members = first.members;
  let S = minSlot;
  let highest;
  if (S === undefined) {
    const slots = await Promise.all(members.map(async (m) => {
      try {
        const got = await call(m.url, "getSlot", [{ commitment: "finalized" }]);
        if (typeof got !== "number" || !Number.isSafeInteger(got) || got < 0) throw new Error("not a slot");
        return { m, slot: BigInt(got) };
      } catch (err) {
        left.push(`the RPC ${hostOf(m.url)} did not give its finalized slot (${whatWentWrong(err)})`);
        return undefined;
      }
    }));
    const have = /** @type {{ m: Member, slot: bigint }[]} */ (slots.filter(Boolean));
    members = have.map((h) => h.m);
    if (have.length) {
      S = have.reduce((lo, h) => (h.slot < lo ? h.slot : lo), have[0].slot);
      highest = have.reduce((hi, h) => (h.slot > hi ? h.slot : hi), have[0].slot);
    }
  }
  const early = short(members, vset, left, first.members.length > 0 && members.length > 0);
  if (early || S === undefined) return early ?? { agreed: false, why: "unreadable", reason: "no slot", left };
  const floor = S;
  if (highest !== undefined && highest - floor > maxSpread) return { agreed: false, why: "disagree", reason: `the endpoints' final slots are ${highest - floor} slots apart`, left };
  const rows = await Promise.all(members.map(async (m) => {
    try {
      const r = await read(m.url, floor);
      if (BigInt(r.slot) < floor) throw new Error("answered below the slot");
      return { m, value: r.value, key: canonical(r.value) };
    } catch (err) {
      left.push(`the RPC ${hostOf(m.url)} could not be read at slot ${floor} (${whatWentWrong(err)})`);
      return undefined;
    }
  }));
  const ok = /** @type {NonNullable<(typeof rows)[number]>[]} */ (rows.filter(Boolean));
  if (new Set(ok.map((r) => r.key)).size > 1) return { agreed: false, why: "disagree", reason: `the endpoints read different values at slot ${floor}`, left };
  const missing = short(ok.map((r) => r.m), vset, left, members.length > 0);
  if (missing) return missing;
  if (atLeast !== undefined && floor < atLeast) return { agreed: false, why: "not_final_yet", reason: `final slot ${floor} is below slot ${atLeast}`, left };
  return { agreed: true, value: ok[0].value, slot: floor, highest, agreement: vset.agreement, operators: [...deciding(ok.map((r) => r.m))] };
}

/**
 * The words for an endpoint set that could not be built: the one wording every budget rail uses. A refused variable
 * (named by `envName` when the caller knows it) gets the way out; unreadable owner settings keep their own reason.
 * @param {string} error the settings module's refusal or read error
 * @param {string} [envName] the RPC variable, when the caller knows which one it is
 */
export function endpointSetErrorWords(error, envName) {
  const refused = /is not an RPC the owner set/.test(error) && (!envName || error.startsWith(envName));
  // the long explanation after the colon is the settings module's; the words keep what was refused and the way out
  return refused
    ? `the RPC endpoints could not be read: ${error.replace(/: owner actions and verdicts read only.*$/, "")}; unset it, or ask the owner to add it in the owner settings`
    : `the RPC endpoints could not be read: ${error}; ask the owner to check the owner settings`;
}

/**
 * The words for a failed agreement, for reasons and RESULT lines.
 * @param {Failed} failed
 */
export function agreementWords(failed) {
  if (failed.why === "disagree") return "the RPC endpoints disagree";
  if (failed.why === "not_final_yet") return "it is not final on chain yet";
  const left = failed.left?.length ? ` (left out: ${failed.left.join("; ")})` : "";
  // no endpoint was tried: the set itself was refused (an RPC variable that is not the owner's, or unreadable owner settings)
  if (failed.why === "unreadable" && failed.reason && !failed.left) {
    return endpointSetErrorWords(failed.reason);
  }
  if (failed.why === "unreadable") return `the RPC endpoints could not be read${left}`;
  return `a second RPC endpoint was not available to confirm it${left}`;
}
