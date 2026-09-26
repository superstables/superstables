import { z } from "zod";

export const TREASURY_LEDGER_KEY = "treasury_ledger_v1";

const amount = z.number().finite().nonnegative();
export const ledgerSchema = z.object({
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

