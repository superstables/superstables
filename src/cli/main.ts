#!/usr/bin/env node
// The `superstables` command. One binary for the three people in this story: the owner who
// sets the machine up and approves payments, the developer who wants to see a payment happen
// from a terminal, and the agent that runs `superstables mcp` and talks JSON-RPC over stdio.
//
// Every command prints facts, one per line, and refuses in one sentence. No command ever
// signs anything: `pay` asks the owner's wallet and reports what the owner decided, which is
// why it can end with "denied" and still be a command that worked.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isAddress } from "../core/chain.js";
import { findServices, getService } from "../core/discovery.js";
import {
  DEFAULT_DEMO_SERVICE_PORT,
  DEFAULT_WALLET_PORT,
  ensureDir,
  homeDir,
  policyPath,
  recordsDir,
  walletDir,
} from "../core/home.js";
import { PaymentEngine } from "../core/pay.js";
import { POLICY_EXAMPLE, loadPolicy, type Policy } from "../core/policy.js";
import { getQuote, quote as takeQuote } from "../core/quote.js";
import { Records } from "../core/records.js";
import type { Signer } from "../core/signer/types.js";
import { walletStatus } from "../core/signer/wallet.js";
import type { Attempt, Quote, ServiceListing, WalletStatus } from "../core/types.js";
import { clientVersion } from "../core/version.js";
import { startDemoService } from "../demo-service/server.js";
import { runStdioServer, signerFor, walletModeFromEnvironment, type WalletMode } from "../mcp/main.js";
import { messageFor } from "../mcp/server.js";
import { policySummary, startWallet } from "../wallet/daemon.js";
import { initKey, keyExists, keyPath, loadAccount } from "../wallet/keystore.js";
import { formatReport, runDoctor } from "./doctor.js";
import { field, json, money, table, yesNo } from "./format.js";

const NO_GAS_LINE = "no ETH is needed, facilitators pay the gas.";
const FAUCET_LINE = `Fund it with test USDC on Base Sepolia at https://faucet.circle.com; ${NO_GAS_LINE}`;

const program = new Command();

program
  .name("superstables")
  // `superstables --version` is the shortest answer to "which build is this?", and the one a
  // person reaches for when a machine has been installed over more than once.
  .version(clientVersion(), "-V, --version", "print the version of this client and exit")
  .description(
    "Discover paid services, quote them, and pay them with test USDC from a wallet you control. " +
      "Base Sepolia testnet only: no real money moves.",
  )
  .option("--home <dir>", "where this client keeps its state (default: SUPERSTABLES_HOME or ~/.superstables)")
  .addOption(
    new Option(
      "--wallet <mode>",
      "who signs: a browser wallet on an approval page this command serves, or the local wallet process",
    )
      .choices(["browser", "local"])
      .env("SUPERSTABLES_WALLET"),
  )
  .enablePositionalOptions()
  // --home and --wallet have to win before anything reads a path or builds a signer, so they
  // are applied to the environment before any action runs.
  .hook("preAction", (thisCommand) => {
    const home = thisCommand.opts().home as string | undefined;
    if (home) process.env.SUPERSTABLES_HOME = resolve(home);
    const wallet = thisCommand.opts().wallet as WalletMode | undefined;
    if (wallet) process.env.SUPERSTABLES_WALLET = wallet;
  });

// ── setup ────────────────────────────────────────────────────────────────────────────────

