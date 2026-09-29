#!/usr/bin/env node
// superstables budget: one command for the budget rails. A thin dispatcher over the rail scripts in evm/ and
// tempo/. It validates input, spawns the rail script, and prints one normalized `RESULT {...}` line last on
// stdout. Logs go to stderr. Contract: CLI.md. Testnet only.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { opsDir } from "./paths.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
// The rails run on the client repo's own install: its tsx and its node_modules.
const REPO = join(ROOT, "..");
const TSX = join(REPO, "node_modules", ".bin", "tsx");

// ---- rails ------------------------------------------------------------------------------------------
const RAILS = {
  evm: { chains: ["base-sepolia", "arc-testnet"], chain: "base-sepolia", addr: /^0x[0-9a-fA-F]{40}$/, unit: "USDC" },
  tempo: { chains: ["moderato"], chain: "moderato", addr: /^0x[0-9a-fA-F]{40}$/, unit: "pathUSD" },
};
// Rails that are planned but not in this version: refused with exit 2 before anything runs.
const LATER = ["solana"];

// ---- commands: flags ('v' takes a value, 'b' is a switch), required flags, help text ----------------
const COMMANDS = {
  doctor: {
    flags: { agent: "v" }, required: [],
    help: "superstables budget doctor --rail evm|tempo [--chain C] [--agent LABEL]\n  Key files, public file, RPC and balances. Prints what to top up at which address. No transactions, no signatures.",
  },
  grant: {
    flags: { amount: "v", expiry: "v", period: "v", sellers: "v", yes: "b", agent: "v" }, required: ["amount"],
    help: "superstables budget grant --rail R --amount A [--expiry ISO] [--period SECONDS] [--sellers a,b] [--agent LABEL] [--yes]\n  Owner command. Prints the terms and what the chain enforces; sends only with --yes.\n  Refuses constraints the rail cannot enforce (evm: no --expiry, --period, --sellers).\n  Tempo: --expiry defaults to 24h from now. --agent LABEL picks the access key (a revoked key can never be granted again).",
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
    flags: { op: "v", yes: "b" }, required: [],
    help: "superstables budget recover --rail evm [--chain C] [--op ID] [--yes]\n  EVM only. Owner command: revoke first, then return stranded funds. Prints the plan; sends only with --yes.",
  },
  revoke: {
    flags: { yes: "b", agent: "v" }, required: [],
    help: "superstables budget revoke --rail R [--chain C] [--agent LABEL] [--yes]\n  Owner command. Ends the budget on chain. Prints the plan; sends only with --yes.",
  },
};
const TOP_HELP = `superstables budget: on-chain agent budgets on evm (Base Sepolia, Arc Testnet) and tempo (Moderato). Testnet only.

Commands (each takes --help):
  superstables budget doctor    --rail R [--chain C]
  superstables budget status    --rail R
  superstables budget grant     --rail R --amount A [--expiry ISO] [--period S] [--sellers a,b] [--yes]   owner
  superstables budget buy       --rail R --url U --max M [--pay-to ADDR] [--op ID]                          agent
  superstables budget reconcile --rail R --op ID
  superstables budget revoke    --rail R [--yes]                                                            owner
  superstables budget recover   --rail evm [--op ID] [--yes]                                                owner

stdout ends with: RESULT {"ok","command","rail","chain","op","state","paid","delivered","amount","remaining","tx","next"}
Exit: 0 done, 1 failed, 2 bad input, 3 refused before signing, 4 paid but not delivered, 5 unknown (superstables budget reconcile).`;

// ---- output -----------------------------------------------------------------------------------------
const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
const log = (...a) => process.stderr.write(a.join(" ") + "\n");

