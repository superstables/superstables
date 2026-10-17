// Finishing a move of an agent key into the OS keychain that a stopped `setup --key-store os-keychain` left half done (evm/setup.ts,
// solana/setup.ts): the key went into the keychain, the replacement that names it was written beside the key file, the key file's
// bytes were overwritten, and the process stopped before the rename. The key file then holds only zeros.
import { renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { isZeroed, leftoverReplacements } from "./secret-file.mjs";
import { KEYCHAIN_UNAVAILABLE, readAgentSecret } from "./os-keychain.mjs";
import { syncDirectory } from "../src/core/private-dir.mjs";

const SERVICE = "superstables-budget-agent";
const ADDRESS_RE = { evm: /^0x[0-9a-fA-F]{40}$/, solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ };
const KEEP = "do not start a new agent: the old one may still hold a live budget";
const said = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
};
const linesOf = (text) => new Map(text.split(/\r?\n/).map((l) => l.match(/^([A-Za-z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));

/**
 * @param {"evm" | "solana"} rail
 * @param {string} path  the agent key file
 * @param {{ storeVar: string, addressVar: string, keyVar: string, addressOf: (secret: string) => string, publicAddress?: () => string | undefined }} o
 * @returns {{ state: "none" } | { state: "finished", address: string, replacement: string } | { state: "refused", reason: string, next: string }}
 */
export function resumeKeychainMove(rail, path, o) {
  if (!isZeroed(path)) return { state: "none" };
  const same = (a, b) => (rail === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const kept = [];
  for (const r of leftoverReplacements(path)) {
    const lines = linesOf(r.text);
    const address = lines.get(o.addressVar);
    if (lines.get(o.storeVar) === "os-keychain" && address !== undefined && ADDRESS_RE[rail].test(address) && !lines.get(o.keyVar)) kept.push({ ...r, address });
  }
  const other = kept.find((r) => r.pid !== process.pid && alive(r.pid));
  if (other) {
    return { state: "refused", reason: `another setup (process ${other.pid}) is moving the agent key into the keychain now`, next: "wait for it to finish, then run setup again" };
  }
  const addresses = [];
  for (const r of kept) if (!addresses.some((a) => same(a, r.address))) addresses.push(r.address);
  if (addresses.length === 0) return noReplacement(rail, path, o);
  if (addresses.length > 1) {
    return {
      state: "refused",
      reason: `${path} holds only zeros, and the replacements beside it name different agents: ${kept.map((r) => r.path).join(", ")}`,
      next: `keep the one whose address the public file names, delete the others, then run setup again; ${KEEP}`,
    };
  }
  const address = addresses[0];
  const mine = kept.filter((r) => same(r.address, address));
  const replacement = mine[0];
  let secret;
  try {
    secret = readAgentSecret(rail, address);
  } catch (err) {
    const unavailable = err?.code === KEYCHAIN_UNAVAILABLE;
    return {
      state: "refused",
      reason: `${path} holds only zeros: an earlier setup was moving the agent key into the OS keychain and stopped before it replaced the file. ${replacement.path} holds the replacement, which names agent ${address}, but the keychain did not give its key back (${err.message})`,
      next: unavailable
        ? `run setup on the machine and account whose keychain holds the key, with secret-tool (Linux) or security (macOS) installed; ${KEEP}`
        : `unlock the keychain, then run setup again; ${KEEP}`,
    };
  }
  let derived;
  try {
    derived = o.addressOf(secret);
  } catch {
    derived = "an unreadable key";
  }
  if (typeof derived !== "string" || !same(derived, address)) {
    return {
      state: "refused",
      reason: `the keychain entry ${SERVICE} / ${rail}:${address} holds the key of another address (${derived})`,
      next: `nothing was changed; look the entry up, and ${KEEP}`,
    };
  }
  try {
    renameSync(replacement.path, path);
  } catch (err) {
    return { state: "refused", reason: `${replacement.path} could not be renamed over ${path} (${err.message})`, next: `mv ${replacement.path} ${path}, then run setup again` };
  }
  try {
    syncDirectory(dirname(path));
  } catch {
    // the rename has happened; flushing the folder is best effort
  }
  for (const r of mine.slice(1)) {
    try {
      unlinkSync(r.path);
    } catch {
      // gone already
    }
  }
  return { state: "finished", address, replacement: replacement.path };
}

function noReplacement(rail, path, o) {
  let known;
  try {
    const a = o.publicAddress?.();
    if (typeof a === "string" && ADDRESS_RE[rail].test(a)) known = a;
  } catch {
    // the public file is not readable: the address is unknown
  }
  const first = `${path} holds only zeros and no replacement is beside it: a move of the agent key into the OS keychain stopped after the file was overwritten.`;
  const A = known ?? "ADDRESS";
  const lookup = `secret-tool lookup service ${SERVICE} account ${rail}:${A} on Linux, or security find-generic-password -s ${SERVICE} -a ${rail}:${A} -w on macOS`;
  return {
    state: "refused",
    reason: known
      ? `${first} The public file names agent ${known}; its key should be in the keychain under service ${SERVICE}, account ${rail}:${known}`
      : `${first} Its key should be in the keychain under service ${SERVICE}, account ${rail}:<the agent's address>`,
    // the warning comes first: the RESULT line the dispatcher prints cuts a long `next`, and this is the part that must not be lost
    next: `${said(KEEP)}. Look the key up (${lookup}), write ${path} (mode 600) with the two lines ${o.storeVar}=os-keychain and ${o.addressVar}=${A}, then run setup again`,
  };
}
