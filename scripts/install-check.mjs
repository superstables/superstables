#!/usr/bin/env node
// Installs the client the ways people install it, each in an empty folder, and runs it there.
//
//   checkout   a copy of this checkout (tracked and untracked files, uncommitted changes included): npm ci, npm run build,
//              then the command through `npm exec` in the checkout, the way its docs say (npx superstables ...)
//   tarball    npm pack in that checkout, then npm install <tgz> in an empty folder
//   omit-dev   the same checkout after npm prune --omit=dev: no tsx, no budget-only packages, so budget runs dist/budget
//   git        npm install git+file://...#<commit> in an empty folder: npm clones, installs the dev packages, runs
//              `prepare` (the build) and installs what it packs. It installs HEAD, committed changes only.
//
// Each route runs, with SUPERSTABLES_HOME in a fresh temporary folder and the working directory an empty folder:
//   superstables --help, superstables find --help, superstables budget --help, superstables budget --version,
//   superstables budget doctor --rail evm   (no keys here: it reads the RPC, fails its key checks and must still end with
//                                            a RESULT line and exit 0 or 1, never a crash)
// and checks what the route must and must not install. Every command has a time limit, so nothing can hang.
//
// node scripts/install-check.mjs [checkout] [tarball] [omit-dev] [git] [--keep]   (no route named: all four)

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES = ["checkout", "tarball", "omit-dev", "git"];
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const unknown = args.filter((a) => a !== "--keep" && !ROUTES.includes(a));
if (unknown.length) {
  console.error(`install-check: unknown argument ${unknown.join(" ")}. Routes: ${ROUTES.join(", ")}`);
  process.exit(2);
}
const wanted = args.filter((a) => ROUTES.includes(a));
const routes = wanted.length ? ROUTES.filter((r) => wanted.includes(r)) : ROUTES;
if (process.platform === "win32") {
  console.error("install-check: runs on Linux and macOS (and WSL)");
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "superstables-install-check-"));
const BUDGET_ONLY = ["@solana/web3.js", "mppx", "bs58", "@x402/fetch"];
const COMMAND_LIMIT_MS = 120_000;
const INSTALL_LIMIT_MS = 900_000;

// npm run sets npm_* variables (the calling project's config and paths); the installs here must not inherit them.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));

function sh(cmd, cmdArgs, cwd, env = cleanEnv) {
  console.log(`\n$ (cd ${cwd} && ${cmd} ${cmdArgs.join(" ")})`);
  execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit", env, timeout: INSTALL_LIMIT_MS });
}

