// The help text. Someone with nothing but the installed CLI, a person or an agent, should be
// able to use it correctly from `--help` alone: what a command does, whether it can move money,
// who is meant to run it, one example, what it prints and how it exits. Every command gets the
// same sections in the same order, through explain(), so a reader learns where to look once.

import type { Command } from "commander";
import { DEFAULT_APPROVE_PORT, DEFAULT_WALLET_PORT } from "../core/home.js";
import { DEFAULT_INDEX_URL } from "../core/discovery.js";

const WIDTH = 100;

export interface Explanation {
  /** Whether the command can move money, and under what condition. */
  money: string;
  /** Owner, agent, or either; and what that means here. */
  who: string;
  examples: string[];
  /** What goes to stdout, with and without --json. */
  prints: string;
  /** The codes this command can exit with. */
  exits: string;
  /** Anything else a reader needs before running it. */
  notes?: string[];
}

/** Add the standard sections to a command's --help. */
export function explain(command: Command, e: Explanation): Command {
  const lines = [
    "",
    ...(e.notes ?? []).flatMap((note) => [...wrap(note, ""), ""]),
    ...wrap(`Moves money: ${e.money}`, "  "),
    ...wrap(`Run by: ${e.who}`, "  "),
    "Example:",
    ...e.examples.map((example) => `  $ ${example}`),
    ...wrap(`Prints: ${e.prints}`, "  "),
    ...wrap(`Exit codes: ${e.exits} (the full table: superstables --help)`, "  "),
  ];
  command.addHelpText("after", lines.join("\n"));
  return command;
}

/** Greedy word wrap; continuation lines take `indent`. */
export function wrap(text: string, indent: string, width = WIDTH): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > width) {
      out.push(line);
      line = indent + word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

export const EXIT_CODE_TABLE = `Exit codes (the same numbers as \`superstables budget\`):
  0  done: printed what was asked; for pay, the payment settled (chain: verified, or unchecked until checked
     again) and the service answered
  1  failed: nothing was paid. Includes an approval that expired or was abandoned, and a service or
     wallet that could not be reached
  2  bad input: unknown command or flag, a missing or wrong parameter, an unknown id, or a quote
     that is used or expired. Nothing was done
  3  refused: the owner rejected the payment, or a spend policy refused it. Nothing was paid
  4  paid, not delivered: the payment settled (verified or unchecked) but the service answered with an error,
     or its answer did not arrive in full. Do not pay again
  5  unknown: the payment may or may not have settled. Do not pay again until you have checked
     \`superstables receipts\` and the payer's account on the explorer`;

export const MAIN_HELP = `
What this is:
  A client for paying per request with test USDC (pathUSD on Tempo): find a paid service, quote
  it, and pay it.
  The agent can ask for a payment but cannot approve one.

Two ways to pay:
  pay      The owner approves each payment in their own wallet: a browser wallet such as MetaMask
           (Phantom on Solana) on a page \`pay\` serves on 127.0.0.1 (the default), or the local
           wallet process (--wallet local, EVM chains only). x402 on the EVM chains below and
           Solana devnet, MPP on Tempo Moderato. Use it when the owner is there to approve.
  budget   The owner grants an on-chain budget once, from their wallet; the agent then buys on its
           own until the budget is spent, expires or is revoked. The chain enforces the limit.
           Rails: evm (Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base
           Sepolia, Ethereum Sepolia), tempo (Tempo Moderato), solana (Solana devnet). Use it when
           the agent should buy without asking each time.

Start here, pay:
  superstables setup                                   owner, once: home directory and policy (pay only)
  superstables doctor                                  check what a payment needs
  superstables find "btc price"                        what can be bought, and the commands to pay it
  superstables quote --service <id> --param k=v        the price and the policy checks; nothing is signed
  superstables pay <quote-id>                          prints an approval link; the owner approves in their wallet
  superstables status <attempt-id>                     where a payment got to

Start here, budget: superstables budget setup --rail evm
  \`superstables setup\` is for pay only. Budgets are a separate tool; each subcommand takes --help.
  An owner command prints an approval link: an agent may start it and hand it to the owner,
  but only the owner approves, in their own wallet. Typical evm order: setup, fund-agent, doctor,
  grant, then buy.
    setup       owner  connect the owner's wallet (a free signature) and create the agent key
    fund-agent  owner  send the agent gas (evm) or fee SOL (solana)
    doctor             keys, addresses, RPC and balances; says what to top up
    preflight          a seller's price and address; signs nothing
    status             the budget left, its expiry, whether it is revoked; reads the chain
    grant       owner  grant the budget: an amount, and on tempo an expiry, period and sellers
    buy         agent  one purchase under the budget (--max is required)
    reconcile          read the chain for one purchase whose outcome is unknown
    revoke      owner  end the budget on chain
    recover     owner  evm: stop the allowance and return stranded funds to the owner
    wait               wait for an owner approval an agent started (--id)

Who runs what:
  owner   setup, wallet init, wallet serve, policy init, and every approval
  agent   find, quote, pay, status, receipts, attempts, doctor
  Either may run the read-only commands.

Where state lives:
  SUPERSTABLES_HOME, default ~/.superstables (--home <dir> for one command): policy.yaml,
  records/ (quotes, attempts, receipts, approvals), wallet/ (--wallet local only), keys/budget/
  and budget/ (budget only).

Discovery:
  find reads a built-in catalogue and the public index at ${DEFAULT_INDEX_URL}.
  SUPERSTABLES_INDEX_URL points it at another index with the same API (a self-hosted one), or
  switches it off with \`off\`. Index listings show their payment protocols (rails) and chains, and
  whether pay or a budget rail could pay them. Only testnets are ever payable.

Environment:
  SUPERSTABLES_HOME              where state lives (default ~/.superstables)
  SUPERSTABLES_WALLET            browser (default) or local: who signs pay's payments
  SUPERSTABLES_POLICY            the spend policy file (default $SUPERSTABLES_HOME/policy.yaml)
  SUPERSTABLES_INDEX_URL         the index find reads; \`off\` to skip it
  SUPERSTABLES_DEMO_SERVICES     on: also list Superstables' testnet services from the hosted catalogue
                                 (most are simulated; the market data service returns live prices)
  SUPERSTABLES_CATALOGUE_URL     where those services are listed; \`off\` to skip it
  SUPERSTABLES_DEMO_SERVICE_URL  another instance of the demo market-data service
  SUPERSTABLES_RPC_URL           the Base Sepolia RPC for balances, the network MetaMask adds, and the chain
                                 check on a settlement (https, or http on this machine)
  SUPERSTABLES_TEMPO_RPC         the Tempo Moderato RPC for pay's chain checks (https, or http on this machine)
  SUPERSTABLES_SOLANA_RPC        the Solana devnet RPC for pay's chain checks (https, or http on this machine)
  SUPERSTABLES_APPROVE_PORT      a fixed port for pay's approval page; unset, ${DEFAULT_APPROVE_PORT} or a free one when busy
  SUPERSTABLES_WALLET_URL        where the local wallet listens (default http://127.0.0.1:${DEFAULT_WALLET_PORT})
  SUPERSTABLES_DOCTOR_OFFLINE    1: doctor skips the network checks
  SUPERSTABLES_DEMO_PAY_TO       where demo-service's earnings go

Output:
  find, quote, pay, status, receipts and attempts take --json: one JSON value on stdout, progress
  and notes on stderr. An error under --json is {"error", "exit_code"} on stdout.

${EXIT_CODE_TABLE}
`;
