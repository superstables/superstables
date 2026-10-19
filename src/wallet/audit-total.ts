// Today's spending, read back from the wallet's audit log. Pure: the log's text goes in, a total in millionths of the cap
// unit comes out, so the sum can be tested without a server and the daemon never adds money up as floating point.

import { capUnit, capUnits } from "../core/policy.js";

export type AuditTotal = { total: bigint } | { problem: string };

/**
 * Today's spending in the cap unit of `asset`, in millionths (policy.ts CAP_DECIMALS), from the wallet's audit log text.
 * One request per id: its last line decides. It counts when that line is "signed" or "approved" and its `at` is today
 * (UTC). The amount is verified.amountAtomic at the token decimals of verified.network (decimalsOf), through capUnits.
 * Any line that is not JSON, or a counted line whose amount or network cannot be read, makes the total unknown.
 */
export function spentTodayFromAudit(text: string, asset: string, today: string, decimalsOf: (caip2: string) => number | undefined): AuditTotal {
  const last = new Map<string, { entry: Record<string, unknown>; line: number }>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { problem: `line ${i + 1} of the audit log is not JSON` };
    }
    const record = entry as Record<string, unknown> | null;
    if (!record || typeof record !== "object" || typeof record.id !== "string" || typeof record.status !== "string") {
      return { problem: `line ${i + 1} of the audit log has no request id and status` };
    }
    last.set(record.id, { entry: record, line: i + 1 });
  }
  let total = 0n;
  for (const { entry, line } of last.values()) {
    if (entry.status !== "signed" && entry.status !== "approved") continue;
    if (typeof entry.at !== "string" || entry.at.slice(0, 10) !== today) continue;
    const verified = (entry.verified ?? {}) as Record<string, unknown>;
    if (typeof verified.asset !== "string") return { problem: `line ${line} of the audit log names no asset` };
    if (capUnit(verified.asset) !== capUnit(asset)) continue;
    const decimals = typeof verified.network === "string" ? decimalsOf(verified.network) : undefined;
    if (typeof verified.amountAtomic !== "string" || !/^\d{1,78}$/.test(verified.amountAtomic) || decimals === undefined || !Number.isInteger(decimals)) {
      return { problem: `line ${line} of the audit log has an amount or a chain that cannot be read` };
    }
    total += capUnits(BigInt(verified.amountAtomic), decimals);
  }
  return { total };
}
