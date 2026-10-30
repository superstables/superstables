import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildPluginZips } from "../../scripts/plugin-zip.mjs";
import { CLI_FORMS_WITH_TOOLS, CONNECTOR_TOOLS, LOCAL_ONLY, PLUGIN_ZIPS, zipName } from "../../scripts/plugin-data.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "plugin-zip-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));
const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const text = (file: string) => readFileSync(join(repo, file), "utf8");
const pluginSkill = text("plugin/skills/superstables/SKILL.md");
const cliSkill = text("skills/superstables-payments/SKILL.md");

describe("plugin zips", () => {
  const built = buildPluginZips(repo, out);

  it("makes one zip per app in the table, named by app and version", () => {
    expect(built.map((b) => b.name)).toEqual(PLUGIN_ZIPS.map((z) => zipName(z.app, version)));
  });

  for (const { app, layout } of PLUGIN_ZIPS) {
    it(`${app}: ${layout} layout, version file and hashes`, () => {
      const name = zipName(app, version);
      const bytes = readFileSync(join(out, name));
      expect(readFileSync(join(out, `${name}.sha256`), "utf8")).toBe(`${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`);
      const files = unzipSync(new Uint8Array(bytes));
      const names = Object.keys(files);
      expect(Buffer.from(files.VERSION).toString()).toBe(`${version}\n`);
      for (const line of Buffer.from(files.SHA256SUMS).toString().trim().split("\n")) {
        const [hash, file] = line.split("  ");
        expect(createHash("sha256").update(files[file]).digest("hex")).toBe(hash);
      }
      const claudeManifests = names.filter((n) => n.endsWith(".claude-plugin/plugin.json"));
      if (layout === "marketplace") {
        expect(names).toContain(".claude-plugin/marketplace.json");
        expect(names).toContain("plugin/skills/superstables/SKILL.md");
      } else if (layout === "claude-root") {
        expect(claudeManifests).toEqual([".claude-plugin/plugin.json"]);
        expect(names).not.toContain("plugin.json");
      } else {
        expect(names).toContain("plugin.json");
        expect(names).toContain("mcp.json");
        expect(claudeManifests).toEqual([]);
        expect(JSON.parse(Buffer.from(files["plugin.json"]).toString()).$schema).toMatch(/agent-plugins\.org/);
      }
      if (layout !== "marketplace") expect(names).toContain("skills/superstables/SKILL.md");
    });
  }
});

describe("connector and local operations", () => {
  it("names every connector tool in the plugin skill", () => {
    for (const tool of CONNECTOR_TOOLS) expect(pluginSkill, tool).toContain(`\`${tool}\``);
  });

  it("names no connector tool the server does not have", () => {
    const named = new Set([...pluginSkill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]));
    const toolLike = [...named].filter((n) => n !== "wait_seconds" && /^(get|find|request|submit|wait|list|remove|preflight)_/.test(n));
    for (const n of toolLike) expect(CONNECTOR_TOOLS, n).toContain(n);
  });

  it("keeps the local-only operations on the CLI and says so", () => {
    for (const op of LOCAL_ONLY) expect(cliSkill, op).toContain(op);
    expect(pluginSkill).toContain("--sign-only");
  });

  it("routes no local-only operation through the connector", () => {
    for (const op of ["budget buy", "pay", "recover", "reconcile"]) {
      expect(CONNECTOR_TOOLS.some((t) => t.includes(op.replace(" ", "_")) && op !== "pay")).toBe(false);
    }
    expect(CONNECTOR_TOOLS).not.toContain("pay");
  });

  it("sends a signed-in person to the tool for each CLI form that has one", () => {
    for (const [form, tool] of Object.entries(CLI_FORMS_WITH_TOOLS)) {
      expect(cliSkill, form).toContain(`\`${tool}\``);
    }
  });

  it("no longer says the connector lacks a tool", () => {
    for (const file of ["plugin/skills/superstables/SKILL.md", "plugin/skills/superstables/references/cli.md", "skills/superstables-payments/SKILL.md", "skills/superstables-payments/references/budget.md"]) {
      expect(text(file)).not.toMatch(/connector has no tool/);
    }
  });

  it("states the server's waiting rule", () => {
    expect(pluginSkill).toMatch(/`get_purchase_status` with `wait_seconds` 25/);
    expect(pluginSkill).toMatch(/only when the turn\s+ends|shows your reply only when the turn\s+ends/);
    expect(pluginSkill).not.toMatch(/Do not approve for them or poll/);
  });

  it("does not use the word recommended in the skill or README", () => {
    for (const file of ["plugin/skills/superstables/SKILL.md", "README.md"]) expect(text(file), file).not.toMatch(/recommended/i);
  });
});
