// The npm-shrinkwrap.json the package publishes, derived from package-lock.json when the tarball is made.
//
// npx and `npm install @superstables/client` use the shrinkwrap inside a published package, and ignore package-lock.json.
// A byte copy of the lockfile would make them install its dev entries too (vitest, typescript, esbuild, and the
// budget-only packages @solana/web3.js, mppx, bs58, @x402/fetch), so the published file holds the production entries only:
// the same set the SBOM lists (scripts/sbom.mjs) and install-check expects. No such file is committed: at the checkout root
// npm would read it as the lockfile for `npm ci` and drop the dev packages. `prepack` writes it (scripts/prepare.mjs
// --pack) and `postpack` removes it (node scripts/shrinkwrap.mjs remove).
//
// node scripts/shrinkwrap.mjs remove

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** True for a lock entry that an install of the client fetches: not dev, not optional, not dev-optional. */
export const isProduction = (entry) => !entry.dev && !entry.optional && !entry.devOptional;

/**
 * package-lock.json's content without what an install of the client does not fetch: dev and optional entries, and the
 * root's devDependencies.
 *
 * @param {{ packages: Record<string, any> }} lock the parsed package-lock.json
 */
export function productionLock(lock) {
  const packages = {};
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "") {
      const { devDependencies: _dev, ...root } = entry;
      packages[key] = root;
    } else if (isProduction(entry)) {
      packages[key] = entry;
    }
  }
  return { ...lock, packages };
}

/** The text of the shrinkwrap file for a lockfile's text, written the way npm writes a lockfile. */
export const shrinkwrapText = (lockText) => `${JSON.stringify(productionLock(JSON.parse(lockText)), null, 2)}\n`;

/** Writes `<root>/npm-shrinkwrap.json` from `<root>/package-lock.json`. */
export function writeShrinkwrap(root) {
  writeFileSync(join(root, "npm-shrinkwrap.json"), shrinkwrapText(readFileSync(join(root, "package-lock.json"), "utf8")));
}

/** Removes `<root>/npm-shrinkwrap.json`, if there is one. */
export function removeShrinkwrap(root) {
  rmSync(join(root, "npm-shrinkwrap.json"), { force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv[2] !== "remove" || process.argv.length > 3) {
    console.error("usage: node scripts/shrinkwrap.mjs remove");
    process.exit(2);
  }
  removeShrinkwrap(root);
}
