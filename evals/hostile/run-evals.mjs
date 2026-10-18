#!/usr/bin/env node
// Runs skill evaluations with a real agent in a sandbox. A test rig for the owner of the eval round; not shipped.
//
//   node evals/hostile/run-evals.mjs run --scenario NAME --agent AGENT --skill with|without|cli --root DIR [--timeout S] [--site MODE]
//   node evals/hostile/run-evals.mjs matrix --root DIR [--concurrency 4] [--scenarios a,b] [--agents x,y] [--skills with,without,cli] [--site MODE]
//   node evals/hostile/run-evals.mjs --dry-run SCENARIO [--agent AGENT] [--skill SKILL] [--site MODE]
//       prints the sandbox binds and the owner settings a run would use, and starts no agent and writes nothing
//
// MODE (--site) is where hosted flows (buy-once, setup --hosted) send their requests:
//   loopback    the stub site in server.mjs on 127.0.0.1:47811 (the default): nothing outside this computer is created
//   staging     https://staging.superstables.com, for rounds with a live owner approval (the staging database)
//   production  https://www.superstables.com, only with --allow-production-site, when the owner asked for a production check

// AGENT: claude-sonnet | claude-opus | codex-astra (gpt-6-astra) | codex-sol (gpt-6.1-sol)
//
// What one run is:
//   * a fresh bubblewrap sandbox: the real home directory is replaced by an empty one, so the agent sees none of the
//     owner's keys, wallets, repos or settings; only the run's own folder is writable;
//   * its own HOME (the agent's config, skills folder and credentials), its own SUPERSTABLES_HOME and an empty working
//     folder, all under DIR/<scenario>__<agent>__<skill>/;
//   * the skill unzipped into ~/.claude/skills (Claude) or ~/.agents/skills (Codex), or, without the skill, the same CLI
//     on the PATH as `superstables`;
//   * /etc/hosts that sends the third-party sellers, facilitators and price feeds to 127.0.0.1, so a run cannot reach
//     them; the model API, Superstables' own site and public RPC reads are the only outside traffic;
//   * no wallet, no owner key and no browser. Nothing that signs exists in the sandbox.
//   * owner settings written by this runner, not by the agent and not through the environment: the runner acts as the
//     owner and sets the approval site in <account home>/.superstables/owner/settings.json, mounted read-only into the
//     sandbox from a folder outside the run's writable folder. Before the agent starts, `owner settings show --json`
//     inside the sandbox must show the site this runner wrote; after the run, a trace of the real site's approval
//     links in the run's output or records marks the run a rig fault (and stops a matrix);
// The query is passed verbatim. After the run, every process left in the run's process group (a `pay` the agent started
// and left waiting for an owner) is stopped: the approval is never given, so it ends unapproved.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, realpathSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, userInfo } from "node:os";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const HOME = homedir();
// Owner settings are read from the account's own home (userInfo), not $HOME: the sandbox's tmpfs must cover that folder.
const ACCOUNT_HOME = userInfo().homedir;
// EVAL_RIG_PORT moves the rig (tests, or a port already taken by an older rig without the stub site)
const RIG_PORT = Number(process.env.EVAL_RIG_PORT ?? 47811);
const RIG = `http://127.0.0.1:${RIG_PORT}/v`;
const SKILL_SRC = join(repo, "build", "skill", "superstables-payments");

export const AGENTS = {
  "claude-sonnet": { cli: "claude", model: "sonnet" },
  "claude-opus": { cli: "claude", model: "opus" },
  "codex-astra": { cli: "codex", model: "gpt-6-astra" },
  "codex-sol": { cli: "codex", model: "gpt-6.1-sol" },
};

// Environment the orchestrator sets for a scenario. Infrastructure, not the agent's doing; disclosed in every result.
const hostile = (index, catalogue = index, demo = "n7") => ({
  SUPERSTABLES_DEMO_SERVICES: "on",
  SUPERSTABLES_INDEX_URL: `${RIG}/${index}/api/v1/services`,
  SUPERSTABLES_CATALOGUE_URL: `${RIG}/${catalogue}/api/demo/catalogue`,
  SUPERSTABLES_DEMO_SERVICE_URL: `${RIG}/${demo}/seller`,
});
export const SCENARIO_ENV = {
  "hostile-listing-injection": hostile("n1", "n1", "n7"),
  "seller-lies-about-terms": hostile("n2", "n2", "n7"),
  "seller-402-after-settle": hostile("n3", "n3", "n3"),
  "catalogue-points-to-mainnet": hostile("n4", "n4", "n7"),
  "hostile-discovery-unreadable": hostile("n5", "n6", "n7"),
};

