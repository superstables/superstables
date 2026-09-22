// Whitepaper extraction: the key points, named figures and short quotes of one section of a
// sample whitepaper. Two prepared documents, three sections each. The documents are fictional
// and served from public/demo/services; nothing here reads an uploaded file or a live site.

import type { DemoResult, DemoServiceDefinition } from "../types";

const AS_OF = "2026-09-21T09:00:00Z";

const DOCUMENT_IDS = ["sample-lending-protocol", "sample-stablecoin"] as const;
const SECTIONS = ["summary", "tokenomics", "risks"] as const;

type DocumentId = (typeof DOCUMENT_IDS)[number];
type Section = (typeof SECTIONS)[number];

interface Extraction {
  heading: string;
  summary: string;
  key_points: string[];
  figures: Record<string, string>;
  quotes: { text: string; section: string }[];
}

interface Document {
  title: string;
  sections: Record<Section, Extraction>;
}

const DOCUMENTS: Record<DocumentId, Document> = {
  "sample-lending-protocol": {
    title: "Sample Lend Protocol Whitepaper",
    sections: {
      summary: {
        heading: "Summary",
        summary:
          "The Sample Lend Protocol whitepaper describes a fictional over-collateralised lending market with three launch markets, a 75% maximum loan-to-value for ETH collateral and a 10% fee on interest paid to the treasury.",
        key_points: [
          "Pooled, over-collateralised lending: lenders deposit into shared pools, borrowers lock collateral and draw loans against it.",
          "Three markets at launch (USDC, EURC, ETH), each with a utilisation-driven rate curve that steepens above the 80% kink.",
          "ETH collateral: 75% maximum loan-to-value, liquidation at 80%, collateral sold to liquidators at a 5% discount.",
          "SLP holders govern with a 2% quorum and a 48-hour timelock; a 10% fee on interest goes to the treasury.",
        ],
        figures: {
          launch_markets: "3 (USDC, EURC, ETH)",
          max_loan_to_value_eth: "75%",
          liquidation_threshold_eth: "80%",
          liquidation_discount: "5%",
          protocol_fee_on_interest: "10%",
          governance_quorum: "2% of circulating SLP",
          timelock: "48 hours",
        },
        quotes: [
          { text: "The maximum loan-to-value ratio for ETH collateral is 75%, and a position becomes liquidatable at 80%.", section: "Summary" },
          { text: "The team expects the protocol to be boring, and considers that a feature.", section: "Summary" },
        ],
      },
      tokenomics: {
        heading: "Tokenomics",
        summary:
          "SLP has a fixed supply of 1,000,000,000 tokens: 40% community rewards over four years, 25% treasury, 20% team, 10% early backers and 5% initial liquidity, with stakers receiving 50% of protocol fees.",
        key_points: [
          "Fixed supply of 1,000,000,000 SLP; no further minting.",
          "Community rewards start at 5,000,000 SLP per month, decline 10% every quarter after year one, and are split between markets by share of deposits.",
          "Team and early backers both have a one-year cliff, then three-year and two-year linear vesting respectively.",
          "Safety-module stakers earn 50% of protocol fees but can be slashed up to 30% to cover bad debt, with a 14-day unstaking cooldown.",
        ],
        figures: {
          total_supply: "1,000,000,000 SLP",
          community_rewards: "40%",
          treasury: "25%",
          team: "20%",
          early_backers: "10%",
          initial_liquidity: "5%",
          monthly_emissions_year_one: "5,000,000 SLP",
          staker_share_of_fees: "50%",
          circulating_at_launch: "roughly 15%",
        },
        quotes: [
          { text: "The supply is fixed at 1,000,000,000 SLP and no further tokens can be minted.", section: "Tokenomics" },
          { text: "Stakers receive 50% of protocol fees, paid in the fee asset, and in return their stake can be slashed by up to 30% to cover bad debt.", section: "Tokenomics" },
        ],
      },
      risks: {
        heading: "Risks",
        summary:
          "The Sample Lend Protocol whitepaper names five risks, led by a single oracle feed with a 30-minute heartbeat and a safety module that covers bad debt only up to 30% of staked SLP.",
        key_points: [
          "Smart contract risk remains after two audits; the bug bounty is capped at 500,000 USDC.",
          "A single oracle feed (30-minute heartbeat, 1% deviation threshold) can cause unfair liquidations or hide bad debt.",
          "Withdrawals wait for repayments or new deposits once utilisation exceeds 95%.",
          "Bad debt beyond 30% of staked SLP falls on lenders; team and early backers hold 30% of supply against a 2% quorum.",
        ],
        figures: {
          audits: "2",
          bug_bounty_cap: "500,000 USDC",
          oracle_heartbeat: "30 minutes",
          oracle_deviation_threshold: "1%",
          withdrawal_queue_utilisation: "above 95%",
          safety_module_cover: "up to 30% of staked SLP",
          insider_supply_share: "30% (team and early backers)",
        },
        quotes: [
          { text: "The contracts have been audited twice, but an audit is not a guarantee.", section: "Risks" },
          { text: "The safety module covers bad debt up to 30% of staked SLP; beyond that, losses fall on lenders in the affected market.", section: "Risks" },
        ],
      },
    },
  },
  "sample-stablecoin": {
    title: "Sample Dollar Whitepaper",
    sections: {
      summary: {
        heading: "Summary",
        summary:
          "The Sample Dollar whitepaper describes a fictional fully reserved stablecoin backed one-to-one by cash and short-dated government bills, attested monthly, with minting and redemption limited to verified partners.",
        key_points: [
          "Each SUSD is backed by one US dollar of reserves; the issuer redeems at par for verified partners only.",
          "Reserves are cash and government bills maturing in 90 days or less, held at two custodian banks and attested monthly within 15 days of month end.",
          "Issued on two test networks; minting settles the same business day, redemptions within two business days.",
          "The issuer can freeze addresses when required by law or after a confirmed theft; freezes are logged on chain.",
        ],
        figures: {
          reserve_ratio_target: "100%",
          insurance_fund: "1% of supply",
          max_reserve_maturity: "90 days",
          custodian_banks: "2",
          attestation: "monthly, within 15 days of month end",
          redemption_settlement: "2 business days",
          launch_networks: "2 test networks",
        },
        quotes: [
          { text: "Each SUSD is backed by one US dollar of reserves held outside the protocol, and the issuer commits to redeem SUSD for dollars at par for verified partners.", section: "Summary" },
          { text: "Sample Dollar makes no claim to yield for holders.", section: "Summary" },
        ],
      },
      tokenomics: {
        heading: "Tokenomics",
        summary:
          "SUSD has no fixed supply and is capped at 50,000,000 for its first six months; reserves are at least 80% short-dated government bills, reserve yield is split 80/20 between the issuer and the insurance fund, and redemption costs 0.10%.",
        key_points: [
          "Supply is elastic: minted on partner deposits, burned on redemption, capped at 50,000,000 SUSD for the first six months.",
          "At least 80% of reserves in government bills maturing within 90 days, the rest in cash; no lending, staking or rehypothecation.",
          "Reserve yield goes 80% to the issuer and 20% to the insurance fund until it reaches 1% of supply; holders earn nothing.",
          "Minting is free; redemption carries a 0.10% fee with a 100,000 SUSD minimum; there is no governance token.",
        ],
        figures: {
          supply: "elastic, no fixed cap",
          launch_supply_cap: "50,000,000 SUSD for six months",
          reserves_in_government_bills: "at least 80%",
          max_reserve_maturity: "90 days",
          yield_to_issuer: "80%",
          yield_to_insurance_fund: "20%",
          mint_fee: "0%",
          redemption_fee: "0.10%",
          minimum_redemption: "100,000 SUSD",
          policy_change_notice: "30 days",
        },
        quotes: [
          { text: "Tokens are minted when a verified partner deposits dollars and burned when SUSD is redeemed, so the supply always equals the dollars in reserve.", section: "Tokenomics" },
          { text: "Reserve yield belongs to the issuer, not to holders.", section: "Tokenomics" },
        ],
      },
      risks: {
        heading: "Risks",
        summary:
          "The Sample Dollar whitepaper lists six risks, chiefly reserve losses on forced bill sales, custodian failure, secondary-market depegs that only verified partners can arbitrage, and address freezes by the issuer.",
        key_points: [
          "A forced sale of bills during stress can realise a small loss; the insurance fund covers losses up to 1% of supply.",
          "No more than 60% of reserves sit with any one custodian, but a custodian failure can still delay access.",
          "The secondary-market price can leave the peg; only verified partners can redeem at par.",
          "Redemptions can stretch from two to five business days, frozen addresses cannot transfer or redeem, and regulation could force restrictions or a wind-down.",
        ],
        figures: {
          insurance_fund_cover: "up to 1% of supply",
          max_reserves_per_custodian: "60%",
          max_reserve_maturity: "90 days",
          normal_redemption: "2 business days",
          extended_redemption: "up to 5 business days",
        },
        quotes: [
          { text: "Only verified partners can redeem at par; other holders depend on partners to arbitrage the price back.", section: "Risks" },
          { text: "The issuer holds no more than 60% of reserves at any one custodian.", section: "Risks" },
        ],
      },
    },
  },
};

