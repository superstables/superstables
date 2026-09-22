// Web search: ranked results and a short answer for one of three fixed queries about the
// agent-payments space. The URLs are real public documentation pages; the snippets and the
// answer are prepared sample text, not fetched content. Nothing here calls a search engine.

import type { DemoResult, DemoServiceDefinition } from "../types";

const AS_OF = "2026-09-21T09:00:00Z";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface Query {
  query: string;
  results: SearchResult[];
  answer: string;
  summary: string;
}

const QUERIES: Record<string, Query> = {
  "x402-facilitators": {
    query: "what is an x402 facilitator",
    results: [
      {
        title: "x402: an open standard for internet-native payments",
        url: "https://x402.org",
        snippet: "The protocol site: a server answers with HTTP 402 and its payment requirements, the client signs a payment and retries the request.",
      },
      {
        title: "coinbase/x402 on GitHub",
        url: "https://github.com/coinbase/x402",
        snippet: "Reference implementation and SDKs. A facilitator exposes verify and settle endpoints, so a seller never has to talk to the chain itself.",
      },
      {
        title: "x402 documentation on Coinbase Developer Platform",
        url: "https://docs.cdp.coinbase.com/x402/welcome",
        snippet: "Guides for buyers, sellers and facilitator operators, including a hosted facilitator that can be used on Base Sepolia.",
      },
      {
        title: "@x402/core on npm",
        url: "https://www.npmjs.com/package/@x402/core",
        snippet: "Core types and helpers shared by the client, server and facilitator packages, including the PaymentRequirements a 402 carries.",
      },
      {
        title: "EIP-3009: Transfer With Authorization",
        url: "https://eips.ethereum.org/EIPS/eip-3009",
        snippet: "The signed-authorization standard the exact scheme uses on EVM networks; the facilitator submits the authorization and pays the gas.",
      },
    ],
    answer:
      "An x402 facilitator is the service that turns a signed payment into a settled one. When a client retries a request with a payment payload, the seller passes it to the facilitator, which verifies the signature, amount and network against the requirements and then submits the transfer on chain, paying the gas. The seller only compares the facilitator's answer with what it asked for. A seller can run its own facilitator or use a hosted one.",
    summary: "Prepared results for “what is an x402 facilitator”: sample sources from the protocol site to EIP-3009 on how a facilitator verifies and settles payments for a seller.",
  },
  "base-sepolia-faucet": {
    query: "how to get test USDC and ETH on Base Sepolia",
    results: [
      {
        title: "Circle USDC faucet",
        url: "https://faucet.circle.com",
        snippet: "Circle's faucet for test USDC on supported test networks, Base Sepolia included. Pick the network and paste a wallet address.",
      },
      {
        title: "Base documentation",
        url: "https://docs.base.org",
        snippet: "Base developer docs: network details for Base Sepolia, chain id 84532, plus a list of faucets that hand out test ETH for gas.",
      },
      {
        title: "USDC contract addresses (Circle developer docs)",
        url: "https://developers.circle.com/stablecoins/usdc-contract-addresses",
        snippet: "Circle's list of official test USDC contract addresses by network, so a wallet can check it holds the canonical token, not a copy.",
      },
      {
        title: "Alchemy Base Sepolia faucet",
        url: "https://www.alchemy.com/faucets/base-sepolia",
        snippet: "A test ETH faucet for Base Sepolia. ETH is only needed when a wallet submits its own transactions rather than signing authorizations.",
      },
      {
        title: "Base Sepolia explorer",
        url: "https://sepolia.basescan.org",
        snippet: "The Base Sepolia block explorer: confirm a faucet transfer landed and follow a settlement transaction by its hash.",
      },
    ],
    answer:
      "Test USDC on Base Sepolia comes from Circle's faucet: choose Base Sepolia, paste the wallet address and a small amount is sent to it. Test ETH for gas comes from a separate faucet, such as Alchemy's or one listed in the Base docs. Compare the token's contract address with Circle's list of test-network deployments, then confirm both balances on the Base Sepolia explorer. A buyer paying through x402 signs EIP-3009 authorizations and needs no ETH, because the facilitator pays the gas.",
    summary: "Prepared results for “how to get test USDC and ETH on Base Sepolia”: sample sources covering Circle's USDC faucet, test ETH faucets and where to verify the balances.",
  },
  "eip-3009-authorizations": {
    query: "how EIP-3009 transferWithAuthorization works",
    results: [
      {
        title: "EIP-3009: Transfer With Authorization",
        url: "https://eips.ethereum.org/EIPS/eip-3009",
        snippet: "The standard itself: a token holder signs a typed message naming from, to, value, a validity window and a nonce, and anyone may submit it.",
      },
      {
        title: "EIP-712: Typed structured data hashing and signing",
        url: "https://eips.ethereum.org/EIPS/eip-712",
        snippet: "The typed-data signing scheme EIP-3009 builds on; its domain separator binds a signature to one token contract on one chain.",
      },
      {
        title: "circlefin/stablecoin-evm on GitHub",
        url: "https://github.com/circlefin/stablecoin-evm",
        snippet: "Circle's USDC contract source, which implements transferWithAuthorization, receiveWithAuthorization and cancelAuthorization.",
      },
      {
        title: "EIP-2612: Permit extension for signed approvals",
        url: "https://eips.ethereum.org/EIPS/eip-2612",
        snippet: "The sibling standard: a signed approval rather than a signed transfer, so a separate transferFrom call still has to move the funds.",
      },
      {
        title: "x402: an open standard for internet-native payments",
        url: "https://x402.org",
        snippet: "On EVM networks the exact payment scheme carries an EIP-3009 authorization, so a buyer signs once and pays no gas.",
      },
    ],
    answer:
      "EIP-3009 lets a token holder authorise a transfer by signature instead of by sending a transaction. The holder signs an EIP-712 message naming the recipient, the amount, a validity window and a random nonce; a relayer submits it to the token contract, which checks the signature and the window, marks the nonce as used and moves the funds. The holder needs no ETH. USDC implements it, and x402's exact scheme relies on it so a facilitator can settle a buyer's payment and pay the gas.",
    summary: "Prepared results for “how EIP-3009 transferWithAuthorization works”: sample sources on signed, gasless USDC transfers, from the EIP text to how x402 uses it.",
  },
};

