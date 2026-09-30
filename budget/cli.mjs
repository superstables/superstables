#!/usr/bin/env node
// superstables budget: one command for the budget rails. A thin dispatcher over the rail scripts in evm/, tempo/
// and solana/. It validates input, spawns the rail script, and prints one normalized `RESULT {...}` line last on
// stdout. Logs go to stderr. Contract: CLI.md. Testnet only.
// Owner commands on evm (setup, fund-agent, grant, revoke, and the owner's part of recover) never sign here: the rail opens a
// page on 127.0.0.1 where the owner approves in their own wallet, and this dispatcher passes the link on as one stdout line,
// `APPROVE {"action","url","expires","terms"}`, as soon as it exists. The owner key file is a test and automation option only
// (--owner-key-file PATH --yes).
// Detached owner approvals (approvals.mjs): when stdout is not a terminal (an agent's shell tool, which shows output only
// when the command exits), or with --detach, an evm owner command starts itself again in the background, returns as soon
// as the link exists with `state: "waiting_owner"` and an approval id, and the caller polls `superstables budget wait --id`.
// In a terminal, or with --wait, it blocks as before. One owner approval at a time per rail and chain.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { approvalsDir, opsDir } from "./paths.mjs";
import { WORKER_ENV, claim, findPending, forget, isApprovalId, logFile, pageWords, readApproval, recordFinal, recordLink, replacePending, startDetached, waitFor, workerDeadlineMs, newApprovalId } from "./approvals.mjs";
import { EVM_CHAINS, EVM_CHAIN_KEYS, EVM_DEFAULT_CHAIN } from "./evm/chains.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
// The rails run on the client repo's own install: its tsx and its node_modules.
const REPO = join(ROOT, "..");
const TSX = join(REPO, "node_modules", ".bin", "tsx");

// ---- rails ------------------------------------------------------------------------------------------
const RAILS = {
  evm: { chains: EVM_CHAIN_KEYS, chain: EVM_DEFAULT_CHAIN, addr: /^0x[0-9a-fA-F]{40}$/, unit: "USDC" },
  tempo: { chains: ["moderato"], chain: "moderato", addr: /^0x[0-9a-fA-F]{40}$/, unit: "pathUSD" },
  solana: { chains: ["devnet"], chain: "devnet", addr: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, unit: "USDC" },
};

// ---- commands: flags ('v' takes a value, 'b' is a switch), required flags, help text ----------------
const OWNER_FLAGS = { timeout: "v", "no-open": "b", "owner-key-file": "v", wait: "b", detach: "b", replace: "b" };
const OWNER_HELP = "  evm: the owner approves in their own wallet on a page this command opens on 127.0.0.1 (link printed as an APPROVE line and on stderr).\n  --timeout SECONDS (default 600) is how long the link stays open.\n  Not in a terminal (an agent), or with --detach: returns at once with state waiting_owner and an approval id; the page waits in the\n  background. Then run superstables budget wait --id ID until the state is final. In a terminal, or with --wait: blocks, and opens the\n  link in the default browser unless --no-open. One owner approval at a time per chain: --replace drops a pending one the wallet has\n  not been asked to send.\n  Tests and automation only: --owner-key-file PATH --yes signs with that key file instead.";
const COMMANDS = {
  setup: {
    flags: { ...OWNER_FLAGS }, required: [],
    help: "superstables budget setup --rail evm [--chain C] [--timeout S] [--no-open]\n  Creates the agent key file if it is missing (never overwrites it), asks the owner to connect their own wallet and sign a free\n  sign-in message (no transaction), and writes the public file with both addresses. Prints the next steps.\n  Tests and automation only: --owner-key-file PATH records that key's address instead of asking the wallet.",
  },
  "fund-agent": {
    flags: { amount: "v", yes: "b", ...OWNER_FLAGS }, required: [],
    help: "superstables budget fund-agent --rail evm [--chain C] [--amount GAS]\n  Owner command. Sends the agent a little of the chain's gas token (default from the chain table) so it can pay for its pulls.\n" + OWNER_HELP,
  },
  doctor: {
    flags: { agent: "v" }, required: [],
    help: "superstables budget doctor --rail evm|tempo|solana [--chain C] [--agent LABEL]\n  Key files, public file, RPC and balances. Prints what to top up at which address. No transactions, no signatures.",
  },
  grant: {
    flags: { amount: "v", expiry: "v", period: "v", sellers: "v", yes: "b", agent: "v", ...OWNER_FLAGS }, required: ["amount"],
    help: "superstables budget grant --rail R --amount A [--expiry ISO] [--period SECONDS] [--sellers a,b] [--agent LABEL] [--yes]\n  Owner command. Prints the terms and what the chain enforces.\n" + OWNER_HELP + "\n  tempo and solana: sends only with --yes (they sign with the owner key file for now).\n  Refuses constraints the rail cannot enforce (evm and solana: no --expiry, --period, --sellers).\n  Tempo: --expiry defaults to 24h from now. --agent LABEL picks the access key (a revoked key can never be granted again).",
  },
  status: {
    flags: { agent: "v" }, required: [],
    help: "superstables budget status --rail R [--chain C] [--agent LABEL]\n  Remaining budget, expiry, revoked, funds at risk. Reads the chain only.",
  },
  buy: {
    flags: { url: "v", max: "v", "pay-to": "v", op: "v", method: "v", body: "v", agent: "v" }, required: ["url", "max"],
    help: "superstables budget buy --rail R --url U --max M [--pay-to ADDR] [--op ID] [--method GET|POST|...] [--body JSON] [--agent LABEL]\n  One purchase under the budget. --max is required. --op defaults to a generated id.\n  Exit 0 delivered, 1 failed, 3 refused before signing, 4 paid but not delivered, 5 unknown (superstables budget reconcile).",
  },
  reconcile: {
    flags: { op: "v" }, required: ["op"],
    help: "superstables budget reconcile --rail R --op ID [--chain C]\n  Reads the chain for one operation and reports its state. Never signs or sends.",
  },
  recover: {
    flags: { op: "v", yes: "b", ...OWNER_FLAGS }, required: [],
    help: "superstables budget recover --rail evm [--chain C] [--op ID]\n  EVM only. Stop the allowance first, then return stranded funds to the owner. Prints the plan, then runs it: the agent key signs\n  its own steps; the owner approves in their wallet only what the agent cannot do (the rest of the allowance, gas for the agent).\n" + OWNER_HELP,
  },
  wait: {
    flags: { id: "v", timeout: "v" }, required: ["id"],
    help: "superstables budget wait --id ID [--timeout S]\n  Waits up to S seconds (default 30, at most 300) for a detached owner approval and prints its state as a RESULT: still\n  waiting_owner (exit 0), or the final RESULT and exit code of the owner command, the same on every later call.\n  Never signs or sends anything.",
  },
  revoke: {
    flags: { yes: "b", agent: "v", ...OWNER_FLAGS }, required: [],
    help: "superstables budget revoke --rail R [--chain C] [--agent LABEL] [--yes]\n  Owner command. Ends the budget on chain. Prints the plan.\n" + OWNER_HELP + "\n  tempo and solana: sends only with --yes (they sign with the owner key file for now).",
  },
};
const TOP_HELP = `superstables budget: on-chain agent budgets on evm (${Object.values(EVM_CHAINS).map((c) => c.label).join(", ")}), tempo (Moderato) and solana (devnet). Testnet only.

Commands (each takes --help):
  superstables budget setup      --rail evm [--chain C]                                                    owner connects a wallet
  superstables budget fund-agent --rail evm [--amount GAS]                                                 owner
  superstables budget doctor     --rail R [--chain C]
  superstables budget status     --rail R
  superstables budget grant      --rail R --amount A [--expiry ISO] [--period S] [--sellers a,b]          owner
  superstables budget buy        --rail R --url U --max M [--pay-to ADDR] [--op ID]                         agent
  superstables budget reconcile  --rail R --op ID
  superstables budget revoke     --rail R                                                                  owner
  superstables budget recover    --rail evm [--op ID]                                                      owner and agent
  superstables budget wait       --id ID [--timeout S]                                                     after an owner command

Owner commands on evm open an approval page on 127.0.0.1: the owner approves in their own wallet. The link comes as a line
  APPROVE {"action","url","expires","terms"}
as soon as it exists (and on stderr). Not in a terminal (an agent), or with --detach, the command then returns at once:
  RESULT {"state":"waiting_owner","id","url","expires","terms","next"}
and superstables budget wait --id ID returns the state until it is final. In a terminal, or with --wait, it waits for the
owner, reads the chain, then prints its RESULT.
tempo and solana owner commands still sign with the owner key file, and send only with --yes.

stdout ends with: RESULT {"ok","command","rail","chain","op","state","paid","delivered","amount","remaining","tx","id","url","next"}
Exit: 0 done (or state waiting_owner: not done yet), 1 failed, 2 bad input, 3 refused before signing, 4 paid but not delivered,
5 unknown (superstables budget reconcile).`;

