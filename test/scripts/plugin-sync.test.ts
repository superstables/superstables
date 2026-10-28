import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { refuseSymlinkPath, syncPlugin } from "../../scripts/plugin-sync.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const scratch: string[] = [];
const skill = "skills/superstables-payments";
const pluginSkill = "plugin/skills/superstables";
const bundle = `${pluginSkill}/references`;
const manifests = ["plugin/plugin.json", "plugin/.claude-plugin/plugin.json"];
const sourceSkill = "---\nname: superstables-payments\n---\n\nBefore. [Pay](references/pay.md)\n<!-- run: how to run -->\nRun from a checkout.\n<!-- /run -->\nAfter.\n";

function write(root: string, file: string, text: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "plugin-sync-"));
  scratch.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  write(root, "package.json", JSON.stringify({ version: "1.2.3" }));
  for (const manifest of manifests) write(root, manifest, JSON.stringify({ name: "superstables", version: "0.0.0" }));
  write(root, `${skill}/SKILL.md`, sourceSkill);
  write(root, `${skill}/references/pay.md`, "Payment instructions. See SKILL.md and [budgets](budget.md).\n");
  write(root, `${skill}/references/budget.md`, "Budgets.\n");
  write(root, `${pluginSkill}/SKILL.md`, "---\nname: superstables\n---\n\nRoute.\n");
  execFileSync("git", ["add", "skills"], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

function slug(heading: string) {
  return heading.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, "").replace(/ /g, "-");
}

/** Relative links in a markdown file whose file, or heading anchor, does not exist. */
function brokenLinks(file: string) {
  const broken: string[] = [];
  for (const [, target] of readFileSync(file, "utf8").matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [path, anchor] = target.split("#");
    const resolved = path ? join(dirname(file), path) : file;
    if (!existsSync(resolved) || !statSync(resolved).isFile()) { broken.push(target); continue; }
    if (anchor === undefined) continue;
    const text = readFileSync(resolved, "utf8");
    const anchors = [...[...text.matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1])), ...[...text.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1])];
    if (!anchors.includes(anchor)) broken.push(target);
  }
  return broken;
}

