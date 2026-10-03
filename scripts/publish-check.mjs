#!/usr/bin/env node
// npm's `prepublishOnly` hook: refuses to publish a package that no commit and no release note describe.
//
// npm packs whatever is in the folder, built from the working tree, so without this a publish could ship
// uncommitted changes, a version with no release notes, or a CLI reference that no longer matches the help.
// Before `npm publish` makes its tarball, this checks, in order:
//   1. the folder is the top of its own git checkout (not a folder inside some other repository), and its working
//      tree is clean: no modified, staged or untracked files (ignored files such as node_modules/ don't count;
//      dist/ is removed and rebuilt below, so nothing left in it can ship);
//   2. CHANGELOG.md has a `## [<version>]` section, with text, for the version in package.json;
//   3. the build, into an emptied dist/, succeeds, and `npm run docs:cli -- --check` passes on what it built;
//   4. the build left the working tree clean.
// npm runs `prepublishOnly` on `npm publish` only: not on `npm install`, `npm ci`, `npm pack`, or an install
// from git, so none of those need a clean tree or a release note.
//
// node scripts/publish-check.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanBuild, isOwnGitCheckout } from "./package-root.mjs";

// A Markdown level-2 ATX heading: up to three spaces, `##`, then a space, a tab or the end of the line.
const H2 = /^ {0,3}##(?:[ \t]|$)/;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text of the CHANGELOG.md section for a version, or null when there is none.
 * A section starts at a `## [<version>]` heading and ends at the next level-2 heading, however it is written.
 *
 * @param {string} changelog the contents of CHANGELOG.md
 * @param {string} version the version from package.json
 * @returns {string | null}
 */
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^ {0,3}##[ \\t]+\\[${escapeRegExp(version)}\\]`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => H2.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * Why the package may not be published, or an empty list when it may.
 *
 * @param {{ status: string | null, version: string, changelog: string }} state
 *   `status` is `git status --porcelain` (null when the folder is not the top of its own git checkout)
 * @returns {string[]}
 */
export function publishProblems({ status, version, changelog }) {
  const problems = [];
  if (status === null) {
    problems.push("this folder is not the top of its own git checkout, so nothing says which commit the package is built from");
  } else if (status.trim()) {
    problems.push(`the working tree has changes that are not committed:\n${status.trimEnd()}`);
  }
  const section = changelogSection(changelog, version);
  if (section === null) {
    problems.push(`CHANGELOG.md has no "## [${version}]" section for the version in package.json`);
  } else if (!section) {
    problems.push(`CHANGELOG.md's "## [${version}]" section is empty`);
  }
  return problems;
}

/** `git status --porcelain` for the package folder, or null when it is not the top of its own checkout. */
export function gitStatus(root) {
  if (!isOwnGitCheckout(root)) return null;
  try {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

function refuse(problems) {
  console.error("publish-check: refusing to publish:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

  const problems = publishProblems({ status: gitStatus(root), version, changelog });
  if (problems.length) refuse(problems);

  // The CLI reference is checked against the built CLI, so build first: the same steps as `npm run build`, into an
  // empty dist/. dist/ is ignored by git, so the clean-tree check above cannot see a stale or stray file in it.
  try {
    cleanBuild(root);
  } catch (error) {
    refuse([`the build failed: ${error.message}`]);
  }
  try {
    execFileSync(process.execPath, [join(root, "scripts", "cli-docs.mjs"), "--check"], { cwd: root, stdio: "inherit" });
  } catch {
    refuse(["docs/cli.md or docs/cli-budget.md differs from the CLI's help: run npm run docs:cli and commit the result"]);
  }

  const after = gitStatus(root);
  if (after === null || after.trim()) refuse([`the build changed files in the working tree:\n${(after ?? "").trimEnd()}`]);

  console.error(`publish-check: ${version} is committed, has release notes, and its CLI reference matches the help.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
