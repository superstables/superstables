#!/usr/bin/env node
// Audits every package the client ships against the registry's advisories.
//
// `npm audit` in a project that installs the client sees only what npm installed. Most of the budget's Solana and Tempo
// code is bundled from devDependencies, so neither a user's audit nor `--omit=dev` covers it. This script runs
// `npm audit` on this checkout's package-lock.json with the dev packages included, and fails on any advisory whose npm
// location (a "node") is a `superstables:path` of a package in an SBOM (scripts/sbom.mjs). The other advisories are
// listed as development-only: packages that are used to build and test and ship nowhere.
//
// It fails closed. `npm audit --offline` prints an empty report and exits 0 without asking anyone, so a report counts
// only when npm's log shows the registry answered the advisory request; a registry that cannot be reached, a report that
// is not JSON, a missing SBOM, and an SBOM whose paths are not locations in this checkout's package-lock.json (it was
// built with a linked node_modules, or from another checkout) all end the run with exit 2.
//
// `npm run build` must run first (and `npm run skill` for the skill's SBOM). There is no offline mode, by design.
//
// node scripts/bundle-audit.mjs [--sbom <file>]...      default dist/sbom.cdx.json
//
// Exit 0: no advisory for a shipped package. 1: at least one. 2: it could not audit.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The node_modules locations the SBOMs list, and for each name@version how it is delivered.
 *
 * @param {object[]} boms parsed CycloneDX documents
 * @returns {{ paths: Set<string>, packages: Map<string, Set<string>> }}
 */
export function shippedPaths(boms) {
  const paths = new Set();
  const packages = new Map();
  for (const bom of boms) {
    for (const c of bom.components ?? []) {
      const id = `${c.group ? `${c.group}/` : ""}${c.name}@${c.version}`;
      if (!packages.has(id)) packages.set(id, new Set());
      for (const p of c.properties ?? []) {
        if (p.name === "superstables:path") paths.add(p.value);
        if (p.name === "superstables:delivery") packages.get(id).add(p.value);
      }
    }
  }
  return { paths, packages };
}

/**
 * What is wrong with the SBOMs' paths. npm audit names a package by its node_modules location, and the audit matches those
 * against the SBOMs, so a path that is not a location in this checkout's lockfile, or whose version differs, would let a
 * shipped advisory pass as development-only. An SBOM built with a linked node_modules, or from another lockfile, does that.
 *
 * @param {object[]} boms parsed CycloneDX documents
 * @param {Record<string, { version: string }>} lockPackages the `packages` of package-lock.json
 * @returns {string[]} one line per problem; empty when every path is a lock key with the component's version
 */
export function checkPaths(boms, lockPackages) {
  const problems = [];
  for (const bom of boms) {
    for (const c of bom.components ?? []) {
      for (const p of c.properties ?? []) {
        if (p.name !== "superstables:path") continue;
        const entry = Object.hasOwn(lockPackages, p.value) ? lockPackages[p.value] : undefined;
        if (!entry) problems.push(`${c.name}@${c.version}: ${p.value} is not a location in package-lock.json`);
        else if (entry.version !== c.version) problems.push(`${c.name}@${c.version}: ${p.value} is ${entry.version} in package-lock.json`);
      }
    }
  }
  return problems;
}

/**
 * Whether npm audit's answer can be believed. Returns { report } or { problem }.
 *
 * @param {{ status: number | null, stdout: string, stderr: string }} run npm audit --json --loglevel=http
 */
export function auditVerdict({ status, stdout, stderr }) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { problem: `npm audit printed no report (exit ${status}): ${stderr.trim().split("\n").pop() ?? ""}` };
  }
  if (report.error || report.message || report.auditReportVersion !== 2 || typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
    return { problem: `npm audit could not complete: ${report.error?.summary || report.message || "no vulnerabilities report"}` };
  }
  if (!/\bPOST 200 \S*\/-\/npm\/v1\/security\/(?:advisories\/bulk|audits\/quick)\b/.test(stderr)) {
    return { problem: "npm audit got no answer from the registry's advisory endpoint (offline?), so nothing was checked" };
  }
  return { report };
}