program
  .command("setup")
  .description("create the home directory and the policy file, then say what to do next")
  .action(() => {
    const mode = walletModeFromEnvironment();
    ensureDir(homeDir());
    ensureDir(recordsDir());
    const wrotePolicy = writeIfAbsent(policyPath(), POLICY_EXAMPLE);

    console.log("Superstables is ready on this machine.");
    console.log("");
    console.log(field("home", homeDir()));
    console.log(field("policy", `${policyPath()}${wrotePolicy ? " (written)" : " (already there)"}`));

    if (mode === "browser") {
      console.log(field("signing", "MetaMask, on an approval page this client serves on 127.0.0.1"));
      console.log("");
      console.log("There is nothing else to start. When an agent asks to pay, it prints a link:");
      console.log("  1. Install MetaMask in your browser: https://metamask.io/download");
      console.log("  2. Open the link the agent gives you and press Connect wallet.");
      console.log("  3. Add or switch to the Base Sepolia network when MetaMask asks.");
      console.log("  4. Check the amount and the recipient on the page, then approve in MetaMask.");
      console.log("");
      console.log(`Fund that MetaMask account with test USDC on Base Sepolia at https://faucet.circle.com; ${NO_GAS_LINE}`);
      console.log("");
      console.log("To use the local wallet process instead, run any command with `--wallet local`.");
    } else {
      ensureDir(walletDir());
      const createdKey = !keyExists(walletDir());
      if (createdKey) initKey({ dir: walletDir() });
      console.log(field("wallet key", `${keyPath(walletDir())}${createdKey ? " (created)" : " (already there)"}`));
      console.log(field("address", loadAccount(walletDir()).address));
      console.log("");
      console.log(FAUCET_LINE);
      console.log("");
      console.log("Then start the wallet, which asks you to approve every payment:");
      console.log("  superstables wallet serve");
    }
    console.log("");
    console.log("Claude Code:");
    console.log(`  claude mcp add superstables -e SUPERSTABLES_DEMO_SERVICES=on -- node ${mcpEntryPath()}`);
    console.log("  The switch adds Superstables' prepared demo services, whose answers are simulated;");
    console.log("  leave it out to see only real sellers.");
    console.log("");
    console.log("Claude Desktop:");
    console.log("  Settings → Extensions → Advanced → Install Extension… and choose the .mcpb file");
    console.log("  built by `npm run bundle`. The bundle has the demo services switch on.");
  });

// ── wallet ───────────────────────────────────────────────────────────────────────────────

const wallet = program.command("wallet").description("the owner's wallet: the only thing here that holds a key");

wallet
  .command("init")
  .description("create this machine's wallet key, or import one")
  .option("--import-key <0xhex>", "import a private key instead of generating one")
  .option("--import-key-file <path>", "import a private key from a file")
  .option("--force", "replace an existing key (the old key cannot be recovered)")
  .action((options: { importKey?: string; importKeyFile?: string; force?: boolean }) => {
    if (options.importKey && options.importKeyFile) {
      throw new Error("Give either --import-key or --import-key-file, not both.");
    }
    const importKey = options.importKeyFile ? readKeyFile(options.importKeyFile) : options.importKey;
    const result = initKey({ dir: walletDir(), importKey, force: options.force });
    console.log(result.created ? "A new wallet key was generated." : "The wallet key was imported.");
    console.log(field("address", result.address));
    console.log(field("key file", keyPath(walletDir())));
    console.log("");
    console.log(FAUCET_LINE);
  });

wallet
  .command("serve")
  .description("run the wallet: it asks you to approve every payment, in a browser page")
  .option("--port <n>", `port to listen on (default ${DEFAULT_WALLET_PORT})`, toInteger)
  .option("--approval-timeout <seconds>", "how long a request waits for you before it expires", toNumber)
  .option("--no-open", "do not open the approval page in a browser")
  .action(async (options: { port?: number; approvalTimeout?: number; open: boolean }) => {
    const handle = await startWallet({
      port: options.port,
      approvalTimeoutMs: options.approvalTimeout === undefined ? undefined : options.approvalTimeout * 1000,
      openBrowser: options.open,
    });
    console.log("");
    console.log("Leave this running. Press Ctrl-C to stop.");
    await untilStopped(() => handle.close());
  });

