#!/usr/bin/env node
// Synchronize the plugin's CLI skill and versions. --check reports drift without writing.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { trackedFiles } from "./package-root.mjs";

const SKILL = "skills/superstables-payments";
const MANIFESTS = ["plugin/plugin.json", "plugin/.claude-plugin/plugin.json"];

function filesIn(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  if (!lstatSync(dir).isDirectory()) throw new Error(`Expected a directory: ${dir}`);
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const file = prefix + name;
    const stat = lstatSync(path);
    if (stat.isDirectory()) return filesIn(path, `${file}/`);
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
    return [file];
  });
}

/** @param {{ root: string, check?: boolean }} options */
export function syncPlugin({ root, check = false }) {
  const source = join(root, SKILL);
  const destination = join(root, "plugin", SKILL);
  const files = trackedFiles(root, SKILL).sort();
  if (!files.includes("SKILL.md")) throw new Error(`${SKILL}/SKILL.md must be tracked`);
  for (const file of files) {
    if (!lstatSync(join(source, file)).isFile()) throw new Error(`Expected a regular source file: ${file}`);
  }
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const problems = [];
  for (const file of MANIFESTS) {
    const path = join(root, file);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest.version === version) continue;
    if (check) problems.push(`${file}: version must equal package.json (${version})`);
    else writeFileSync(path, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  }
  if (check) {
    const bundled = filesIn(destination).sort();
    for (const file of new Set([...files, ...bundled])) {
      if (!files.includes(file) || !bundled.includes(file) ||
          !readFileSync(join(source, file)).equals(readFileSync(join(destination, file)))) {
        problems.push(`plugin/${SKILL}/${file}: differs from the source skill`);
      }
    }
    if (problems.length) throw new Error(`${problems.join("\n")}\nRun npm run plugin:sync and commit the result.`);
  } else {
    rmSync(destination, { recursive: true, force: true });
    for (const file of files) {
      mkdirSync(dirname(join(destination, file)), { recursive: true });
      cpSync(join(source, file), join(destination, file));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) throw new Error("Usage: node scripts/plugin-sync.mjs [--check]");
  syncPlugin({ root: resolve(dirname(fileURLToPath(import.meta.url)), ".."), check: args.includes("--check") });
  console.log(args.includes("--check") ? "Plugin skill and versions match." : "Plugin skill and versions synchronized.");
}
