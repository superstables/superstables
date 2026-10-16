// The spend policy: a YAML file the owner writes, evaluated in a fixed order so the reason
// a caller sees is always the first rule that refused. The same engine runs in two places:
// in the agent-side client (an early, advisory refusal, before the wallet is bothered) and
// inside the wallet (the owner's copy, the one that counts). Everything here is software
// policy; nothing here is enforced by the chain, and the docs say so.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isAlias, isMap, isScalar, isSeq, parse as parseYaml, parseDocument, type Document } from "yaml";
import { fromAtomicString, networkFor, toAtomicExact } from "./chain.js";
import { accountPolicyPath, policyPath } from "./home.js";
import { untrustedText } from "./text.js";
import type { PolicyCheck } from "./types.js";

export interface Money {
  /** The cap as a number, for display (formatMoney). Never compared: see atomic. */
  amount: number;
  asset: string;
  /**
   * The cap in millionths of its unit (CAP_DECIMALS), as a whole-number string ("50000" for 0.05), so a policy stays
   * plain JSON. This is what is compared. parseMoney always sets it. A Money built by hand without it is read from
   * `amount`, exactly; one whose amount is not a decimal with at most six places refuses every payment it applies to.
   * When both are set they must agree, or the cap refuses every payment: to change a cap by hand, change `amount` and
   * drop or update `atomic`.
   */
  atomic?: string;
}

export interface Policy {
  /** The most any single payment may be. */
  perCall?: Money;
  /** The most all payments may add up to in one UTC day, per asset, from the local records. */
  perDay?: Money;
  /** Hostname patterns; empty = any. "*.example.com" matches the domain and its subdomains. */
  allow: string[];
  deny: string[];
  stablecoins: string[];
  /** Refuse everything, before any other rule. */
  killSwitch: boolean;
  /** The only mode in this release: the owner approves every payment in the wallet. */
  approval: "ask-every-payment";
  /** The account's own policy file, which applies as well: both must allow a payment. */
  also?: { file: string; policy: Policy };
}

/**
 * The US dollar stablecoins `pay` pays in: USDC (the EVM chains and Solana), pathUSD (Tempo Moderato) and USDG (Robinhood
 * Chain Testnet). The caps count them together, one for one, as dollars; any other asset is refused unless the owner
 * lists it, and is then counted on its own.
 */
export const USD_STABLECOINS: readonly string[] = ["USDC", "pathUSD", "USDG"];

/** The asset's own spelling when it is one this client knows (USDC, pathUSD, USDG), else its name in capitals. */
export function assetName(asset: string): string {
  return USD_STABLECOINS.find((known) => known.toUpperCase() === asset.toUpperCase()) ?? asset.toUpperCase();
}

/** What the daily cap adds an asset's payments up as: "USD" for the dollar stablecoins, the asset itself otherwise. */
export function capUnit(asset: string): string {
  const name = assetName(asset);
  return USD_STABLECOINS.includes(name) ? "USD" : name;
}

/**
 * Caps and today's totals are whole numbers of millionths of their unit: 10⁻⁶ USD for the dollar stablecoins. A token's
 * own decimals are scaled into it by capUnits; the unit is the policy's, not any token's.
 */
export const CAP_DECIMALS = 6;

/**
 * A token amount, in the token's smallest units, as millionths of its cap unit: exact at six decimals, scaled up below
 * six, rounded up above six (a cap is never passed by a fraction it cannot see).
 */
export function capUnits(amountAtomic: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77 || amountAtomic < 0n) throw new Error("not an amount in a token's smallest units");
  if (decimals <= CAP_DECIMALS) return amountAtomic * 10n ** BigInt(CAP_DECIMALS - decimals);
  const scale = 10n ** BigInt(decimals - CAP_DECIMALS);
  return (amountAtomic + scale - 1n) / scale;
}

export const DEFAULT_POLICY: Policy = {
  perCall: { amount: 0.05, asset: "USDC", atomic: "50000" },
  perDay: { amount: 1, asset: "USDC", atomic: "1000000" },
  allow: [],
  deny: [],
  stablecoins: [...USD_STABLECOINS],
  killSwitch: false,
  approval: "ask-every-payment",
};

