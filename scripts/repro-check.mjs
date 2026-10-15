#!/usr/bin/env node
// Builds HEAD twice, the way the release builds it, and fails unless the npm tarball and the skill zip are the same bytes.
//
// Each build is `git archive HEAD` into its own empty folder, then SUPERSTABLES_SKILL_FROM_ARCHIVE=1 and
// SUPERSTABLES_BUILD_COMMIT=<HEAD's short hash>, then `npm ci`, `npm run skill` and `npm pack` (bin/superstables-release
// does the same). The two builds differ in everything a build must not depend on: the folder
// (<tmp>/one/superstables, <tmp>/two/superstables), the time zone (UTC, Pacific/Kiritimati), the locale (en_US.UTF-8,
// lt_LT.UTF-8), the umask (022, 002: the two common defaults, both of which pack files as 0644) and the moment they run.
// SOURCE_DATE_EPOCH and every npm_* variable are removed, because the release sets
// none of them.
//
// The umask is varied because it is part of the tarball: file modes come from it, and node-tar only clears the group and
// other write bits, so a build under umask 077 packs -rw------- files and gives another tarball. That is left as it is: a
// fix belongs in prepack, which is part of the release process. The check pins 022 and 002 itself, and the docs tell
// people to build under 022 (docs/install.md).
//
// It compares the SHA-256 of the .tgz, of the uncompressed tar inside it, and of the zip. Different npm versions compress
// the same files into different .tgz bytes (the uncompressed tar is the same), so a published tarball is compared by its
// uncompressed tar (docs/install.md, "Checking a build against its commit"). On a mismatch it names the files that differ.
//
// It builds HEAD: uncommitted changes are not part of it. It needs git, tar, npm and the registry (for npm ci), and runs in
// the package's own git checkout only.
//
// node scripts/repro-check.mjs [--keep]      --keep leaves the temporary folder
//
// Exit 0: identical. 1: they differ, or a build failed. 2: it could not start.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { isOwnGitCheckout } from "./package-root.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const unknown = process.argv.slice(2).filter((a) => a !== "--keep");
if (unknown.length) {
  console.error(`repro-check: unknown argument ${unknown.join(" ")}. Usage: node scripts/repro-check.mjs [--keep]`);
  process.exit(2);
}
if (!isOwnGitCheckout(root)) {
  console.error("repro-check: run it in the package's own git checkout: it builds HEAD from `git archive`");
  process.exit(2);
}

const BUILDS = [
  { name: "one", tz: "UTC", locale: "en_US.UTF-8", umask: 0o022 },
  { name: "two", tz: "Pacific/Kiritimati", locale: "lt_LT.UTF-8", umask: 0o002 },
];
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const sha = git("rev-parse", "--short=10", "HEAD");
if (git("status", "--porcelain", "--untracked-files=no")) console.log("repro-check: this tree has uncommitted changes; it builds HEAD, which does not include them");

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/.test(k) && k !== "SOURCE_DATE_EPOCH")),
  SUPERSTABLES_SKILL_FROM_ARCHIVE: "1",
  SUPERSTABLES_BUILD_COMMIT: sha,
};