const QUERY_IDS = Object.keys(QUERIES);

export const webSearch: DemoServiceDefinition = {
  slug: "web-search",
  name: "Web search",
  description: "Prepared web search results for one of three fixed queries about agent payments: ranked results with title, URL and snippet, and a short answer drawn from them.",
  price: "0.003",
  params: [
    {
      name: "query_id",
      required: true,
      description: "Which prepared query to answer: x402-facilitators (what is an x402 facilitator), base-sepolia-faucet (how to get test USDC and ETH on Base Sepolia) or eip-3009-authorizations (how EIP-3009 transferWithAuthorization works). No other query is searched.",
      enum: QUERY_IDS,
      example: "x402-facilitators",
    },
    {
      name: "max_results",
      required: false,
      description: "How many of the prepared ranked results to return.",
      enum: ["3", "5"],
      default: "5",
      example: "5",
    },
  ],
  returns: {
    query_id: "string",
    query: "string",
    result_count: "number",
    results: "[{ rank, title, url, snippet }]",
    answer: "string",
    note: "string",
  },
  examplePrompts: [
    "Search the web for what an x402 facilitator does, query_id x402-facilitators, and give me the top 3 results.",
    "Run the base-sepolia-faucet search and tell me where to get test USDC on Base Sepolia.",
  ],
  resultFor(params): DemoResult {
    const scenario = QUERY_IDS.includes(params.query_id) ? params.query_id : QUERY_IDS[0];
    const query = QUERIES[scenario];
    const count = params.max_results === "3" ? 3 : 5;
    const results = query.results.slice(0, count).map((result, index) => ({ rank: index + 1, ...result }));
    return {
      scenario_id: scenario,
      as_of: AS_OF,
      summary: query.summary,
      data: {
        query_id: scenario,
        query: query.query,
        result_count: results.length,
        results,
        answer: query.answer,
        note: "The result URLs are real public pages; the snippets and the answer are prepared sample text, not fetched content.",
      },
      sources: [],
    };
  },
};
