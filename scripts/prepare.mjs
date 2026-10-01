#!/usr/bin/env node
// npm's `prepare` hook: builds dist/ when the build tools are installed.
//
// dist/ is not committed, so an install that starts from the sources must build it. npm runs `prepare`:
//   - on `npm install` or `npm ci` in a checkout (dev packages included, unless --omit=dev),
//   - on `npm pack` and `npm publish`, before the tarball is made,
//   - for `npm install github:owner/repo` or a git URL: npm clones the repo, installs its dev packages, runs `prepare`,
//     then packs the result with `files`, so the install gets dist/ and never the sources or the dev packages.
// An install without dev packages (`npm ci --omit=dev`, or a Dockerfile that copies a dist/ built elsewhere) has no
// tsc and no esbuild. There this does not fail the install: it says what it skipped and keeps dist/ as it is.
//
// node scripts/prepare.mjs

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));

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
  // `npm run build`, without going through npm again: tsc, then the budget build.
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, [join(root, "scripts", "budget-build.mjs")], { cwd: root, stdio: "inherit" });
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
