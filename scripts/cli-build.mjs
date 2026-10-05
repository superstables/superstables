#!/usr/bin/env node
// Builds the whole `superstables` CLI as plain JavaScript that runs with node alone (Node 20+): the skill zip's scripts/
// (see scripts/skill.mjs). No checkout, no node_modules.
//
// One esbuild call bundles src/cli/main.ts and the budget's dispatcher and rail scripts (the same entries as
// scripts/budget-build.mjs), so the code they share is written once, into lib/. The layout keeps what each part expects
// to find next to it:
//   superstables.mjs           the entry: behaves exactly like the `superstables` binary
//   cli/main.mjs               src/cli/main.ts; `superstables budget` runs ../budget/cli.mjs, as dist/cli/main.js does
//   budget/cli.mjs, evm/...    the budget dispatcher and rail scripts, laid out as in dist/budget/
//   lib/                       shared code
//   VERSION.json               the version, commit and build time; budget/VERSION.json is a copy for `budget --version`
//   THIRD_PARTY_NOTICES.txt    every bundled package with its version, licence and full licence text
//
// node scripts/cli-build.mjs [--outdir <dir>] [--version <version>]   default build/cli/

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { budgetEntryPoints, buildStandalone, checkSelfContained } from "./budget-build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ENTRY = `#!/usr/bin/env node
// superstables, standalone: the same commands as the superstables binary, bundled with everything it needs.
// See VERSION.json for the build and THIRD_PARTY_NOTICES.txt for the bundled packages.
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(\`superstables needs Node 20 or newer; this is Node \${process.versions.node}.\`);
  process.exit(1);
}
await import("./cli/main.mjs");
`;

export async function buildCli(outdir = join(root, "build", "cli"), version) {
  const entryPoints = { "cli/main": join(root, "src", "cli", "main.ts"), ...budgetEntryPoints("budget/") };
  const built = await buildStandalone({
    outdir,
    entryPoints,
    version,
    name: "superstables",
    title: "superstables",
    builtBy: "scripts/cli-build.mjs",
    rebuild: "npm run skill",
    versionFiles: ["VERSION.json", "budget/VERSION.json"],
  });
  writeFileSync(join(outdir, "superstables.mjs"), ENTRY);
  checkSelfContained(outdir);
  console.log(`cli: ${built.summary}`);
  return built;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  await buildCli(arg("--outdir") ? resolve(arg("--outdir")) : undefined, arg("--version"));
}
