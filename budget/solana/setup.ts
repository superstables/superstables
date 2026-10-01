// setup for the solana rail: make this machine an agent and record who its owner is. No owner key is ever created or stored.
//   1. The agent key file ($SUPERSTABLES_HOME/keys/budget/solana-agent.env, mode 600): SOLANA_AGENT_SECRET_BASE58, its address
//      and, once known, the owner's public SOLANA_OWNER_ADDRESS. Created if missing, never overwritten.
//   2. The owner connects their own wallet (Phantom or any Wallet Standard wallet) on the owner page and signs a free sign-in
//      message (solana:signMessage, checked as an ed25519 signature): it proves the address is theirs and sends nothing. With
//      --owner-key-file <path> the address comes from that key instead (tests and automation only).
//   3. The public file: owner and agent addresses, no secret.
// Then it prints the next steps: fund the owner (devnet SOL and USDC), fund-agent, doctor, grant. Never prints a key.
//
// Setup is a trusted step: the signature proves control of the connected address, not that it is the intended owner, so
// the owner runs it or watches it run, and an agent must not complete it. A recorded owner never changes silently:
// --new-owner replaces it, refused while the agent is the delegate of the recorded owner's USDC account.
// npx tsx budget/solana/setup.ts [--new-owner] [--timeout <s>] [--no-open] [--owner-key-file <path>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { AGENT_KEY_PATH, PUBLIC_PATH, USDC_MINT, connection, formatUnits, loadOwner, parseEnvFile, parseStrict, readPublic, replaceKeyFile, retryRead, writePublic } from "./lib.mjs";
import { getAssociatedTokenAddressSync, getAccount, getAccountOrNull } from "./token.mjs";
import { OWNER_KEY_FILE, checkOwnerKeyFile } from "../owner-page.ts";
import { askConnect, closeOwnerPage, emit, endUnapproved, sol } from "./owner.ts";

const USAGE = `Usage: npx tsx budget/solana/setup.ts [--new-owner] [--timeout <s>] [--no-open] [--owner-key-file <path>]

Create the agent key file (mode 600, never overwritten), let the owner connect their own wallet on the owner page, and write
the public address file. No owner key is created. Prints addresses only, never a key.

  --new-owner              replace the recorded owner (refused while a budget is live on it)
  --timeout <s>            how long the approval link stays open (default 600)
  --no-open                do not open the link in the default browser
  --owner-key-file <path>  tests and automation only: record this key file's address instead of asking the wallet
  -h, --help               show this help`;
const cli = parseStrict(process.argv.slice(2), { "new-owner": "bool", timeout: "value", "no-open": "bool", "owner-key-file": "value" }, { usage: USAGE });
const newOwner = cli["new-owner"] === true;
const result = (exit: number, o: Record<string, unknown>) => emit("setup", exit, o);

