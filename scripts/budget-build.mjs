#!/usr/bin/env node
// Builds dist/budget/: `superstables budget` as plain JavaScript that runs with node alone (Node 20+).
//
// budget/ is TypeScript and ES modules that a checkout runs with its own tsx and node_modules. The standalone copy (the
// skill zip's scripts/, see scripts/skill.mjs) has neither, so `npm run build` bundles the dispatcher and every runnable
// rail script with esbuild into dist/budget/, keeping the layout the dispatcher expects: dist/budget/cli.mjs,
// dist/budget/evm/buy.mjs, dist/budget/tempo/setBudget.mjs, ... Code the scripts share goes into dist/budget/lib/. Every
// dependency is bundled in, so dist/budget imports only node: built-ins and its own files; checkSelfContained proves it.
//
// It also writes:
//   dist/budget/VERSION.json            the client version, the commit and the build time (`superstables budget --version`)
//   dist/budget/THIRD_PARTY_NOTICES.txt every bundled package with its version, licence and full licence text
//
// A checkout never runs dist/budget: budget/cli.mjs runs the sources when they sit next to it (see its railSpec).
//
// node scripts/budget-build.mjs [--outdir <dir>]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { revisionOf } from "./dev-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "budget");

// ---- what gets built ------------------------------------------------------------------------------------------------
// Every .ts or .mjs file at the top of a rail folder is either a runnable script (the dispatcher spawns it) or a library
// (imported by the scripts). A file in neither list fails the build: a new script would otherwise be missing from the
// standalone copy, and a new library must be named here so nobody mistakes it for a script.
const RUNNABLE = {
  evm: ["setup", "fundAgent", "preflight", "setBudget", "buy", "reconcile", "revoke", "recover", "read"],
  tempo: ["setup", "setBudget", "buy", "reconcile", "readBudget", "revokeBudget"],
  solana: ["setup", "fundAgent", "setBudget", "buy", "reconcile", "readBudget", "revokeBudget"],
};
const LIBRARIES = {
  evm: ["chains", "cli-guard", "lib", "ops", "owner", "purchase"],
  tempo: ["owner"], // and tempo/lib/, a folder of libraries
  solana: ["lib", "ops", "owner", "precheck", "token"],
};
// The letters budget/cli.mjs uses for each rail's script lines: T("buy", ...) is tempo/buy, E("setBudget", ...) evm/setBudget.
const DISPATCH = { T: "tempo", S: "solana", O: "solana", E: "evm" };

// Optional native speed-ups of ws that the packages loading them wrap in try/catch, and the optional `encoding` package
// node-fetch tries the same way. Left out of the bundle; each falls back to JavaScript when it is absent.
const OPTIONAL = ["bufferutil", "utf-8-validate", "encoding"];

// ---- licences -------------------------------------------------------------------------------------------------------
// Licences whose notices travel with the copy (the notices file does that) and that ask nothing else of a bundle.
const PERMISSIVE = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Unlicense", "CC0-1.0", "BlueOak-1.0.0"]);
// Copyleft licences this build knows how to follow, with the licence texts that must accompany the bundle.
const COPYLEFT = {
  "LGPL-3.0-only": ["LGPL-3.0.txt", "GPL-3.0.txt"],
  "LGPL-3.0-or-later": ["LGPL-3.0.txt", "GPL-3.0.txt"],
};
// Packages whose package.json names no licence, checked by hand: name -> [licence, where it says so].
const LICENCE_BY_HAND = {
  "text-encoding-utf-8": ["Unlicense", "its LICENSE.md: the Unlicense (public domain dedication)"],
};

