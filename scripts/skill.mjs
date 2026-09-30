#!/usr/bin/env node
// Builds the standalone Agent Skill: build/skill/superstables-budget/ and build/superstables-budget-skill-<version>.zip.
//
// The skill is budget/SKILL.md with the files it points to, plus scripts/: a copy of dist/budget, which
// scripts/budget-build.mjs makes self-contained. So the skill needs Node 20 or newer and nothing else: no checkout, no
// npm install. The agent runs `node <skill folder>/scripts/cli.mjs <command>`. Keys and state live where every copy of
// the tool keeps them ($SUPERSTABLES_HOME, default ~/.superstables). scripts/VERSION.json names the build, and
// scripts/THIRD_PARTY_NOTICES.txt the bundled packages and their licences.
//
// There is one SKILL.md. The zip's copy differs in one paragraph, between the <!-- run: --> and <!-- /run --> markers:
// how to run the tool. The zip is written with fflate, so no zip program is needed (Windows has none by default).
//
// node scripts/skill.mjs [--dev]   --dev stamps the version with the commit, like npm run bundle -- --dev.

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { buildBudget } from "./budget-build.mjs";
import { devVersion, revisionOf } from "./dev-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "superstables-budget"; // the folder the zip unpacks to, and the skill's name in SKILL.md
const outRoot = join(root, "build", "skill");
const out = join(outRoot, NAME);

const RUN_IN_ZIP = `\`superstables budget\` is \`node scripts/cli.mjs\` in this skill's folder (the folder this SKILL.md is in). Run it with that folder's absolute path, for example \`node ~/.claude/skills/${NAME}/scripts/cli.mjs doctor --rail evm\`. It needs Node 20+ and nothing else: \`scripts/\` holds the whole tool, bundled. \`node scripts/cli.mjs --version\` names the build. Keys and state are in \`$SUPERSTABLES_HOME\` (default \`~/.superstables\`), shared with any other copy of the tool on this computer. Testnet only: \`--mainnet\` or a mainnet chain is refused.`;

const { outdir: built, version: stamp } = await buildBudget();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.argv.includes("--dev") ? devVersion(pkg.version, revisionOf(root)) : pkg.version;

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(built, join(out, "scripts"), { recursive: true });
if (version !== stamp.version) writeFileSync(join(out, "scripts", "VERSION.json"), JSON.stringify({ ...stamp, version }, null, 2) + "\n");

const skill = readFileSync(join(root, "budget", "SKILL.md"), "utf8");
const block = /<!-- run:[^>]*-->\n[\s\S]*?\n<!-- \/run -->\n/g;
if ((skill.match(block) ?? []).length !== 1) throw new Error("budget/SKILL.md needs exactly one <!-- run: --> ... <!-- /run --> paragraph (how to run the tool)");
writeFileSync(join(out, "SKILL.md"), skill.replace(block, RUN_IN_ZIP + "\n"));
for (const f of ["references", "agents", "README.md", "CLI.md", "CONTRACT.md"]) cpSync(join(root, "budget", f), join(out, f), { recursive: true });
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));

// Every file under build/skill/, with forward slashes, dated at the build time so the same build zips the same.
const mtime = new Date(stamp.builtAt);
const entries = {};
for (const f of readdirSync(outRoot, { recursive: true }).map(String).sort()) {
  const p = join(outRoot, f);
  if (statSync(p).isFile()) entries[f.split(sep).join("/")] = [readFileSync(p), { mtime }];
}
mkdirSync(join(root, "build"), { recursive: true });
const zipPath = join(root, "build", `${NAME}-skill-${version}.zip`);
writeFileSync(zipPath, zipSync(entries, { level: 9 }));

const size = (dir) => readdirSync(dir, { recursive: true }).reduce((n, f) => n + (statSync(join(dir, f)).isFile() ? statSync(join(dir, f)).size : 0), 0);
console.log(`\nSkill: ${relative(root, out)}/ (${(size(out) / 1e6).toFixed(2)} MB unpacked, ${Object.keys(entries).length} files)`);
console.log(`Zip:   ${relative(root, zipPath)} (${(statSync(zipPath).size / 1e6).toFixed(2)} MB)`);