// ---- output -----------------------------------------------------------------------------------------
const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
const log = (...a) => process.stderr.write(a.join(" ") + "\n");

// A background worker for a detached owner approval (approvals.mjs) has its id in the environment.
const workerRecord = readApproval(process.env[WORKER_ENV]);
const WORKER_ID = workerRecord && !workerRecord.final ? workerRecord.id : undefined;

// One RESULT object, last line of stdout. Written synchronously so the process exits right after it.
// A worker also stores it (and the exit code) in its approval record, for every later `wait`.
function emit(code, fields) {
  const order = ["command", "rail", "chain", "op", "state", "paid", "delivered", "amount", "remaining", "tx", "expiry", "revoked", "atRisk", "owner", "agent", "id", "action", "url", "expires", "terms", "next", "reason"];
  if (WORKER_ID && fields.id === undefined) fields = { ...fields, id: WORKER_ID };
  const out = { ok: code === 0 };
  for (const k of order) if (fields[k] !== undefined) out[k] = k === "reason" ? clean(fields[k]) : fields[k];
  if (WORKER_ID) recordFinal(WORKER_ID, code, out);
  writeSync(1, "RESULT " + JSON.stringify(out) + "\n");
  process.exit(code);
}

function badInput(ctx, reason) {
  log(`superstables budget: ${reason}`);
  emit(2, { ...ctx, state: "failed", next: `fix the command; see superstables budget ${ctx.command ?? ""} --help`.replace("  ", " "), reason });
}
function refuse(ctx, reason, next = "respect the refusal; nothing was signed") {
  log(`superstables budget: refused: ${reason}`);
  emit(3, { ...ctx, state: "refused_precheck", paid: false, delivered: false, tx: {}, next, reason });
}