export function runnableEntries() {
  const entries = [];
  for (const [dir, names] of Object.entries(RUNNABLE)) {
    const files = readdirSync(join(src, dir)).filter((f) => /\.(ts|mjs)$/.test(f) && statSync(join(src, dir, f)).isFile());
    const known = new Set([...names, ...LIBRARIES[dir]]);
    const unknown = [...new Set(files.map((f) => f.replace(/\.(ts|mjs)$/, "")))].filter((n) => !known.has(n));
    if (unknown.length) throw new Error(`budget/${dir} has files the build does not know: ${unknown.join(", ")}. Add each to RUNNABLE (a script the dispatcher runs) or LIBRARIES in scripts/budget-build.mjs`);
    for (const n of names) {
      const file = [".ts", ".mjs"].map((ext) => join(src, dir, n + ext)).find((p) => existsSync(p));
      if (!file) throw new Error(`budget/${dir}/${n} is listed in RUNNABLE but does not exist`);
      entries.push(file);
    }
  }
  // Every script the dispatcher spawns must be one of them.
  const cli = readFileSync(join(src, "cli.mjs"), "utf8");
  for (const [, letter, name] of cli.matchAll(/\b([TSOE])\("([A-Za-z-]+)"/g)) {
    if (!RUNNABLE[DISPATCH[letter]].includes(name)) throw new Error(`budget/cli.mjs runs ${DISPATCH[letter]}/${name}, which RUNNABLE in scripts/budget-build.mjs does not list`);
  }
  return entries;
}

/**
 * Fails unless every .mjs under dir imports only node: built-ins, its own relative files and the OPTIONAL packages.
 * Reads the text (static imports, dynamic imports with a literal, require calls) and the esbuild metafile when there is one.
 */
export function checkSelfContained(dir, metafile) {
  const builtins = new Set(builtinModules);
  const ok = (spec) => spec.startsWith("node:") || builtins.has(spec) || builtins.has(spec.split("/")[0]) || OPTIONAL.includes(spec);
  const bad = [];
  const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".mjs"));
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    const specs = [
      ...[...text.matchAll(/^\s*(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/gm)].map((m) => m[1]),
      ...[...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm)].map((m) => m[1]),
      ...[...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
      ...[...text.matchAll(/\b(?:__require|require)\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
    ];
    for (const spec of specs) {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        if (!existsSync(resolve(dir, dirname(f), spec))) bad.push(`${f} imports ${spec}, which is not in ${relative(root, dir)}`);
      } else if (!ok(spec)) {
        bad.push(`${f} imports ${spec}`);
      }
    }
  }
  for (const [out, o] of Object.entries(metafile?.outputs ?? {})) {
    for (const i of o.imports) if (i.external && !ok(i.path)) bad.push(`${out} imports ${i.path} (external)`);
  }
  if (bad.length) throw new Error(`${relative(root, dir)} is not self-contained:\n  ${[...new Set(bad)].join("\n  ")}`);
  return files.length;
}

// The folder and package.json of the package a bundled input file belongs to.
function packageOf(input) {
  let d = dirname(resolve(root, input));
  while (d.includes(`${sep}node_modules${sep}`)) {
    const p = join(d, "package.json");
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      if (pkg.name && pkg.version) return { dir: d, pkg };
    }
    d = dirname(d);
  }
  return null;
}

function licenceOf(pkg) {
  const l = pkg.license ?? pkg.licence;
  if (typeof l === "string") return l;
  if (l && typeof l === "object" && l.type) return l.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((x) => x.type ?? x).join(" OR ");
  return LICENCE_BY_HAND[pkg.name]?.[0];
}

// An SPDX expression is acceptable when one side of every OR is: A OR B needs one, A AND B needs both.
function accepted(expr) {
  const e = expr.replace(/[()]/g, " ").trim();
  if (/\bOR\b/.test(e)) return e.split(/\bOR\b/).some((x) => accepted(x));
  if (/\bAND\b/.test(e)) return e.split(/\bAND\b/).every((x) => accepted(x));
  return PERMISSIVE.has(e) || e in COPYLEFT;
}
const copyleftIn = (expr) => expr.replace(/[()]/g, " ").split(/\s+(?:OR|AND)\s+|\s+/).filter((x) => x in COPYLEFT);

function repoUrl(pkg) {
  const r = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!r) return pkg.homepage ?? null;
  return r.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^(?:ssh:\/\/)?git@([^:/]+)[:/]/, "https://$1/").replace(/^git:\/\//, "https://").replace(/^github:/, "https://github.com/").replace(/^(?!https?:)([\w-]+\/[\w.-]+)$/, "https://github.com/$1");
}