wallet
  .command("status")
  .description("ask the running wallet what it is doing")
  .option("--json", "print the wallet's answer as JSON")
  .action(async (options: { json?: boolean }) => {
    const status = await walletStatus().catch(() => undefined);
    if (!status) {
      throw new Error("The wallet is not answering; start it with `superstables wallet serve`.");
    }
    if (options.json) {
      console.log(json(status));
      return;
    }
    console.log(field("address", status.address));
    console.log(field("network", status.networkLabel));
    console.log(field("balance", status.balanceDecimal === undefined ? "unknown" : money(status.balanceDecimal, status.asset)));
    console.log(field("approval", status.approvalMode));
    console.log(field("pending", status.pending));
    const caps = [
      status.policy.perCall ? `up to ${status.policy.perCall} per payment` : undefined,
      status.policy.perDay ? `${status.policy.perDay} per day` : undefined,
      status.policy.allow.length ? `only ${status.policy.allow.join(", ")}` : undefined,
      status.policy.deny.length ? `never ${status.policy.deny.join(", ")}` : undefined,
    ].filter(Boolean);
    console.log(field("policy", status.policy.killSwitch ? "kill switch on: every payment is refused" : caps.join(", ") || "no caps set"));
  });

wallet
  .command("address")
  .description("the address that pays, from this machine's wallet key")
  .action(() => {
    console.log(loadAccount(walletDir()).address);
  });

// ── mcp ──────────────────────────────────────────────────────────────────────────────────

program
  .command("mcp")
  .description("run the MCP server on stdio, for Claude Code and Claude Desktop")
  .action(async () => {
    await runStdioServer();
  });

// ── find ─────────────────────────────────────────────────────────────────────────────────

program
  .command("find")
  .description("search for services that can be paid for per request")
  .argument("[query]", "what to look for, in plain words")
  .option("--limit <n>", "how many services to show", toInteger, 20)
  .option("--all", "also show services this client cannot pay, and why")
  .option("--demo", "include the simulated demo services from the hosted catalogue (SUPERSTABLES_DEMO_SERVICES=on does the same)")
  .option("--json", "print the raw listings")
  .action(async (query: string | undefined, options: { limit: number; all?: boolean; json?: boolean; demo?: boolean }) => {
    const found = await findServices({ query, limit: options.limit, probe: true, ...(options.demo ? { demoServices: true } : {}) });
    const services = options.all ? found.services : found.services.filter((s) => s.actionable);
    if (options.json) {
      console.log(json({ services, warnings: found.warnings }));
      return;
    }
    if (services.length === 0) {
      console.log(
        options.all
          ? "Nothing matched."
          : "No service this client can pay matched. Try --all to see what else is listed.",
      );
    } else {
      console.log(
        table(
          ["id", "name", "price", "network", "live", "simulated", "payable"],
          services.map((service) => [
            service.id,
            service.name,
            service.payment.price?.display ?? "ask for a quote",
            service.payment.networkLabel,
            yesNo(service.live),
            service.mock ? "yes" : "no",
            payable(service),
          ]),
        ),
      );
    }
    for (const warning of found.warnings) console.log(`note: ${warning}`);
  });

// ── quote ────────────────────────────────────────────────────────────────────────────────

program
  .command("quote")
  .description("ask a paid endpoint what one call costs; nothing is paid and nothing is signed")
  .argument("[url]", "a paid URL to quote directly")
  .option("--service <id>", "quote a service found by `superstables find`")
  .option("--param <key=value>", "a request parameter for the service (repeatable)", collect, [] as string[])
  .option("--json", "print the quote record")
  .action(async (url: string | undefined, options: { service?: string; param: string[]; json?: boolean }) => {
    if ((url && options.service) || (!url && !options.service)) {
      throw new Error("Give either a URL or --service <id>, not both and not neither.");
    }
    const { records, policy } = context();
    let taken: Quote;
    if (options.service) {
      const service = await getService(options.service);
      if (!service) throw new Error(`There is no service "${options.service}"; run \`superstables find\` first.`);
      taken = await takeQuote({ service, params: parseParams(options.param) }, { records, policy });
    } else {
      taken = await takeQuote({ url: url as string }, { records, policy });
    }
    if (options.json) {
      console.log(json(taken));
      return;
    }
    console.log(field("quote", taken.id));
    console.log(field("url", taken.url));
    if (taken.serviceName) console.log(field("service", taken.serviceName));
    console.log(field("price", money(taken.terms.amountDecimal, taken.terms.asset)));
    console.log(field("network", taken.terms.networkLabel));
    console.log(field("recipient", taken.terms.recipient));
    console.log(field("expires", taken.expiresAt));
    console.log(
      field("policy", taken.policy.allowed ? "allowed by the local policy" : `refused: ${taken.policy.reason}`),
    );
    console.log("");
    console.log(
      taken.policy.allowed
        ? `Nothing has been paid. Run \`superstables pay ${taken.id}\` to ask the wallet's owner to approve it.`
        : "Nothing has been paid, and the local policy refuses this payment; edit policy.yaml if that is wrong.",
    );
  });