// ---- argument parsing and validation (nothing is spawned before this passes) ------------------------
function parse(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") { console.log(TOP_HELP); process.exit(0); }
  const spec = COMMANDS[cmd];
  if (!spec) return badInput({}, `unknown command "${cmd}". Commands: ${Object.keys(COMMANDS).join(", ")}`);
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) { console.log(spec.help); process.exit(0); }
  if (rest.includes("--mainnet")) return refuse({ command: cmd }, "mainnet is refused: superstables budget is testnet only");

  const allowed = { rail: "v", chain: "v", ...spec.flags };
  const f = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) return badInput({ command: cmd }, `unexpected argument "${a}"`);
    const [, name, inline] = m;
    if (!allowed[name]) return badInput({ command: cmd }, `unknown flag --${name} for superstables budget ${cmd}`);
    if (name in f) return badInput({ command: cmd }, `--${name} given twice`);
    if (allowed[name] === "b") { f[name] = true; continue; }
    const v = inline ?? rest[++i];
    if (v === undefined || (inline === undefined && v.startsWith("--"))) return badInput({ command: cmd }, `--${name} needs a value`);
    f[name] = v;
  }
  if (cmd === "wait") {
    const ctx = { command: cmd };
    if (f.id === undefined) return badInput(ctx, "missing required flag --id (the id an owner command printed)");
    if (!isApprovalId(f.id)) return badInput(ctx, `--id must be an approval id like oa-20260930120000-1a2b3c4d (got "${f.id}")`);
    if (f.timeout !== undefined && !(/^\d+$/.test(f.timeout) && Number(f.timeout) <= 300)) badInput(ctx, "--timeout must be a whole number of seconds from 0 to 300");
    return { cmd, f, ctx };
  }
  const ctx = { command: cmd, rail: f.rail };
  if (!f.rail) return badInput(ctx, "--rail is required (evm, tempo or solana)");
  const rail = RAILS[f.rail];
  if (!rail) return badInput(ctx, `--rail must be evm, tempo or solana (got "${f.rail}")`);
  if (f.chain !== undefined && !rail.chains.includes(f.chain)) {
    if (/mainnet|^(base|ethereum|eth|arc|tempo|solana|polygon|optimism|op|arbitrum|avalanche|monad|sei|celo|robinhood|skale-base|bsc)$|^\d+$|^eip155:/i.test(f.chain)) return refuse({ ...ctx, chain: f.chain }, `"${f.chain}" looks like a mainnet: superstables budget is testnet only`);
    return badInput(ctx, `--chain for ${f.rail} must be one of: ${rail.chains.join(", ")}`);
  }
  f.chain ??= rail.chain;
  ctx.chain = f.chain;
  for (const r of spec.required) if (f[r] === undefined) return badInput(ctx, `missing required flag --${r}`);

  const amount = (name) => {
    if (f[name] === undefined) return;
    if (!/^\d+(\.\d{1,6})?$/.test(f[name]) || !(Number(f[name]) > 0)) badInput(ctx, `--${name} must be a positive decimal with at most 6 places (got "${f[name]}")`);
  };
  amount("amount"); amount("max");
  if (f.url !== undefined) {
    let u; try { u = new URL(f.url); } catch { u = null; }
    if (!u || !/^https?:$/.test(u.protocol)) badInput(ctx, "--url must be an http(s) URL");
  }
  if (f.op !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(f.op)) badInput(ctx, "--op must be 1 to 64 characters: letters, digits, '.', '_' or '-'");
  if (f["pay-to"] !== undefined && !rail.addr.test(f["pay-to"])) badInput(ctx, `--pay-to is not a valid ${f.rail} address`);
  if (f.method !== undefined && !/^(GET|POST|PUT|PATCH|DELETE)$/.test(f.method.toUpperCase())) badInput(ctx, "--method must be GET, POST, PUT, PATCH or DELETE");
  if (f.agent !== undefined) {
    if (f.rail !== "tempo") badInput(ctx, "--agent is for tempo only (it picks the access key)");
    if (!/^[A-Za-z0-9]{1,32}$/.test(f.agent)) badInput(ctx, "--agent must be 1 to 32 letters or digits");
  }
  if (f.period !== undefined && !/^[1-9]\d*$/.test(f.period)) badInput(ctx, "--period must be a whole number of seconds");
  if (f.sellers !== undefined && !f.sellers.split(",").every((s) => rail.addr.test(s))) badInput(ctx, `--sellers must be a comma list of ${f.rail} addresses`);
  if (f.expiry !== undefined && !(Date.parse(f.expiry) > Date.now())) badInput(ctx, "--expiry must be an ISO date in the future (for example 2026-10-01T12:00:00Z)");
  if (cmd === "grant" && f.rail === "solana") {
    for (const k of ["expiry", "period", "sellers"]) if (f[k] !== undefined) badInput(ctx, `solana cannot enforce --${k} on chain: revoke by your deadline, and any seller can be paid`);
  }
  if (cmd === "grant" && f.rail === "evm") {
    for (const k of ["expiry", "period", "sellers"]) if (f[k] !== undefined) badInput(ctx, `evm cannot enforce --${k} on chain (a plain approve has a total cap only): revoke by your deadline`);
  }
  if (cmd === "buy" && f.rail === "evm") {
    for (const k of ["method", "body"]) if (f[k] !== undefined && !(k === "method" && f.method.toUpperCase() === "GET")) badInput(ctx, `evm buy is GET only (no --${k})`);
  }
  if (cmd === "recover" && f.rail !== "evm") badInput(ctx, "recover is EVM only (tempo and solana have no stranded funds: the agent never holds the budget)");
  if ((cmd === "setup" || cmd === "fund-agent") && f.rail !== "evm") badInput(ctx, `${cmd} is evm only for now: tempo uses npx tsx budget/tempo/setup.ts, solana node budget/solana/generate-keys.mjs and node budget/solana/fund.mjs`);
  if (cmd === "fund-agent" && f.amount !== undefined && !/^\d+(\.\d{1,18})?$/.test(f.amount)) badInput(ctx, "--amount must be a decimal amount of the chain's gas token");
  if (f.timeout !== undefined && !(/^\d+$/.test(f.timeout) && Number(f.timeout) >= 10 && Number(f.timeout) <= 3600)) badInput(ctx, "--timeout must be a whole number of seconds from 10 to 3600");
  const ownerFlagUsed = ["owner-key-file", "timeout", "no-open", "wait", "detach", "replace"].find((k) => f[k] !== undefined);
  if (ownerFlagUsed && f.rail !== "evm") badInput(ctx, `--${ownerFlagUsed} is for the evm rail: tempo and solana owner commands still sign with their owner key file (--yes)`);
  if (f.rail === "evm" && f.yes && !f["owner-key-file"]) badInput(ctx, "on evm the owner approves in their own wallet: drop --yes. --yes only goes with --owner-key-file PATH (tests and automation)");
  if (f["owner-key-file"] !== undefined && !existsSync(f["owner-key-file"])) badInput(ctx, `--owner-key-file ${f["owner-key-file"]} does not exist`);
  if (f.wait && f.detach) badInput(ctx, "--wait and --detach cannot go together");
  const pageOnly = ["detach", "replace"].find((k) => f[k]);
  if (pageOnly && f["owner-key-file"] !== undefined) badInput(ctx, `--${pageOnly} is for the owner's approval page; with --owner-key-file there is no page`);
  return { cmd, f, ctx };
}