function writeNotices(outdir, metafile, version) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages ?? {};
  const packages = new Map(); // name@version -> { name, version, dir, pkg }
  const pkgByInput = new Map();
  for (const o of Object.values(metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(o.inputs)) {
      if (!input.includes("node_modules/")) continue;
      const found = packageOf(input);
      if (!found) throw new Error(`cannot find the package of the bundled file ${input}`);
      pkgByInput.set(input, found);
      if (bytesInOutput === 0) continue; // parsed but tree-shaken away: none of its code ships
      const key = `${found.pkg.name}@${found.pkg.version}`;
      if (!packages.has(key)) packages.set(key, { name: found.pkg.name, version: found.pkg.version, ...found });
    }
  }
  const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  const refused = [];
  for (const p of list) {
    p.licence = licenceOf(p.pkg);
    if (!p.licence) refused.push(`${p.name}@${p.version} names no licence (add it to LICENCE_BY_HAND after reading the package)`);
    else if (!accepted(p.licence)) refused.push(`${p.name}@${p.version} is ${p.licence}, which this build has no rule for`);
    p.copyleft = p.licence ? copyleftIn(p.licence) : [];
    p.files = readdirSync(p.dir).filter((f) => /^(licen[cs]e|copying|notice|unlicense)([.-]|$)/i.test(f)).sort();
    p.source = repoUrl(p.pkg);
    const rel = relative(root, p.dir).split(sep).join("/");
    p.tarball = lock[rel]?.resolved ?? null;
    // who pulls it in: the packages whose bundled files import this one
    p.via = new Set();
    for (const [input, info] of Object.entries(metafile.inputs)) {
      const from = pkgByInput.get(input);
      if (!from || from.dir === p.dir) continue;
      if (info.imports.some((i) => pkgByInput.get(i.path)?.dir === p.dir)) p.via.add(from.pkg.name);
    }
  }
  if (refused.length) throw new Error(`bundled licences need a decision:\n  ${refused.join("\n  ")}`);

  const copyleft = list.filter((p) => p.copyleft.length);
  const texts = [...new Set(copyleft.flatMap((p) => p.copyleft.flatMap((id) => COPYLEFT[id])))];
  const rule = "=".repeat(100);
  const out = [];
  out.push(`THIRD-PARTY NOTICES for superstables budget ${version.version}${version.commit ? ` (commit ${version.commit})` : ""}`);
  out.push("");
  out.push("This folder was built by scripts/budget-build.mjs from the superstables-client source");
  out.push("(https://github.com/superstables/superstables-client). The Superstables code in it is licensed under Apache-2.0");
  out.push(`(the LICENSE file of that repository). The bundled .mjs files also contain code from the ${list.length} packages listed`);
  out.push("below, each under its own licence. The code is bundled by esbuild and not minified: a comment names the");
  out.push("node_modules path each part comes from. Each package's licence files follow the list, as the package ships them.");
  out.push("");
  if (copyleft.length) {
    out.push("COPYLEFT");
    out.push("");
    for (const p of copyleft) {
      out.push(`${p.name} ${p.version} is licensed under ${p.licence}.${p.via.size ? ` It is bundled because ${[...p.via].sort().join(", ")} use${p.via.size === 1 ? "s" : ""} it.` : ""}`);
      if (p.copyleft.some((id) => id.startsWith("LGPL"))) {
        out.push(`This bundle is a Combined Work that uses ${p.name}, which is covered by the GNU Lesser General Public License`);
        out.push("version 3. The texts of the GNU LGPL v3 and the GNU GPL v3 are at the end of this file.");
        out.push(`- Its source: ${p.source ?? "(no repository in its package.json)"}; the published package, bundled unmodified:`);
        out.push(`  ${p.tarball ?? `npm package ${p.name}@${p.version}`}.`);
        out.push(`- To use a modified ${p.name}: edit its part of the bundled lib/*.mjs files (the comments mark it), or build this`);
        out.push("  folder again from the superstables-client source at the commit in VERSION.json with your copy in node_modules");
        out.push("  (npm ci, replace the package, npm run build).");
      }
      out.push("");
    }
  }
  out.push("PACKAGES (name, version, licence, source)");
  out.push("");
  const w = Math.max(...list.map((p) => `${p.name} ${p.version}`.length));
  for (const p of list) out.push(`${`${p.name} ${p.version}`.padEnd(w)}  ${p.licence.padEnd(18)}  ${p.source ?? ""}`);
  out.push("");
  for (const p of list) {
    out.push(rule);
    out.push(`${p.name} ${p.version} (${p.licence})`);
    if (p.source) out.push(p.source);
    if (LICENCE_BY_HAND[p.pkg.name] && !(p.pkg.license ?? p.pkg.licence)) out.push(`Its package.json names no licence; the licence is from ${LICENCE_BY_HAND[p.pkg.name][1]}.`);
    out.push(rule);
    if (!p.files.length) out.push(`The published package contains no licence file. Its package.json says: ${p.licence}.`);
    for (const f of p.files) {
      if (p.files.length > 1) out.push(`--- ${f}`);
      out.push(readFileSync(join(p.dir, f), "utf8").trimEnd());
    }
    out.push("");
  }
  for (const t of texts) {
    out.push(rule);
    out.push(`Licence text: ${t.replace(/\.txt$/, "")}`);
    out.push(rule);
    out.push(readFileSync(join(root, "scripts", "licenses", t), "utf8").trimEnd());
    out.push("");
  }
  writeFileSync(join(outdir, "THIRD_PARTY_NOTICES.txt"), out.join("\n") + "\n");
  return { list, copyleft };
}

