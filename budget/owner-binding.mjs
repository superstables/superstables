// Whether the owner on record signed for the agent address an owner plan names. Setup stores the exact text the owner's wallet
// signed (the sign-in on this computer, or the site's owner proof) and the signature; every grant, gas transfer and recovery checks
// them, the agent key file on this machine, and the retired list before it builds anything.
//
// The binding is three public lines: SETUP_MESSAGE (base64url of the UTF-8 text), SETUP_SIGNATURE (0x hex) and SETUP_SIGNED_AT (ISO).
// On tempo a labelled key uses AGENT<label>_SETUP_*. Verification is offline and covers EOA (EIP-191) and ed25519 owners only.
// The binding is owner to agent, not chain: the local text names a chain label and the hosted text a chain, and neither is compared
// (EVM uses one agent key on every chain). It proves who the owner on record signed for, not who that owner is.
// Plain JS; imports only viem, node:crypto and ./retired.mjs, so it bundles into the rail scripts like site.mjs.
import { createPrivateKey, createPublicKey, randomBytes, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { retiredProblem } from "./retired.mjs";
import { siteOrigin } from "./site.mjs";

export const SETUP_KEYS = ["SETUP_MESSAGE", "SETUP_SIGNATURE", "SETUP_SIGNED_AT"];
/** The three keys; a tempo label ("2") gives AGENT2_SETUP_MESSAGE and so on. */
export function setupKeys(label = "") {
  return SETUP_KEYS.map((k) => (label ? `AGENT${label}_${k}` : k));
}

/** The public-file lines for a binding: { [key]: value }. */
export function bindingLines({ message, signature, signedAt = new Date() }, label = "") {
  const [m, s, t] = setupKeys(label);
  return { [m]: Buffer.from(message, "utf8").toString("base64url"), [s]: signature, [t]: new Date(signedAt).toISOString() };
}

const MAX_MESSAGE_BYTES = 2048;
const LOCAL_TAIL = "\nThis signature grants no spending permission and has no network fee.";
const LOCAL = /^Superstables budget: record this wallet as the owner of agent (\S+) on ([^\n]+)\.\n\nApproval id: ([0-9a-f]{32})\nThis signature grants no spending permission and has no network fee\.$/;
const HOSTED_TITLE = "Superstables: add an agent to my account";
const HOSTED_FIELDS = ["site", "owner", "agent", "rail", "chain", "request", "code"];

/**
 * Strict parse of the three texts this client has ever had signed: { kind: "local", agent } (the sign-in on this computer), or
 * { kind: "hosted", agent, owner, rail, version } (the site's owner proof: eight lines, or nine with the v2 title and a final
 * `account:` line). Anything else, including any line before, after or between, is null.
 */
export function signedNames(rail, message) {
  if (typeof message !== "string") return null;
  const local = LOCAL.exec(message);
  if (local) return { kind: "local", agent: local[1], chain: local[2] };
  const lines = message.split("\n");
  let version = 1;
  if (lines[0] === `${HOSTED_TITLE} (v2)`) version = 2;
  else if (lines[0] !== HOSTED_TITLE) return null;
  if (lines.length !== (version === 2 ? 9 : 8)) return null;
  const got = {};
  for (let i = 0; i < HOSTED_FIELDS.length; i++) {
    const prefix = `${HOSTED_FIELDS[i]}: `;
    const line = lines[i + 1];
    if (!line.startsWith(prefix) || line.length === prefix.length) return null;
    got[HOSTED_FIELDS[i]] = line.slice(prefix.length);
  }
  if (version === 2 && !/^account: \S+$/.test(lines[8])) return null;
  void rail;
  return { kind: "hosted", agent: got.agent, owner: got.owner, rail: got.rail, version };
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = BASE58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function ed25519Verifies(address, message, signature) {
  if (!/^0x[0-9a-fA-F]{128}$/.test(signature)) return false;
  const pub = base58Decode(address);
  if (!pub || pub.length !== 32) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pub).toString("base64url") }, format: "jwk" });
    return verifyBytes(null, Buffer.from(message, "utf8"), key, Buffer.from(signature.slice(2), "hex"));
  } catch {
    return false;
  }
}

async function eip191Signer(message, signature) {
  if (!/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(signature)) return null;
  try {
    return await recoverMessageAddress({ message, signature });
  } catch {
    return null;
  }
}

