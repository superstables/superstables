#!/usr/bin/env node
// Synchronize the plugin's CLI references and versions. --check reports drift without writing.
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { trackedFiles } from "./package-root.mjs";
import { PLUGIN_LISTING as L } from "./plugin-data.mjs";

const SKILL = "skills/superstables-payments";
const PLUGIN_SKILL = "skills/superstables";
const REFERENCES = `${PLUGIN_SKILL}/references`;

/** Every file the listing writes, from PLUGIN_LISTING and the version: path from the repository root -> text. */
function listingFiles(version) {
  const json = (value) => JSON.stringify(value, null, 2) + "\n";
  const author = { name: L.developerName };
  const common = { version, description: L.shortDescription, author, homepage: L.homepage, repository: L.repository, license: L.license, keywords: L.keywords };
  const openai = {
    displayName: L.displayName,
    shortDescription: L.shortDescription,
    longDescription: L.longDescription,
    developerName: L.developerName,
    category: L.category,
    websiteURL: L.homepage,
    brandColor: L.brandColor,
    composerIcon: `./${L.icon}`,
    logo: `./${L.icon}`,
  };
  return new Map([
    // Agent Plugins schema: no top-level icon or displayName, so Codex's listing sits under extensions.com.openai.interface.
    ["plugin/plugin.json", json({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: L.name, ...common, extensions: { "com.openai": { interface: openai } } })],
    ["plugin/.claude-plugin/plugin.json", json({ name: L.name, displayName: L.displayName, ...common, icon: `./${L.icon}` })],
    ["plugin/.cursor-plugin/plugin.json", json({ name: L.name, ...common, logo: L.icon })],
    [
      ".claude-plugin/marketplace.json",
      json({
        name: L.name,
        owner: author,
        metadata: { description: L.marketplaceDescription },
        plugins: [{ name: L.name, source: "./plugin", displayName: L.displayName, description: L.shortDescription, category: L.category, tags: L.keywords, homepage: L.homepage }],
      }),
    ],
    [
      `plugin/${PLUGIN_SKILL}/agents/openai.yaml`,
      `interface:\n  display_name: ${JSON.stringify(L.displayName)}\n  short_description: ${JSON.stringify(L.shortDescription)}\n  icon_small: "./${L.skillIcons.small}"\n  icon_large: "./${L.skillIcons.large}"\n  brand_color: ${JSON.stringify(L.brandColor)}\npolicy:\n  allow_implicit_invocation: true\n`,
    ],
  ]);
}

/** Icon files the skill carries for itself: openai.yaml paths are relative to the skill folder. */
const SKILL_ICON_COPIES = [
  ["plugin/assets/icon.svg", `plugin/${PLUGIN_SKILL}/${L.skillIcons.small}`],
  ["plugin/assets/icon.png", `plugin/${PLUGIN_SKILL}/${L.skillIcons.large}`],
];

function runInPlugin(version) {
  const cli = `npx --yes @superstables/client@${version}`;
  return `**This reference needs an agent that can run commands.** If this chat can't run the CLI with the storage, network access and wallet approval a command needs, use the connector tools in SKILL.md.

Run the CLI as \`${cli} <command>\`, for example \`${cli} find weather\` or \`${cli} budget doctor --rail evm\`. In the commands below, \`superstables\` is shorthand for \`${cli}\`. If \`superstables\` is already installed at version ${version}, that works too. Node 22 or newer is required. Keys and state are in \`$SUPERSTABLES_HOME\` (default \`~/.superstables\`), shared with any other copy of the tool on this machine. Never run unscoped \`npx superstables\`: it can download a different package. Use the scoped, pinned package above.

If \`npx\` reports that the pinned \`@superstables/client\` version is unavailable (E404 or ETARGET), stop and ask the owner to check the plugin installation against the public marketplace, \`superstables/superstables\`. Do not substitute another version, package or download source.`;
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
  const problems = [];
  const outputs = [...listingFiles(version)].map(([file, text]) => ({ file, content: Buffer.from(text) }));
  for (const [from, to] of SKILL_ICON_COPIES) {
    const sourcePath = join(root, from);
    refuseSymlinkPath(sourcePath, root);
    if (!statIfPresent(sourcePath)?.isFile()) throw new Error(`${from} must exist: it is the plugin's icon`);
    outputs.push({ file: to, content: readFileSync(sourcePath) });
  }
  for (const output of outputs) {
    output.path = resolve(root, output.file);
    refuseSymlinkPath(output.path, root);
  }
  for (const output of outputs) {
    const current = statIfPresent(output.path) ? readFileSync(output.path) : undefined;
    if (current?.equals(output.content)) continue;
    if (!check) continue;
    let staleVersion = false;
    if (current && output.file.endsWith("plugin.json")) {
      try {
        staleVersion = JSON.parse(current.toString()).version !== version;
      } catch {}
    }
    problems.push(staleVersion ? `${output.file}: version must equal package.json (${version})` : `${output.file}: differs from the plugin listing (scripts/plugin-data.mjs)`);
  }
  if (!statIfPresent(join(root, "plugin", L.icon))?.isFile()) throw new Error(`plugin/${L.icon} must exist`);
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
    for (const { path, content } of outputs) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
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
    console.log(args.includes("--check") ? "Plugin references, listing and versions match." : "Plugin references, listing and versions synchronized.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
