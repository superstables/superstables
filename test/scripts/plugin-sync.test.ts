import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { syncPlugin } from "../../scripts/plugin-sync.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const scratch: string[] = [];
const skill = "skills/superstables-payments";
const bundle = `plugin/${skill}`;
const manifests = ["plugin/plugin.json", "plugin/.claude-plugin/plugin.json"];

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
  write(root, `${skill}/SKILL.md`, "---\nname: superstables-payments\n---\n");
  write(root, `${skill}/references/pay.md`, "Payment instructions.\n");
  execFileSync("git", ["add", "skills"], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("plugin synchronization", () => {
  it("checks the committed package's skill copy and client versions", () => {
    expect(() => syncPlugin({ root: repo, check: true })).not.toThrow();
  });

  it("copies tracked skill files, removes stale files and leaves untracked source files out", () => {
    const root = fixture();
    write(root, `${skill}/scratch.txt`, "Do not ship.\n");
    write(root, `${bundle}/old.md`, "Obsolete.\n");
    syncPlugin({ root });
    expect(readFileSync(join(root, bundle, "references/pay.md"), "utf8")).toBe("Payment instructions.\n");
    expect(existsSync(join(root, bundle, "scratch.txt"))).toBe(false);
    expect(existsSync(join(root, bundle, "old.md"))).toBe(false);
    expect(() => syncPlugin({ root, check: true })).not.toThrow();
  });

  it("detects changed, missing and extra bundled files without repairing them", () => {
    const root = fixture();
    syncPlugin({ root });
    write(root, `${bundle}/SKILL.md`, "Changed.\n");
    rmSync(join(root, bundle, "references/pay.md"));
    write(root, `${bundle}/extra.md`, "Extra.\n");
    expect(() => syncPlugin({ root, check: true })).toThrow(/SKILL.md[\s\S]*references\/pay.md[\s\S]*extra.md/);
    expect(readFileSync(join(root, bundle, "SKILL.md"), "utf8")).toBe("Changed.\n");
    expect(existsSync(join(root, bundle, "references/pay.md"))).toBe(false);
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
    expect(() => syncPlugin({ root })).toThrow(/regular source file/);
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