// 1. the agent key
const existing = existsSync(AGENT_KEY_PATH) ? parseEnvFile(AGENT_KEY_PATH) : {};
let agent: string;
if (existing.SOLANA_AGENT_SECRET_BASE58) {
  agent = Keypair.fromSecretKey(bs58.decode(existing.SOLANA_AGENT_SECRET_BASE58)).publicKey.toBase58();
  console.log(`agent key file ${AGENT_KEY_PATH} exists; reusing it (agent ${agent})`);
} else {
  if (existsSync(AGENT_KEY_PATH)) process.exit(result(3, { state: "refused_precheck", reason: `${AGENT_KEY_PATH} has no SOLANA_AGENT_SECRET_BASE58`, next: `move ${AGENT_KEY_PATH} away if you mean to start over` }));
  const kp = Keypair.generate();
  agent = kp.publicKey.toBase58();
  mkdirSync(dirname(AGENT_KEY_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(AGENT_KEY_PATH, `# Solana devnet AGENT key. Only buy opens this file. No owner secret here.\nSOLANA_AGENT_SECRET_BASE58=${bs58.encode(kp.secretKey)}\nSOLANA_AGENT_ADDRESS=${agent}\n`, { mode: 0o600, flag: "wx" });
  console.log(`created the agent key file ${AGENT_KEY_PATH} (mode 600): agent ${agent}`);
}
const pub = readPublic();
if (pub.agent && pub.agent.toBase58() !== agent) {
  console.error(`REFUSED: ${PUBLIC_PATH} already names another agent (${pub.agent.toBase58()}). Nothing was changed.`);
  process.exit(result(3, { state: "refused_precheck", reason: "the public file already names another agent", next: `move ${PUBLIC_PATH} away if you mean to start over` }));
}

// 2. the owner address
const bound = existing.SOLANA_OWNER_ADDRESS;
const recorded: string | undefined = bound ?? (pub.owner && pub.agent?.toBase58() === agent ? pub.owner.toBase58() : undefined);
if (newOwner && recorded) {
  // never move the owner while the agent is still the delegate of the recorded owner's USDC account
  const { PublicKey: Pk } = await import("@solana/web3.js");
  const acc = await retryRead(() => getAccountOrNull(connection(), getAssociatedTokenAddressSync(USDC_MINT, new Pk(recorded)))).then((a) => ({ ok: true as const, a }), (e) => ({ ok: false as const, e }));
  const live = !acc.ok ? null : Boolean(acc.a?.delegate && acc.a.delegate.toBase58() === agent && acc.a.delegatedAmount > 0n);
  if (live !== false) {
    const reason = live === null ? `could not read the USDC account of the recorded owner ${recorded}; the owner is not replaced` : `a budget is live: the agent is the delegate of ${recorded}'s USDC account with ${formatUnits(acc.ok ? acc.a!.delegatedAmount : 0n)} USDC left`;
    console.log(`REFUSED: ${reason}. Nothing was changed.`);
    process.exit(result(3, { state: "refused_precheck", reason, owner: recorded, next: live === null ? "superstables budget doctor --rail solana, then setup --new-owner again" : `revoke first (superstables budget revoke --rail solana, approved by ${recorded}), then setup --new-owner` }));
  }
  console.log(`replacing the recorded owner ${recorded} (no budget is live): the new owner connects on the page`);
}
let owner: string;
let finish: ((v: { ok: boolean; message: string }) => void) | null = null;
if (OWNER_KEY_FILE) {
  checkOwnerKeyFile(OWNER_KEY_FILE);
  owner = loadOwner(OWNER_KEY_FILE).keypair.publicKey.toBase58();
  console.log(`owner address from --owner-key-file: ${owner}`);
} else if (pub.owner && pub.agent?.toBase58() === agent && !newOwner) {
  owner = pub.owner.toBase58();
  console.log(`${PUBLIC_PATH} already records owner ${owner} for this agent; not asking again. If this isn't your wallet, stop: superstables budget setup --rail solana --new-owner replaces it`);
} else {
  const { handle, outcome } = await askConnect("setup", {
    title: "Connect your wallet",
    summary: "Connect your wallet and sign a message to record its address as the budget owner on this computer. This does not grant a budget or send a transaction.",
    rows: [
      { label: "Your agent", value: agent, mono: true },
      { label: "Agent key", value: `on this computer only, in ${AGENT_KEY_PATH}` },
    ],
    enforced: [],
    notEnforced: [],
    notes: [
      "Signing the message proves control of this address. It grants no spending permission and has no network fee.",
      "Your signing key stays in your wallet. You will review and approve any later budget grant separately.",
    ],
  }, `Superstables budget: record this wallet as the owner of agent ${agent} on Solana devnet (testnet).`, newOwner ? recorded : undefined);
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved("setup", outcome, { agent });
  if (outcome.status !== "connected") throw new Error(`unexpected owner page outcome ${outcome.status}`);
  owner = outcome.address;
  finish = handle.finish;
  console.log(`the owner connected ${owner} and signed the sign-in message`);
}
if (owner === agent || (bound && bound !== owner && !newOwner)) {
  const reason = owner === agent ? "the owner address is the agent's address" : `the agent key file is bound to another owner (${bound})`;
  finish?.({ ok: false, message: owner === agent ? "That is the agent's own address. Connect your own wallet instead." : `This agent is already bound to another owner (${bound}). Nothing was changed.` });
  await closeOwnerPage();
  process.exit(result(3, { state: "refused_precheck", reason, ...(owner === agent ? {} : { owner: bound }), next: owner === agent ? "connect the owner's own wallet" : "superstables budget setup --rail solana --new-owner replaces it (refused while a budget is live)" }));
}
const replaced = recorded && recorded !== owner ? recorded : undefined;
if (replaced) console.log(`the recorded owner changed: ${replaced} -> ${owner}`);

// 3. the owner's public address, in the agent file (buy reads it) and the public file
if (bound !== owner) {
  const lines = readFileSync(AGENT_KEY_PATH, "utf8").split("\n").filter((l) => l !== "" && !l.startsWith("SOLANA_OWNER_ADDRESS="));
  replaceKeyFile(AGENT_KEY_PATH, `${[...lines, `SOLANA_OWNER_ADDRESS=${owner}`].join("\n")}\n`); // the only copy of the agent key: never truncated in place
}
writePublic({ SOLANA_OWNER_ADDRESS: owner, SOLANA_AGENT_ADDRESS: agent });
console.log(`wrote ${PUBLIC_PATH} (no secret) and the owner's address into ${AGENT_KEY_PATH}`);

const conn = connection();
const { PublicKey } = await import("@solana/web3.js");
const ownerPk = new PublicKey(owner);
const [ownerSol, agentSol] = await Promise.all([retryRead(() => conn.getBalance(ownerPk, "confirmed")), retryRead(() => conn.getBalance(new PublicKey(agent), "confirmed"))]).catch(() => [null, null]);
const usdc = await retryRead(() => getAccount(conn, getAssociatedTokenAddressSync(USDC_MINT, ownerPk))).then((a) => a.amount, () => 0n);
console.log(`owner ${owner}: SOL ${ownerSol === null ? "unknown" : sol(ownerSol)}, USDC ${formatUnits(usdc)}`);
console.log(`agent ${agent}: SOL ${agentSol === null ? "unknown" : sol(agentSol)}`);

const steps = [
  `Fund your wallet ${owner} with devnet SOL (faucet.solana.com; at least 0.01) and devnet USDC (faucet.circle.com, Solana devnet; at least 0.05).`,
  "Give the agent SOL for fees: superstables budget fund-agent --rail solana sends 0.01 SOL from your wallet (you approve it there).",
  "Check everything: superstables budget doctor --rail solana",
  "Grant a budget: superstables budget grant --rail solana --amount 0.05 (you approve it in your wallet).",
];
console.log("\nNext:");
steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
finish?.({ ok: true, message: `Done. The owner on record is now ${owner}. Check that this is your own wallet's address: if it is not, someone else connected, so grant nothing. Agent: ${agent}. You can close this page. Next: fund your wallet with devnet SOL and USDC, give the agent SOL for fees, then grant a budget (the terminal lists the commands).` });
await closeOwnerPage();
process.exit(result(0, { state: "ok", owner, ...(replaced ? { replacedOwner: replaced } : {}), agent, publicFile: PUBLIC_PATH, agentKeyFile: AGENT_KEY_PATH, steps, next: "superstables budget fund-agent --rail solana (SOL for the agent's fees), then superstables budget doctor --rail solana (it says what the owner still needs), then superstables budget grant --rail solana --amount A" }));
