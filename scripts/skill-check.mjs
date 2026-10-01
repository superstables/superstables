#!/usr/bin/env node
// Checks the skill zip the way a user gets it: unpacked into an empty folder outside the repository, with no
// node_modules anywhere above it and $SUPERSTABLES_HOME in a fresh temporary folder, then run with node alone.
//
// It runs `--version`, `--help`, `find --help`, `find btc --json` (a read of the hosted catalogue: needs the network),
// `budget --help`, `budget --version` and `budget doctor --rail evm` (reads keys and balances, signs nothing). Any
// import the bundle is missing fails here, not on a user's machine.
//
// node scripts/skill-check.mjs [--zip <path>]   default build/superstables-payments-skill-<package.json version>.zip

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "superstables-payments";
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const i = process.argv.indexOf("--zip");
const zip = i > 0 ? resolve(process.argv[i + 1]) : join(root, "build", `${NAME}-skill-${pkg.version}.zip`);
if (!existsSync(zip)) throw new Error(`${zip} does not exist: run npm run skill first`);

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "superstables-skill-check-")));
let failed = 0;
try {
  if (tmp.startsWith(root)) throw new Error(`the temporary folder ${tmp} is inside the repository`);
  for (let d = tmp; ; d = dirname(d)) {
    if (existsSync(join(d, "node_modules"))) throw new Error(`${join(d, "node_modules")} exists above the check folder; the check needs a tree without one`);
    if (d === parse(d).root) break;
  }

  const skills = join(tmp, "skills");
  for (const [name, data] of Object.entries(unzipSync(readFileSync(zip)))) {
    if (name.endsWith("/")) continue;
    mkdirSync(dirname(join(skills, name)), { recursive: true });
    writeFileSync(join(skills, name), data);
  }
  const cli = join(skills, NAME, "scripts", "superstables.mjs");
  if (!existsSync(cli)) throw new Error(`the zip has no ${NAME}/scripts/superstables.mjs`);
  const built = JSON.parse(readFileSync(join(skills, NAME, "scripts", "VERSION.json"), "utf8"));

  const env = { ...process.env, SUPERSTABLES_HOME: join(tmp, "home") };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const run = (script, args) => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd: tmp, env, encoding: "utf8", timeout: 120_000 });
    return { code: r.status, out: r.stdout ?? "", err: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
  };
  const check = (label, r, ok) => {
    const why = ok(r);
    const pass = why === true;
    if (!pass) failed++;
    console.log(`${pass ? "ok  " : "FAIL"} ${label} (exit ${r.code})${pass ? "" : `: ${why}\n--- stdout\n${r.out.trim()}\n--- stderr\n${r.err.trim()}`}`);
  };
  const exit0 = (r) => r.code === 0 || `exit ${r.code}`;
  const noMissingModule = (r) => !/Cannot find (module|package)|ERR_MODULE_NOT_FOUND/.test(r.out + r.err) || "a module is missing";

  check("--version", run(cli, ["--version"]), (r) => exit0(r) === true && (r.out.trim() === built.version || `printed ${r.out.trim()}, VERSION.json says ${built.version}`));
  check("--help", run(cli, ["--help"]), (r) => exit0(r) === true && (/\bfind\b/.test(r.out) || "no find command in the help"));
  check("find --help", run(cli, ["find", "--help"]), exit0);
  check("find btc --json", run(cli, ["find", "btc", "--json"]), (r) => {
    if (r.code !== 0) return `exit ${r.code}`;
    try {
      JSON.parse(r.out);
      return true;
    } catch {
      return "stdout is not JSON";
    }
  });

  // `superstables budget` in a build runs ../budget/cli.mjs next to cli/main.mjs: the zip's own bundled budget.
  const budget = (args) => run(cli, ["budget", ...args]);
  check("budget --help", budget(["--help"]), (r) => exit0(r) === true && (/doctor/.test(r.out + r.err) || "no doctor command in the help"));
  check("budget --version", budget(["--version"]), (r) => exit0(r) === true && (/standalone build/.test(r.out) || "not reported as the standalone build"));
  // No keys in a fresh home: doctor reports what is missing and exits non-zero. It must still run and print RESULT.
  check("budget doctor --rail evm", budget(["doctor", "--rail", "evm"]), (r) => noMissingModule(r) === true && (/^RESULT \{/m.test(r.out) || "no RESULT line"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (failed) {
  console.error(`\n${failed} check${failed === 1 ? "" : "s"} failed`);
  process.exit(1);
}
console.log(`\n${zip.slice(root.length + 1)} runs with node alone`);
