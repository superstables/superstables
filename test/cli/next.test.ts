// What `find` tells an agent to run for each listing. The commands must fit the listing's
// routes: a quote for what `pay` can take, preflight and buy for an evm budget, buy alone on
// tempo and solana, both when both fit (pay first), and nothing at all for a mainnet listing.

import { describe, expect, it } from "vitest";
import { formatListingCommands, listingCommands, quoteCommand } from "../../src/cli/next.js";
import { demoService } from "../../src/core/discovery.js";
import { routesFor } from "../../src/core/routes.js";
import type { ServiceListing } from "../../src/core/types.js";

/** An index listing as discovery builds it: no request parameters, never actionable. */
function indexListing(id: string, rails: string[], chains: string[], extra: Partial<ServiceListing> = {}): ServiceListing {
  return {
    id,
    name: id,
    description: "",
    endpoint: `https://${id}/api`,
    method: "GET",
    params: [],
    payment: { rail: "x402", scheme: "exact", network: chains[0] ?? "", networkLabel: chains[0] ?? "", asset: "USDC" },
    source: "superstables-index",
    testnet: true,
    actionable: false,
    notActionableReason: "a reason",
    rails,
    chains,
    routes: routesFor(rails, chains),
    ...extra,
  };
}

describe("the commands find prints for a listing", () => {
  it("gives a catalogue listing buy once first, then the quote, then the evm budget commands with the parameters filled", () => {
    const service = { ...demoService(), endpoint: "https://seller.example/market" };
    const commands = listingCommands(service);
    expect(commands.map((c) => c.way)).toEqual(["buy-once", "pay", "budget"]);
    expect(commands[0].run).toEqual(["superstables budget buy-once --service superstables-demo-market-data --param asset=BTC --max <ceiling>"]);
    expect(commands[0].note).toBe("the owner approves on superstables.com from any device; asset: BTC, ETH");
    const pay = commands[1];
    expect(pay.run).toEqual([
      "superstables quote --service superstables-demo-market-data --param asset=BTC",
      "superstables pay <quote-id>",
    ]);
    expect(pay.note).toBe("asset: BTC, ETH");
    // a third-party catalogue listing cannot be bought once: pay comes first there
    const third = listingCommands({ ...service, operator: "Third party (not operated by Superstables)" });
    expect(third.map((c) => c.way)).toEqual(["pay", "budget"]);
    expect(commands[2]).toMatchObject({ rail: "evm", chain: "base-sepolia" });
    expect(commands[2].run).toEqual([
      "superstables budget preflight --rail evm --chain base-sepolia --url 'https://seller.example/market?asset=BTC'",
      "superstables budget buy --rail evm --chain base-sepolia --url 'https://seller.example/market?asset=BTC' " +
        "--max <ceiling> --pay-to <payTo> --op <new id>",
    ]);
  });

  it("gives a budget-only evm listing preflight then buy, on its own chain, and no quote", () => {
    const commands = listingCommands(indexListing("arc.example", ["x402"], ["arc-testnet"]));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ way: "budget", rail: "evm", chain: "arc-testnet" });
    expect(commands[0].run[0]).toBe("superstables budget preflight --rail evm --chain arc-testnet --url 'https://arc.example/api?<parameters>'");
    expect(commands[0].run[1]).toContain("superstables budget buy --rail evm --chain arc-testnet");
    expect(commands[0].run[1]).toContain("--max <ceiling> --pay-to <payTo> --op <new id>");
    expect(commands.flatMap((c) => c.run).join("\n")).not.toContain("quote");
  });

  it("gives tempo and solana listings buy alone, since they have no preflight", () => {
    const tempo = listingCommands(indexListing("tempo.example", ["mpp"], ["tempo-moderato"]));
    expect(tempo).toEqual([
      expect.objectContaining({
        way: "budget",
        rail: "tempo",
        chain: "moderato",
        run: ["superstables budget buy --rail tempo --chain moderato --url 'https://tempo.example/api?<parameters>' --max <ceiling> --op <new id>"],
      }),
    ]);
    const price = { amountDecimal: 0.005, asset: "USDC", display: "0.005 USDC" };
    const solana = listingCommands(
      indexListing("devnet.example", ["x402"], ["solana-devnet"], {
        payment: { rail: "x402", scheme: "exact", network: "solana-devnet", networkLabel: "", asset: "USDC", price },
      }),
    );
    expect(solana).toHaveLength(1);
    expect(solana[0]).toMatchObject({ rail: "solana", chain: "devnet" });
    expect(solana[0].run).toHaveLength(1);
    expect(solana[0].run[0]).toMatch(/^superstables budget buy --rail solana --chain devnet /);
    expect(solana[0].note).toContain("listed at 0.005 USDC");
  });

  it("lists every way for a listing on several testnets, pay first", () => {
    const commands = listingCommands(indexListing("multi.example", ["x402"], ["solana-devnet", "base-sepolia", "polygon-amoy"]));
    expect(commands.map((c) => `${c.way} ${c.rail ?? ""} ${c.chain ?? ""}`.trim())).toEqual([
      "pay",
      "budget evm base-sepolia",
      "budget evm polygon-amoy",
      "budget solana devnet",
    ]);
    expect(commands[0].run[0]).toBe("superstables quote 'https://multi.example/api?<parameters>'");
  });

  it("routes every name the index may give Ethereum Sepolia to its evm chain key", () => {
    for (const name of ["ethereum-sepolia", "sepolia", "eip155:11155111"]) {
      const commands = listingCommands(indexListing("sepolia.example", ["x402"], [name]));
      expect(commands.map((c) => `${c.way} ${c.rail ?? ""} ${c.chain ?? ""}`.trim())).toEqual(["budget evm ethereum-sepolia"]);
    }
  });

  it("never suggests a command for a mainnet listing", () => {
    for (const chains of [["base"], ["solana"], ["base", "solana"], ["eip155:8453"], ["ethereum"], ["eip155:1"]]) {
      const service = indexListing("main.example", ["x402"], chains, { testnet: false, notActionableReason: "mainnet only" });
      expect(listingCommands(service)).toEqual([]);
      expect(formatListingCommands(service)).toEqual(["not payable by this client: mainnet only"]);
    }
    // A mainnet next to a testnet: only the testnet is offered.
    const mixed = listingCommands(indexListing("mixed.example", ["x402"], ["base", "arbitrum-sepolia"]));
    expect(mixed.map((c) => c.chain)).toEqual(["arbitrum-sepolia"]);
  });

  it("offers nothing for a catalogue listing refused for a reason a budget shares", () => {
    const service: ServiceListing = {
      ...demoService(),
      endpoint: "http://seller.example/market",
      actionable: false,
      notActionableReason: "the endpoint is not https",
    };
    expect(listingCommands(service)).toEqual([]);
  });

  it("prints each way under a heading, its commands one per line", () => {
    const lines = formatListingCommands(indexListing("arc.example", ["x402"], ["arc-testnet"]));
    expect(lines[0]).toMatch(/^with a budget, evm on arc-testnet \(preflight signs nothing/);
    expect(lines[1]).toMatch(/^ {2}superstables budget preflight /);
    expect(lines[2]).toMatch(/^ {2}superstables budget buy /);
  });

  it("quotes a placeholder for a required parameter with no example, so the shell does not read it as a redirect", () => {
    const service: ServiceListing = {
      ...demoService(),
      params: [{ name: "city", in: "query", required: true }],
    };
    expect(quoteCommand(service)).toBe("superstables quote --service superstables-demo-market-data --param 'city=<city>'");
  });
});