export const POLICY_EXAMPLE = `# Superstables spend policy (software policy: enforced by this client and by the wallet,
# not by the chain). Evaluation order, first refusal wins:
#   kill_switch → deny → allow → stablecoins → per_call → per_day
# Amounts are plain decimals with at most 6 decimals, like 0.05 or 0.05 USDC (not 0x10, 1e3 or .5).
caps:
  per_call: 0.05 USDC   # the most one payment may be
  per_day: 1 USDC       # the most all payments may add up to in one UTC day
allow: []               # hostname patterns; empty = any host
deny: []                # e.g. ["*.example.net"]
stablecoins: [USDC, pathUSD, USDG]  # allowed assets; the caps count them together, one for one
approval: ask-every-payment   # the wallet asks the owner before every payment
# kill_switch: true     # refuse everything
`;

/** A cap as written: digits; then a point (or a comma) and one to six digits, or nothing; then an asset, or nothing. */
const AMOUNT = /^(\d{1,30})(?:[.,](\d{1,6}))?(?:\s+([A-Za-z0-9]{1,12}))?$/;
const AS_WRITTEN = "write it in decimal notation with at most 6 decimals, like 0.05 or 0.05 USDC";

export function parseMoney(value: string | number): Money {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`not an amount: "${untrustedText(value, 40)}"`);
  const text = String(value).trim();
  const match = AMOUNT.exec(text);
  const decimal = match ? (match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`) : "";
  const amount = Number(decimal);
  if (!match || !Number.isFinite(amount)) throw new Error(`not an amount: "${untrustedText(text, 40)}"; ${AS_WRITTEN}`);
  return { amount, asset: (match[3] ?? "USDC").toUpperCase(), atomic: toAtomicExact(decimal, CAP_DECIMALS).toString() };
}

export function formatMoney(m?: Money): string | undefined {
  return m ? `${m.amount} ${m.asset}` : undefined;
}

const POLICY_KEYS = ["caps", "allow", "deny", "stablecoins", "approval", "kill_switch"];
const CAP_KEYS = ["per_call", "per_day"];

/**
 * Reads a policy file's text. A rule the file does not set takes the default; a file that cannot be read as the
 * policy it was meant to be (an unknown key, a kill_switch that is not true or false, a scalar where a list belongs,
 * an amount that is not one) throws with the key named, because reading it as "no rule" would lift the limits the
 * owner meant to set.
 */
export function parsePolicy(yamlText: string): Policy {
  const raw: unknown = parseYaml(yamlText) ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("the policy must be a YAML mapping");
  const doc = raw as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!POLICY_KEYS.includes(key)) {
      throw new Error(`unknown key "${untrustedText(key, 40)}" (the keys are ${POLICY_KEYS.join(", ")})`);
    }
  }

  const caps = doc.caps ?? {};
  if (typeof caps !== "object" || Array.isArray(caps)) throw new Error("caps must be a mapping of per_call and per_day");
  for (const key of Object.keys(caps)) {
    if (!CAP_KEYS.includes(key)) throw new Error(`unknown cap "${untrustedText(key, 40)}" in caps (the caps are ${CAP_KEYS.join(", ")})`);
  }
  const source = parseDocument(yamlText);
  const cap = (key: "per_call" | "per_day", fallback: Money | undefined): Money | undefined => {
    const value = (caps as Record<string, unknown>)[key];
    if (value === undefined || value === null) return fallback;
    try {
      return parseMoney(capText(source, key, value) as string);
    } catch (err) {
      throw new Error(`caps.${key}: ${(err as Error).message}`);
    }
  };
  const list = (key: "allow" | "deny" | "stablecoins", fallback: string[]): string[] => {
    const value = doc[key];
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
      throw new Error(`${key} must be a list of ${key === "stablecoins" ? "asset names" : "host names"}`);
    }
    return value as string[];
  };

  const killSwitch = doc.kill_switch === undefined ? false : doc.kill_switch;
  if (typeof killSwitch !== "boolean") throw new Error("kill_switch must be true or false");
  const approval = doc.approval ?? "ask-every-payment";
  if (approval !== "ask-every-payment") {
    throw new Error(`approval: "${untrustedText(approval, 40)}" is not supported in this release (only ask-every-payment)`);
  }
  return {
    perCall: cap("per_call", DEFAULT_POLICY.perCall),
    perDay: cap("per_day", DEFAULT_POLICY.perDay),
    allow: list("allow", []),
    deny: list("deny", []),
    stablecoins: list("stablecoins", [...USD_STABLECOINS]).map(assetName),
    killSwitch,
    approval: "ask-every-payment",
  };
}

/**
 * A cap as the owner wrote it: a plain scalar's own source text, never the number YAML makes of it (0x10 is 16 to YAML,
 * 0o10 is 8, 1e3 is 1000, .5 is 0.5), or a quoted or block scalar's string. An alias is read through to what it names.
 * A list or a map is passed on as parsed, and parseMoney refuses it. A plain scalar without source text gives
 * undefined, which parseMoney refuses: a cap is never taken from YAML's number. A value the document has no node for
 * (YAML 1.1 merges it in with `<<`) is refused: its source text is not there to read.
 */
function capText(doc: Document, key: string, parsed: unknown): unknown {
  let node: unknown = doc.getIn(["caps", key], true);
  if (isAlias(node)) node = node.resolve(doc);
  if (!isScalar(node)) {
    if (isMap(node) || isSeq(node)) return parsed;
    throw new Error("a cap must be written under caps itself, not merged in with <<");
  }
  if (node.type === "PLAIN") return typeof node.source === "string" ? node.source : undefined;
  return typeof node.value === "string" ? node.value : undefined;
}

/**
 * Reads a policy file; undefined only when the file is genuinely absent (ENOENT). Every other failure refuses every
 * payment: an unreadable file or a parent directory the process may not enter (EACCES, EPERM), an I/O error, a symlink
 * loop, a path that runs through something that is not a directory (ENOTDIR: that could be an owner's file hidden
 * behind a replaced directory, so it is not taken for absence) and text that is not a policy. A rule that cannot be
 * read is not a rule that is not there.
 */
export function loadOptionalPolicy(path: string): Policy | undefined {
  const unusable = (err: unknown) =>
    new Error(`the spend policy ${path} cannot be used: ${(err as Error).message}. Fix the file; until then nothing is paid`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unusable(err);
  }
  try {
    return parsePolicy(text);
  } catch (err) {
    throw unusable(err);
  }
}

/** Reads a policy file; a missing file means the default policy, and a file that cannot be used refuses every payment. */
export function loadPolicy(path: string): Policy {
  return loadOptionalPolicy(path) ?? DEFAULT_POLICY;
}

/**
 * The policy quote and pay apply: the file SUPERSTABLES_POLICY or SUPERSTABLES_HOME names, and, when the account's own
 * ~/.superstables/policy.yaml is another file that is there, that one as well (also). An agent's environment chooses
 * the first; it cannot choose away the second. Only an absent account file is skipped: one that exists but cannot be
 * read (a directory above it closed to this process, say) refuses every payment.
 */
export function loadPaymentPolicy(path = policyPath(), accountPath = accountPolicyPath()): Policy {
  const chosen = loadPolicy(path);
  if (resolve(path) === resolve(accountPath)) return chosen;
  const account = loadOptionalPolicy(accountPath);
  return account ? { ...chosen, also: { file: accountPath, policy: account } } : chosen;
}

export interface Attempt {
  /** The counterparty's hostname (the URL asked for, never the seller's self-declared resource). */
  domain: string;
  asset: string;
  /** The payment in the token's smallest units: what the caps compare. policyAmount(terms) gives it with its decimals. */
  amountAtomic?: bigint;
  /**
   * The token's decimals, which amountAtomic is counted in (policyAmount gives them from the chain table). Without it,
   * amountAtomic is read in the cap's unit, millionths (CAP_DECIMALS).
   */
  decimals?: number;
  /** Already spent today in this asset's cap unit, in millionths (Records.spentTodayAtomic). Needed when caps.per_day is set. */
  spentTodayAtomic?: bigint;
  /** @deprecated Pass amountAtomic. Read exactly at six decimals: a value with more places, or not finite, refuses. */
  amountDecimal?: number;
  /** @deprecated Pass spentTodayAtomic. Read as amountDecimal is. Omitting both refuses when caps.per_day is set. */
  spentTodayDecimal?: number;
}

export interface Verdict {
  allowed: boolean;
  reason?: string;
}

/**
 * The amount fields of an Attempt for a payment's terms: amountAtomic as recorded, at its chain's token decimals. Empty
 * when amountAtomic is not a whole number or the chain is not in this client's table, so a cap then refuses.
 */
export function policyAmount(terms: { amountAtomic?: unknown; network?: unknown }): Pick<Attempt, "amountAtomic" | "decimals"> {
  const atomic = terms.amountAtomic;
  if (typeof atomic !== "string" || !/^\d{1,78}$/.test(atomic)) return {};
  const decimals = typeof terms.network === "string" ? networkFor(terms.network)?.token.decimals : undefined;
  if (decimals === undefined) return {};
  return { amountAtomic: BigInt(atomic), decimals };
}

/** A deprecated decimal field in millionths: undefined unless it is a finite, non-negative number exact at six places. */
function fromDecimal(n: unknown): bigint | undefined {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  try {
    return toAtomicExact(String(n), CAP_DECIMALS);
  } catch {
    return undefined;
  }
}

/** What the caps compare, in millionths of the cap unit, and the payment in words. Never throws. */
function exact(a: Attempt): { amount?: bigint; amountText?: string; spent?: bigint } {
  let amount: bigint | undefined;
  let amountText: string | undefined;
  try {
    if (typeof a.amountAtomic === "bigint") {
      const decimals = a.decimals ?? CAP_DECIMALS;
      amount = capUnits(a.amountAtomic, decimals);
      amountText = fromAtomicString(a.amountAtomic, decimals);
    } else if (a.amountAtomic === undefined) {
      amount = fromDecimal(a.amountDecimal);
      amountText = amount === undefined ? undefined : fromAtomicString(amount, CAP_DECIMALS);
    }
  } catch {
    amount = undefined;
    amountText = undefined;
  }
  const spent =
    a.spentTodayAtomic === undefined
      ? fromDecimal(a.spentTodayDecimal)
      : typeof a.spentTodayAtomic === "bigint" && a.spentTodayAtomic >= 0n
        ? a.spentTodayAtomic
        : undefined;
  return { amount, amountText, spent };
}

/**
 * A cap in millionths: its atomic, or its amount read exactly; undefined when neither is usable. When both are set, the
 * amount must be what parseMoney made of the atomic (the number of its decimal text), or the cap has been edited in one
 * field only and is unusable.
 */
function capAtomic(m: Money): bigint | undefined {
  if (m.atomic === undefined) return fromDecimal(m.amount);
  if (typeof m.atomic !== "string" || !/^\d{1,78}$/.test(m.atomic)) return undefined;
  const atomic = BigInt(m.atomic);
  return m.amount === Number(fromAtomicString(atomic, CAP_DECIMALS)) ? atomic : undefined;
}

const shown = (units: bigint): string => fromAtomicString(units, CAP_DECIMALS);
const UNKNOWN_AMOUNT = "the payment's amount is not a whole number of the token's smallest units, so the caps cannot be checked";
const unusableCap = (key: string, m: Money): string =>
  typeof m.atomic === "string" && /^\d{1,78}$/.test(m.atomic)
    ? `${key} (${formatMoney(m)}) does not match its atomic value, so it cannot be checked`
    : `${key} (${formatMoney(m)}) is not an amount with at most 6 decimals, so it cannot be checked`;

function domainMatches(pattern: string, domain: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\.$/, "");
  const p = norm(pattern);
  const d = norm(domain);
  if (p.startsWith("*.")) return d === p.slice(2) || d.endsWith(p.slice(1));
  return d === p;
}

export function evaluatePolicy(policy: Policy, a: Attempt): Verdict {
  if (policy.also) {
    const v = evaluatePolicy(policy.also.policy, a);
    if (!v.allowed) return { allowed: false, reason: `${v.reason} (in ${policy.also.file})` };
  }
  if (policy.killSwitch) return { allowed: false, reason: "kill_switch is on" };
  if (a.domain) {
    if (policy.deny.some((p) => domainMatches(p, a.domain))) return { allowed: false, reason: `host ${a.domain} is on the deny list` };
    if (policy.allow.length > 0 && !policy.allow.some((p) => domainMatches(p, a.domain))) {
      return { allowed: false, reason: `host ${a.domain} is not on the allow list` };
    }
  }
  if (!listed(policy, a.asset)) {
    return { allowed: false, reason: `${a.asset} is not in the policy's stablecoin list [${policy.stablecoins.join(", ")}]` };
  }
  const x = exact(a);
  if (policy.perCall) {
    const cap = capAtomic(policy.perCall);
    if (cap === undefined) return { allowed: false, reason: unusableCap("caps.per_call", policy.perCall) };
    if (x.amount === undefined) return { allowed: false, reason: UNKNOWN_AMOUNT };
    if (x.amount > cap) return { allowed: false, reason: `${x.amountText} ${a.asset} exceeds caps.per_call (${formatMoney(policy.perCall)})` };
  }
  if (policy.perDay) {
    const cap = capAtomic(policy.perDay);
    if (cap === undefined) return { allowed: false, reason: unusableCap("caps.per_day", policy.perDay) };
    if (x.amount === undefined) return { allowed: false, reason: UNKNOWN_AMOUNT };
    // An unknown total is not zero: a library caller that passes none is refused, never waved through.
    if (x.spent === undefined) return { allowed: false, reason: `today's spending is unknown, so caps.per_day (${formatMoney(policy.perDay)}) cannot be checked` };
    if (x.spent + x.amount > cap) {
      return { allowed: false, reason: `today's payments (${shown(x.spent)} ${a.asset}) plus ${shown(x.amount)} exceed caps.per_day (${formatMoney(policy.perDay)})` };
    }
  }
  return { allowed: true };
}