const startUmask = process.umask();
const tmp = mkdtempSync(join(tmpdir(), "superstables-repro-check-"));
let failed = false;
try {
  const built = BUILDS.map((b) => {
    // Files take their mode from the umask (the export's, and everything the build writes), and the tarball records it:
    // under 077 the same commit packs as -rw-------. Child processes inherit it. The builds run one after the other.
    process.umask(b.umask);
    const dir = join(tmp, b.name, "superstables");
    mkdirSync(dir, { recursive: true });
    const archive = join(tmp, b.name, "head.tar");
    execFileSync("git", ["archive", "--format=tar", "-o", archive, "HEAD"], { cwd: root });
    execFileSync("tar", ["-xf", archive, "-C", dir]);
    const buildEnv = { ...env, TZ: b.tz, LC_ALL: b.locale, LANG: b.locale };
    const run = (cmd, args) => {
      console.log(`repro-check: build ${b.name}: ${cmd} ${args.join(" ")}`);
      const r = spawnSync(cmd, args, { cwd: dir, env: buildEnv, encoding: "utf8", maxBuffer: 64 << 20 });
      if (r.status !== 0) throw new Error(`build ${b.name}: ${cmd} ${args.join(" ")} failed (exit ${r.status ?? r.signal})\n${(r.stderr ?? "").trim().split("\n").slice(-15).join("\n")}`);
    };
    run("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"]);
    run("npm", ["run", "--silent", "skill"]);
    mkdirSync(join(dir, ".npm-pack"), { recursive: true });
    run("npm", ["pack", "--silent", "--pack-destination", ".npm-pack"]);
    const only = (folder, pattern, what) => {
      const found = existsSync(folder) ? readdirSync(folder).filter((f) => pattern.test(f)) : [];
      if (found.length !== 1) throw new Error(`build ${b.name}: expected exactly one ${what} in ${folder}, found ${found.length}`);
      return join(folder, found[0]);
    };
    const tgz = only(join(dir, ".npm-pack"), /\.tgz$/, "tarball");
    const zip = only(join(dir, "build"), /-skill-.*\.zip$/, "skill zip");
    return { ...b, dir, tgz, zip };
  });

  const [one, two] = built;
  const rows = [
    ["tarball", basename(one.tgz), (b) => readFileSync(b.tgz)],
    ["tar", "its uncompressed tar", (b) => gunzipSync(readFileSync(b.tgz))],
    ["zip", basename(one.zip), (b) => readFileSync(b.zip)],
  ];
  console.log(`\nrepro-check: built ${sha} twice from git archive exports (${BUILDS.map((b) => `${b.tz}, ${b.locale.split(".")[0]}, umask ${b.umask.toString(8).padStart(3, "0")}`).join("; ")}), as the release does`);
  const bad = [];
  for (const [kind, label, get] of rows) {
    const [a, b] = [sha256(get(one)), sha256(get(two))];
    const same = a === b;
    if (!same) bad.push(kind);
    console.log(`  ${(kind === "tar" ? `  ${label}` : label).padEnd(42)} sha256 ${a}  ${same ? "identical" : `DIFFERS (${b})`}`);
  }

  if (bad.length) {
    failed = true;
    if (bad.includes("tarball") || bad.includes("tar")) {
      const files = (b) => {
        const out = join(tmp, b.name, "unpacked");
        mkdirSync(out, { recursive: true });
        execFileSync("tar", ["-xzpf", b.tgz, "-C", out]); // -p: keep the modes the tarball records
        const map = new Map();
        for (const f of readdirSync(out, { recursive: true }).map(String).sort()) {
          const st = statSync(join(out, f));
          if (st.isFile()) map.set(f, { sha: sha256(readFileSync(join(out, f))), mode: (st.mode & 0o777).toString(8) });
        }
        return map;
      };
      const [x, y] = [files(one), files(two)];
      const lines = [];
      for (const f of new Set([...x.keys(), ...y.keys()])) {
        const [a, b] = [x.get(f), y.get(f)];
        if (!a || !b) lines.push(`  tarball differs: ${f} (only in one)`);
        else if (a.sha !== b.sha) lines.push(`  tarball differs: ${f} (contents)`);
        else if (a.mode !== b.mode) lines.push(`  tarball differs: ${f} (mode ${a.mode} against ${b.mode})`);
      }
      console.log([...lines.slice(0, 20), ...(lines.length > 20 ? [`  ... and ${lines.length - 20} more`] : [])].join("\n"));
    }
    if (bad.includes("zip")) {
      const { unzipSync } = createRequire(join(one.dir, "package.json"))("fflate");
      const [x, y] = [unzipSync(readFileSync(one.zip)), unzipSync(readFileSync(two.zip))];
      for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (!x[f] || !y[f] || sha256(x[f]) !== sha256(y[f])) console.log(`  zip entry differs: ${f}`);
      }
      if (!Object.keys(x).some((f) => !y[f] || sha256(x[f]) !== sha256(y[f])) && !Object.keys(y).some((f) => !x[f])) {
        console.log("  zip entries have the same contents: the difference is in their dates or order");
      }
    }
  }
} catch (err) {
  failed = true;
  console.error(`repro-check: ${err.message}`);
} finally {
  process.umask(startUmask);
  if (keep) console.log(`repro-check: kept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