// ---- rail command lines: the only place that knows script names and flags ---------------------------
const tsx = (dir, script, args) => ({ cwd: join(ROOT, dir), cmd: TSX, args: [script, ...args] });
const mjs = (dir, script, args) => ({ cwd: join(ROOT, dir), cmd: process.execPath, args: [script, ...args] });
const opt = (name, v) => (v === undefined ? [] : [`--${name}`, v]);
/** The owner flags every evm owner script takes: how long the link stays open, whether to open a browser, the test key file. */
const ownerOpts = (f) => [...opt("timeout", f.timeout), ...(f["no-open"] ? ["--no-open"] : []), ...opt("owner-key-file", f["owner-key-file"])];

function railCommand(verb, f, extra = {}) {
  const agent = opt("agent", f.agent);
  if (f.rail === "tempo") {
    const T = (s, a) => tsx("tempo", `${s}.ts`, a);
    switch (verb) {
      case "buy": return T("buy", ["--url", f.url, "--max", f.max, "--op", f.op, ...opt("pay-to", f["pay-to"]), ...opt("method", f.method), ...opt("body", f.body), ...agent]);
      case "reconcile": return T("reconcile", ["--op", f.op]);
      case "read": return T("readBudget", agent);
      case "grant": return T("setBudget", ["--amount", f.amount, "--expiry-seconds", String(extra.expirySeconds), ...opt("period-seconds", f.period), ...opt("sellers", f.sellers), ...agent]);
      case "revoke": return T("revokeBudget", agent);
    }
  }
  if (f.rail === "solana") {
    const S = (s, a) => mjs("solana", `${s}.mjs`, a);
    switch (verb) {
      case "buy": return S("buy", ["--url", f.url, "--max", f.max, "--op", f.op, ...opt("pay-to", f["pay-to"]), ...opt("method", f.method), ...opt("body", f.body)]);
      case "reconcile": return S("reconcile", ["--op", f.op]);
      case "read": return S("readBudget", []);
      case "grant": return S("setBudget", ["--amount", f.amount]);
      case "revoke": return S("revokeBudget", []);
    }
  }
  return evmCommand(verb, f, extra);
}

// ---- EVM dispatch: flags mapped from `npx tsx budget/evm/<script>.ts --help`. The evm scripts end with a RESULT line of their own.
function evmCommand(verb, f, extra = {}) {
  const E = (script, args) => tsx("evm", `${script}.ts`, [...args, "--chain", f.chain]);
  switch (verb) {
    case "buy": return E("buy", ["--url", f.url, "--max", f.max, "--op", f.op, ...opt("pay-to", f["pay-to"])]); // GET only
    case "reconcile": return E("reconcile", ["--op", f.op]);
    case "read": return E("read", []);
    case "grant": return E("setBudget", ["--cap", f.amount, ...ownerOpts(f)]);
    case "revoke": return E("revoke", ownerOpts(f));
    case "recover": return E("recover", [...opt("op", f.op), ...(extra.plan ? ["--plan"] : ownerOpts(f))]);
    case "setup": return E("setup", ownerOpts(f));
    case "fund-agent": return E("fundAgent", [...opt("amount", f.amount), ...ownerOpts(f)]);
  }
}
const evmReadFromResult = (r) => ({ ok: true, remaining: r.allowance ?? null, expiry: r.expiry ?? null, revoked: r.revoked === true, atRisk: r.maxMovable ?? null });
// ---- end of EVM section -----------------------------------------------------------------------------

