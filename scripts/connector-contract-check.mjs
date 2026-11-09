#!/usr/bin/env node
// Checks the plugin skill against the connector's contract (test/scripts/connector-contract.json, a copy generated from
// the server's own code): it must name every tool the server serves, name no tool the server lacks, state the
// server's waiting rule, and not say the connector lacks a tool or forbid polling. Runs in `npm run skill:check`, so CI
// runs it on every push, and test/scripts/plugin-zip.test.ts runs the same function.
// When it fails after the server changed, regenerate the contract there (`npm run contract`), copy it here, and
// update plugin/skills/superstables/SKILL.md. Never edit the contract by hand to make this pass.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export const CONTRACT_FILE = "test/scripts/connector-contract.json";
export const SKILL_FILE = "plugin/skills/superstables/SKILL.md";
/** Other files that may talk about the connector. They are held to the forbidden phrases only. */
export const OTHER_FILES = ["plugin/skills/superstables/references/cli.md", "skill-source/cli.md", "skill-source/references/budget.md"];

const FORBIDDEN = [
  { pattern: /connector has no tool/i, why: "the connector has the tool; send the person to it" },
  { pattern: /Do not approve for (?:them|the user) or poll/i, why: "the server tells the agent to keep calling get_purchase_status with wait_seconds in the same turn" },
  { pattern: /\b(?:never|do not|don't) poll/i, skillOnly: true, why: "the server tells the agent to keep calling get_purchase_status with wait_seconds in the same turn" },
];
const TOOL_LIKE = /^(get|find|request|submit|wait|list|remove|preflight)_/;

/** Problems, each naming the file and the fix. `files` is { path, text } for the skill and the other files. */
export function checkSkill(contract, skillIn, others = []) {
  const flat = (f) => ({ path: f.path, text: f.text.replace(/\s+/g, " ") });
  const skill = flat(skillIn);
  others = others.map(flat);
  const problems = [];
  const named = new Set([...skill.text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]));
  for (const tool of contract.tools) {
    if (!skill.text.includes(`\`${tool}\``)) problems.push(`${skill.path} does not name \`${tool}\`, which the server serves. Add it under "The connector tools" and say when to use it.`);
  }
  for (const n of named) {
    if (n !== "wait_seconds" && TOOL_LIKE.test(n) && !contract.tools.includes(n)) problems.push(`${skill.path} names \`${n}\`, which the server does not serve. Remove it or fix the name.`);
  }
  for (const [tool, max] of Object.entries(contract.waits)) {
    if (!new RegExp(`\`${tool}\` with \`wait_seconds\` ${max}\\b`).test(skill.text)) problems.push(`${skill.path} must say to call \`${tool}\` with \`wait_seconds\` ${max}, as the server's instructions do.`);
  }
  const { tool, param, seconds } = contract.purchaseWait;
  if (!new RegExp(`in the same turn, call \`${tool}\` with \`${param}\` ${seconds}, and keep calling it while`).test(skill.text)) problems.push(`${skill.path} must say, after request_purchase, "in the same turn, call \`${tool}\` with \`${param}\` ${seconds}, and keep calling it while ..." (the server's waiting rule).`);
  if (!/If your app shows your reply only when the turn ends, end your turn/.test(skill.text)) problems.push(`${skill.path} must say to end the turn only "If your app shows your reply only when the turn ends" (the server's waiting rule).`);
  for (const file of [skill, ...others]) {
    for (const { pattern, why, skillOnly } of FORBIDDEN) {
      if (skillOnly && file !== skill) continue;
      const m = pattern.exec(file.text);
      if (m) problems.push(`${file.path} says "${m[0]}": ${why}.`);
    }
  }
  return problems;
}

const read = (path) => ({ path, text: readFileSync(root + path, "utf8") });

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = checkSkill(JSON.parse(readFileSync(root + CONTRACT_FILE, "utf8")), read(SKILL_FILE), OTHER_FILES.map(read));
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log("connector contract: the plugin skill matches the server");
}
