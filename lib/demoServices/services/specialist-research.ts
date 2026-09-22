// Specialist research: a prepared desk-research brief on one agent-payments topic, at one of
// two depths. Three topics, written in advance and deliberately general; nothing here searches,
// fetches or reasons at request time, and the confidence level describes the prepared text.

import type { DemoResult, DemoServiceDefinition } from "../types";

const AS_OF = "2026-09-21T09:00:00Z";

type Depth = "brief" | "standard";

interface Finding {
  claim: string;
  reasoning: string;
}

interface Topic {
  title: string;
  question: string;
  /** Five findings; "brief" returns the first three. */
  findings: Finding[];
  what_this_means: string;
  /** Returned at "standard" depth only. */
  open_questions: string[];
  confidence: "low" | "medium" | "high";
  summary: string;
}

const METHOD = "Prepared desk-research sample: findings written in advance from public protocol descriptions, not gathered at request time.";

const TOPICS: Record<string, Topic> = {
  "stablecoin-settlement-latency": {
    title: "Stablecoin settlement latency: L2s versus card rails",
    question: "In general terms, how quickly is a USDC transfer on an L2 final, compared with a card payment?",
    findings: [
      {
        claim: "A USDC transfer on an L2 is usable by the recipient within seconds.",
        reasoning: "The sequencer includes it in a block almost at once and the balance updates; most applications treat that as settled.",
      },
      {
        claim: "Card payments authorise in seconds but settle in days.",
        reasoning: "Authorisation is a hold, not a transfer; the merchant's money arrives after batch clearing, and chargebacks stay open for far longer.",
      },
      {
        claim: "Settlement to the L1 is slower and depends on the rollup design.",
        reasoning: "Optimistic rollups keep a challenge window of days; validity rollups post proofs in minutes to hours. Faster paths are a service, not the base guarantee.",
      },
      {
        claim: "For small agent payments, sequencer inclusion is the latency that matters.",
        reasoning: "Amounts are tiny and the counterparty is a service, so waiting for L1 finality costs more in delay than it protects.",
      },
      {
        claim: "The slowest step is usually off chain, at the on- and off-ramps.",
        reasoning: "Moving between bank money and USDC still runs on banking hours; the chain leg is rarely the end-to-end bottleneck.",
      },
    ],
    what_this_means: "USDC on an L2 settles in seconds where cards settle in days, but the guarantee behind those seconds is a sequencer's promise rather than L1 finality. For low-value machine payments that trade-off is usually acceptable; for large transfers the answer depends on the rollup and on how long the recipient is prepared to wait.",
    open_questions: [
      "Which L2s offer a fast-finality path an agent can rely on without trusting an intermediary?",
      "How do refunds compare once the card chargeback window is counted as part of settlement?",
      "Does off-ramp delay change the picture for a business that needs bank money at the end?",
    ],
    confidence: "medium",
    summary: "A prepared brief on settlement latency: a USDC transfer on an L2 is usable in seconds where card money arrives in days, though the guarantee behind those seconds is the sequencer's, not the L1's.",
  },
  "agent-payment-rails": {
    title: "Agent payment rails compared: x402, MPP and ACP",
    question: "At a high level, how do x402, MPP and ACP differ in who initiates, how approval works and where each is live?",
    findings: [
      {
        claim: "x402 is initiated by the server: it answers a request with 402 and a price.",
        reasoning: "The client signs a stablecoin authorisation and retries; a facilitator verifies and settles it. Live on Base and other EVM chains with USDC, mostly for small services.",
      },
      {
        claim: "MPP keeps the same HTTP challenge shape but is meant to be rail-agnostic.",
        reasoning: "The payment method is negotiated and presented as a credential, so a merchant need not hold stablecoins. Published, with early integrations.",
      },
      {
        claim: "ACP is a commerce protocol rather than a payment rail.",
        reasoning: "It defines how an agent runs a checkout with a merchant and invokes the buyer's stored payment method through a delegated token; the money moves on existing card rails.",
      },
      {
        claim: "Approval differs more than the wire format does.",
        reasoning: "x402 approval is a wallet signature on an exact amount; MPP approval is a scoped credential; ACP approval sits with the buyer's account and the merchant's checkout.",
      },
      {
        claim: "None of the three settles spending limits for autonomous agents.",
        reasoning: "Each leans on something outside the protocol: a wallet policy, a session budget or the buyer's account controls.",
      },
    ],
    what_this_means: "x402 suits pay-per-call machine services where a stablecoin wallet is acceptable; MPP aims at the same request shape with more payment methods; ACP is about agent-driven checkout at existing merchants. They compete less than they appear to, and one service could offer more than one. Where each is live changes quickly and should be re-checked before relying on it.",
    open_questions: [
      "Will MPP and x402 converge on one HTTP challenge format, or remain two dialects?",
      "How do merchants reconcile ACP orders with their existing fraud and refund tooling?",
      "Which rail will owners actually trust with a standing budget for an agent?",
    ],
    confidence: "medium",
    summary: "A prepared brief comparing x402, MPP and ACP: x402 is server-initiated pay-per-call with a wallet signature, MPP keeps the HTTP shape but opens the payment method, and ACP is agent checkout on existing rails.",
  },
  "testnet-facilitators": {
    title: "What a facilitator does in x402",
    question: "What does an x402 facilitator do, who pays the gas, what happens when it fails, and what must each party trust?",
    findings: [
      {
        claim: "A facilitator verifies a signed payment and settles it on chain for the seller.",
        reasoning: "The seller needs no chain connection or funded key; it forwards the payment header to the facilitator's verify and settle endpoints and serves the content on success.",
      },
      {
        claim: "The facilitator, not the buyer, pays the gas.",
        reasoning: "The buyer signs a transfer authorisation and the facilitator submits it, so a buyer holding only USDC can pay. On a testnet the gas is free; on mainnet it is a cost someone recovers.",
      },
      {
        claim: "A facilitator cannot move funds the buyer did not authorise.",
        reasoning: "The signature fixes the amount, the recipient and a validity window; the worst a bad facilitator can do is refuse or delay settlement.",
      },
      {
        claim: "Failover is the seller's problem in practice.",
        reasoning: "If the facilitator is down the seller cannot verify payments. Sellers can list more than one or settle themselves, but most demo setups have a single point of failure.",
      },
      {
        claim: "On a testnet the facilitator is a convenience; on mainnet it is a counterparty.",
        reasoning: "With free gas the sponsorship costs nothing to offer; with real money the seller trusts it to settle promptly and report honestly.",
      },
    ],
    what_this_means: "A facilitator turns a signed authorisation into an on-chain transfer so the seller can stay a plain web server. Its trust surface is narrow, because the buyer's signature bounds what can move, but the seller's liveness depends on it. On a testnet that dependency is cheap to accept; on mainnet a seller should know who runs it and what happens when it is unavailable.",
    open_questions: [
      "Should sellers verify locally and outsource only settlement, to shrink the liveness dependency?",
      "How would a facilitator prove it settled a payment it reported as settled?",
      "Will gas sponsorship survive on mainnet without a fee on every settlement?",
    ],
    confidence: "high",
    summary: "A prepared brief on x402 facilitators: they verify a buyer's signed authorisation and settle it on chain, paying the gas, so the seller stays a plain web server; the signature bounds what can move.",
  },
};