// One RESULT object, last line of stdout. Written synchronously so the process exits right after it.
function emit(code, fields) {
  const order = ["command", "rail", "chain", "op", "state", "paid", "delivered", "amount", "remaining", "tx", "expiry", "revoked", "atRisk", "next", "reason"];
  const out = { ok: code === 0 };
  for (const k of order) if (fields[k] !== undefined) out[k] = k === "reason" ? clean(fields[k]) : fields[k];
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
  const ctx = { command: cmd, rail: f.rail };
  if (!f.rail) return badInput(ctx, "--rail is required (evm or tempo)");
  if (LATER.includes(f.rail)) return badInput(ctx, `--rail ${f.rail} is not in this version yet: it has evm and tempo`);
  const rail = RAILS[f.rail];
  if (!rail) return badInput(ctx, `--rail must be evm or tempo (got "${f.rail}")`);
  if (f.chain !== undefined && !rail.chains.includes(f.chain)) {
    if (/mainnet|^(base|ethereum|eth|arc|tempo|solana|polygon|optimism|arbitrum)$|^\d+$|^eip155:/i.test(f.chain)) return refuse({ ...ctx, chain: f.chain }, `"${f.chain}" looks like a mainnet: superstables budget is testnet only`);
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
  if (cmd === "grant" && f.rail === "evm") {
    for (const k of ["expiry", "period", "sellers"]) if (f[k] !== undefined) badInput(ctx, `evm cannot enforce --${k} on chain (a plain approve has a total cap only): revoke by your deadline`);
  }
  if (cmd === "buy" && f.rail === "evm") {
    for (const k of ["method", "body"]) if (f[k] !== undefined && !(k === "method" && f.method.toUpperCase() === "GET")) badInput(ctx, `evm buy is GET only (no --${k})`);
  }
  if (cmd === "recover" && f.rail !== "evm") badInput(ctx, "recover is EVM only (tempo has no stranded funds: the agent never holds the budget)");
  return { cmd, f, ctx };
}

// ---- rail command lines: the only place that knows script names and flags ---------------------------
const tsx = (dir, script, args) => ({ cwd: join(ROOT, dir), cmd: TSX, args: [script, ...args] });
const opt = (name, v) => (v === undefined ? [] : [`--${name}`, v]);

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
  return evmCommand(verb, f, extra);
}

// ---- EVM dispatch: flags mapped from `npx tsx budget/evm/<script>.ts --help`. The evm scripts end with a RESULT line of their own.
function evmCommand(verb, f, extra = {}) {
  const E = (script, args) => tsx("evm", `${script}.ts`, [...args, "--chain", f.chain]);
  switch (verb) {
    case "buy": return E("buy", ["--url", f.url, "--max", f.max, "--op", f.op, ...opt("pay-to", f["pay-to"])]); // GET only
    case "reconcile": return E("reconcile", ["--op", f.op]);
    case "read": return E("read", []);
    case "grant": return E("setBudget", ["--cap", f.amount]);
    case "revoke": return E("revoke", []);
    case "recover": return E("recover", [...opt("op", f.op), ...(extra.plan ? ["--plan"] : [])]);
  }
}
const evmReadFromResult = (r) => ({ ok: true, remaining: r.allowance ?? null, expiry: r.expiry ?? null, revoked: r.revoked === true, atRisk: r.maxMovable ?? null });
// ---- end of EVM section -----------------------------------------------------------------------------