// ── pay ──────────────────────────────────────────────────────────────────────────────────

program
  .command("pay")
  .description("ask the owner to approve a quote, and pay it if they do")
  .argument("<quote-id>", "the quote to pay")
  .option("--wait <seconds>", "how long to wait for the owner", toNumber)
  .action(async (quoteId: string, options: { wait?: number }) => {
    const { records, engine, signer } = context();
    let linkShown = false;
    // Subscribe first: the first transition is emitted inside startPayment().
    engine.events.on("transition", (attempt: Attempt) => {
      if (attempt.quoteId !== quoteId) return;
      console.log(`  ${attempt.state}${lastNote(attempt)}`);
      // The link is the approval in browser mode: print it once, on its own line, unmissable.
      if (attempt.approvalUrl && !linkShown) {
        linkShown = true;
        console.log("");
        console.log("Open this link and approve the payment in your browser wallet:");
        console.log(`  ${attempt.approvalUrl}`);
        console.log("");
      }
    });
    const started = engine.startPayment(quoteId);
    console.log(`Paying quote ${quoteId} (attempt ${started.id}).`);
    const attempt = await engine.waitForAttempt(
      started.id,
      options.wait === undefined ? undefined : options.wait * 1000,
    );

    console.log("");
    console.log(messageFor(attempt, attempt.receiptId ? records.getReceipt(attempt.receiptId) : undefined));
    const receipt = attempt.receiptId ? records.getReceipt(attempt.receiptId) : undefined;
    if (receipt) {
      console.log("");
      console.log(field("receipt", receipt.id));
      console.log(field("paid", money(receipt.terms.amountDecimal, receipt.terms.asset)));
      console.log(field("transaction", receipt.transactionUrl || receipt.transaction));
      console.log(field("payer", receipt.payer));
      console.log(field("recipient", receipt.terms.recipient));
      console.log(field("service", `HTTP ${receipt.serviceStatus ?? "unknown"} (${receipt.serviceOutcome})`));
    }
    if (attempt.serviceBody) {
      console.log("");
      console.log(attempt.serviceBody);
    }
    // The browser signer listens on loopback for as long as it exists; let the command exit.
    await closeSigner(signer);
    if (attempt.state !== "settled") process.exitCode = 1;
  });

// ── status, receipts, attempts ───────────────────────────────────────────────────────────

program
  .command("status")
  .description("where a payment attempt got to")
  .argument("<attempt-id>", "the attempt to look up")
  .option("--json", "print the attempt record")
  .action((attemptId: string, options: { json?: boolean }) => {
    const { records } = context();
    const attempt = records.getAttempt(attemptId);
    if (!attempt) throw new Error(`There is no payment attempt ${attemptId} on this machine.`);
    if (options.json) {
      console.log(json(attempt));
      return;
    }
    const receipt = attempt.receiptId ? records.getReceipt(attempt.receiptId) : undefined;
    console.log(field("attempt", attempt.id));
    console.log(field("quote", attempt.quoteId));
    console.log(field("state", attempt.state));
    console.log(field("url", attempt.url));
    console.log(field("price", money(attempt.terms.amountDecimal, attempt.terms.asset)));
    if (receipt) console.log(field("transaction", receipt.transactionUrl || receipt.transaction));
    console.log("");
    console.log(messageFor(attempt, receipt));
  });