describe("plugin synchronization", () => {
  it("checks the committed package's skill copy and client versions", () => {
    expect(() => syncPlugin({ root: repo, check: true })).not.toThrow();
  });

  it("ships one skill, with every relative link in it resolving", () => {
    expect(readdirSync(join(repo, "plugin/skills"))).toEqual(["superstables"]);
    const folder = join(repo, pluginSkill);
    const files = ["SKILL.md", ...readdirSync(join(folder, "references")).map((file) => `references/${file}`)];
    expect(files.sort()).toEqual(["SKILL.md", "references/budget.md", "references/cli.md", "references/discovery.md", "references/once.md", "references/pay.md"]);
    for (const file of files) expect(brokenLinks(join(folder, file)), file).toEqual([]);
    const entry = readFileSync(join(folder, "SKILL.md"), "utf8");
    expect(entry).toMatch(/^---\nname: superstables\n/);
    expect(entry).not.toMatch(/superstables-payments/);
    expect(readFileSync(join(folder, "agents/openai.yaml"), "utf8")).toContain("allow_implicit_invocation: true");
    for (const manifest of [...manifests, ".claude-plugin/marketplace.json"]) {
      expect(readFileSync(join(repo, manifest), "utf8"), manifest).not.toContain("CLI payments skill");
    }
  });

  it("keeps the single-purchase order in references/cli.md: buy-once first, local pay as the fallback", () => {
    const cli = readFileSync(join(repo, bundle, "cli.md"), "utf8");
    const source = readFileSync(join(repo, skill, "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    for (const line of source.split("\n").filter((text) => /budget buy-once|Single purchase on superstables\.com/.test(text))) {
      expect(cli, line.slice(0, 60)).toContain(line.replace(/\]\(references\//g, "]("));
    }
  });

  it("imports without running when argv names a missing entry point", () => {
    const root = fixture();
    const script = pathToFileURL(join(repo, "scripts/plugin-sync.mjs")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(script)})`, join(root, "missing.mjs")], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(existsSync(join(root, bundle))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, manifests[0]), "utf8")).version).toBe("0.0.0");
  });

  it("refuses a path outside the root with a containment error", () => {
    const root = fixture();
    expect(() => refuseSymlinkPath(dirname(root), root)).toThrow("Not under root:");
    expect(existsSync(join(root, bundle))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, manifests[0]), "utf8")).version).toBe("0.0.0");
  });

  it("synchronizes a repository reached through a symlinked ancestor", () => {
    const root = fixture();
    const ancestor = mkdtempSync(join(tmpdir(), "plugin-sync-ancestor-"));
    scratch.push(ancestor);
    symlinkSync(dirname(root), join(ancestor, "linked"), "dir");
    const linkedRoot = join(ancestor, "linked", basename(root));
    mkdirSync(join(root, "scripts"));
    for (const script of ["plugin-sync.mjs", "package-root.mjs"]) cpSync(join(repo, "scripts", script), join(root, "scripts", script));
    const result = spawnSync(process.execPath, [join(linkedRoot, "scripts/plugin-sync.mjs")], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Plugin references and versions synchronized.\n");
    expect(readFileSync(join(root, bundle, "pay.md"), "utf8")).toBe("Payment instructions. See cli.md and [budgets](budget.md).\n");
    expect(() => syncPlugin({ root: linkedRoot, check: true })).not.toThrow();
  });

  it("copies tracked skill files, removes stale files and leaves untracked source files out", () => {
    const root = fixture();
    write(root, `${skill}/scratch.txt`, "Do not ship.\n");
    write(root, `${bundle}/old.md`, "Obsolete.\n");
    syncPlugin({ root });
    expect(readFileSync(join(root, bundle, "pay.md"), "utf8")).toBe("Payment instructions. See cli.md and [budgets](budget.md).\n");
    expect(existsSync(join(root, bundle, "scratch.txt"))).toBe(false);
    expect(existsSync(join(root, bundle, "old.md"))).toBe(false);
    expect(() => syncPlugin({ root, check: true })).not.toThrow();
  });

  it("replaces only the run block with instructions pinned to the client version", () => {
    const root = fixture();
    syncPlugin({ root });
    const bundled = readFileSync(join(root, bundle, "cli.md"), "utf8");
    expect(bundled).toContain("**This reference needs an agent that can run commands.** In a chat app without a terminal, the connector tools in SKILL.md are the route.");
    expect(bundled).not.toContain("the `superstables` skill");
    expect(bundled).toContain("npx --yes @superstables/client@1.2.3 find weather");
    expect(bundled).toContain("npx --yes @superstables/client@1.2.3 budget doctor --rail evm");
    expect(bundled).toContain("budget doctor --rail evm`. In the commands below, `superstables` is shorthand for `npx --yes @superstables/client@1.2.3`. If `superstables` is already installed");
    expect(bundled).toContain("Never run unscoped `npx superstables`");
    expect(bundled).not.toContain("<!--");
    expect(bundled).toMatch(/^Before\. \[Pay\]\(pay\.md\)\n[\s\S]*\nAfter\.\n$/);
    expect(readFileSync(join(root, skill, "SKILL.md"), "utf8")).toBe(sourceSkill);
    expect(() => syncPlugin({ root, check: true })).not.toThrow();
    write(root, `${bundle}/cli.md`, sourceSkill);
    expect(() => syncPlugin({ root, check: true })).toThrow(/cli.md: differs/);
  });

  it("updates the pinned instructions on a version bump and keeps manifest formatting stable", () => {
    const root = fixture();
    syncPlugin({ root });
    const previous = manifests.map((file) => readFileSync(join(root, file), "utf8"));
    write(root, "package.json", JSON.stringify({ version: "2.0.0" }));
    expect(() => syncPlugin({ root, check: true })).toThrow(/version must equal package.json \(2.0.0\)/);
    syncPlugin({ root });
    for (const [index, file] of manifests.entries()) {
      expect(readFileSync(join(root, file), "utf8")).toBe(previous[index].replace('"1.2.3"', '"2.0.0"'));
    }
    expect(readFileSync(join(root, bundle, "cli.md"), "utf8")).toContain("@superstables/client@2.0.0");
    expect(() => syncPlugin({ root, check: true })).not.toThrow();
  });

  it.each(["missing", "duplicate"])("refuses a %s run block before updating manifests", (kind) => {
    const root = fixture();
    write(root, `${skill}/SKILL.md`, kind === "missing" ? "No run block.\n" : sourceSkill + sourceSkill);
    const previous = readFileSync(join(root, manifests[0]), "utf8");
    expect(() => syncPlugin({ root })).toThrow(/exactly one run block/);
    expect(readFileSync(join(root, manifests[0]), "utf8")).toBe(previous);
    expect(existsSync(join(root, bundle))).toBe(false);
  });

  it("writes the source skill body as references/cli.md and the references beside it, with working links", () => {
    const root = fixture();
    syncPlugin({ root });
    expect(readdirSync(join(root, bundle)).sort()).toEqual(["budget.md", "cli.md", "pay.md"]);
    expect(existsSync(join(root, "plugin/skills/superstables-payments"))).toBe(false);
    for (const file of readdirSync(join(root, bundle))) expect(brokenLinks(join(root, bundle, file))).toEqual([]);
  });

  it("refuses a second skill folder in the plugin, in both modes, before updating manifests", () => {
    const root = fixture();
    syncPlugin({ root });
    write(root, "plugin/skills/superstables-payments/SKILL.md", "---\nname: superstables-payments\n---\n");
    write(root, "package.json", JSON.stringify({ version: "2.0.0" }));
    for (const check of [true, false]) {
      expect(() => syncPlugin({ root, check })).toThrow(/plugin\/skills may hold only the superstables skill; remove plugin\/skills\/superstables-payments/);
    }
    expect(JSON.parse(readFileSync(join(root, manifests[0]), "utf8")).version).toBe("1.2.3");
  });

  it("refuses to run without the plugin's own SKILL.md", () => {
    const root = fixture();
    rmSync(join(root, pluginSkill, "SKILL.md"));
    expect(() => syncPlugin({ root })).toThrow(/superstables\/SKILL.md must exist/);
  });

  it("detects and repairs executable mode drift", () => {
    const root = fixture();
    const file = "pay.md";
    chmodSync(join(root, skill, "references", file), 0o755);
    syncPlugin({ root });
    expect(statSync(join(root, bundle, file)).mode & 0o111).toBe(0o111);
    chmodSync(join(root, bundle, file), 0o644);
    expect(() => syncPlugin({ root, check: true })).toThrow(/references\/pay.md: executable mode differs/);
    syncPlugin({ root });
    expect(() => syncPlugin({ root, check: true })).not.toThrow();
  });

  it("detects changed, missing and extra bundled files without repairing them", () => {
    const root = fixture();
    syncPlugin({ root });
    write(root, `${bundle}/cli.md`, "Changed.\n");
    rmSync(join(root, bundle, "pay.md"));
    write(root, `${bundle}/extra.md`, "Extra.\n");
    expect(() => syncPlugin({ root, check: true })).toThrow(/cli.md[\s\S]*pay.md[\s\S]*extra.md/);
    expect(readFileSync(join(root, bundle, "cli.md"), "utf8")).toBe("Changed.\n");
    expect(existsSync(join(root, bundle, "pay.md"))).toBe(false);
    syncPlugin({ root });
    expect(() => syncPlugin({ root, check: true })).not.toThrow();
  });

  it.each(manifests)("detects a version mismatch in %s and synchronizes from package.json", (manifest) => {
    const root = fixture();
    syncPlugin({ root });
    write(root, manifest, JSON.stringify({ name: "superstables", version: "0.0.0" }));
    expect(() => syncPlugin({ root, check: true })).toThrow(`${manifest}: version must equal package.json (1.2.3)`);
    syncPlugin({ root });
    expect(() => syncPlugin({ root, check: true })).not.toThrow();
  });

  it("refuses a tracked source symlink rather than copying its target", () => {
    const root = fixture();
    symlinkSync(join(root, "package.json"), join(root, skill, "linked.json"));
    execFileSync("git", ["add", "skills"], { cwd: root });
    expect(() => syncPlugin({ root })).toThrow(/Symlinks are not allowed/);
  });

  it.each([
    "plugin", "plugin/skills", pluginSkill, bundle, `${bundle}/pay.md`,
    "plugin/.claude-plugin", "plugin/.claude-plugin/plugin.json", "plugin/plugin.json",
    "skills", skill, `${skill}/references`, `${skill}/references/pay.md`,
  ])("refuses a symlink at %s without touching its target or updating manifests", (file) => {
    const root = fixture();
    syncPlugin({ root });
    write(root, "package.json", JSON.stringify({ version: "2.0.0" }));
    const outside = mkdtempSync(join(tmpdir(), "plugin-sync-outside-"));
    scratch.push(outside);
    const target = join(outside, "target");
    const isFile = statSync(join(root, file)).isFile();
    renameSync(join(root, file), target);
    symlinkSync(target, join(root, file), isFile ? "file" : "dir");
    const sentinel = isFile ? target : join(target, "keep.txt");
    if (!isFile) writeFileSync(sentinel, "Keep this outside file.\n");
    const before = readFileSync(sentinel, "utf8");
    for (const check of [true, false]) {
      expect(() => syncPlugin({ root, check })).toThrow(/Symlinks are not allowed/);
      expect(readFileSync(sentinel, "utf8")).toBe(before);
      expect(JSON.parse(readFileSync(join(root, manifests[0]), "utf8")).version).toBe("1.2.3");
    }
  });

  it.each([`${skill}/untracked-link`, `${bundle}/dangling-link`])("refuses even an untracked or dangling symlink at %s", (file) => {
    const root = fixture();
    syncPlugin({ root });
    symlinkSync(join(root, "missing"), join(root, file));
    for (const check of [true, false]) expect(() => syncPlugin({ root, check })).toThrow(/Symlinks are not allowed/);
  });

  it.each(["skill", "version"])("reports %s drift from the CLI with exit 1 and no stack trace", (kind) => {
    const root = fixture();
    syncPlugin({ root });
    mkdirSync(join(root, "scripts"));
    for (const script of ["plugin-sync.mjs", "package-root.mjs"]) cpSync(join(repo, "scripts", script), join(root, "scripts", script));
    if (kind === "skill") write(root, `${bundle}/cli.md`, "Changed.\n");
    else write(root, manifests[0], JSON.stringify({ version: "0.0.0" }));
    const result = spawnSync(process.execPath, [join(root, "scripts/plugin-sync.mjs"), "--check"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(kind === "skill" ? `${bundle}/cli.md: differs` : `${manifests[0]}: version must equal`);
    expect(result.stderr).toContain("Run npm run plugin:sync");
    expect(result.stderr).not.toMatch(/\n\s+at |Error:|file:\/\//);
  });
});

describe("plugin connections and marketplace", () => {
  const json = (file: string) => JSON.parse(readFileSync(join(repo, file), "utf8"));

  it("connects both formats to the same pathless server with discovery-based authentication", () => {
    expect(json("plugin/mcp.json")).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { superstables: { type: "streamable-http", url: "https://mcp.superstables.com" } },
    });
    expect(json("plugin/.mcp.json")).toEqual({
      mcpServers: { superstables: { type: "http", url: "https://mcp.superstables.com" } },
    });
  });

  it("keeps manifest metadata aligned and the marketplace source resolvable", () => {
    const { $schema, ...portable } = json("plugin/plugin.json");
    expect($schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(json("plugin/.claude-plugin/plugin.json")).toEqual(portable);
    const marketplace = json(".claude-plugin/marketplace.json");
    expect(marketplace.metadata.description).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    expect(entry.name).toBe(portable.name);
    expect(json(join(entry.source, ".claude-plugin/plugin.json")).name).toBe(entry.name);
  });
});
