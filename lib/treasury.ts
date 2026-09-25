import "server-only";
import { z } from "zod";
import { treasury } from "@/content/treasury";

const source = "https://script.google.com/macros/s/AKfycbx1c_PoQdJA61z6cVwwUSQ6UKx_eB0u4Aziiz16MdsMtJOZbj0iv7WbVjSNNOgQBeAF-g/exec?format=json";
const amount = z.number().finite().nonnegative();
const ledgerSchema = z.object({
  version: z.literal(1),
  syncedAt: z.iso.datetime(),
  fees: z.object({
    total: amount,
    pending: amount,
    price: amount.positive(),
    updatedAt: z.iso.datetime(),
  }).refine((fees) => fees.pending <= fees.total, "Pending fees exceed generated fees"),
  expenses: z.array(z.object({
    date: z.iso.date(),
    category: z.string().trim().min(1),
    description: z.string(),
    usd: amount,
  })),
});

const categoryNames: Record<string, string> = {
  "Desenvolvimento": "Development",
  "Operacional / infra": "Operational / infra",
  "Equipa / pagamentos": "Team / payments",
  "Auditoria / legal": "Audit / legal",
  "Liquidez / market making": "Liquidity / market making",
  "Outro": "Other",
};

export async function getTreasury() {
  const response = await fetch(source, { next: { revalidate: 300 }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("Treasury source unavailable");
  const ledger = ledgerSchema.parse(await response.json());
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