function gitDirty() {
  try {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
  } catch {
    return null;
  }
}

export async function buildBudget(outdir = join(root, "dist", "budget")) {
  const { build } = await import("esbuild");
  const entries = runnableEntries();
  rmSync(outdir, { recursive: true, force: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(src, "cli.mjs"), join(src, "doctor.mjs"), ...entries],
    outdir,
    outbase: src,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outExtension: { ".js": ".mjs" },
    chunkNames: "lib/[name]-[hash]",
    // A CommonJS dependency inside an ES module bundle still calls require().
    banner: { js: 'import { createRequire as __budgetRequire } from "node:module"; const require = __budgetRequire(import.meta.url);' },
    external: OPTIONAL,
    // licence comments stay in the code too, at the end of each file; the full texts are in THIRD_PARTY_NOTICES.txt
    legalComments: "eof",
    metafile: true,
    logLevel: "warning",
  });
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const rev = revisionOf(root);
  const version = { name: "superstables-budget", version: pkg.version, commit: rev.sha ?? null, commits: rev.count === undefined ? null : Number(rev.count), dirty: rev.sha ? gitDirty() : null, builtAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") };
  writeFileSync(join(outdir, "VERSION.json"), JSON.stringify(version, null, 2) + "\n");
  const { list, copyleft } = writeNotices(outdir, result.metafile, version);
  const files = checkSelfContained(outdir, result.metafile);
  const bytes = readdirSync(outdir, { recursive: true }).reduce((n, f) => n + (statSync(join(outdir, f)).isFile() ? statSync(join(outdir, f)).size : 0), 0);
  console.log(`budget: ${relative(root, outdir)}/ ${files} files, ${(bytes / 1e6).toFixed(2)} MB, ${entries.length} rail scripts, ${list.length} bundled packages (copyleft: ${copyleft.map((p) => `${p.name} ${p.version} ${p.licence}`).join(", ") || "none"}), version ${version.version}${version.commit ? ` ${version.commit}${version.dirty ? " with uncommitted changes" : ""}` : ""}`);
  return { outdir, version, packages: list };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const i = process.argv.indexOf("--outdir");
  const outdir = i > 0 ? resolve(process.argv[i + 1]) : undefined;
  if (outdir) mkdirSync(dirname(outdir), { recursive: true });
  await buildBudget(outdir);
}
