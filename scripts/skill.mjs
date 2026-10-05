#!/usr/bin/env node
// Builds the standalone Agent Skill: build/skill/superstables-payments/ and build/superstables-payments-skill-<version>.zip.
//
// The skill is skills/superstables-payments/ (SKILL.md, references/, agents/openai.yaml), plus scripts/: the whole
// `superstables` CLI with the budget, bundled by scripts/cli-build.mjs so that it imports only Node built-ins. So the
// skill needs Node 20 or newer and nothing else: no checkout, no npm install. The agent runs
// `node <skill folder>/scripts/superstables.mjs <command>`. Keys and state live where every copy of the tool keeps them
// ($SUPERSTABLES_HOME, default ~/.superstables). scripts/VERSION.json names the build, and
// scripts/THIRD_PARTY_NOTICES.txt the bundled packages and their licences.
//
// Only files git tracks in skills/superstables-payments/ are copied, so nothing left in the folder by hand (a key, a
// scratch file) can ship. The release builds this from a `git archive` export, which has no .git and so no `git ls-files` --
// but a tree that came out of `git archive` holds exactly the commit's files and nothing else, so the same rule holds
// without git: see trackedFiles in scripts/package-root.mjs.
//
// SUPERSTABLES_SKILL_FROM_ARCHIVE=1 is a promise by the caller, not something this build checks: it says the folder is an
// unmodified `git archive` export of the commit named in SUPERSTABLES_BUILD_COMMIT (which it then requires). The build
// cannot verify that; a file added to the export afterwards would ship. Set it only on a fresh export, as the release
// script does, and never in a checkout or a folder anyone has worked in. There is one SKILL.md. The zip's copy differs in one paragraph, between the <!-- run: -->
// and <!-- /run --> markers: how to run the tool. The zip is written with fflate, so no zip program is needed (Windows has
// none by default).
//
// node scripts/skill.mjs [--dev]   --dev stamps the build's version with the commit (<version>-dev.<commits>+g<sha>,
// see scripts/dev-version.mjs); package.json is not changed.

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { buildCli } from "./cli-build.mjs";
import { devVersion, revisionOf } from "./dev-version.mjs";
import { trackedFiles } from "./package-root.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "superstables-payments"; // the folder the zip unpacks to, and the skill's name in SKILL.md
const source = join(root, "skills", NAME);
const outRoot = join(root, "build", "skill");
const out = join(outRoot, NAME);

const RUN_IN_ZIP = `\`superstables\` is \`node scripts/superstables.mjs\` in this skill's folder (the folder this SKILL.md is in). Run it with that folder's absolute path, for example \`node ~/.claude/skills/${NAME}/scripts/superstables.mjs find weather\` or \`node ~/.claude/skills/${NAME}/scripts/superstables.mjs budget doctor --rail evm\`. It needs Node 20+ and nothing else: \`scripts/\` holds the whole tool, bundled. \`node scripts/superstables.mjs --version\` names the build. Keys and state are in \`$SUPERSTABLES_HOME\` (default \`~/.superstables\`), shared with any other copy of the tool on this machine.`;

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.argv.includes("--dev") ? devVersion(pkg.version, revisionOf(root)) : pkg.version;

rmSync(outRoot, { recursive: true, force: true });
const { version: stamp } = await buildCli(join(out, "scripts"), version);

// Tracked files only; outside the package's own checkout, only with the archive promise above. See package-root.mjs.
const tracked = trackedFiles(root, join("skills", NAME));
if (!tracked.includes("SKILL.md")) throw new Error(`skills/${NAME}/SKILL.md is not tracked by git; only tracked files are copied into the skill`);
for (const f of tracked) {
  if (f === "SKILL.md") continue;
  mkdirSync(dirname(join(out, f)), { recursive: true });
  cpSync(join(source, f), join(out, f));
}

const skill = readFileSync(join(source, "SKILL.md"), "utf8");
if (!new RegExp(`^---\\nname: ${NAME}\\n`).test(skill)) throw new Error(`skills/${NAME}/SKILL.md must start with front matter naming the skill ${NAME}`);
const block = /<!-- run:[^>]*-->\n[\s\S]*?\n<!-- \/run -->\n/g;
if ((skill.match(block) ?? []).length !== 1) throw new Error(`skills/${NAME}/SKILL.md needs exactly one <!-- run: --> ... <!-- /run --> paragraph (how to run the tool)`);
writeFileSync(join(out, "SKILL.md"), skill.replace(block, RUN_IN_ZIP + "\n"));
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