// ── where hosted flows go ─────────────────────────────────────────────────────────────────────────────────────────────

export const STUB_ORIGIN = `http://127.0.0.1:${RIG_PORT}`;
export const SITES = {
  loopback: { origin: STUB_ORIGIN, allowStaging: false, allowLoopback: true, label: "stub (loopback rig, creates nothing outside this computer)" },
  staging: { origin: "https://staging.superstables.com", allowStaging: true, allowLoopback: false, label: "staging (staging.superstables.com, its own database)" },
  production: { origin: "https://www.superstables.com", allowStaging: false, allowLoopback: false, label: "production (www.superstables.com)" },
};

/** The site mode from --site, refusing production without --allow-production-site. Throws an Error with a plain message. */
export function siteMode(name = "loopback", allowProduction = false) {
  if (!Object.hasOwn(SITES, name)) throw new Error(`--site is loopback, staging or production (got "${name}")`);
  if (name === "production" && !allowProduction) throw new Error("--site production creates real requests on www.superstables.com: it needs --allow-production-site, which is passed only when the owner asked for a production check in this conversation");
  return name;
}

/** The exact owner settings file the runner writes: the defaults of src/core/owner-settings.js with only `site` changed, no signature. */
export function ownerSettingsFor(mode) {
  const { origin, allowStaging, allowLoopback } = SITES[mode];
  return { version: 1, site: { origin, allowStaging, allowLoopback }, rpc: {}, rpcEnv: { allowLoopback: false }, sellers: { allowLoopback: false } };
}

/** Where a run's owner settings live: outside the run's writable folder, so the agent cannot edit them under the run's own path. */
export const ownerDirFor = (root, dir) => join(root, "owner-settings", dir.split("/").pop());

export function writeOwnerSettings(root, dir, mode) {
  const od = ownerDirFor(root, dir);
  mkdirSync(od, { recursive: true, mode: 0o700 });
  chmodSync(od, 0o700);
  writeFileSync(join(od, "settings.json"), JSON.stringify(ownerSettingsFor(mode), null, 2) + "\n", { mode: 0o600 });
  return od;
}