// ---- running a rail script --------------------------------------------------------------------------
// Rail logs are forwarded to stderr as they arrive. Returns { code, stdout } (stdout is kept to find RESULT).
function run(spec) {
  return new Promise((resolve) => {
    if (!existsSync(TSX)) { log(`superstables budget: dependencies are missing: run npm ci at the repo root (${REPO})`); return resolve({ code: 2, stdout: "", missing: true }); }
    const p = spawn(spec.cmd, spec.args, { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    p.stdout.on("data", (d) => { stdout += d; process.stderr.write(d); });
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
  const rr = railResult(t); // evm: the read script ends with a RESULT line
  return rr ? evmReadFromResult(rr) : { ok: false, code: 2 };
}

const journal = (f) => join(opsDir(f.rail, f.chain), `${f.op}.json`);
const readJournal = (f) => { const p = journal(f); try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } };
const newOp = () => { const d = new Date().toISOString().replace(/\D/g, "").slice(0, 14); return `rb-${d}-${Math.random().toString(16).slice(2, 6)}`; };
const txOf = (text) => [...text.matchAll(/(?:tx hash|signature):\s*(\S+)|\/tx\/(0x[0-9a-fA-F]{64})/gi)].map((m) => m[1] ?? m[2]).pop();

// ---- state -> exit code (from the rail's RESULT state, never from the rail's own exit code) ---------
const STATES = ["planned", "sent", "settled", "failed", "refused_precheck", "refused_chain", "unknown", "not_found", "ok"];
function exitFor(cmd, state, delivered) {
  switch (state) {
    case "settled": return delivered === true ? 0 : delivered === false || cmd === "buy" ? 4 : 0;
    case "planned": case "sent": case "ok": return 0;
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
    fields: { ...base, state, paid, delivered, amount, remaining: rail.remaining ?? null, tx, next: nextFor(state, delivered, f, cmd), reason: rail.reason },
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

// Owner commands: tempo prints no RESULT line, so the rail's exit code says whether it sent. The evm scripts end
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

async function grant({ f, ctx }) {
  const secs = f.expiry ? Math.ceil((Date.parse(f.expiry) - Date.now()) / 1000) : 86400;
  const now = await readBudget(f);
  const unit = RAILS[f.rail].unit;
  log(`\nPLAN grant on ${f.rail} (${f.chain}). Nothing is sent without --yes.`);
  if (f.rail === "tempo") {
    const windows = f.period ? Math.ceil(secs / Number(f.period)) : 1;
    log(`  cap:       ${f.amount} ${unit}${f.period ? ` per ${f.period}s` : " in total (one-time)"} to access key ${f.agent ? `AGENT${f.agent}` : "primary agent"}`);
    log(`  expiry:    ${f.expiry ?? "24h from now (default)"} (${secs}s from now)`);
    log(`  sellers:   ${f.sellers ?? "any"}`);
    log(`  TRUE MAXIMUM by expiry: ${decimal(micro(f.amount) * BigInt(windows))} ${unit} (${windows} window${windows === 1 ? "" : "s"})`);
    log(`  enforced by the chain: cap, expiry, period reset, seller list (AccountKeychain). Not enforced: a per-payment maximum. Fees come out of the same limit.`);
    log(`  a revoked or expired key can never be granted again: use a fresh --agent label (npx tsx budget/tempo/setup.ts --extra-agent LABEL).`);
  } else {
    log(`  cap:       ${f.amount} USDC: USDC.approve(agent, ${f.amount}) from the owner, in total (no reset)`);
    log(`  TRUE MAXIMUM: min(${f.amount}, the owner's USDC balance). It does not expire.`);
    log(`  enforced by the chain: the total allowance. NOT enforced: expiry, period, seller list (a stolen agent key can pay any address).`);
    log(`  a live allowance is never overwritten silently: the script refuses until it is revoked.`);
  }
  if (now.ok) log(`  current:   remaining ${ago(now.remaining)}, expiry ${ago(now.expiry)}, revoked ${now.revoked}`);
  if (!f.yes) return emit(0, { ...ctx, state: "planned", amount: f.amount, remaining: now.ok ? now.remaining : null, tx: {}, next: "rerun the same command with --yes to send (owner signs)" });

  const r = await run(railCommand("grant", f, { expirySeconds: secs }));
  const rr = railResult(r.stdout);
  const o = ownerOutcome(r.code, rr);
  if (o.code !== 0) return emit(o.code, { ...ctx, state: o.state, tx: {}, next: o.state === "refused_precheck" ? "nothing was sent; revoke the live budget first, or fix what the reason says" : `superstables budget status --rail ${f.rail}: the chain may or may not have changed`, reason: o.reason ?? `the rail script exited ${r.code}` });
  const after = await readBudget(f);
  emit(0, { ...ctx, state: "settled", amount: f.amount, remaining: after.ok ? after.remaining : null, tx: { grant: ownerTx(rr, r.stdout) ?? null }, expiry: after.ok ? after.expiry : null, next: "none" });
}

async function revoke({ f, ctx }) {
  const now = await readBudget(f);
  log(`\nPLAN revoke on ${f.rail} (${f.chain}). Nothing is sent without --yes.`);
  if (now.ok) log(`  now: remaining ${ago(now.remaining)}, expiry ${ago(now.expiry)}, revoked ${now.revoked}, funds at risk ${ago(now.atRisk)}`);
  log({
    tempo: "  effect: AccountKeychain.revokeKey. From the block it lands in every payment by this key is refused, even one signed earlier. Open payment sessions are not covered.",
    evm: "  effect: USDC.approve(agent, 0). From the block it lands the agent can pull nothing more. USDC already pulled into the agent key is not covered: superstables budget recover returns it.",
  }[f.rail]);
  if (now.ok && now.revoked) return emit(0, { ...ctx, state: "ok", remaining: now.remaining, revoked: true, tx: {}, next: "none", reason: "already revoked; nothing to send" });
  if (!f.yes) return emit(0, { ...ctx, state: "planned", remaining: now.ok ? now.remaining : null, revoked: false, tx: {}, next: "rerun the same command with --yes to send (owner signs)" });
  const r = await run(railCommand("revoke", f));
  const rr = railResult(r.stdout);
  const after = await readBudget(f);
  const done = r.code === 0 && after.ok && after.revoked;
  const o = ownerOutcome(r.code, rr);
  emit(done ? 0 : o.code || 1, {
    ...ctx, state: done ? "settled" : o.code === 0 ? "failed" : o.state, remaining: after.ok ? after.remaining : null, revoked: after.ok ? after.revoked : null,
    tx: { revoke: ownerTx(rr, r.stdout) ?? null }, next: done ? "none" : `superstables budget status --rail ${f.rail}: confirm whether the revoke landed, then run superstables budget revoke --yes again`, reason: done ? undefined : `the rail script exited ${r.code}`,
  });
}

async function recover({ f, ctx }) {
  const plan = await run(railCommand("recover", f, { plan: true })); // the script's own --plan sends nothing
  if (plan.code !== 0) { const o = ownerOutcome(plan.code, railResult(plan.stdout)); return emit(o.code, { ...ctx, state: o.state, tx: {}, next: "read the plan output above", reason: o.reason ?? `the recover plan exited ${plan.code}` }); }
  if (!f.yes) return emit(0, { ...ctx, state: "planned", tx: {}, next: "rerun the same command with --yes to send (owner signs: revoke first, then return funds)" });
  const r = await run(railCommand("recover", f));
  const rr = railResult(r.stdout);
  const o = ownerOutcome(r.code, rr);
  const tx = {};
  for (const [k, v] of [["selfRevoke", rr?.selfRevokeTx], ["ownerRevoke", rr?.ownerRevokeTx], ["sweep", rr?.sweepTx]]) if (v) tx[k] = v;
  emit(o.code, { ...ctx, state: o.state, amount: rr?.swept ?? null, remaining: rr?.allowance ?? null, tx, next: o.code === 0 ? "none" : `superstables budget status --rail ${f.rail}; then superstables budget recover again`, reason: o.code === 0 ? undefined : o.reason ?? `the rail script exited ${r.code}` });
}

// ---- main -------------------------------------------------------------------------------------------
const HANDLERS = { doctor, status, buy, reconcile, grant, revoke, recover };
const parsed = parse(process.argv.slice(2));
await HANDLERS[parsed.cmd](parsed);