/**
 * Every rule of the policy as it applies to one payment, in evaluation order, passed or not.
 * evaluatePolicy() answers yes or no; this says what was compared with what, so a quote can
 * show the limits it was held to rather than only the verdict.
 */
export function policyChecks(policy: Policy, a: Attempt): PolicyCheck[] {
  const checks: PolicyCheck[] = [];
  checks.push({ rule: "kill_switch", ok: !policy.killSwitch, detail: policy.killSwitch ? "on: every payment is refused" : "off" });
  if (a.domain) {
    const denied = policy.deny.find((p) => domainMatches(p, a.domain));
    checks.push({
      rule: "deny",
      ok: !denied,
      detail: denied ? `host ${a.domain} matches ${denied}` : policy.deny.length ? `host ${a.domain} matches none of ${policy.deny.join(", ")}` : "empty",
    });
    const allowed = policy.allow.length === 0 || policy.allow.some((p) => domainMatches(p, a.domain));
    checks.push({
      rule: "allow",
      ok: allowed,
      detail: policy.allow.length === 0 ? "empty: any host" : `host ${a.domain} ${allowed ? "is" : "is not"} on ${policy.allow.join(", ")}`,
    });
  }
  const coin = listed(policy, a.asset);
  checks.push({ rule: "stablecoins", ok: coin, detail: `${a.asset} ${coin ? "is" : "is not"} in [${policy.stablecoins.join(", ")}]` });
  const x = exact(a);
  if (!policy.perCall) {
    checks.push({ rule: "caps.per_call", ok: true, detail: "not set" });
  } else {
    const cap = capAtomic(policy.perCall);
    checks.push({
      rule: "caps.per_call",
      ok: cap !== undefined && x.amount !== undefined && x.amount <= cap,
      detail: `${x.amountText ?? "unknown"} ${a.asset}, at most ${formatMoney(policy.perCall)}`,
    });
  }
  if (!policy.perDay) {
    checks.push({ rule: "caps.per_day", ok: true, detail: "not set" });
  } else if (x.spent === undefined) {
    checks.push({ rule: "caps.per_day", ok: false, detail: `at most ${formatMoney(policy.perDay)}; today's spending unknown` });
  } else if (x.amount === undefined) {
    checks.push({ rule: "caps.per_day", ok: false, detail: `at most ${formatMoney(policy.perDay)}; the payment's amount unknown` });
  } else {
    const cap = capAtomic(policy.perDay);
    const total = x.spent + x.amount;
    checks.push({
      rule: "caps.per_day",
      ok: cap !== undefined && total <= cap,
      detail: `${shown(x.spent)} ${a.asset} paid today (UTC) + this ${shown(x.amount)} = ${shown(total)}, at most ${formatMoney(policy.perDay)}`,
    });
  }
  if (policy.also) {
    const file = policy.also.file;
    for (const check of policyChecks(policy.also.policy, a)) checks.push({ ...check, detail: `${file}: ${check.detail}` });
  }
  return checks;
}

/** Is this asset on the policy's stablecoin list? Letter case does not matter. */
function listed(policy: Policy, asset: string): boolean {
  return policy.stablecoins.some((coin) => coin.toUpperCase() === asset.toUpperCase());
}

/** @deprecated Rounds through floating point; for display only. Nothing in this client compares it. */
export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