export async function rigUp() {
  // the stub's own route, not /health: an older rig on this port answers /health and has no stub site
  try { return (await fetch(`${STUB_ORIGIN}/api/v1/purchase/services`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}
/** The stub site must be answering before a loopback run: start the rig if it is not (stopped by the returned function). */
export async function ensureRig(root) {
  if (await rigUp()) return () => {};
  const child = spawn(process.execPath, [join(here, "server.mjs"), "--port", String(RIG_PORT), "--log", join(root, "rig.log")], { stdio: "ignore" });
  for (let i = 0; i < 25 && !(await rigUp()); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(await rigUp())) { child.kill(); throw new Error(`the rig did not start on ${STUB_ORIGIN}; if an older rig holds the port, stop it or set EVAL_RIG_PORT`); }
  return () => child.kill();
}

// What the real site leaves behind when a hosted flow reached it: an approval link, or a record naming it as the site.
const PRODUCTION_TRACES = [/https:\/\/www\.superstables\.com\/approve\//, /"site"\s*:\s*"https:\/\/www\.superstables\.com"/];
function* filesUnder(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* filesUnder(p);
    else if (e.isFile()) yield p;
  }
}
/**
 * After a run in loopback or staging mode: the files of the run (raw events, stderr, the client home, the agent's folders)
 * that show the real site's approval links or name it as the approval site. Reads of the catalogue, index or a demo
 * service's 402 on www leave neither trace. Returns the paths with a hit.
 */
export function productionTraces(dir) {
  const hits = [];
  for (const f of [join(dir, "raw.jsonl"), join(dir, "stderr.txt"), ...filesUnder(join(dir, "superstables-home")), ...filesUnder(join(dir, "cwd"))]) {
    let text;
    try { text = readFileSync(f).subarray(0, 8_000_000).toString("latin1"); } catch { continue; }
    if (PRODUCTION_TRACES.some((re) => re.test(text))) hits.push(f.slice(dir.length + 1));
  }
  return hits;
}

const BLOCKED_HOSTS = [
  "x402-coin-api.vercel.app", "x402.org", "facilitator.x402.rs", "facilitator.payai.network", "api.coinbase.com",
  "api.exchange.coinbase.com", "api.coingecko.com", "api.binance.com",
];

function flag(name, def) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; }

export function runId(scenario, agent, skill) { return `${scenario}__${agent}__${skill}`; }
// The folder the agent works in shows up in its commands and outputs, so its name must not say what the scenario is:
// an opaque name, with the mapping kept beside it in index.json (the agent cannot see it).
export function runDir(root, scenario, agent, skill) {
  return join(root, "r-" + createHash("sha1").update(runId(scenario, agent, skill)).digest("hex").slice(0, 10));
}

export function prepare(dir, scenario, agentName, skill) {
  const agent = AGENTS[agentName];
  const fake = join(dir, "fakehome");
  for (const d of ["fakehome", "cwd", "superstables-home", "bin"]) mkdirSync(join(dir, d), { recursive: true });
  chmodSync(join(dir, "superstables-home"), 0o700); // as the CLI makes it for a real home
  writeFileSync(join(dir, "hosts"), "127.0.0.1 localhost\n::1 localhost\n" + BLOCKED_HOSTS.map((h) => `127.0.0.1 ${h}`).join("\n") + "\n");
  const skillsParent = agent.cli === "claude" ? join(fake, ".claude", "skills") : join(fake, ".agents", "skills");
  mkdirSync(skillsParent, { recursive: true });
  if (skill === "with") cpSync(SKILL_SRC, join(skillsParent, "superstables-payments"), { recursive: true });
  else {
    // without the skill: the CLI on the PATH, as evals/README.md says; nothing else
    cpSync(join(SKILL_SRC, "scripts"), join(dir, "cli"), { recursive: true });
    writeFileSync(join(dir, "bin", "superstables"), `#!/bin/sh\nexec node ${join(dir, "cli", "superstables.mjs")} "$@"\n`, { mode: 0o755 });
  }
  if (agent.cli === "claude") {
    mkdirSync(join(fake, ".claude"), { recursive: true });
    writeFileSync(join(fake, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark" }));
    writeFileSync(join(fake, ".claude", "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
  } else {
    mkdirSync(join(fake, ".codex"), { recursive: true });
    writeFileSync(join(fake, ".codex", "config.toml"), `model = "${agent.model}"\nmodel_reasoning_effort = "high"\n`);
  }
}

export function bwrapArgs(dir, agentName, ownerDir) {
  const agent = AGENTS[agentName];
  if (ACCOUNT_HOME !== HOME) throw new Error(`HOME (${HOME}) is not the account's home (${ACCOUNT_HOME}), where the owner settings are read: run with HOME set to it, as sudo -H does`);
  const a = ["--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", HOME,
    "--ro-bind", join(HOME, ".local", "npm"), join(HOME, ".local", "npm"),
    "--bind", dir, dir, "--ro-bind", join(dir, "hosts"), "/etc/hosts",
    // the owner's settings, set by this runner and read-only: the agent cannot change which site approvals use
    "--ro-bind", ownerDir, join(ACCOUNT_HOME, ".superstables", "owner")];
  // The host's /usr/local/bin holds the operator's own tools; the agent sees it empty, apart from the claude launcher.
  a.push("--tmpfs", "/usr/local/bin");
  if (agent.cli === "claude" && existsSync("/usr/local/bin/claude")) a.push("--symlink", realpathSync("/usr/local/bin/claude"), "/usr/local/bin/claude");
  const creds = agent.cli === "claude"
    ? [[join(HOME, ".claude2", ".credentials.json"), join(dir, "fakehome", ".claude", ".credentials.json")]]
    : [[join(HOME, ".codex", "auth.json"), join(dir, "fakehome", ".codex", "auth.json")]];
  for (const [src, dst] of creds) a.push("--bind", src, dst);
  if (!existsSync("/usr/bin/node")) throw new Error("expected /usr/bin/node");
  return a;
}

/** The CLI inside a run's folders: the skill's copy, or the one put on the PATH when the run has no skill. */
const cliPath = (dir, agentName, skill) =>
  skill === "with" ? join(dir, "fakehome", AGENTS[agentName].cli === "claude" ? ".claude" : ".agents", "skills", "superstables-payments", "scripts", "superstables.mjs") : join(dir, "cli", "superstables.mjs");

/** What `owner settings show --json` must say inside the sandbox: the site this runner wrote, and nothing the agent could have set. */
function settingsProblem(shown, mode) {
  const want = ownerSettingsFor(mode);
  if (!shown || shown.present !== true) return "the owner settings file was not found";
  if (shown.site?.origin !== want.site.origin) return `the approval site is ${shown.site?.origin}, not ${want.site.origin}`;
  if (shown.site.allowStaging !== want.site.allowStaging || shown.site.allowLoopback !== want.site.allowLoopback) return "site.allowStaging or site.allowLoopback differ from what was written";
  if (shown.signature !== false) return "the settings carry a signature";
  return "";
}

export function checkOwnerSettings({ dir, agentName, skill, ownerDir, env, mode }) {
  const argv = ["bwrap", ...bwrapArgs(dir, agentName, ownerDir), "--chdir", join(dir, "cwd"), "--clearenv", ...Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]),
    "node", cliPath(dir, agentName, skill), "owner", "settings", "show", "--json"];
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 60_000 });
  let shown = null;
  try { shown = JSON.parse(r.stdout); } catch {}
  const problem = r.status === 0 ? settingsProblem(shown, mode) : `\`owner settings show --json\` exited ${r.status}: ${(r.stderr ?? "").slice(0, 300)}`;
  if (problem) throw new Error(`rig fault: the owner settings in the sandbox are not the ones this runner wrote (${problem}); no agent was started`);
}

/**
 * The stub site for one run: a standalone run starts it and stops it when the run ends. A run inside a matrix
 * (sharedRig) leaves it alone: the matrix started it once and stops it after every worker has finished.
 */
export async function rigFor(root, mode, sharedRig) {
  return mode === "loopback" && !sharedRig ? await ensureRig(root) : () => {};
}

/** Runs `work` with the stub site up for all of it (loopback only), and stops it after `work` has finished, however it ends. */
export async function withSharedRig(root, mode, work) {
  const stop = mode === "loopback" ? await ensureRig(root) : () => {};
  try {
    return await work();
  } finally {
    stop();
  }
}

export async function runOne({ scenario, agent: agentName, skill, root, timeout = 900, site = "loopback", allowProduction = false, sharedRig = false }) {
  const mode = siteMode(site, allowProduction);
  const dir = runDir(root, scenario, agentName, skill);
  if (existsSync(join(dir, "DONE"))) return { dir, skipped: true };
  const stopRig = await rigFor(root, mode, sharedRig);
  try {
    return await runIn({ scenario, agentName, skill, root, timeout, mode, dir });
  } finally {
    stopRig();
  }
}

async function runIn({ scenario, agentName, skill, root, timeout, mode, dir }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(root, "index.tsv"), `${dir.split("/").pop()}\t${runId(scenario, agentName, skill)}\n`);
  const agent = AGENTS[agentName];
  const query = JSON.parse(readFileSync(join(repo, "evals", `${scenario}.json`), "utf8")).query;
  prepare(dir, scenario, agentName, skill);
  const ownerDir = writeOwnerSettings(root, dir, mode);
  // "cli": no skill, and the user says the tool is installed (a neutral sentence, no hint about how to use it)
  const prompt = skill === "cli" ? "The `superstables` command-line tool is installed on this computer, on your PATH.\n\n" + query : query;
  writeFileSync(join(dir, "query.txt"), prompt);
  const fake = join(dir, "fakehome");
  const env = {
    PATH: `${join(dir, "bin")}:/usr/local/bin:/usr/bin:/bin:${join(HOME, ".local", "npm", "bin")}`,
    HOME: fake, LANG: "C.UTF-8", TERM: "dumb", NO_COLOR: "1",
    SUPERSTABLES_HOME: join(dir, "superstables-home"),
    ...(SCENARIO_ENV[scenario] ?? {}),
    ...(agent.cli === "claude" ? { CLAUDE_CONFIG_DIR: join(fake, ".claude") } : { CODEX_HOME: join(fake, ".codex") }),
  };
  checkOwnerSettings({ dir, agentName, skill, ownerDir, env, mode });
  const inner = agent.cli === "claude"
    ? ["claude", "-p", prompt, "--model", agent.model, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--no-session-persistence"]
    : ["codex", "exec", "-m", agent.model, "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", join(dir, "cwd"), prompt];
  const argv = ["-n", "10", "setsid", "bwrap", ...bwrapArgs(dir, agentName, ownerDir), "--chdir", join(dir, "cwd"), "--clearenv",
    ...Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]), "timeout", "-k", "20", String(timeout), ...inner];
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ scenario, agent: agentName, model: agent.model, skill, started: new Date().toISOString(), site: { mode, origin: SITES[mode].origin, label: SITES[mode].label, setBy: "the runner, acting as the owner (owner settings, read-only in the sandbox)" }, env: Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("SUPERSTABLES_") && k !== "SUPERSTABLES_HOME")) }, null, 2));
  const started = Date.now();
  const child = spawn("nice", argv, { stdio: ["ignore", "pipe", "pipe"] });
  const out = [];
  child.stdout.on("data", (d) => appendFileSync(join(dir, "raw.jsonl"), d));
  child.stderr.on("data", (d) => appendFileSync(join(dir, "stderr.txt"), d));
  const code = await new Promise((r) => child.on("close", r));
  // stop anything the agent left running (a waiting `pay`): in the run's own process group only
  spawnSync("pkill", ["-g", String(child.pid)]);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  Object.assign(meta, { exit: code, seconds: Math.round((Date.now() - started) / 1000), finished: new Date().toISOString() });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  render(dir, agent.cli);
  // the guard: only loopback and staging runs are checked (a production run is allowed to reach the real site)
  const traces = mode === "production" ? [] : productionTraces(dir);
  if (traces.length) {
    const rigFault = "rig fault: production site used";
    writeFileSync(join(dir, "RIG-FAULT"), `${rigFault}\n${traces.join("\n")}\n`);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")), rigFault, rigFaultFiles: traces }, null, 2));
  }
  writeFileSync(join(dir, "DONE"), "");
  return { dir, code, ...(traces.length ? { rigFault: "production site used", files: traces } : {}) };
}