program
  .command("receipts")
  .description("the payments made from this machine, newest first")
  .option("--limit <n>", "how many to show", toInteger, 20)
  .option("--json", "print the receipt records")
  .action((options: { limit: number; json?: boolean }) => {
    const receipts = context().records.listReceipts(options.limit);
    if (options.json) {
      console.log(json(receipts));
      return;
    }
    if (receipts.length === 0) {
      console.log("No payment has been made from this machine yet.");
      return;
    }
    console.log(
      table(
        ["when", "amount", "service", "outcome", "transaction"],
        receipts.map((receipt) => [
          receipt.at,
          money(receipt.terms.amountDecimal, receipt.terms.asset),
          receipt.serviceName ?? receipt.url,
          receipt.serviceOutcome,
          receipt.transaction || "(pending)",
        ]),
      ),
    );
  });

program
  .command("attempts")
  .description("every payment attempt, paid or not, newest first")
  .option("--limit <n>", "how many to show", toInteger, 20)
  .option("--json", "print the attempt records")
  .action((options: { limit: number; json?: boolean }) => {
    const attempts = context().records.listAttempts(options.limit);
    if (options.json) {
      console.log(json(attempts));
      return;
    }
    if (attempts.length === 0) {
      console.log("No payment has been attempted from this machine yet.");
      return;
    }
    console.log(
      table(
        ["when", "attempt", "state", "amount", "service"],
        attempts.map((attempt) => [
          attempt.createdAt,
          attempt.id,
          attempt.state,
          money(attempt.terms.amountDecimal, attempt.terms.asset),
          attempt.serviceName ?? attempt.url,
        ]),
      ),
    );
  });

// ── demo-service ─────────────────────────────────────────────────────────────────────────

program
  .command("demo-service")
  .description("run the demo paid service, so there is something to buy on this machine")
  .option("--port <n>", `port to listen on (default ${DEFAULT_DEMO_SERVICE_PORT})`, toInteger)
  .option("--pay-to <0x>", "where the money goes (default: SUPERSTABLES_DEMO_PAY_TO)")
  .option("--price <decimal>", "price per call in USDC", toNumber)
  .action(async (options: { port?: number; payTo?: string; price?: number }) => {
    let payTo = options.payTo ?? process.env.SUPERSTABLES_DEMO_PAY_TO;
    let throwaway = false;
    if (!payTo) {
      payTo = privateKeyToAccount(generatePrivateKey()).address;
      throwaway = true;
    }
    if (!isAddress(payTo)) throw new Error(`"${payTo}" is not an address; --pay-to takes a 0x-prefixed address.`);
    if (throwaway) {
      console.log(`No recipient was given, so this run pays to a throwaway address: ${payTo}`);
      console.log("Nobody holds its key, so any test USDC paid to it is gone for good.");
      console.log("Set SUPERSTABLES_DEMO_PAY_TO or pass --pay-to to keep what the service earns.");
      console.log("");
    }
    const service = await startDemoService({ port: options.port, payTo, priceDecimal: options.price });
    console.log("Leave this running. Press Ctrl-C to stop.");
    await untilStopped(() => service.close());
  });

// ── budget ───────────────────────────────────────────────────────────────────────────────

// budget/ is its own program with its own flags, exit codes and RESULT line, so everything
// after `budget` goes to it untouched, --help included.
program
  .command("budget")
  .description("on-chain agent budgets on testnets: grant once, the agent buys, revoke")
  .helpOption(false)
  .allowUnknownOption()
  .allowExcessArguments()
  .passThroughOptions()
  .argument("[args...]")
  .action((args: string[]) => {
    const cli = fileURLToPath(new URL("../../budget/cli.mjs", import.meta.url));
    if (!existsSync(cli)) {
      throw new Error("superstables budget runs from a checkout of the client repo for now; this install has no budget/cli.mjs.");
    }
    const run = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
    process.exitCode = run.status ?? 1;
  });

