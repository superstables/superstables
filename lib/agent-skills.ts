/**
 * The one agent skill we publish: how to use the index. The source is skills/superstables-index/SKILL.md
 * in this repository (also the Agent Plugins layout, with plugin.json and mcp.json at the root). It is
 * served at SKILL_PATH as text/markdown and listed in /.well-known/agent-skills/index.json, whose digest
 * is computed from the exact bytes served.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE } from "@/lib/site";
export { SITE };
export const SKILL_NAME = "superstables-index";
export const SKILL_PATH = `/skills/${SKILL_NAME}/SKILL.md`;

const PRODUCTION = "https://www.superstables.com";
const FILE = readFileSync(join(process.cwd(), "skills", SKILL_NAME, "SKILL.md"), "utf8");

/** The document as served: the repository file, with links pointing at this deployment's origin. */
export const SKILL_MD = SITE === PRODUCTION ? FILE : FILE.replaceAll(PRODUCTION, SITE);

/** The description from the file's frontmatter, so the discovery index always matches the document. */
export const SKILL_DESCRIPTION = (() => {
  const m = /^description:\s*"?(.*?)"?\s*$/m.exec(FILE);
  if (!m) throw new Error("SKILL.md frontmatter has no description");
  return m[1];
})();