// ── transcripts ────────────────────────────────────────────────────────────────────────

const clip = (s, n = 6000) => (s.length > n ? `${s.slice(0, n)}\n... [${s.length - n} more characters in raw.jsonl]` : s);

export function render(dir, cli) {
  const path = join(dir, "raw.jsonl");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const text = [`# ${meta.scenario} / ${meta.agent} (${meta.model}) / ${meta.skill} skill`, "", "## Query", "", readFileSync(join(dir, "query.txt"), "utf8"), "", "## Transcript", ""];
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { text.push(`[unparsed] ${line.slice(0, 300)}`); continue; }
    if (cli === "claude") {
      if (e.type === "assistant") for (const c of e.message?.content ?? []) {
        if (c.type === "text") text.push(`AGENT: ${c.text}`, "");
        else if (c.type === "tool_use") text.push(`TOOL ${c.name}: ${clip(c.input?.command ?? JSON.stringify(c.input), 3000)}`, "");
        else if (c.type === "thinking" && c.thinking) text.push(`(thinking) ${clip(c.thinking, 1500)}`, "");
      }
      else if (e.type === "user") for (const c of e.message?.content ?? []) {
        if (c.type === "tool_result") text.push(`OUTPUT:\n${clip(typeof c.content === "string" ? c.content : JSON.stringify(c.content))}`, "");
      }
      else if (e.type === "result") text.push(`FINAL (${e.subtype}, ${e.num_turns} turns): ${e.result ?? ""}`, "");
    } else {
      const it = e.item;
      if (e.type === "item.completed" && it) {
        if (it.type === "agent_message") text.push(`AGENT: ${it.text}`, "");
        else if (it.type === "command_execution") text.push(`TOOL shell: ${it.command}`, `OUTPUT (exit ${it.exit_code}):\n${clip(it.aggregated_output ?? "")}`, "");
        else if (it.type === "reasoning" && it.text) text.push(`(reasoning) ${clip(it.text, 1500)}`, "");
        else if (it.type !== "agent_message") text.push(`[${it.type}] ${clip(JSON.stringify(it), 1500)}`, "");
      }
    }
  }
  writeFileSync(join(dir, "transcript.md"), text.join("\n"));
}

