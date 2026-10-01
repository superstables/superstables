// Which build is this? The one question a machine that has been reinstalled a few times cannot
// answer by looking, and the reason it matters: an MCP client still running an older copy of the
// server looks exactly like one running the new copy, until something asks.
//
// The answer is the version in package.json, read from the file at run time rather than baked in
// at compile time, so a checkout, an npm install and a git install each report the package they
// actually are. A standalone build has no package.json beside it; see below.
//
// The same file is found from source and from the build: `src/core/version.ts` and
// `dist/core/version.js` are both two directories below the package root.

import { readFileSync } from "node:fs";

/** Read once per process: this cannot change while the server runs, and it is on a hot path. */
let cached: string | undefined;

export function clientVersion(): string {
  if (cached === undefined) cached = readVersion();
  return cached;
}

// A standalone build (scripts/budget-build.mjs, buildStandalone) has no package.json beside it:
// esbuild writes the version in here instead. Everywhere else the name is undefined.
declare const SUPERSTABLES_BUILD_VERSION: string | undefined;

function readVersion(): string {
  if (typeof SUPERSTABLES_BUILD_VERSION === "string") return SUPERSTABLES_BUILD_VERSION;
  try {
    const text = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    return (JSON.parse(text) as { version?: string }).version ?? "0.0.0";
  } catch {
    // A version is a diagnostic, never a reason to fail: an unreadable package.json says so.
    return "0.0.0";
  }
}
