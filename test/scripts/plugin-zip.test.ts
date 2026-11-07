import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { checkSkill, OTHER_FILES, SKILL_FILE } from "../../scripts/connector-contract-check.mjs";
import { buildPluginZips } from "../../scripts/plugin-zip.mjs";
import { CLI_FORMS_WITH_TOOLS, LOCAL_ONLY, PLUGIN_ZIPS, zipName } from "../../scripts/plugin-data.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "plugin-zip-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));
const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const text = (file: string) => readFileSync(join(repo, file), "utf8");
const pluginSkill = text("plugin/skills/superstables/SKILL.md");
// The server's tools and waiting rule, a generated copy from the connector's code (test/scripts/connector-contract.json).
// When this file is out of date the server changed: regenerate it there (`npm run contract`) and copy it here.
const contract = JSON.parse(text("test/scripts/connector-contract.json")) as { tools: string[]; waits: Record<string, number>; purchaseWait: { tool: string; param: string; seconds: number } };
const CONNECTOR_TOOLS = contract.tools;
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
        expect(names).toContain("plugin/assets/icon.png");
        expect(names).toContain("plugin/skills/superstables/assets/icon-large.png");
      } else if (layout === "claude-root") {
        expect(claudeManifests).toEqual([".claude-plugin/plugin.json"]);
        expect(names).not.toContain("plugin.json");
        expect(names).not.toContain(".cursor-plugin/plugin.json");
        expect(names).toContain("assets/icon.png");
      } else {
        expect(names).toContain("plugin.json");
        expect(names).toContain("mcp.json");
        expect(claudeManifests).toEqual([]);
        expect(JSON.parse(Buffer.from(files[".cursor-plugin/plugin.json"]).toString()).logo).toBe("assets/icon.png");
        expect(names).toContain("assets/icon.png");
        expect(JSON.parse(Buffer.from(files["plugin.json"]).toString()).$schema).toMatch(/agent-plugins\.org/);
      }
      if (layout !== "marketplace") expect(names).toContain("skills/superstables/SKILL.md");
    });
  }
});

describe("connector and local operations", () => {
  it("matches the server: names every tool it serves and none it lacks, states its waiting rule, says nothing it contradicts", () => {
    const read = (path: string) => ({ path, text: text(path) });
    expect(checkSkill(contract, read(SKILL_FILE), OTHER_FILES.map(read))).toEqual([]);
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

  it("gives install commands, in the README and the skill, that name the marketplace and plugin in .claude-plugin/marketplace.json", () => {
    const market = JSON.parse(text(".claude-plugin/marketplace.json")) as { name: string; plugins: { name: string }[] };
    const ref = `${market.plugins[0].name}@${market.name}`;
    const readme = text("README.md");
    const lines = [...readme.matchAll(/(?:claude plugin install|codex plugin add) (\S+?)(?=`|\s|$)/g)];
    expect(lines.length, "README.md has no plugin install command").toBeGreaterThanOrEqual(2);
    for (const [line, got] of lines) expect(got, `README.md: "${line}" must name ${ref}, from .claude-plugin/marketplace.json`).toBe(ref);
    for (const file of ["plugin/skills/superstables/SKILL.md", "plugin/skills/superstables/references/cli.md"]) {
      for (const [line, got] of text(file).matchAll(/(?:claude plugin install|codex plugin add) (\S+?)(?=`|\s|$)/g)) expect(got, `${file}: "${line}"`).toBe(ref);
    }
  });
});

describe("the contract check catches a changed waiting rule", () => {
  const skill = text("plugin/skills/superstables/SKILL.md");
  const run = (t: string) => checkSkill(contract, { path: "SKILL.md", text: t }, []);
  it("fails when same-turn polling is replaced by ending the turn, wrapped or not", () => {
    const bad = skill.replace(/Then, in the same turn, call\s+`get_purchase_status`[\s\S]*?Report what it establishes\./, "End your turn now. Never poll for purchase approval.");
    expect(bad).not.toBe(skill);
    expect(run(bad).length).toBeGreaterThan(0);
    expect(run(`${skill}\nDo not approve for them or\npoll while waiting.`).length).toBeGreaterThan(0);
  });
});