const sameAddress = (rail, a, b) => (rail === "solana" ? a === b : String(a).toLowerCase() === String(b).toLowerCase());
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * @param rail "evm" | "solana" | "tempo"
 * @param pub  { owner, agent, lines }: the public file's owner and agent, and all its KEY=value lines
 * @param opts { label?: string, keyAgent?: string | null, file?: string, retiredOk?: boolean, testnet?: boolean }
 *   label: the tempo key label; keyAgent: the agent key file's address, null when there is no file here; file: its name, for the words;
 *   retiredOk: skip the retired list (only recover, which returns a retired key's funds to the signed owner);
 *   testnet: the chain is marked testnet. A file without the owner's signature (legacy) is refused on any other chain.
 * @returns {Promise<{ state: "signed", kind: string, signedAt: string } | { state: "legacy" } | { state: "refused", problem: string }>}
 */
export async function agentBinding(rail, pub, opts = {}) {
  const { label = "", keyAgent = null, file = "the public file", retiredOk = false, testnet = false } = opts;
  const refused = (problem) => ({ state: "refused", problem });
  const retired = retiredOk ? "" : retiredProblem(rail, pub.agent);
  if (retired) return refused(retired);
  if (keyAgent && !sameAddress(rail, keyAgent, pub.agent)) return refused(`the agent key on this machine is ${keyAgent}, but ${file} names ${pub.agent}`);
  const [mk, sk, tk] = setupKeys(label);
  const lines = pub.lines ?? {};
  const present = [mk, sk, tk].filter((k) => lines[k] !== undefined && lines[k] !== "");
  if (present.length === 0) {
    return testnet === true ? { state: "legacy" } : refused(`${file} has no owner signature naming agent ${pub.agent}, and only testnets accept such files`);
  }
  if (present.length !== 3 || !ISO.test(lines[tk]) || Number.isNaN(Date.parse(lines[tk]))) return refused(`the owner's setup signature in ${file} is incomplete`);
  const b64 = lines[mk];
  let message = "";
  let known = null;
  if (/^[A-Za-z0-9_-]+$/.test(b64)) {
    const bytes = Buffer.from(b64, "base64url");
    if (bytes.length <= MAX_MESSAGE_BYTES && bytes.toString("base64url") === b64) {
      message = bytes.toString("utf8");
      if (Buffer.from(message, "utf8").equals(bytes)) known = signedNames(rail, message);
    }
  }
  if (!known) return refused(`the owner's setup signature in ${file} is not a setup text this client knows`);
  if (!sameAddress(rail, known.agent, pub.agent)) return refused(`the owner signed for agent ${known.agent}, not ${pub.agent}`);
  if (known.kind === "local") {
    // the local text names a chain label, not a rail; one secp256k1 wallet can own on evm and tempo, so the label keeps them apart
    const crossed = rail === "tempo" ? !known.chain.startsWith("Tempo ") : rail === "solana" ? !known.chain.startsWith("Solana ") : /^(?:Tempo|Solana) /.test(known.chain);
    if (crossed) return refused(`the owner's signature is for another rail, not ${rail}`);
  } else {
    if (!sameAddress(rail, known.owner, pub.owner)) return refused(`the owner's signature names the owner ${known.owner}, not ${pub.owner}`);
    if (known.rail !== rail) return refused(`the owner's signature is for the ${known.rail} rail, not ${rail}`);
  }
  const signature = lines[sk];
  const ok = rail === "solana"
    ? ed25519Verifies(pub.owner, message, signature)
    : sameAddress(rail, (await eip191Signer(message, signature)) ?? "", pub.owner);
  if (!ok) return refused(`the setup signature was not made by the owner ${pub.owner}`);
  return { state: "signed", kind: known.kind, signedAt: lines[tk] };
}

/** "" when the binding is signed or legacy; the problem when it is refused. */
export async function bindingProblem(rail, pub, opts) {
  const b = await agentBinding(rail, pub, opts);
  return b.state === "refused" ? b.problem : "";
}

/**
 * " --hosted --site <origin>" when the public file's approvals are hosted on a site, else "". On such a chain a plain setup re-run
 * reuses the file and records nothing; setup --hosted --site takes the site's owner proof, which is what records the signature.
 */
export function hostedFlags(lines = {}) {
  if (lines.APPROVALS !== "hosted" || !lines.SITE) return "";
  const site = siteOrigin(lines.SITE);
  return site.origin ? ` --hosted --site ${site.origin}` : "";
}

/** The one stderr line for a public file from before the owner's signature was kept. */
export function legacyWarning(rail, file, agent, chainFlag = "") {
  return `warning: ${file} has no owner signature naming agent ${agent} (it was set up before this check existed). Testnet goes on; run superstables budget setup --rail ${rail}${chainFlag} again, where the agent key is, to record one.`;
}

/** The sign-in text for --owner-key-file setups: the format of signInMessage (src/core/signer/owner-approval-server.ts). */
export function localSetupMessage(agent, chainLabel, id = randomBytes(16).toString("hex")) {
  return `Superstables budget: record this wallet as the owner of agent ${agent} on ${chainLabel}.\n\nApproval id: ${id}${LOCAL_TAIL}`;
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
/**
 * --owner-key-file: builds the local setup text with a fresh approval id and signs it with the owner's key. `ownerKey` is the 0x hex
 * private key (evm, tempo) or the 64-byte Solana secret key (seed, then public key). → { message, signature }
 */
export async function signLocalBinding(rail, ownerKey, agent, chainLabel) {
  const message = localSetupMessage(agent, chainLabel);
  if (rail === "solana") {
    const seed = Buffer.from(ownerKey).subarray(0, 32);
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
    return { message, signature: `0x${signBytes(null, Buffer.from(message, "utf8"), key).toString("hex")}` };
  }
  return { message, signature: await privateKeyToAccount(ownerKey).signMessage({ message }) };
}