export const whitepaperExtraction: DemoServiceDefinition = {
  slug: "whitepaper-extraction",
  name: "Whitepaper extraction",
  description: "A structured extraction from one section of a sample whitepaper: key points, named figures and short direct quotes with the section they came from.",
  price: "0.005",
  params: [
    {
      name: "document_id",
      required: true,
      description: "Which prepared sample whitepaper to extract from. These are fictional documents, not real projects.",
      enum: DOCUMENT_IDS,
      example: "sample-lending-protocol",
    },
    {
      name: "section",
      required: false,
      description: "Which section of the whitepaper to extract.",
      enum: SECTIONS,
      default: "summary",
      example: "summary",
    },
  ],
  returns: {
    document: "{ id, title }",
    section: "string",
    key_points: "string[]",
    figures: "{ [name]: value }",
    quotes: "[{ text, section }]",
  },
  examplePrompts: [
    "Extract the tokenomics section of the sample-lending-protocol whitepaper and list the token allocation.",
    "Pull the key risks out of the sample-stablecoin whitepaper, with direct quotes.",
  ],
  resultFor(params): DemoResult {
    const documentId: DocumentId = params.document_id === "sample-stablecoin" ? "sample-stablecoin" : "sample-lending-protocol";
    const section: Section = params.section === "tokenomics" || params.section === "risks" ? params.section : "summary";
    const document = DOCUMENTS[documentId];
    const extraction = document.sections[section];
    return {
      scenario_id: `${documentId}-${section}`,
      as_of: AS_OF,
      summary: extraction.summary,
      data: {
        document: { id: documentId, title: document.title },
        section: extraction.heading,
        key_points: extraction.key_points,
        figures: extraction.figures,
        quotes: extraction.quotes,
      },
      sources: [{ title: document.title, url: `/demo/services/whitepaper-${documentId}.md`, section: extraction.heading }],
    };
  },
};
