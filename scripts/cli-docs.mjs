#!/usr/bin/env node
// Writes the CLI reference, docs/cli.md and docs/cli-budget.md, from the `--help` of the built CLI,
// so the reference says exactly what the commands say. Run `npm run build` first.
//
//   npm run docs:cli              write both pages
//   npm run docs:cli -- --check   exit 1 if either page differs from the help (CI runs this)
//
// The command lists come from the help itself: the Commands section of `superstables --help`, each
// group's own Commands section, and the commands table of `superstables budget --help`. A new
// command therefore gets its section without a change here.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const cli = join(root, "dist/cli/main.js");
const check = process.argv.includes("--check");

// A clean environment, so no local setting changes the help, and a home that holds nothing.
const home = await mkdtemp(join(tmpdir(), "superstables-cli-docs-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SUPERSTABLES_") && !k.startsWith("B4_")));
env.SUPERSTABLES_HOME = home;

async function help(args) {
  const { stdout, stderr } = await run(process.execPath, [cli, ...args, "--help"], { env, cwd: root, maxBuffer: 4 << 20 }).catch((e) => {
    throw new Error(`superstables ${args.join(" ")} --help failed: ${e.stderr || e.message}`);
  });
  return (stdout + stderr)
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replaceAll(home, "~/.superstables")
    .trim();
}

/** Rows of a commander "Commands:" section: [name, description], wrapped lines joined. */
function commandsOf(text, heading = /^Commands:$/) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return [];
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    const m = line.match(/^ {2}(\S+)((?: \S+)*?)\s{2,}(\S.*)$/);
    if (m) rows.push([m[1], m[3]]);
    else if (rows.length && /^\s{6,}\S/.test(line)) rows[rows.length - 1][1] += ` ${line.trim()}`;
  }
  return rows.filter(([name]) => name !== "help");
}

const anchor = (title) => title.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");
const block = (title, text) => `## ${title}\n\n\`\`\`text\n${text}\n\`\`\`\n`;
const cell = (text) => text.replace(/\|/g, "\\|");
const table = (rows, columns = ["What it does"]) =>
  [
    `| Command | ${columns.join(" | ")} |`,
    `| --- |${" --- |".repeat(columns.length)}`,
    ...rows.map(([t, ...rest]) => `| [\`${t}\`](#${anchor(t)}) | ${rest.map(cell).join(" | ")} |`),
  ].join("\n");

async function mainPage() {
  const top = await help([]);
  const sections = [block("superstables", top)];
  const rows = [];
  for (const [name, description] of commandsOf(top)) {
    if (name === "budget") continue;
    const text = await help([name]);
    const subs = commandsOf(text);
    if (!subs.length) {
      rows.push([`superstables ${name}`, description]);
      sections.push(block(`superstables ${name}`, text));
      continue;
    }
    sections.push(block(`superstables ${name}`, text));
    for (const [sub, subDescription] of subs) {
      rows.push([`superstables ${name} ${sub}`, subDescription]);
      sections.push(block(`superstables ${name} ${sub}`, await help([name, sub])));
    }
  }
  return [
    "# CLI reference",
    "",
    "The `superstables` commands other than budgets, with the text their `--help` prints. The help is written to be enough on its own: what the command does, whether it can move money, who runs it, an example, what it prints and its exit codes. Budgets have their own page: [Budget CLI reference](cli-budget.md).",
    "",
    "This page is generated from the help by `npm run docs:cli`, and CI fails when the two differ.",
    "",
    table(rows),
    "",
    sections.join("\n"),
  ].join("\n");
}

async function budgetPage() {
  const top = await help(["budget"]);
  const rows = [];
  const sections = [block("superstables budget", top)];
  for (const line of top.split("\n").slice(top.split("\n").findIndex((l) => l.startsWith("Commands (")) + 1)) {
    const m = line.match(/^ {2}([a-z-]+)\s{2,}(\S+)\s{2,}(.*?)\s{2,}(\S.*)$/);
    if (!m) break;
    rows.push([`superstables budget ${m[1]}`, m[3], m[2], m[4]]);
    sections.push(block(`superstables budget ${m[1]}`, await help(["budget", m[1]])));
  }
  return [
    "# Budget CLI reference",
    "",
    "Every `superstables budget` command, with the text its `--help` prints. [Budgets](budget.md) walks through them in order; the rest of the CLI is in the [CLI reference](cli.md).",
    "",
    "This page is generated from the help by `npm run docs:cli`, and CI fails when the two differ.",
    "",
    table(rows, ["What it does", "Run by", "Moves money"]),
    "",
    sections.join("\n"),
  ].join("\n");
}

try {
  const pages = { "docs/cli.md": await mainPage(), "docs/cli-budget.md": await budgetPage() };
  let stale = 0;
  for (const [file, text] of Object.entries(pages)) {
    const path = join(root, file);
    if (check) {
      const current = await readFile(path, "utf8").catch(() => "");
      if (current !== text) {
        stale++;
        console.error(`${file} differs from the CLI's --help. Run npm run build && npm run docs:cli, and commit the result.`);
      }
    } else {
      await writeFile(path, text);
      console.log(`wrote ${file}`);
    }
  }
  process.exitCode = stale ? 1 : 0;
} finally {
  await rm(home, { recursive: true, force: true });
}