/**
 * Splits the advisories into those for a shipped location and the rest.
 *
 * @param {{ vulnerabilities: Record<string, { severity: string, range: string, nodes?: string[], via?: unknown[] }> }} report
 * @param {Set<string>} paths from shippedPaths
 */
export function classify(report, paths) {
  const shipped = [];
  const devOnly = [];
  for (const [name, v] of Object.entries(report.vulnerabilities)) {
    const hit = (v.nodes ?? []).filter((n) => paths.has(n));
    (hit.length ? shipped : devOnly).push({
      name,
      severity: v.severity,
      range: v.range,
      nodes: hit.length ? hit : (v.nodes ?? []),
      urls: (v.via ?? []).filter((x) => typeof x === "object" && x !== null).map((x) => x.url),
    });
  }
  return { shipped, devOnly };
}

// npm run and the calling shell hand down npm_* variables and npm settings (omit, production, offline ...), which npm
// reads in any case (NPM_CONFIG_*), that change what an audit covers. Only the settings that say where the registry is,
// how to reach it and where npm keeps its files pass through, and NPM_TOKEN, for an .npmrc that names it.
const KEEP = /^npm_config_(?:registry|(?:https_|http_)?proxy|noproxy|cafile|ca|strict_ssl|cache|userconfig|globalconfig|fetch_\w+)$/i;
const isNpmVariable = (k) => /^npm_config_/i.test(k) || /^npm_/.test(k);
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !isNpmVariable(k) || KEEP.test(k)));

function main() {
  const args = process.argv.slice(2);
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sbom" && args[i + 1]) files.push(resolve(args[++i]));
    else {
      console.error(`bundle-audit: unknown argument ${args[i]}. Usage: node scripts/bundle-audit.mjs [--sbom <file>]...`);
      return 2;
    }
  }
  if (!files.length) files.push(join(root, "dist", "sbom.cdx.json"));
  for (const f of files) {
    if (!existsSync(f)) {
      console.error(`bundle-audit: ${f} does not exist: run npm run build first (and npm run skill for the skill's SBOM)`);
      return 2;
    }
  }
  const boms = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
  const problems = checkPaths(boms, JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages ?? {});
  if (problems.length) {
    console.error(`bundle-audit: the SBOM does not match this checkout's package-lock.json, so its packages cannot be matched to npm's advisories. Rebuild with npm ci, npm run build and npm run skill:\n  ${problems.slice(0, 10).join("\n  ")}${problems.length > 10 ? `\n  ... and ${problems.length - 10} more` : ""}`);
    return 2;
  }
  const { paths, packages } = shippedPaths(boms);

  const r = spawnSync("npm", ["audit", "--json", "--include=dev", "--include=optional", "--include=peer", "--offline=false", "--loglevel=http"], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv(),
    maxBuffer: 64 << 20,
  });
  if (r.error) {
    console.error(`bundle-audit: could not run npm: ${r.error.message}`);
    return 2;
  }
  const { report, problem } = auditVerdict({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  if (problem) {
    console.error(`bundle-audit: ${problem}`);
    return 2;
  }

  const delivered = (kind) => [...packages.values()].filter((d) => d.has(kind)).length;
  const both = [...packages.values()].filter((d) => d.has("installed") && d.has("bundled")).length;
  console.log(`bundle-audit: ${packages.size} shipped packages (${delivered("installed")} installed with the client, ${delivered("bundled")} bundled, ${both} both), from ${files.map((f) => f.replace(`${root}/`, "")).join(", ")}`);
  const { shipped, devOnly } = classify(report, paths);
  if (!shipped.length) console.log("bundle-audit: no advisory for a shipped package");
  for (const s of shipped) console.log(`bundle-audit: ADVISORY ${s.name} ${s.severity} ${s.range} at ${s.nodes.join(", ")} ${s.urls.join(" ")}`.trimEnd());
  if (devOnly.length) {
    console.log(`bundle-audit: not shipped, used only to develop and test: ${devOnly.map((d) => `${d.name} (${d.severity})`).sort().join(", ")}`);
  }
  return shipped.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