// ── doctor ───────────────────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("check everything a payment needs, one line at a time")
  .option("--json", "print the checks as JSON")
  .action(async (options: { json?: boolean }) => {
    const report = await runDoctor(walletModeFromEnvironment());
    console.log(options.json ? json(report) : formatReport(report));
    if (!report.ok) process.exitCode = 1;
  });

// ── policy ───────────────────────────────────────────────────────────────────────────────

const policy = program.command("policy").description("the spend policy this client and the wallet both apply");

policy
  .command("show")
  .description("print the policy in force")
  .option("--json", "print the parsed policy")
  .action((options: { json?: boolean }) => {
    const parsed = loadPolicy(policyPath());
    if (options.json) {
      console.log(json(parsed));
      return;
    }
    console.log(field("file", existsSync(policyPath()) ? policyPath() : `${policyPath()} (missing: defaults apply)`));
    console.log(field("in force", policySummary(parsed)));
    if (existsSync(policyPath())) {
      console.log("");
      console.log(readFileSync(policyPath(), "utf8").trimEnd());
    }
  });

policy
  .command("init")
  .description("write a commented policy.yaml, if there is not one already")
  .addOption(new Option("--force", "overwrite the existing policy file"))
  .action((options: { force?: boolean }) => {
    ensureDir(homeDir());
    if (existsSync(policyPath()) && !options.force) {
      throw new Error(`There is already a policy at ${policyPath()}; pass --force to overwrite it.`);
    }
    writeFileSync(policyPath(), POLICY_EXAMPLE, { mode: 0o600 });
    console.log(`Wrote ${policyPath()}.`);
    console.log(field("in force", policySummary(loadPolicy(policyPath()))));
  });

// ── Plumbing ─────────────────────────────────────────────────────────────────────────────

/** Everything a command needs to read and write this machine's state. Built after --home. */
function context(): {
  records: Records;
  policy: Policy;
  engine: PaymentEngine;
  signer: Signer & { status(): Promise<WalletStatus> };
} {
  const records = new Records(recordsDir());
  const parsed = loadPolicy(policyPath());
  const signer = signerFor();
  return { records, policy: parsed, engine: new PaymentEngine({ records, policy: parsed, signer }), signer };
}

/** A signer that binds a port has to give it back before the command exits. */
async function closeSigner(signer: Signer): Promise<void> {
  const closable = signer as Signer & { close?: () => Promise<void> };
  if (typeof closable.close === "function") await closable.close().catch(() => undefined);
}

/** Where `claude mcp add` should point. Absolute, because the client runs it from anywhere. */
function mcpEntryPath(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const beside = resolve(here, "../mcp/main.js");
  // Built: dist/cli/ -> dist/mcp/main.js. Run from source: fall back to where the build lands.
  return existsSync(beside) ? beside : resolve(here, "../../dist/mcp/main.js");
}

function payable(service: ServiceListing): string {
  if (service.actionable) return "yes";
  return service.notActionableReason ? `no (${service.notActionableReason})` : "no";
}

function lastNote(attempt: Attempt): string {
  const last = attempt.history[attempt.history.length - 1];
  const note = last?.note ?? attempt.reason;
  return note ? `: ${note}` : "";
}

function parseParams(pairs: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new Error(`--param takes key=value, not "${pair}".`);
    params[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return params;
}

function readKeyFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (err) {
    throw new Error(`Could not read the key file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeIfAbsent(path: string, contents: string): boolean {
  if (existsSync(path)) return false;
  writeFileSync(path, contents, { mode: 0o600 });
  return true;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function toInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`"${value}" is not a whole number.`);
  return parsed;
}

function toNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`"${value}" is not a number.`);
  return parsed;
}

/** Run until the terminal says stop, then close cleanly. Used by the two long-lived commands. */
function untilStopped(close: () => Promise<void>): Promise<void> {
  return new Promise<void>((done) => {
    const stop = () => {
      console.log("");
      void close().then(done, done);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // One sentence, on stderr, and a non-zero exit. Never a stack trace: these are not bugs,
  // they are answers — a quote that expired, a wallet that is not running, a typo in a flag.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
