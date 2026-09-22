// Wallet briefing: what happened in a sample wallet over a period. Three prepared wallets,
// two periods. The wallets are fictional and the addresses are documentation placeholders;
// nothing here reads a chain.

import type { DemoResult, DemoServiceDefinition } from "../types";

const AS_OF = "2026-09-21T09:00:00Z";

interface Wallet {
  label: string;
  address: string;
  balances: { asset: string; amount: string; chain: string }[];
  activity: Record<"7d" | "30d", { transactions: number; inflow_usdc: string; outflow_usdc: string; notable: string[] }>;
  positions: { protocol: string; kind: string; value_usdc: string; note: string }[];
  summary: Record<"7d" | "30d", string>;
}

const WALLETS: Record<string, Wallet> = {
  "demo-active": {
    label: "Active sample wallet",
    address: "0x1111111111111111111111111111111111111111",
    balances: [
      { asset: "USDC", amount: "1240.50", chain: "Base Sepolia" },
      { asset: "ETH", amount: "0.42", chain: "Base Sepolia" },
    ],
    activity: {
      "7d": {
        transactions: 9,
        inflow_usdc: "250.00",
        outflow_usdc: "38.20",
        notable: [
          "Received 250 USDC from 0x2222…2222 on 2026-09-16",
          "Opened a 500 USDC supply position on Sample Lend on 2026-09-17",
          "Seven small x402 payments totalling 0.077 USDC to demo services",
        ],
      },
      "30d": {
        transactions: 31,
        inflow_usdc: "1,050.00",
        outflow_usdc: "412.75",
        notable: [
          "Three inbound transfers of 250 to 400 USDC, each from the same counterparty",
          "Swapped 0.1 ETH for 310.40 USDC on Sample Swap on 2026-09-02",
          "Supply position on Sample Lend grew from 200 to 500 USDC",
        ],
      },
    },
    positions: [{ protocol: "Sample Lend", kind: "supply", value_usdc: "500.00", note: "earning a variable rate, no borrow against it" }],
    summary: {
      "7d": "The sample wallet received 250 USDC and added a 500 USDC lending position; outgoing activity was small.",
      "30d": "Over 30 days the sample wallet took in about 1,050 USDC, swapped some ETH to USDC and grew its lending position to 500 USDC.",
    },
  },
  "demo-dormant": {
    label: "Dormant sample wallet",
    address: "0x3333333333333333333333333333333333333333",
    balances: [{ asset: "USDC", amount: "12.00", chain: "Base Sepolia" }],
    activity: {
      "7d": { transactions: 0, inflow_usdc: "0.00", outflow_usdc: "0.00", notable: ["No transactions in the period"] },
      "30d": { transactions: 1, inflow_usdc: "12.00", outflow_usdc: "0.00", notable: ["One inbound transfer of 12 USDC on 2026-08-28; nothing since"] },
    },
    positions: [],
    summary: {
      "7d": "The sample wallet had no activity in the last 7 days and holds 12 USDC.",
      "30d": "The sample wallet received a single 12 USDC transfer 24 days ago and has done nothing since.",
    },
  },
  "demo-treasury": {
    label: "Treasury sample wallet",
    address: "0x4444444444444444444444444444444444444444",
    balances: [
      { asset: "USDC", amount: "48,900.00", chain: "Base Sepolia" },
      { asset: "EURC", amount: "12,000.00", chain: "Base Sepolia" },
    ],
    activity: {
      "7d": {
        transactions: 4,
        inflow_usdc: "0.00",
        outflow_usdc: "6,100.00",
        notable: ["Four payroll-style transfers of 1,525 USDC each on 2026-09-19, to four distinct addresses"],
      },
      "30d": {
        transactions: 11,
        inflow_usdc: "25,000.00",
        outflow_usdc: "12,200.00",
        notable: [
          "One 25,000 USDC inbound transfer on 2026-09-01",
          "Two payroll batches of 6,100 USDC, on 2026-09-05 and 2026-09-19",
          "Converted 12,000 USDC to EURC on 2026-09-10",
        ],
      },
    },
    positions: [],
    summary: {
      "7d": "The treasury sample wallet paid out 6,100 USDC in four equal transfers and received nothing.",
      "30d": "The treasury sample wallet received 25,000 USDC, ran two payroll batches and moved 12,000 USDC into EURC.",
    },
  },
};

export const walletBriefing: DemoServiceDefinition = {
  slug: "wallet-briefing",
  name: "Wallet briefing",
  description: "A plain-language briefing on a sample wallet: balances, activity over a period, notable transactions and open positions.",
  price: "0.003",
  params: [
    {
      name: "sample_wallet",
      required: true,
      description: "Which prepared sample wallet to brief on. These are fictional wallets, not the owner's.",
      enum: Object.keys(WALLETS),
      example: "demo-active",
    },
    {
      name: "period",
      required: false,
      description: "How far back the briefing looks.",
      enum: ["7d", "30d"],
      default: "7d",
      example: "7d",
    },
  ],
  returns: {
    wallet: "{ label, address }",
    period: "string",
    balances: "[{ asset, amount, chain }]",
    activity: "{ transactions, inflow_usdc, outflow_usdc, notable[] }",
    positions: "[{ protocol, kind, value_usdc, note }]",
  },
  examplePrompts: [
    "Buy me a briefing on the sample wallet demo-active for the last 7 days.",
    "Get a 30-day wallet briefing for demo-treasury and tell me where the money went.",
  ],
  resultFor(params): DemoResult {
    const id = Object.hasOwn(WALLETS, params.sample_wallet) ? params.sample_wallet : "demo-active";
    const wallet = WALLETS[id];
    const period = (params.period === "30d" ? "30d" : "7d") as "7d" | "30d";
    return {
      scenario_id: id,
      as_of: AS_OF,
      summary: wallet.summary[period],
      data: {
        wallet: { label: wallet.label, address: wallet.address },
        period,
        balances: wallet.balances,
        activity: wallet.activity[period],
        positions: wallet.positions,
      },
      sources: [],
    };
  },
};
