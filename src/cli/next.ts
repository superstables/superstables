// What to run next for a listing that `find` returns. A listing can be paid two ways, and the
// commands differ:
//
//   pay      superstables quote, then superstables pay <quote-id>. x402 on Base Sepolia; the
//            owner approves each payment.
//   budget   evm: superstables budget preflight (signs nothing; prints the price and payTo),
//            then superstables budget buy. tempo and solana have no preflight: buy alone.
//
// The ways come from the listing's routes, which only ever name testnets: a mainnet listing gets
// no command at all. A listing both ways can pay gets both, pay first.

import type { BudgetRoute, ServiceListing } from "../core/types.js";
import { shellWord } from "./outcome.js";

/** One way to pay a listing: the commands to run, in order. */
export interface ListingCommands {
  way: "pay" | "budget";
  /** For a budget: the `--rail` and `--chain` the commands use. */
  rail?: BudgetRoute["rail"];
  chain?: string;
  /** The commands, in order; placeholders are in angle brackets. */
  run: string[];
  /** What to know before running them: allowed values, what a placeholder stands for. */
  note?: string;
}

/**
 * Every way this client could pay a listing, pay first. Empty when it cannot pay it at all (a
 * mainnet, a protocol it does not speak, or a catalogue listing it refuses, such as one whose
 * endpoint is not https).
 */
export function listingCommands(service: ServiceListing): ListingCommands[] {
  // A catalogue listing on Base Sepolia that pay still cannot take is refused for a reason that
  // holds for a budget too (the endpoint is not https, the seller has no payout address).
  if (service.source === "demo-catalogue" && !service.actionable && service.routes?.pay) return [];

  const commands: ListingCommands[] = [];
  const unknownParams = service.source === "superstables-index";
  const choices = service.params
    .filter((p) => p.enum && p.enum.length > 1)
    .map((p) => `${p.name}: ${p.enum?.join(", ")}`)
    .join("; ");
  const paramsNote = unknownParams
    ? "the index does not list the request parameters: put the seller's in place of <parameters>"
    : choices || undefined;

  if (service.actionable) {
    commands.push({
      way: "pay",
      run: [quoteCommand(service), "superstables pay <quote-id>"],
      ...(paramsNote ? { note: paramsNote } : {}),
    });
  } else if (service.routes?.pay && unknownParams) {
    commands.push({
      way: "pay",
      run: [`superstables quote ${shellWord(requestUrl(service))}`, "superstables pay <quote-id>"],
      ...(paramsNote ? { note: paramsNote } : {}),
    });
  }

  const price = service.payment.price?.display;
  for (const route of service.routes?.budget ?? []) {
    const url = shellWord(requestUrl(service));
    const on = `--rail ${route.rail} --chain ${route.chain}`;
    if (route.rail === "evm") {
      commands.push({
        way: "budget",
        rail: route.rail,
        chain: route.chain,
        run: [
          `superstables budget preflight ${on} --url ${url}`,
          `superstables budget buy ${on} --url ${url} --max <ceiling> --pay-to <payTo> --op <new id>`,
        ],
        note: join("preflight signs nothing and prints the price and payTo", paramsNote),
      });
    } else {
      commands.push({
        way: "budget",
        rail: route.rail,
        chain: route.chain,
        run: [`superstables budget buy ${on} --url ${url} --max <ceiling> --op <new id>`],
        note: join(
          `no preflight on ${route.rail}${price ? `; listed at ${price}` : ""}`,
          paramsNote,
        ),
      });
    }
  }
  return commands;
}

/** The lines `find` prints under a listing's id: each way, then its commands. */
export function formatListingCommands(service: ServiceListing, commands = listingCommands(service)): string[] {
  if (commands.length === 0) {
    return [`not payable by this client: ${service.notActionableReason ?? "no reason recorded"}`];
  }
  const lines: string[] = [];
  for (const way of commands) {
    const heading = way.way === "pay" ? "with pay" : `with a budget, ${way.rail} on ${way.chain}`;
    lines.push(`${heading}${way.note ? ` (${way.note})` : ""}:`);
    for (const command of way.run) lines.push(`  ${command}`);
  }
  return lines;
}

/** What the placeholders in budget commands stand for, said once under the listings. */
export const BUDGET_PLACEHOLDERS =
  "<ceiling> is the most the owner accepts for one purchase (buy refuses before signing above it); " +
  "<payTo> is the address preflight prints; <new id> names the purchase, for reconcile.";

/** The command that quotes a listing, with an example or a placeholder for each required parameter. */
export function quoteCommand(service: ServiceListing): string {
  const params = service.params
    .filter((p) => p.required)
    .map((p) => ` --param ${shellWord(`${p.name}=${paramValue(p)}`)}`);
  return `superstables quote --service ${shellWord(service.id)}${params.join("")}`;
}

/**
 * The URL a budget buy (or a quote by URL) calls: the endpoint with each required parameter
 * filled in the same way as the quote command. When the parameters are not known (index
 * listings), `?<parameters>` stands in for them.
 */
function requestUrl(service: ServiceListing): string {
  if (service.source === "superstables-index") return `${service.endpoint}${service.endpoint.includes("?") ? "&" : "?"}<parameters>`;
  const query = service.params
    .filter((p) => p.required)
    .map((p) => {
      const value = paramValue(p);
      const known = p.example !== undefined || (p.enum?.length ?? 0) > 0;
      return `${encodeURIComponent(p.name)}=${known ? encodeURIComponent(value) : value}`;
    });
  if (query.length === 0) return service.endpoint;
  return `${service.endpoint}${service.endpoint.includes("?") ? "&" : "?"}${query.join("&")}`;
}

function paramValue(p: ServiceListing["params"][number]): string {
  return p.example ?? p.enum?.[0] ?? `<${p.name}>`;
}

function join(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join("; ");
}
