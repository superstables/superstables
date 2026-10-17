// The agent addresses this machine retired with `budget rotate`: never granted, funded, set up or used to buy again here.
//
// keys/budget/retired.json, mode 600, written through writeJournalFile (journal.mjs):
//   { "version": 1, "retired": [ { "rail", "address", "retiredAt", "reason" } ] }
// An absent file means none retired. A file that is there but is not a regular file, is larger than a megabyte, is not JSON
// or does not have this shape throws, and every check that reads it refuses: an unreadable list never means "none retired".
// Addresses compare without case on evm and tempo, exactly on solana. The file sits next to the agent's key files, so it is
// only as strong as they are: the owner's on-chain revoke is what stops a stolen key (docs/security.md).
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KEYS_DIR } from "./paths.mjs";
import { writeJournalFile } from "./journal.mjs";

export const RETIRED_PATH = join(KEYS_DIR, "retired.json");
/** More than any list this client writes. */
const MAX_BYTES = 1024 * 1024;
const RAILS = ["evm", "solana", "tempo"];

const unusable = (why) => new Error(`the retired-keys list ${RETIRED_PATH} cannot be read: ${why}`);
const same = (rail, a, b) => (rail === "solana" ? a === b : String(a).toLowerCase() === String(b).toLowerCase());

/** The list as { version: 1, retired: [...] }; an absent file is the empty list. Throws when the file cannot be trusted. */
export function readRetired() {
  let fd;
  try {
    // O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer forever
    fd = openSync(RETIRED_PATH, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if (err?.code === "ENOENT") return { version: 1, retired: [] };
    throw unusable(`it could not be opened (${/^[A-Z0-9_]+$/.test(String(err?.code)) ? err.code : "error"})`);
  }
  let text;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw unusable("it is not a regular file");
    if (st.size > MAX_BYTES) throw unusable(`it is larger than a list this client writes (${st.size} bytes)`);
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  let value;
  try { value = JSON.parse(text); } catch { throw unusable("it is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.retired)) throw unusable("it does not hold a version 1 list");
  for (const e of value.retired) {
    const ok = e && typeof e === "object" && RAILS.includes(e.rail) && ["address", "retiredAt", "reason"].every((k) => typeof e[k] === "string");
    if (!ok) throw unusable("an entry is missing its rail, address, retiredAt or reason");
  }
  return value;
}

/** The entry for this address, or undefined. Throws as readRetired does. */
export function retiredEntry(rail, address) {
  return readRetired().retired.find((e) => e.rail === rail && same(rail, e.address, address));
}

/** Whether this agent address was retired on this machine. Throws as readRetired does. */
export function isRetired(rail, address) {
  return retiredEntry(rail, address) !== undefined;
}

/** "" when the address may be used, else why not (also when the list itself cannot be read). Never throws. */
export function retiredProblem(rail, address) {
  try {
    const e = retiredEntry(rail, address);
    return e ? `agent ${address} was retired by \`budget rotate\` on ${e.retiredAt}; it is never granted, funded, set up or used again` : "";
  } catch (err) {
    return err.message;
  }
}

/** Adds the address to the list unless it is there. Returns the entry. Throws as readRetired does. */
export function retire(rail, address, reason, now = new Date()) {
  const list = readRetired();
  const have = list.retired.find((e) => e.rail === rail && same(rail, e.address, address));
  if (have) return have;
  const entry = { rail, address, retiredAt: now.toISOString(), reason };
  writeJournalFile(RETIRED_PATH, `${JSON.stringify({ version: 1, retired: [...list.retired, entry] }, null, 2)}\n`);
  return entry;
}