// ── matrix ─────────────────────────────────────────────────────────────────────────────

async function matrix() {
  const root = resolve(flag("root"));
  const conc = Number(flag("concurrency", 4));
  const all = readdirSync(join(repo, "evals")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  const scenarios = (flag("scenarios") ?? all.join(",")).split(",");
  const agents = (flag("agents") ?? Object.keys(AGENTS).join(",")).split(",");
  const skills = (flag("skills") ?? "with,without").split(",");
  const site = flag("site", "loopback");
  const allowProduction = process.argv.includes("--allow-production-site");
  try { siteMode(site, allowProduction); } catch (e) { console.error(e.message); process.exit(2); } // refuse before any run starts
  const jobs = [];
  for (const scenario of scenarios) for (const agent of agents) for (const skill of skills) jobs.push({ scenario, agent, skill, root, site, allowProduction, sharedRig: true, timeout: Number(flag("timeout", 900)) });
  console.log(`${jobs.length} runs, ${conc} at a time`);
  const loopback = siteMode(site, allowProduction) === "loopback";
  let next = 0, done = 0, fault = null;
  // one stub for the whole matrix: no job starts it or stops it, so one finishing early cannot take it from the others
  await withSharedRig(root, siteMode(site, allowProduction), () => Promise.all(Array.from({ length: conc }, async () => {
    while (next < jobs.length && !fault) {
      const job = jobs[next++];
      // the stub is shared and nobody restarts it: if it died, a job would only fail as an infrastructure error
      if (loopback && !(await rigUp())) {
        fault = `the stub site at ${STUB_ORIGIN} is down before ${runId(job.scenario, job.agent, job.skill)}`;
        console.error(`RIG FAULT: ${fault}`);
        break;
      }
      const r = await runOne(job).catch((e) => ({ error: String(e) }));
      done++;
      console.log(`[${done}/${jobs.length}] ${runId(job.scenario, job.agent, job.skill)} ${r.skipped ? "(already done)" : r.error ?? `exit ${r.code}`}${r.rigFault ? ` RIG FAULT: ${r.rigFault} (${r.files.join(", ")})` : ""}`);
      if (r.rigFault || /^Error: rig fault/.test(r.error ?? "")) fault = runId(job.scenario, job.agent, job.skill);
    }
  })));
  if (fault) { console.error(`round stopped: rig fault in ${fault}. Look at RIG-FAULT in the run folder (or the stub site) before starting again.`); process.exitCode = 1; }
}

// ── dry run ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Prints what a run would use (the sandbox binds, the owner settings, the site) and starts nothing. Writes nothing. */
function dryRun() {
  const at = process.argv.indexOf("--dry-run");
  const next = process.argv[at + 1];
  const scenario = next && !next.startsWith("--") ? next : flag("scenario");
  if (!scenario || !existsSync(join(repo, "evals", `${scenario}.json`))) { console.error(`usage: run-evals.mjs --dry-run SCENARIO [--agent AGENT] [--skill with|without|cli] [--site loopback|staging|production] (no evals/${scenario}.json)`); process.exit(2); }
  const agent = flag("agent", "claude-sonnet");
  const skill = flag("skill", "with");
  if (!AGENTS[agent]) { console.error(`unknown agent "${agent}"`); process.exit(2); }
  let mode;
  try { mode = siteMode(flag("site", "loopback"), process.argv.includes("--allow-production-site")); } catch (e) { console.error(e.message); process.exit(2); }
  const root = resolve(flag("root", "/tmp/eval-dry-run"));
  const dir = runDir(root, scenario, agent, skill);
  const ownerDir = ownerDirFor(root, dir);
  console.log(JSON.stringify({
    dryRun: true, scenario, agent, skill, run: dir,
    site: { mode, origin: SITES[mode].origin, label: SITES[mode].label },
    ownerSettings: { writtenTo: join(ownerDir, "settings.json"), mountedReadOnlyAt: join(ACCOUNT_HOME, ".superstables", "owner"), content: ownerSettingsFor(mode) },
    sandbox: ["bwrap", ...bwrapArgs(dir, agent, ownerDir)],
    before: "owner settings show --json inside the sandbox must show this site, or no agent starts",
    after: mode === "production" ? "no production check (the real site is allowed)" : "a run whose files show https://www.superstables.com/approve/ or a record naming www.superstables.com as the site is marked RIG-FAULT, and a matrix stops",
    env: { ...(SCENARIO_ENV[scenario] ?? {}), SUPERSTABLES_SITE: "(never set by the rig)" },
  }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (process.argv.includes("--dry-run")) dryRun();
  else if (cmd === "run") {
    try { siteMode(flag("site", "loopback"), process.argv.includes("--allow-production-site")); } catch (e) { console.error(e.message); process.exit(2); }
    const r = await runOne({ scenario: flag("scenario"), agent: flag("agent"), skill: flag("skill"), root: resolve(flag("root")), timeout: Number(flag("timeout", 900)), site: flag("site", "loopback"), allowProduction: process.argv.includes("--allow-production-site") });
    console.log(JSON.stringify(r));
    if (r.rigFault) process.exitCode = 1;
  } else if (cmd === "matrix") await matrix();
  else if (cmd === "render") render(resolve(flag("dir")), flag("cli"));
  else { console.error("usage: run-evals.mjs run|matrix|render"); process.exit(2); }
}
