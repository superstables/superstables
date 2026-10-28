#!/usr/bin/env node
// Synchronize the plugin's CLI references and versions. --check reports drift without writing.
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { trackedFiles } from "./package-root.mjs";

const SKILL = "skills/superstables-payments";
const PLUGIN_SKILL = "skills/superstables";
const REFERENCES = `${PLUGIN_SKILL}/references`;
const MANIFESTS = ["plugin/plugin.json", "plugin/.claude-plugin/plugin.json"];

function runInPlugin(version) {
  const cli = `npx --yes @superstables/client@${version}`;
  return `**This reference needs an agent that can run commands.** In a chat app without a terminal, the connector tools in SKILL.md are the route.

Run the CLI as \`${cli} <command>\`, for example \`${cli} find weather\` or \`${cli} budget doctor --rail evm\`. In the commands below, \`superstables\` is shorthand for \`${cli}\`. If \`superstables\` is already installed at version ${version}, that works too. Node 22 or newer is required. Keys and state are in \`$SUPERSTABLES_HOME\` (default \`~/.superstables\`), shared with any other copy of the tool on this machine. Never run unscoped \`npx superstables\`: it can download a different package. Use the scoped, pinned package above.`;
}

function statIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function refuseSymlinkPath(path, root) {
  if (path === root) return;
  if (dirname(path) === path) throw new Error(`Not under root: ${path}`);
  refuseSymlinkPath(dirname(path), root);
  if (statIfPresent(path)?.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${path}`);
}

function filesIn(dir, prefix = "") {
  const stat = statIfPresent(dir);
  if (!stat) return [];
  if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${dir}`);
  if (!stat.isDirectory()) throw new Error(`Expected a directory: ${dir}`);
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const file = prefix + name;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${path}`);
    if (stat.isDirectory()) return filesIn(path, `${file}/`);
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
    return [file];
  });
}

/** @param {{ root: string, check?: boolean }} options */
export function syncPlugin({ root, check = false }) {
  root = realpathSync(root);
  const plugin = join(root, "plugin");
  const destinationPath = (file) => {
    const path = resolve(plugin, file);
    if (!path.startsWith(plugin + sep)) throw new Error(`Destination must stay under plugin/: ${path}`);
    refuseSymlinkPath(path, root);
    return path;
  };
  const source = join(root, SKILL);
  refuseSymlinkPath(source, root);
  filesIn(source);
  const skills = destinationPath("skills");
  const extra = filesIn(skills).map((file) => file.split("/")[0]).filter((name) => name !== "superstables");
  if (extra.length) throw new Error(`plugin/skills may hold only the superstables skill; remove plugin/skills/${[...new Set(extra)].sort().join(", plugin/skills/")}`);
  if (!statIfPresent(destinationPath(`${PLUGIN_SKILL}/SKILL.md`))) throw new Error(`plugin/${PLUGIN_SKILL}/SKILL.md must exist`);
  const destination = destinationPath(REFERENCES);
  const bundled = filesIn(destination).sort();
  const files = trackedFiles(root, SKILL).sort();
  if (!files.includes("SKILL.md")) throw new Error(`${SKILL}/SKILL.md must be tracked`);
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const expected = new Map();
  for (const file of files) {
    if (file === "agents/openai.yaml") continue;
    const sourceFile = file === "SKILL.md" ? file : file.startsWith("references/") ? file.slice("references/".length) : undefined;
    if (sourceFile === undefined || sourceFile.includes("/")) throw new Error(`${SKILL}/${file}: no place in the plugin's references`);
    const path = join(source, file);
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`Expected a regular source file: ${file}`);
    let text = readFileSync(path, "utf8");
    let name = sourceFile;
    if (file === "SKILL.md") {
      const block = /<!-- run:[^>]*-->\n[\s\S]*?\n<!-- \/run -->\n/g;
      if ((text.match(block) ?? []).length !== 1) throw new Error(`${SKILL}/SKILL.md needs exactly one run block`);
      text = text.replace(/^---\n[\s\S]*?\n---\n\n?/, "").replace(block, () => runInPlugin(version) + "\n");
      // SKILL.md sat one folder above references/; cli.md sits beside them.
      text = text.replace(/\]\(references\//g, "](");
      name = "cli.md";
    } else {
      text = text.replace(/\bSKILL\.md\b/g, "cli.md");
    }
    if (text.includes("<!--")) throw new Error(`${SKILL}/${file}: HTML comments are not allowed in the plugin copy`);
    expected.set(name, { path: destinationPath(`${REFERENCES}/${name}`), content: Buffer.from(text), mode: stat.mode & 0o777 });
  }
  const manifests = MANIFESTS.map((file) => {
    const path = destinationPath(file.slice("plugin/".length));
    return { file, path, manifest: JSON.parse(readFileSync(path, "utf8")) };
  });
  const problems = [];
  for (const { file, path, manifest } of manifests) {
    if (manifest.version === version) continue;
    if (check) problems.push(`${file}: version must equal package.json (${version})`);
    else writeFileSync(path, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  }
  if (check) {
    for (const file of new Set([...expected.keys(), ...bundled])) {
      const entry = expected.get(file);
      if (!entry || !bundled.includes(file) || !entry.content.equals(readFileSync(entry.path))) {
        problems.push(`plugin/${REFERENCES}/${file}: differs from the expected plugin reference`);
      } else if ((lstatSync(entry.path).mode & 0o111) !== (entry.mode & 0o111)) {
        // Git releases preserve the executable bits, not arbitrary read/write permissions.
        problems.push(`plugin/${REFERENCES}/${file}: executable mode differs from the source skill`);
      }
    }
    if (problems.length) throw new Error(`${problems.join("\n")}\nRun npm run plugin:sync and commit the result.`);
  } else {
    rmSync(destination, { recursive: true, force: true });
    for (const { path, content, mode } of expected.values()) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      chmodSync(path, mode);
    }
  }
}

function isEntryPoint(path) {
  try {
    return import.meta.url === pathToFileURL(realpathSync(path)).href;
  } catch {
    return false;
  }
}

if (process.argv[1] && isEntryPoint(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--check")) throw new Error("Usage: node scripts/plugin-sync.mjs [--check]");
    syncPlugin({ root: resolve(dirname(fileURLToPath(import.meta.url)), ".."), check: args.includes("--check") });
    console.log(args.includes("--check") ? "Plugin references and versions match." : "Plugin references and versions synchronized.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