const TOPIC_IDS = Object.keys(TOPICS);
const DEFAULT_TOPIC = "agent-payment-rails";

export const specialistResearch: DemoServiceDefinition = {
  slug: "specialist-research",
  name: "Specialist research",
  description: "A prepared research brief on one agent-payments topic: findings with reasoning, what they mean, open questions and a confidence level.",
  price: "0.020",
  params: [
    {
      name: "topic_id",
      required: true,
      description: "Which prepared topic to brief on.",
      enum: TOPIC_IDS,
      example: DEFAULT_TOPIC,
    },
    {
      name: "depth",
      required: false,
      description: "How much comes back: brief gives three findings, standard gives five and the open questions.",
      enum: ["brief", "standard"],
      default: "standard",
      example: "standard",
    },
  ],
  returns: {
    topic: "{ id, title, question }",
    depth: "string",
    findings: "[{ claim, reasoning }]",
    what_this_means: "string",
    open_questions: "string[]",
    confidence: "\"low\" | \"medium\" | \"high\"",
    method: "string",
  },
  examplePrompts: [
    "Buy a research brief on agent-payment-rails and summarise how x402, MPP and ACP differ.",
    "Get me a brief on testnet-facilitators: what does a facilitator actually do, and what do I have to trust?",
  ],
  resultFor(params): DemoResult {
    const id = TOPIC_IDS.includes(params.topic_id) ? params.topic_id : DEFAULT_TOPIC;
    const topic = TOPICS[id];
    const depth: Depth = params.depth === "brief" ? "brief" : "standard";
    return {
      scenario_id: id,
      as_of: AS_OF,
      summary: topic.summary,
      data: {
        topic: { id, title: topic.title, question: topic.question },
        depth,
        findings: depth === "brief" ? topic.findings.slice(0, 3) : topic.findings,
        what_this_means: topic.what_this_means,
        open_questions: depth === "brief" ? [] : topic.open_questions,
        confidence: topic.confidence,
        method: METHOD,
      },
      sources: [],
    };
  },
};
