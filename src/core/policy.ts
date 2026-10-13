// The spend policy: a YAML file the owner writes, evaluated in a fixed order so the reason
// a caller sees is always the first rule that refused. The same engine runs in two places:
// in the agent-side client (an early, advisory refusal, before the wallet is bothered) and
// inside the wallet (the owner's copy, the one that counts). Everything here is software
// policy; nothing here is enforced by the chain, and the docs say so.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { accountPolicyPath, policyPath } from "./home.js";
import { untrustedText } from "./text.js";
import type { PolicyCheck } from "./types.js";

export interface Money {
  amount: number;
  asset: string;
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

export const DEFAULT_POLICY: Policy = {
  perCall: { amount: 0.05, asset: "USDC" },
  perDay: { amount: 1, asset: "USDC" },
  allow: [],
  deny: [],
  stablecoins: [...USD_STABLECOINS],
  killSwitch: false,
  approval: "ask-every-payment",
};

export const POLICY_EXAMPLE = `# Superstables spend policy (software policy: enforced by this client and by the wallet,
# not by the chain). Evaluation order, first refusal wins:
#   kill_switch → deny → allow → stablecoins → per_call → per_day
caps:
  per_call: 0.05 USDC   # the most one payment may be
  per_day: 1 USDC       # the most all payments may add up to in one UTC day
allow: []               # hostname patterns; empty = any host
deny: []                # e.g. ["*.example.net"]
stablecoins: [USDC, pathUSD, USDG]  # allowed assets; the caps count them together, one for one
approval: ask-every-payment   # the wallet asks the owner before every payment
# kill_switch: true     # refuse everything
`;

export function parseMoney(value: string | number): Money {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`not an amount: "${untrustedText(value, 40)}"`);
  const match = /^(\d+(?:[.,]\d+)?)(?:\s+([A-Za-z0-9]{1,12}))?$/.exec(String(value).trim());
  const n = match ? Number(match[1].replace(",", ".")) : NaN;
  if (!match || !Number.isFinite(n)) throw new Error(`not an amount: "${untrustedText(value, 40)}"`);
  return { amount: n, asset: (match[2] ?? "USDC").toUpperCase() };
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
  const cap = (key: "per_call" | "per_day", fallback: Money | undefined): Money | undefined => {
    const value = (caps as Record<string, unknown>)[key];
    if (value === undefined || value === null) return fallback;
    try {
      return parseMoney(value as string | number);
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
  amountDecimal: number;
  asset: string;
  /** Already spent today in this asset, from the local records. Omit when unknown. */
  spentTodayDecimal?: number;
}

export interface Verdict {
  allowed: boolean;
  reason?: string;
}

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
  if (policy.perCall && a.amountDecimal > policy.perCall.amount) {
    return { allowed: false, reason: `${a.amountDecimal} ${a.asset} exceeds caps.per_call (${formatMoney(policy.perCall)})` };
  }
  if (policy.perDay && a.spentTodayDecimal !== undefined && a.spentTodayDecimal + a.amountDecimal > policy.perDay.amount) {
    return {
      allowed: false,
      reason: `today's payments (${round6(a.spentTodayDecimal)} ${a.asset}) plus ${a.amountDecimal} exceed caps.per_day (${formatMoney(policy.perDay)})`,
    };
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
  checks.push(
    policy.perCall
      ? {
          rule: "caps.per_call",
          ok: a.amountDecimal <= policy.perCall.amount,
          detail: `${a.amountDecimal} ${a.asset}, at most ${formatMoney(policy.perCall)}`,
        }
      : { rule: "caps.per_call", ok: true, detail: "not set" },
  );
  if (!policy.perDay) {
    checks.push({ rule: "caps.per_day", ok: true, detail: "not set" });
  } else if (a.spentTodayDecimal === undefined) {
    checks.push({ rule: "caps.per_day", ok: true, detail: `at most ${formatMoney(policy.perDay)}; today's spending unknown` });
  } else {
    const total = round6(a.spentTodayDecimal + a.amountDecimal);
    checks.push({
      rule: "caps.per_day",
      ok: total <= policy.perDay.amount,
      detail: `${round6(a.spentTodayDecimal)} ${a.asset} paid today (UTC) + this ${a.amountDecimal} = ${total}, at most ${formatMoney(policy.perDay)}`,
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

export const round6 =(n: number): number => Math.round(n * 1e6) / 1e6;