const failures = [];
const results = [];
function check(route, what, ok, detail = "") {
  results.push({ route, what, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(`${route}: ${what}${detail ? `: ${detail}` : ""}`);
}

const emptyDir = (name) => {
  const d = join(work, name);
  mkdirSync(d, { recursive: true });
  return d;
};

/**
 * Runs the installed command and checks it. `superstables` is [program, ...args] that starts it.
 * `version` is a pattern the budget --version line must match: which build this route runs.
 */
function exercise(route, superstables, { version, cwd }) {
  const home = mkdtempSync(join(work, `home-${route}-`));
  const env = { ...cleanEnv, SUPERSTABLES_HOME: home };
  const run = (extra) => {
    const [cmd, ...pre] = superstables;
    console.log(`\n$ ${superstables.join(" ")} ${extra.join(" ")}`);
    const r = spawnSync(cmd, [...pre, ...extra], { cwd, env, encoding: "utf8", timeout: COMMAND_LIMIT_MS });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    process.stdout.write(out.split("\n").slice(0, 12).map((l) => `    ${l}`).join("\n") + "\n");
    if (r.error) console.log(`    (${r.error.message})`);
    console.log(`    exit ${r.status ?? r.signal}`);
    return r;
  };
  let r = run(["--help"]);
  check(route, "superstables --help", r.status === 0 && /Usage: superstables/.test(r.stdout), `exit ${r.status ?? r.signal}`);
  r = run(["find", "--help"]);
  check(route, "superstables find --help", r.status === 0 && /Usage: superstables find/.test(r.stdout), `exit ${r.status ?? r.signal}`);
  r = run(["budget", "--help"]);
  check(route, "superstables budget --help", r.status === 0 && /superstables budget setup/.test(r.stdout), `exit ${r.status ?? r.signal}`);
  r = run(["budget", "--version"]);
  check(route, "superstables budget --version", r.status === 0 && version.test(r.stdout), `exit ${r.status ?? r.signal}, want ${version}`);
  r = run(["budget", "doctor", "--rail", "evm"]);
  const last = (r.stdout ?? "").trimEnd().split("\n").pop() ?? "";
  let result = null;
  try { result = last.startsWith("RESULT {") ? JSON.parse(last.slice(7)) : null; } catch {}
  check(route, "superstables budget doctor --rail evm", (r.status === 0 || r.status === 1) && result?.command === "doctor", `exit ${r.status ?? r.signal}, ${result ? `RESULT state ${result.state}` : "no RESULT line"}`);
}

/** Checks an installed @superstables/client under node_modules: dist/budget with its notices, no budget-only packages. */
function checkInstalled(route, dir) {
  const pkg = join(dir, "node_modules", "@superstables", "client");
  check(route, "the package has dist/budget/cli.mjs", existsSync(join(pkg, "dist", "budget", "cli.mjs")));
  check(route, "the package has dist/budget/THIRD_PARTY_NOTICES.txt", existsSync(join(pkg, "dist", "budget", "THIRD_PARTY_NOTICES.txt")));
  check(route, "the package has no budget/ sources", !existsSync(join(pkg, "budget")));
  const present = BUDGET_ONLY.filter((p) => existsSync(join(dir, "node_modules", p)));
  check(route, "no budget-only package installed", present.length === 0, present.join(", "));
}

// ---- the checkout copy: the files git knows about or would add, as they are on disk now ----------------------------
function copyCheckout(to) {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of files) {
    const from = join(root, f);
    if (!existsSync(from) || lstatSync(from).isDirectory()) continue; // deleted, or a nested repository
    mkdirSync(dirname(join(to, f)), { recursive: true });
    copyFileSync(from, join(to, f));
  }
  return files.length;
}

const checkoutDir = join(work, "checkout");
let checkoutReady = false;
function prepareCheckout() {
  if (checkoutReady) return;
  const n = copyCheckout(checkoutDir);
  console.log(`\ninstall-check: copied ${n} files of this checkout to ${checkoutDir}`);
  sh("npm", ["ci", "--no-audit", "--no-fund"], checkoutDir); // prepare builds
  sh("npm", ["run", "build"], checkoutDir);
  checkoutReady = true;
}
const inCheckout = ["npm", "exec", "--prefix", checkoutDir, "--no", "--", "superstables"];

const version = JSON.parse(execFileSync("node", ["-p", "JSON.stringify(require('./package.json').version)"], { cwd: root, encoding: "utf8" }));

for (const route of routes) {
  console.log(`\n==== ${route} ${"=".repeat(90 - route.length)}`);
  try {
    if (route === "checkout") {
      prepareCheckout();
      exercise(route, inCheckout, { version: /\(checkout: runs the TypeScript sources with tsx/, cwd: emptyDir("run-checkout") });
    }
    if (route === "tarball") {
      prepareCheckout();
      const packs = emptyDir("packs");
      sh("npm", ["pack", "--pack-destination", packs], checkoutDir);
      const tgz = readdirSync(packs).find((f) => f.endsWith(".tgz"));
      const dir = emptyDir("install-tarball");
      sh("npm", ["install", "--no-audit", "--no-fund", join(packs, tgz)], dir);
      checkInstalled(route, dir);
      exercise(route, [join(dir, "node_modules", ".bin", "superstables")], { version: new RegExp(`^superstables budget ${version.replace(/\./g, "\\.")} \\(standalone build`), cwd: emptyDir("run-tarball") });
    }
    if (route === "omit-dev") {
      prepareCheckout();
      sh("npm", ["prune", "--omit=dev", "--no-audit", "--no-fund"], checkoutDir);
      checkoutReady = false; // the dev packages are gone: a later route needing them reinstalls
      check(route, "no tsx in the pruned checkout", !existsSync(join(checkoutDir, "node_modules", ".bin", "tsx")));
      const present = BUDGET_ONLY.filter((p) => existsSync(join(checkoutDir, "node_modules", p)));
      check(route, "no budget-only package in the pruned checkout", present.length === 0, present.join(", "));
      exercise(route, ["node", join(checkoutDir, "dist", "cli", "main.js")], { version: /\(standalone build.*has no tsx/, cwd: emptyDir("run-omit-dev") });
    }
    if (route === "git") {
      // A clone of HEAD with a branch on it, so npm can fetch it by name whatever this checkout's HEAD is (detached in
      // CI) and nothing in this checkout changes.
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim()) {
        console.log(`install-check: uncommitted changes are not part of this route: it installs HEAD (${sha.slice(0, 12)})`);
      }
      const src = join(work, "git-source");
      sh("git", ["clone", "--quiet", "--no-checkout", root, src], work);
      sh("git", ["branch", "install-check", sha], src);
      const dir = emptyDir("install-git");
      sh("npm", ["install", "--no-audit", "--no-fund", `git+${pathToFileURL(src).href}#install-check`], dir);
      checkInstalled(route, dir);
      exercise(route, [join(dir, "node_modules", ".bin", "superstables")], { version: new RegExp(`^superstables budget ${version.replace(/\./g, "\\.")} \\(standalone build, commit ${sha.slice(0, 7)}`), cwd: emptyDir("run-git") });
    }
  } catch (err) {
    check(route, "install", false, err.message.split("\n")[0]);
  }
}

console.log(`\n==== summary ${"=".repeat(84)}`);
for (const route of routes) {
  const mine = results.filter((r) => r.route === route);
  console.log(`  ${mine.every((r) => r.ok) && mine.length ? "ok  " : "FAIL"}  ${route} (${mine.filter((r) => r.ok).length}/${mine.length} checks)`);
}
if (keep) console.log(`\nkept ${work}`);
else rmSync(work, { recursive: true, force: true });
if (failures.length) {
  console.error(`\ninstall-check: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
