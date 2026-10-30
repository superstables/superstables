#!/usr/bin/env node
// Builds one plugin zip per app from the one plugin/ source: build/plugin/superstables-plugin-<app>-<version>.zip, with a
// .sha256 file beside each. Inside each zip, VERSION holds the version and SHA256SUMS the hash of every other file.
// The table of apps and layouts is scripts/plugin-data.mjs. Only files git tracks are packed.
//
// node scripts/plugin-zip.mjs

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { trackedFiles } from "./package-root.mjs";
import { PLUGIN_ZIPS, zipName } from "./plugin-data.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Files of one layout as { path-in-zip: bytes }. */
export function layoutFiles(root, layout) {
  const read = (path) => readFileSync(join(root, path));
  const plugin = trackedFiles(root, "plugin").map((f) => [`plugin/${f}`, f]);
  if (layout === "marketplace") {
    return Object.fromEntries([[".claude-plugin/marketplace.json", read(".claude-plugin/marketplace.json")], ...plugin.map(([zip]) => [zip, read(zip)])]);
  }
  const skip = layout === "claude-root" ? new Set(["plugin.json", "mcp.json"]) : new Set([".claude-plugin/plugin.json", ".mcp.json"]);
  if (layout !== "claude-root" && layout !== "cursor-root") throw new Error(`Unknown layout: ${layout}`);
  return Object.fromEntries(plugin.filter(([, f]) => !skip.has(f)).map(([zip, f]) => [f, read(zip)]));
}

export function buildPluginZips(root, outDir = join(root, "build", "plugin")) {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  let time;
  try {
    time = new Date(execFileSync("git", ["log", "-1", "--format=%cI"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {}
  const mtime = time && !Number.isNaN(+time) ? time : new Date("2026-01-01T00:00:00Z");
  process.env.TZ = "UTC";
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const built = [];
  for (const { app, layout } of PLUGIN_ZIPS) {
    const files = layoutFiles(root, layout);
    files.VERSION = Buffer.from(`${version}\n`);
    const sums = Object.keys(files).sort().map((f) => `${sha(files[f])}  ${f}\n`).join("");
    files.SHA256SUMS = Buffer.from(sums);
    const entries = Object.fromEntries(Object.keys(files).sort().map((f) => [f, [files[f], { mtime }]]));
    const bytes = zipSync(entries, { level: 9 });
    const name = zipName(app, version);
    writeFileSync(join(outDir, name), bytes);
    writeFileSync(join(outDir, `${name}.sha256`), `${sha(bytes)}  ${name}\n`);
    built.push({ app, layout, name, bytes: bytes.length });
  }
  return built;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const b of buildPluginZips(root)) console.log(`${b.name} (${b.layout}, ${(b.bytes / 1e3).toFixed(1)} kB)`);
}
