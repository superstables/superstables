// Whether `superstables budget setup` has finished on this computer for a rail and chain: the agent key exists and an owner
// has connected. Reads two files, never the chain, and prints nothing: a buy asks it before it takes its lock, writes a
// journal or starts a rail script, so a buy with no setup is refused with nothing signed, and status asks it to say so
// first. Whether the owner has granted a budget is on chain: the rail reads it before it signs.
//
// Variable names per rail are the ones the setup scripts write (evm/setup.ts, tempo/setup.ts, solana/setup.ts) and
// doctor.mjs checks.
import { existsSync, readFileSync } from "node:fs";
import { agentKeyFile, publicFile } from "./paths.mjs";

const VARS = {
  evm: (label) => ({ key: "B4_AGENT_KEY", owner: "B4_OWNER_ADDRESS", agent: "B4_AGENT_ADDRESS", ownerInAgentFile: false, label }),
  // tempo keeps the owner's address in the agent file too; an extra agent key is AGENT<label>_*
  tempo: (label = "") => ({ key: `AGENT${label}_PRIVATE_KEY`, owner: "OWNER_ADDRESS", agent: `AGENT${label}_ADDRESS`, ownerInAgentFile: true, label }),
  solana: (label) => ({ key: "SOLANA_AGENT_SECRET_BASE58", owner: "SOLANA_OWNER_ADDRESS", agent: "SOLANA_AGENT_ADDRESS", ownerInAgentFile: true, label }),
};

function readEnv(path) {
  const out = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2] !== "") out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * What setup has not done yet for this rail and chain (tempo: and agent label), in plain words; [] when both the agent key
 * and the owner are recorded. `agentKey` and `publicFile` are the paths it looked at.
 * @returns {{ missing: string[], agentKey: string, publicFile: string }}
 */
export function setupGaps({ rail, chain, agent }) {
  const v = VARS[rail](agent ?? "");
  const keyPath = agentKeyFile(rail);
  const pubPath = publicFile(rail, chain);
  const keys = readEnv(keyPath);
  const pub = readEnv(pubPath);
  const missing = [];
  if (!existsSync(keyPath)) missing.push("no agent key on this computer");
  else if (!keys[v.key]) missing.push(v.label ? `no agent key for --agent ${v.label}` : "the agent key file holds no key");
  const owner = pub[v.owner] ?? (v.ownerInAgentFile ? keys[v.owner] : undefined);
  if (!owner) missing.push("no owner has connected a wallet");
  return { missing, agentKey: keyPath, publicFile: pubPath };
}

/** The owner's commands, in order, that make a budget on this rail and chain: for a `next` field or a log line. */
export function ownerSteps(rail, chain, defaultChain) {
  const c = chain && chain !== defaultChain ? ` --chain ${chain}` : "";
  const r = `--rail ${rail}${c}`;
  const fund = rail === "tempo" ? "" : `superstables budget fund-agent ${r}, superstables budget doctor ${r}, `;
  return `superstables budget setup ${r}, ${fund}superstables budget grant ${r} --amount A`;
}
