// The operating system's keychain, for budget agent keys: macOS `security`, Linux `secret-tool` (libsecret). Not Tempo's
// on-chain AccountKeychain. The secret is passed on stdin only, never as an argument, so no other user sees it in ps.
import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { agentKeyFile } from "./paths.mjs";
import { readRegularFile } from "./secret-file.mjs";
import { setPrerequisiteCheck } from "../src/core/chain-gate.js";

const SERVICE = "superstables-budget-agent";
/** The `code` of the Error these functions throw when no keychain tool is installed. */
export const KEYCHAIN_UNAVAILABLE = "KEYCHAIN_UNAVAILABLE";
/** The `code` of the Error they throw for a secret or an address that must not be sent, or that came back wrong. */
export const KEYCHAIN_REFUSED = "KEYCHAIN_REFUSED";

// What a secret may look like before it goes anywhere near `security -i`'s tokenizer: an EVM key, or a base58 Solana key.
const SECRET_RE = /^(0x[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{80,90})$/;
const ADDRESS_RE = { evm: /^0x[0-9a-fA-F]{40}$/, solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ };
const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 64 * 1024;

function refused(message) {
  return Object.assign(new Error(message), { code: KEYCHAIN_REFUSED });
}

function isExecutable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name, pathVar = process.env.PATH ?? "") {
  // only absolute entries: a relative one (".", "bin") would let a project folder supply the tool that receives the key
  for (const dir of pathVar.split(delimiter).filter((d) => d && isAbsolute(d))) {
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * The tool this system keeps secrets with, `/usr/bin/security` on macOS, `secret-tool` on Linux (found on the absolute entries of PATH). Null on any other
 * system, or when it is not installed.
 * @param {NodeJS.Platform} [platform]
 * @returns {{ kind: "security" | "secret-tool", path: string } | null}
 */
export function keychainTool(platform = process.platform) {
  const kind = platform === "darwin" ? "security" : platform === "linux" ? "secret-tool" : null;
  if (!kind) return null;
  const path = platform === "darwin" && isExecutable("/usr/bin/security") ? "/usr/bin/security" : onPath(kind);
  return path ? { kind, path } : null;
}

function toolOrThrow(platform) {
  const tool = keychainTool(platform);
  if (!tool) {
    throw Object.assign(new Error(`no keychain tool is installed (${platform === "darwin" ? "security" : "secret-tool, from libsecret-tools"})`), { code: KEYCHAIN_UNAVAILABLE });
  }
  return tool;
}

function checkIds(rail, address) {
  const syntax = ADDRESS_RE[rail];
  if (!syntax) throw refused(`the keychain holds evm and solana agent keys, not ${String(rail).slice(0, 20)}`);
  if (typeof address !== "string" || !syntax.test(address)) throw refused(`not an ${rail} address: ${String(address).slice(0, 60)}`);
  return `${rail}:${address}`;
}

const RUN = (extra) => ({ encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, stdio: ["pipe", "pipe", "pipe"], ...extra });

function failure(err) {
  const stderr = err && err.stderr ? String(err.stderr).trim().split("\n")[0].slice(0, 200) : "";
  return stderr || (err && err.code === "ETIMEDOUT" ? "timed out" : err && err.message ? String(err.message).split("\n")[0].slice(0, 200) : "failed");
}

/**
 * Puts an agent key in the keychain, from standard input. Reads it back and compares, because `security -i` can report a
 * failed command without a failing exit status. Throws, and stores nothing it cannot read back, otherwise.
 * @param {"evm" | "solana"} rail
 * @param {string} address
 * @param {string} secret
 * @param {typeof execFileSync} [run]
 * @param {NodeJS.Platform} [platform]
 */
export function storeAgentSecret(rail, address, secret, run = execFileSync, platform = process.platform) {
  const account = checkIds(rail, address);
  if (typeof secret !== "string" || !SECRET_RE.test(secret)) throw refused("the agent key is not in a form the keychain can take; nothing was sent to it");
  const tool = toolOrThrow(platform);
  try {
    if (tool.kind === "security") {
      run(tool.path, ["-i"], RUN({ input: `add-generic-password -U -s ${SERVICE} -a ${account} -w ${secret}\n` }));
    } else {
      run(tool.path, ["store", `--label=Superstables budget agent ${account}`, "service", SERVICE, "account", account], RUN({ input: secret }));
    }
  } catch (err) {
    throw new Error(`the keychain did not take the key: ${failure(err)}`);
  }
  let back;
  try {
    back = readAgentSecret(rail, address, run, platform);
  } catch {
    throw new Error("the keychain did not keep the key: it could not be read back");
  }
  if (back !== secret) throw new Error("the keychain did not keep the key: what it returned differs");
}

/**
 * The agent key in the keychain. Throws "the agent key for <address> is not in the keychain" when there is none.
 * @param {"evm" | "solana"} rail
 * @param {string} address
 * @param {typeof execFileSync} [run]
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function readAgentSecret(rail, address, run = execFileSync, platform = process.platform) {
  const account = checkIds(rail, address);
  const tool = toolOrThrow(platform);
  let out;
  try {
    out =
      tool.kind === "security"
        ? run(tool.path, ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], RUN({}))
        : run(tool.path, ["lookup", "service", SERVICE, "account", account], RUN({}));
  } catch (err) {
    const why = failure(err);
    throw Object.assign(new Error(`the agent key for ${address} is not in the keychain${why && why !== "failed" ? ` (${why})` : ""}`), { code: KEYCHAIN_REFUSED });
  }
  const secret = String(out ?? "").trim();
  if (!secret) throw Object.assign(new Error(`the agent key for ${address} is not in the keychain`), { code: KEYCHAIN_REFUSED });
  if (!SECRET_RE.test(secret)) throw Object.assign(new Error(`the keychain entry for ${address} is not an agent key`), { code: KEYCHAIN_REFUSED });
  return secret;
}

/**
 * Removes an agent key's entry. An entry that is not there is not an error.
 * @param {"evm" | "solana"} rail
 * @param {string} address
 * @param {typeof execFileSync} [run]
 * @param {NodeJS.Platform} [platform]
 */
export function deleteAgentSecret(rail, address, run = execFileSync, platform = process.platform) {
  const account = checkIds(rail, address);
  const tool = toolOrThrow(platform);
  try {
    if (tool.kind === "security") run(tool.path, ["delete-generic-password", "-s", SERVICE, "-a", account], RUN({}));
    else run(tool.path, ["clear", "service", SERVICE, "account", account], RUN({}));
  } catch (err) {
    const code = err && err.status;
    // security exits 44 for "not found"; secret-tool clear exits 0 for none
    if (code === 44) return;
    throw new Error(`the keychain did not remove the key: ${failure(err)}`);
  }
}

const STORE_LINES = { evm: ["B4_AGENT_KEY_STORE", "B4_AGENT_KEY"], solana: ["SOLANA_AGENT_KEY_STORE", "SOLANA_AGENT_SECRET_BASE58"] };

/**
 * How this machine keeps the rail's agent key: "os-keychain" (the file names the keychain and holds no key), "file",
 * "absent", or "unreadable" (not a regular file, too large, or unreadable). Keeps nothing it read. Tempo is always "file".
 * @param {string} rail
 * @param {string} [path]
 * @returns {"os-keychain" | "file" | "absent" | "unreadable"}
 */
export function agentKeyStorage(rail, path = agentKeyFile(rail)) {
  const names = Object.hasOwn(STORE_LINES, rail) ? STORE_LINES[rail] : undefined;
  let text;
  try {
    text = readRegularFile(path, "agent key file");
  } catch (err) {
    return /** @type {any} */ (err)?.code === "ENOENT" ? "absent" : "unreadable";
  }
  if (!names) return "file";
  const lines = new Map(text.split(/\r?\n/).map((l) => l.match(/^([A-Za-z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  return lines.get(names[0]) === "os-keychain" && !lines.get(names[1]) ? "os-keychain" : "file";
}

// The chain gate's key prerequisite (src/core/chain-gate.js): this rail's agent key file names the keychain and holds no key.
setPrerequisiteCheck("agentKeyStore", (rail) => agentKeyStorage(String(rail)) === "os-keychain");
