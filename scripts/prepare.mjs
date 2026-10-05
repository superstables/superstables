#!/usr/bin/env node
// npm's `prepare` and `prepack` hooks: build dist/, from an empty dist/.
//
// dist/ is not committed, so an install that starts from the sources must build it.
//
// `prepack` (node scripts/prepare.mjs --pack) runs on `npm pack` and `npm publish`, before the tarball is made. It
// empties dist/ and builds, and refuses when the build tools are missing, so a tarball only ever holds what this build
// produced: never a file an earlier build or a person left in dist/ (dist/ is ignored by git, so nothing else would
// notice one).
//
// `prepare` (node scripts/prepare.mjs) runs:
//   - on `npm install` or `npm ci` in a checkout (dev packages included, unless --omit=dev),
//   - for `npm install github:owner/repo#<commit>` or a git URL: npm clones the repo, installs its dev packages, runs
//     `prepare` (and not `prepack`), then packs the result with `files`, so the install gets dist/ and never the sources
//     or the dev packages,
//   - on `npm pack` and `npm publish` too, right after `prepack`; there it does nothing, as `prepack` has just built.
// When it builds, it also empties dist/ first. An install without dev packages (`npm ci --omit=dev`, or a Dockerfile
// that copies a dist/ built elsewhere) has no tsc and no esbuild. There `prepare` does not fail the install: it says
// what it skipped and keeps dist/ as it is. Such a folder cannot be packed: `prepack` refuses.
//
// node scripts/prepare.mjs [--pack]

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanBuild } from "./package-root.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const pack = process.argv.includes("--pack");

// npm names the command that runs a hook in npm_command. `prepare` during `npm pack` or `npm publish` follows `prepack`.
if (!pack && ["pack", "publish"].includes(process.env.npm_command ?? "")) {
  process.exit(0);
}

const tools = ["typescript", "esbuild"];
const missing = tools.filter((name) => {
  try {
    require.resolve(`${name}/package.json`);
    return false;
  } catch {
    return true;
  }
});

if (missing.length === 0) {
  // `npm run build`, without going through npm again, into an empty dist/: tsc, then the budget build.
  cleanBuild(root);
} else if (pack) {
  console.error(`prepack: refusing to pack: the build tools are not installed (${missing.join(", ")}: dev packages), so dist/ cannot be rebuilt from the sources.`);
  console.error("prepack: run npm ci (with dev packages) and pack again.");
  process.exit(1);
} else {
  const built = ["dist/cli/main.js", "dist/budget/cli.mjs"].every((f) => existsSync(join(root, f)));
  const why = `the build tools are not installed (${missing.join(", ")}: dev packages)`;
  if (built) {
    console.error(`prepare: skipped the build, ${why}; the existing dist/ is used as it is.`);
  } else {
    console.error(`prepare: skipped the build, ${why}, and there is no dist/ yet.`);
    console.error("prepare: the superstables command needs it: run npm ci (with dev packages) and npm run build here.");
  }
}
