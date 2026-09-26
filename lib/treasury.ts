import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ledgerSchema, TREASURY_LEDGER_KEY } from "@/lib/treasury-ledger";
import { unstable_cache } from "next/cache";
import initialLedger from "@/content/treasury-ledger.json";
import { treasury } from "@/content/treasury";

const categoryNames: Record<string, string> = {
  "Desenvolvimento": "Development",
  "Operacional / infra": "Operational / infra",
  "Equipa / pagamentos": "Team / payments",
  "Auditoria / legal": "Audit / legal",
  "Liquidez / market making": "Liquidity / market making",
  "Outro": "Other",
};

const getLedger = unstable_cache(async () => {
  const rows = await db.select({ value: schema.settings.value }).from(schema.settings)
    .where(eq(schema.settings.key, TREASURY_LEDGER_KEY)).limit(1);
  if (!rows[0]) throw new Error("Treasury synchronization has not completed yet");
  return ledgerSchema.parse(JSON.parse(rows[0].value));
}, ["treasury-pushed-ledger-v1"], { revalidate: 300, tags: [TREASURY_LEDGER_KEY] });

export async function getTreasury() {
  const ledger = await getLedger().catch((error: unknown) => {
    console.error(JSON.stringify({ event: "treasury_sync_unavailable", message: error instanceof Error ? error.message : "Unknown error" }));
    return ledgerSchema.parse(initialLedger);
  });
  const expenses = ledger.expenses.map((expense) => ({
    ...expense,
    category: categoryNames[expense.category] ?? expense.category,
  })).sort((a, b) => b.date.localeCompare(a.date));
  const categoryCents = new Map<string, number>();
  let spentCents = 0;
  for (const expense of expenses) {
    const cents = Math.round(expense.usd * 100);
    spentCents += cents;
    categoryCents.set(expense.category, (categoryCents.get(expense.category) ?? 0) + cents);
  }
  const claimedNvda = Math.round((ledger.fees.total - ledger.fees.pending) * 1e6) / 1e6;
  const claimedCents = Math.round(claimedNvda * ledger.fees.price * 100);
  return {
    ...treasury,
    syncedAt: ledger.syncedAt,
    feesUpdatedAt: ledger.fees.updatedAt,
    nvdaPriceUsd: ledger.fees.price,
    fees: { generatedNvda: ledger.fees.total, pendingClaimNvda: ledger.fees.pending, claimedNvda },
    valuation: { claimedUsd: claimedCents / 100, spentUsd: spentCents / 100, availableUsd: (claimedCents - spentCents) / 100 },
    categories: Array.from(categoryCents, ([name, cents]) => ({ name, usd: cents / 100 })).sort((a, b) => b.usd - a.usd),
    expenses,
  };
}
