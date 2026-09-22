// Token and contract screening: a risk read on a sample token contract. Three prepared
// contracts, one boring, one hostile, one in between. The tokens are fictional and the
// addresses are documentation placeholders; nothing here reads a chain or runs an analyser.

import type { DemoResult, DemoServiceDefinition } from "../types";

const AS_OF = "2026-09-21T09:00:00Z";

type Severity = "info" | "low" | "medium" | "high";

interface Token {
  label: string;
  symbol: string;
  address: string;
  checks: {
    verified_source: string;
    ownership: string;
    upgradeable: string;
    mint_authority: string;
    transfer_restrictions: string;
    liquidity_lock: string;
    holder_concentration: string;
  };
  findings: { severity: Severity; finding: string }[];
  verdict: { risk: Exclude<Severity, "info">; note: string };
  summary: string;
}

const TOKENS: Record<string, Token> = {
  "sample-usdc-base": {
    label: "Sample USD stablecoin",
    symbol: "sUSDC",
    address: "0x5555555555555555555555555555555555555555",
    checks: {
      verified_source: "Verified; published source matches the deployed bytecode",
      ownership: "3-of-5 multisig; no single-key owner",
      upgradeable: "Yes, proxy; upgrades queue behind a 48-hour timelock",
      mint_authority: "Issuer role only, capped per epoch; no mint in the sample's last 30 days",
      transfer_restrictions: "Blocklist only; no fees, no pause, no cooldowns",
      liquidity_lock: "Not applicable; issuer-redeemable, not pool-dependent",
      holder_concentration: "Top 10 holders own 18%, mostly exchange and protocol contracts",
    },
    findings: [
      { severity: "info", finding: "Upgradeable proxy; the 48-hour timelock gives notice before any change." },
      { severity: "low", finding: "Issuer can freeze addresses through the blocklist, as is usual for an issued stablecoin." },
      { severity: "info", finding: "Mint is role-gated and capped; supply moved only with redemptions in the sample." },
    ],
    verdict: {
      risk: "low",
      note: "Controls are conventional for an issued stablecoin. Beyond the blocklist, nothing in the sample exposes a holder to owner discretion.",
    },
    summary: "The sample stablecoin contract shows conventional controls: multisig ownership, a timelocked proxy and a capped, role-gated mint; risk is low.",
  },
  "sample-meme-token": {
    label: "Sample meme token",
    symbol: "sMEME",
    address: "0x6666666666666666666666666666666666666666",
    checks: {
      verified_source: "Verified; the source includes an owner-only unlimited mint",
      ownership: "Single externally owned key; not renounced, no timelock",
      upgradeable: "No proxy, but owner functions cover the same ground",
      mint_authority: "Owner can mint any amount at any time; no cap",
      transfer_restrictions: "Owner can pause all transfers; sell tax 3%, adjustable by owner up to 25%",
      liquidity_lock: "None; all pool LP tokens sit in the owner key",
      holder_concentration: "Top 10 holders own 62%; the largest single holder 31%",
    },
    findings: [
      { severity: "high", finding: "Owner can mint without limit and dilute every holder at will." },
      { severity: "high", finding: "Liquidity is unlocked and held by the owner, who could withdraw it at any time." },
      { severity: "high", finding: "Owner can pause transfers, trapping holders while the owner exits." },
      { severity: "medium", finding: "Top 10 holders own 62%; one seller could move the price sharply." },
      { severity: "low", finding: "Sell tax is 3% today and adjustable to 25% without notice." },
    ],
    verdict: {
      risk: "high",
      note: "The sample contract puts every important power in one key with no lock and no timelock. A holder depends entirely on the owner's goodwill.",
    },
    summary: "The sample meme token gives one owner key unlimited mint, a pause switch and unlocked liquidity, and ten holders own 62% of supply; risk is high.",
  },
  "sample-lp-token": {
    label: "Sample liquidity-pool share",
    symbol: "sLP-USDC-ETH",
    address: "0x7777777777777777777777777777777777777777",
    checks: {
      verified_source: "Verified; matches the pool factory's published template",
      ownership: "Pool factory contract; only the fee switch answers to factory governance",
      upgradeable: "No; the pool contract is immutable",
      mint_authority: "Minted only against deposits; burned on withdrawal",
      transfer_restrictions: "None",
      liquidity_lock: "None; any share can be redeemed for the underlying at any time",
      holder_concentration: "Top 10 holders own 47%; the largest is a yield vault holding 22%",
    },
    findings: [
      { severity: "medium", finding: "A yield vault holds 22% of shares; its exit would thin the pool and raise slippage." },
      { severity: "medium", finding: "Factory governance can switch on a protocol fee that takes part of the trading fees from holders." },
      { severity: "low", finding: "The share tracks a 50/50 USDC and ETH pool, so its value moves with ETH and carries impermanent loss." },
      { severity: "info", finding: "No owner mint; supply moves only with deposits and withdrawals." },
    ],
    verdict: {
      risk: "medium",
      note: "The sample pool share itself is well-behaved; the risk is in what it holds and who else holds it, not in the contract's controls.",
    },
    summary: "The sample LP token is immutable with no owner mint, but ten holders own 47% of shares and its value moves with ETH; risk is medium.",
  },
};

export const contractScreening: DemoServiceDefinition = {
  slug: "contract-screening",
  name: "Token and contract screening",
  description: "A risk screening of a sample token contract: ownership, mint authority, transfer restrictions, liquidity lock, holder concentration, verified source, findings by severity and a plain verdict.",
  price: "0.005",
  params: [
    {
      name: "token_id",
      required: true,
      description: "Which prepared sample contract to screen. These are fictional contracts, not live tokens.",
      enum: Object.keys(TOKENS),
      example: "sample-usdc-base",
    },
  ],
  returns: {
    token: "{ label, symbol, address, chain }",
    checks: "{ verified_source, ownership, upgradeable, mint_authority, transfer_restrictions, liquidity_lock, holder_concentration }",
    findings: "[{ severity: info | low | medium | high, finding }]",
    verdict: "{ risk: low | medium | high, note }",
  },
  examplePrompts: [
    "Screen the sample token sample-meme-token before I consider buying it.",
    "Run a contract screening on sample-lp-token and tell me what the medium findings are.",
  ],
  resultFor(params): DemoResult {
    const id = Object.hasOwn(TOKENS, params.token_id) ? params.token_id : "sample-usdc-base";
    const token = TOKENS[id];
    return {
      scenario_id: id,
      as_of: AS_OF,
      summary: token.summary,
      data: {
        token: { label: token.label, symbol: token.symbol, address: token.address, chain: "Base Sepolia" },
        checks: token.checks,
        findings: token.findings,
        verdict: token.verdict,
      },
      sources: [],
    };
  },
};