// ---- running a rail script --------------------------------------------------------------------------
// Rail logs are forwarded to stderr as they arrive. Returns { code, stdout } (stdout is kept to find RESULT).
// An `APPROVE {...}` line from an evm owner script is passed on to this process's stdout at once: it carries the link the
// owner opens, and the command then waits for the owner.
let approvalUrl;
function passApproval(line) {
  if (!/^APPROVE \{/.test(line)) return;
  let approve;
  try { approve = JSON.parse(line.slice(8)); } catch { return; }
  approvalUrl = approve.url;
  if (WORKER_ID) recordLink(WORKER_ID, approve);
  writeSync(1, line + "\n");
}
let currentChild;
function run(spec) {
  return new Promise((resolve) => {
    if (!existsSync(TSX)) { log(`superstables budget: dependencies are missing: run npm ci at the repo root (${REPO})`); return resolve({ code: 2, stdout: "", missing: true }); }
    const p = spawn(spec.cmd, spec.args, { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    currentChild = p;
    let stdout = "";
    let partial = "";
    p.stdout.on("data", (d) => {
      stdout += d;
      process.stderr.write(d);
      const lines = (partial + d).split("\n");
      partial = lines.pop();
      for (const l of lines) passApproval(l);
    });
    p.stderr.on("data", (d) => process.stderr.write(d));
    for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => p.kill(s));
    p.on("error", (e) => { log(`superstables budget: could not start ${spec.cmd}: ${e.message}`); resolve({ code: 2, stdout }); });
    p.on("close", (code, sig) => resolve({ code: code ?? (sig ? 130 : 1), stdout }));
  });
}
const railResult = (stdout) => {
  const line = stdout.split("\n").reverse().find((l) => /^RESULT \{/.test(l));
  try { return line ? JSON.parse(line.slice(7)) : null; } catch { return null; }
};

// ---- helpers for amounts and reads ------------------------------------------------------------------
const micro = (s) => { const [i, d = ""] = s.split("."); return BigInt(i) * 1000000n + BigInt(d.padEnd(6, "0")); };
const decimal = (n) => { const s = n.toString().padStart(7, "0"); return (s.slice(0, -6) + "." + s.slice(-6)).replace(/\.?0+$/, "") || "0"; };
const ago = (iso) => (iso ? iso : "none");
// The budget token's symbol: per chain on evm (chains.mjs), per rail elsewhere.
const unitOf = (f) => (f.rail === "evm" ? EVM_CHAINS[f.chain].token.symbol : RAILS[f.rail].unit);

// Reads the budget through the rail's read script (no key file, no signature) and parses its text.
async function readBudget(f) {
  const r = await run(railCommand("read", f));
  if (r.code !== 0) return { ok: false, code: r.code };
  const t = r.stdout;
  const pick = (re) => re.exec(t)?.[1];
  if (f.rail === "tempo") {
    const remaining = pick(/remaining:\s+\d+ base units \(([\d.]+) pathUSD\)/);
    const exp = Number(pick(/expiry:\s+(\d+)/) ?? 0);
    const revoked = pick(/isRevoked:\s+(true|false)/) === "true";
    const expiry = exp ? new Date(exp * 1000).toISOString() : null;
    const live = !revoked && !(exp && exp * 1000 < Date.now());
    return { ok: true, remaining: remaining ?? null, expiry, revoked, atRisk: remaining === undefined ? null : live ? remaining : "0" };
  }
  if (f.rail === "solana") {
    const remaining = pick(/delegatedAmount \(remaining\):\s+([\d.]+) USDC/);
    const most = pick(/maximum the delegate can still move:\s+([\d.]+) USDC/);
    return { ok: true, remaining: remaining ?? null, expiry: null, revoked: pick(/revoked:\s+(true|false)/) === "true", atRisk: most ?? null };
  }
  const rr = railResult(t); // evm: the read script ends with a RESULT line
  return rr ? evmReadFromResult(rr) : { ok: false, code: 2 };
}

const journal = (f) => join(opsDir(f.rail, f.chain), `${f.op}.json`);
const readJournal = (f) => { const p = journal(f); try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } };
const newOp = () => { const d = new Date().toISOString().replace(/\D/g, "").slice(0, 14); return `rb-${d}-${Math.random().toString(16).slice(2, 6)}`; };
const txOf = (text) => [...text.matchAll(/(?:tx hash|signature):\s*(\S+)|\/tx\/(0x[0-9a-fA-F]{64})/gi)].map((m) => m[1] ?? m[2]).pop();

// ---- state -> exit code (from the rail's RESULT state, never from the rail's own exit code) ---------
const STATES = ["planned", "sent", "settled", "failed", "refused_precheck", "refused_chain", "unknown", "not_found", "ok", "waiting_owner"];
function exitFor(cmd, state, delivered) {
  switch (state) {
    case "settled": return delivered === true ? 0 : delivered === false || cmd === "buy" ? 4 : 0;
    case "planned": case "sent": case "ok": case "waiting_owner": return 0;
    case "refused_precheck": return 3;
    case "unknown": return 5;
    default: return 1; // failed, refused_chain, not_found
  }
}
const nextFor = (state, delivered, f, cmd) => {
  const rc = `superstables budget reconcile --rail ${f.rail} --chain ${f.chain} --op ${f.op}`;
  if (state === "settled") return delivered === true ? "none" : "paid but not delivered: never pay again; report the tx to the seller";
  if (state === "unknown") return `${rc} (never pay again for this op)`;
  if (state === "refused_precheck") return "respect the refusal; nothing was signed; never raise --max to get around it";
  if (state === "not_found") return "no funds moved; buy again with a new --op if you still want it";
  if (state === "refused_chain" || state === "failed") return `read reason; do not retry blindly; superstables budget status --rail ${f.rail}`;
  return "none";
};

// Turn the rail's RESULT (or its absence) into the CLI's normalized fields.
function normalize(cmd, f, rail, code) {
  const base = { command: cmd, rail: f.rail, chain: f.chain, op: f.op };
  if (!rail) {
    if (code === 2) return { code: 2, fields: { ...base, state: "failed", next: `fix the command; see superstables budget ${cmd} --help`, reason: "the rail script rejected the input" } };
    const state = cmd === "buy" ? "unknown" : "failed";
    return { code: exitFor(cmd, state, null), fields: { ...base, state, paid: cmd === "buy" ? null : false, delivered: null, amount: null, remaining: null, tx: {}, next: nextFor(state, null, f, cmd), reason: `the rail script exited ${code} without a RESULT line` } };
  }
  let state = STATES.includes(rail.state) ? rail.state : "unknown";
  if (rail.state === "submitted" || (rail.state === "sent" && ["buy", "reconcile"].includes(cmd))) state = "unknown";
  if (rail.state === "quoted") state = "planned";
  const paid = state === "settled" ? true : state === "unknown" ? null : false;
  const delivered = paid === false ? false : (rail.delivered ?? null);
  const tx = rail.tx && typeof rail.tx === "object" ? rail.tx : rail.tx ? { settle: rail.tx } : {};
  const nothingMoved = ["refused_precheck", "refused_chain", "failed", "not_found"].includes(state);
  const amount = state === "unknown" ? null : nothingMoved ? "0" : rail.debit == null ? null : String(rail.debit);
  return {
    code: exitFor(cmd, state, delivered),
    // a refusal whose fix is the owner's recover (a refund or stranded funds in the agent key) keeps the rail's own next step
    fields: { ...base, state, paid, delivered, amount, remaining: rail.remaining ?? null, tx, next: state === "refused_precheck" && /superstables budget recover/.test(rail.next ?? "") ? rail.next : nextFor(state, delivered, f, cmd), reason: rail.reason },
  };
}

// ---- commands ---------------------------------------------------------------------------------------
async function doctor({ f, ctx }) {
  const { runDoctor } = await import("./doctor.mjs");
  const failed = await runDoctor(f);
  emit(failed ? 1 : 0, { ...ctx, state: failed ? "failed" : "ok", next: failed ? "fix what the output marks FAIL (top-up lines name the address), then rerun superstables budget doctor" : "none", reason: failed ? `${failed} doctor check${failed === 1 ? "" : "s"} failed` : undefined });
}

async function status({ f, ctx }) {
  const s = await readBudget(f);
  if (!s.ok) return emit(s.code === 2 ? 2 : 1, { ...ctx, state: "failed", next: "check superstables budget doctor", reason: "could not read the budget" });
  emit(0, { ...ctx, state: "ok", remaining: s.remaining, expiry: s.expiry, revoked: s.revoked, atRisk: s.atRisk, next: "none" });
}

async function buy({ f, ctx }) {
  f.op ??= newOp();
  ctx.op = f.op;
  const j = readJournal(f);
  if (j && ["submitted", "unknown", "settled"].includes(j.state)) {
    log(`superstables budget: operation ${f.op} is already ${j.state}. Not paying again.`);
    return emit(3, { ...ctx, state: "refused_precheck", paid: j.state === "settled" ? true : null, delivered: j.delivered ?? null, amount: null, remaining: null, tx: (j.tx ?? j.settleTx) ? { settle: j.tx ?? j.settleTx } : {}, next: j.state === "settled" ? "none: already settled; use a new --op for a new purchase" : `superstables budget reconcile --rail ${f.rail} --chain ${f.chain} --op ${f.op}`, reason: `op_already_${j.state}` });
  }
  const r = await run(railCommand("buy", f));
  const n = normalize("buy", f, railResult(r.stdout), r.code);
  emit(n.code, n.fields);
}

async function reconcile({ f, ctx }) {
  if (!readJournal(f)) return badInput(ctx, `no journal for op ${f.op} under ${opsDir(f.rail, f.chain)}`);
  const r = await run(railCommand("reconcile", f)); // read-only: none of the three rail scripts signs or sends
  const n = normalize("reconcile", f, railResult(r.stdout), r.code);
  emit(n.code, n.fields);
}

// Owner commands: tempo and solana print no RESULT line, so the rail's exit code says whether it sent. The evm scripts end
// with a RESULT line whose state is a rail word (set, revoked, ok, planned, mismatch, not_revoked); those map to the CLI states.
const OWNER_STATES = { set: "settled", revoked: "settled", ok: "settled", planned: "planned", refused_precheck: "refused_precheck", mismatch: "refused_precheck", not_revoked: "failed", failed: "failed", unknown: "unknown" };
function ownerOutcome(code, rr = null) {
  const c = [0, 2, 3, 5].includes(code) ? code : 1;
  const byCode = { 0: "settled", 2: "failed", 3: "refused_precheck", 5: "unknown" }[c] ?? "failed";
  const mapped = OWNER_STATES[rr?.state];
  return { code: c, state: c !== 0 && mapped && mapped !== "settled" && mapped !== "planned" ? mapped : byCode, reason: rr?.reason };
}
// Owner transaction hashes: the evm RESULT carries them; the other rails print an explorer line.
const ownerTx = (rr, stdout) => (typeof rr?.tx === "string" ? rr.tx : rr?.tx && typeof rr.tx === "object" ? rr.tx : txOf(stdout));

// evm owner commands: the owner approves in the wallet by default; the key file needs --yes.
const walletFlow = (f) => f.rail === "evm" && !f["owner-key-file"];
const sendsNow = (f) => walletFlow(f) || f.yes === true;
const waitLine = (f) => walletFlow(f) ? "The owner approves this in their own wallet: this command opens a page for it and waits." : "Nothing is sent without --yes.";
const notSentNext = (f) => walletFlow(f) ? undefined : "rerun the same command with --yes to send (owner signs with the key file)";
// A refusal or an unknown from an evm owner script keeps the script's own next step (it knows whether the owner declined).
const ownerNext = (o, rr, fallback) => (["refused_precheck", "unknown"].includes(o.state) && rr?.next ? rr.next : fallback);

async function grant({ f, ctx }) {
  const secs = f.expiry ? Math.ceil((Date.parse(f.expiry) - Date.now()) / 1000) : 86400;
  const now = await readBudget(f);
  const unit = unitOf(f);
  log(`\nPLAN grant on ${f.rail} (${f.chain}). ${waitLine(f)}`);
  if (f.rail === "tempo") {
    const windows = f.period ? Math.ceil(secs / Number(f.period)) : 1;
    log(`  cap:       ${f.amount} ${unit}${f.period ? ` per ${f.period}s` : " in total (one-time)"} to access key ${f.agent ? `AGENT${f.agent}` : "primary agent"}`);
    log(`  expiry:    ${f.expiry ?? "24h from now (default)"} (${secs}s from now)`);
    log(`  sellers:   ${f.sellers ?? "any"}`);
    log(`  TRUE MAXIMUM by expiry: ${decimal(micro(f.amount) * BigInt(windows))} ${unit} (${windows} window${windows === 1 ? "" : "s"})`);
    log(`  enforced by the chain: cap, expiry, period reset, seller list (AccountKeychain). Not enforced: a per-payment maximum. Fees come out of the same limit.`);
    log(`  a revoked or expired key can never be granted again: use a fresh --agent label (npx tsx budget/tempo/setup.ts --extra-agent LABEL).`);
  } else if (f.rail === "solana") {
    log(`  cap:       ${f.amount} USDC as SPL delegate amount for the agent, in total, ever (no reset)`);
    log(`  TRUE MAXIMUM: min(${f.amount}, the owner's USDC balance). It does not expire.`);
    log(`  enforced by the chain: the total cap. NOT enforced: expiry, period, seller list (a stolen agent key can pay any address).`);
    log(`  a new approval overwrites the current delegate and its remaining amount; the script refuses that unless you replace it by hand.`);
  } else {
    log(`  cap:       ${f.amount} ${unit}: ${unit}.approve(agent, ${f.amount}) from the owner, in total (no reset)`);
    log(`  TRUE MAXIMUM: min(${f.amount}, the owner's ${unit} balance). It does not expire.`);
    log(`  enforced by the chain: the total allowance. NOT enforced: expiry, period, seller list (a stolen agent key can pay any address).`);
    log(`  a live allowance is never overwritten silently: the script refuses until it is revoked.`);
  }
  if (now.ok) log(`  current:   remaining ${ago(now.remaining)}, expiry ${ago(now.expiry)}, revoked ${now.revoked}`);
  if (!sendsNow(f)) return emit(0, { ...ctx, state: "planned", amount: f.amount, remaining: now.ok ? now.remaining : null, tx: {}, next: notSentNext(f) });

  const r = await run(railCommand("grant", f, { expirySeconds: secs }));
  const rr = railResult(r.stdout);
  const o = ownerOutcome(r.code, rr);
  if (o.code !== 0) return emit(o.code, { ...ctx, state: o.state, amount: f.amount, tx: rr?.tx ? { grant: rr.tx } : {}, url: approvalUrl, next: ownerNext(o, rr, o.state === "refused_precheck" ? "nothing was sent; revoke the live budget first, or fix what the reason says" : `superstables budget status --rail ${f.rail}: the chain may or may not have changed`), reason: o.reason ?? `the rail script exited ${r.code}` });
  const after = await readBudget(f);
  emit(0, { ...ctx, state: "settled", amount: f.amount, remaining: after.ok ? after.remaining : null, tx: { grant: ownerTx(rr, r.stdout) ?? null }, expiry: after.ok ? after.expiry : null, url: approvalUrl, next: "none" });
}

async function revoke({ f, ctx }) {
  const now = await readBudget(f);
  log(`\nPLAN revoke on ${f.rail} (${f.chain}). ${waitLine(f)}`);
  if (now.ok) log(`  now: remaining ${ago(now.remaining)}, expiry ${ago(now.expiry)}, revoked ${now.revoked}, funds at risk ${ago(now.atRisk)}`);
  log({
    tempo: "  effect: AccountKeychain.revokeKey. From the block it lands in every payment by this key is refused, even one signed earlier. Open payment sessions are not covered.",
    solana: "  effect: the owner's Revoke clears the delegate. From the slot it lands every payment by the agent fails, even one signed earlier.",
    evm: `  effect: ${unitOf(f)}.approve(agent, 0). From the block it lands the agent can pull nothing more. ${unitOf(f)} already pulled into the agent key is not covered: superstables budget recover returns it.`,
  }[f.rail]);
  if (now.ok && now.revoked) return emit(0, { ...ctx, state: "ok", remaining: now.remaining, revoked: true, tx: {}, next: "none", reason: "already revoked; nothing to send" });
  if (!sendsNow(f)) return emit(0, { ...ctx, state: "planned", remaining: now.ok ? now.remaining : null, revoked: false, tx: {}, next: notSentNext(f) });
  const r = await run(railCommand("revoke", f));
  const rr = railResult(r.stdout);
  const o = ownerOutcome(r.code, rr);
  if (walletFlow(f) && o.code !== 0 && ["refused_precheck", "unknown"].includes(o.state)) {
    return emit(o.code, { ...ctx, state: o.state, remaining: now.ok ? now.remaining : null, revoked: false, tx: rr?.tx ? { revoke: rr.tx } : {}, url: approvalUrl, next: ownerNext(o, rr, "none"), reason: o.reason });
  }
  const after = await readBudget(f);
  const done = r.code === 0 && after.ok && after.revoked;
  emit(done ? 0 : o.code || 1, {
    ...ctx, state: done ? "settled" : o.code === 0 ? "failed" : o.state, remaining: after.ok ? after.remaining : null, revoked: after.ok ? after.revoked : null,
    tx: { revoke: ownerTx(rr, r.stdout) ?? null }, url: approvalUrl, next: done ? "none" : `superstables budget status --rail ${f.rail}: confirm whether the revoke landed, then run superstables budget revoke again`, reason: done ? undefined : o.reason ?? `the rail script exited ${r.code}`,
  });
}

async function recover({ f, ctx }) {
  const plan = await run(railCommand("recover", f, { plan: true })); // the script's own --plan sends nothing
  if (plan.code !== 0) { const o = ownerOutcome(plan.code, railResult(plan.stdout)); return emit(o.code, { ...ctx, state: o.state, tx: {}, next: "read the plan output above", reason: o.reason ?? `the recover plan exited ${plan.code}` }); }
  if (!sendsNow(f)) return emit(0, { ...ctx, state: "planned", tx: {}, next: "rerun the same command with --yes to send (the owner key file signs the owner's steps)" });
  const r = await run(railCommand("recover", f));
  const rr = railResult(r.stdout);
  const o = ownerOutcome(r.code, rr);
  const tx = {};
  for (const [k, v] of [["selfRevoke", rr?.selfRevokeTx], ["ownerRevoke", rr?.ownerRevokeTx], ["gas", rr?.gasTx], ["sweep", rr?.sweepTx]]) if (v) tx[k] = v;
  emit(o.code, { ...ctx, state: o.state, amount: rr?.swept ?? null, remaining: rr?.allowance ?? null, tx, url: approvalUrl, next: o.code === 0 ? "none" : ownerNext(o, rr, `superstables budget status --rail ${f.rail}; then superstables budget recover again`), reason: o.code === 0 ? undefined : o.reason ?? `the rail script exited ${r.code}` });
}

async function setup({ f, ctx }) {
  log(`\nsetup on evm (${f.chain}): the agent key stays on this computer; the owner connects their own wallet. No owner key is created.`);
  const r = await run(railCommand("setup", f));
  const rr = railResult(r.stdout);
  const o = ownerOutcome(r.code, rr);
  if (o.code !== 0) return emit(o.code, { ...ctx, state: o.state, agent: rr?.agent, url: approvalUrl, next: ownerNext(o, rr, "read the output above"), reason: o.reason ?? `the setup script exited ${r.code}` });
  emit(0, { ...ctx, state: "ok", owner: rr?.owner, agent: rr?.agent, url: approvalUrl, next: rr?.next ?? "none" });
}

async function fundAgent({ f, ctx }) {
  log(`\nfund-agent on evm (${f.chain}): the owner sends the agent gas. ${waitLine(f)}`);
  if (!sendsNow(f)) return emit(0, { ...ctx, state: "planned", tx: {}, next: notSentNext(f) });
  const r = await run(railCommand("fund-agent", f));
  const rr = railResult(r.stdout);
  const o = ownerOutcome(r.code, rr);
  if (o.code !== 0) return emit(o.code, { ...ctx, state: o.state, tx: rr?.tx ? { fundAgent: rr.tx } : {}, url: approvalUrl, next: ownerNext(o, rr, "superstables budget doctor --rail evm"), reason: o.reason ?? `the fund-agent script exited ${r.code}` });
  emit(0, { ...ctx, state: "settled", amount: rr?.sent ?? null, tx: { fundAgent: rr?.tx ?? null }, url: approvalUrl, next: "none" });
}

// ---- detached owner approvals (approvals.mjs) -------------------------------------------------------
const OWNER_COMMANDS = new Set(["setup", "fund-agent", "grant", "revoke", "recover"]);
const waitNext = (id) => `show the owner the url and the terms: they approve in their own wallet, in a browser on this computer. Then run superstables budget wait --id ${id} until the state is final. Do not start another owner command meanwhile`;
const approvalFields = (r) => ({ id: r.id, action: r.action, url: r.url, expires: r.expires, terms: r.terms });

function refusePending(ctx, pending) {
  log(`superstables budget: refused: owner approval ${pending.id} (${pending.command}) is still waiting for the owner on ${pending.rail} ${pending.chain}`);
  emit(3, {
    ...ctx, state: "refused_precheck", ...approvalFields(pending),
    next: `nothing was started. Show the owner the pending link, then superstables budget wait --id ${pending.id}. Only if the owner asks to drop it: rerun this command with --replace`,
    reason: `owner approval ${pending.id} (${pending.command}) is still waiting for the owner on this chain; one owner approval at a time`,
  });
}

// Runs before an evm owner command: one approval at a time on the chain, and, when detached, starts the worker and exits.
async function ownerGate({ cmd, f, ctx }) {
  const detach = f.detach === true || (!f.wait && !process.stdout.isTTY);
  const id = detach ? newApprovalId() : undefined;
  const pending = findPending(f.rail, f.chain);
  if (pending) {
    if (!f.replace) return refusePending(ctx, pending);
    const r = await replacePending(pending, id ?? "an approval in a terminal");
    if (!r.ok) return emit(3, { ...ctx, state: "refused_precheck", ...approvalFields(pending), next: `superstables budget wait --id ${pending.id}`, reason: r.reason });
    log(`superstables budget: replaced the pending approval ${pending.id}; nothing had been sent`);
  }
  if (!detach) return;
  const c = claim(f.rail, f.chain, id);
  if (!c.ok) return refusePending(ctx, c.pending);
  const argv = process.argv.slice(2).filter((a) => a !== "--detach" && a !== "--replace");
  const args = [fileURLToPath(import.meta.url), ...argv, "--wait", ...(f["no-open"] ? [] : ["--no-open"])];
  log(`\nsuperstables budget: the owner approval runs in the background (id ${id}); this command returns as soon as its link exists.`);
  const r = await startDetached({ id, command: cmd, rail: f.rail, chain: f.chain, cmd: process.execPath, args, cwd: process.cwd(), timeoutS: Number(f.timeout ?? 600), onLog: (s) => process.stderr.write(s) });
  if (r.kind === "final") {
    // it ended before it needed the owner (a refusal before any page, or nothing to do): the same RESULT as blocking
    const { code, result } = r.record.final;
    delete result.id;
    forget(id);
    writeSync(1, "RESULT " + JSON.stringify(result) + "\n");
    process.exit(code);
  }
  if (r.kind === "failed") return emit(1, { ...ctx, state: "failed", id, next: `nothing was sent. The log is ${logFile(id)}`, reason: r.reason });
  const rec = r.record;
  writeSync(1, `APPROVE ${JSON.stringify({ action: rec.action, url: rec.url, expires: rec.expires, terms: rec.terms })}\n`);
  log(`\nThe approval page stays open in the background until ${rec.expires}. Show the owner the link, then run: superstables budget wait --id ${id}`);
  emit(0, { ...ctx, state: "waiting_owner", ...approvalFields(rec), next: waitNext(id) });
}

async function wait({ f }) {
  const r = await waitFor(f.id, (f.timeout === undefined ? 30 : Number(f.timeout)) * 1000);
  if (!r) return badInput({ command: "wait" }, `no owner approval with id ${f.id} under ${approvalsDir()}`);
  if (r.final) {
    writeSync(1, "RESULT " + JSON.stringify(r.result) + "\n");
    process.exit(r.code);
  }
  const rec = r.record;
  log(`superstables budget: ${rec.id} (${rec.command}) is still waiting: ${pageWords(r.page)}. Link: ${rec.url}`);
  emit(0, { command: rec.command, rail: rec.rail, chain: rec.chain, state: "waiting_owner", ...approvalFields(rec), next: waitNext(rec.id), reason: pageWords(r.page) });
}

// ---- main -------------------------------------------------------------------------------------------
const HANDLERS = { setup, "fund-agent": fundAgent, doctor, status, buy, reconcile, grant, revoke, recover, wait };
const parsed = parse(process.argv.slice(2));
if (WORKER_ID) {
  // the worker's backstop: nothing it runs may outlive the link, the send grace and the chain reads
  const f = parsed.f;
  setTimeout(() => {
    try { currentChild?.kill("SIGKILL"); } catch {}
    emit(5, { command: parsed.cmd, rail: f.rail, chain: f.chain, state: "unknown", url: approvalUrl, next: `superstables budget status --rail ${f.rail} --chain ${f.chain}: read whether it landed before running this again`, reason: "the background approval ran past its deadline and was stopped" });
  }, workerDeadlineMs(Number(f.timeout ?? 600))).unref();
} else if (OWNER_COMMANDS.has(parsed.cmd) && walletFlow(parsed.f)) {
  await ownerGate(parsed);
}
await HANDLERS[parsed.cmd](parsed);
