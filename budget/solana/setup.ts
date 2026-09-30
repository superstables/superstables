// setup for the solana rail: make this machine an agent and record who its owner is. No owner key is ever created or stored.
//   1. The agent key file ($SUPERSTABLES_HOME/keys/budget/solana-agent.env, mode 600): SOLANA_AGENT_SECRET_BASE58, its address
//      and, once known, the owner's public SOLANA_OWNER_ADDRESS. Created if missing, never overwritten.
//   2. The owner connects their own wallet (Phantom or any Wallet Standard wallet) on the owner page and signs a free sign-in
//      message (solana:signMessage, checked as an ed25519 signature): it proves the address is theirs and sends nothing. With
//      --owner-key-file <path> the address comes from that key instead (tests and automation only).
//   3. The public file: owner and agent addresses, no secret.
// Then it prints the next steps: fund the owner (devnet SOL and USDC), fund-agent, doctor, grant. Never prints a key.
// npx tsx budget/solana/setup.ts [--timeout <s>] [--no-open] [--owner-key-file <path>]
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { AGENT_KEY_PATH, PUBLIC_PATH, USDC_MINT, connection, formatUnits, loadOwner, parseEnvFile, parseStrict, readPublic, retryRead, writePublic } from "./lib.mjs";
import { getAssociatedTokenAddressSync, getAccount } from "./token.mjs";
import { OWNER_KEY_FILE, checkOwnerKeyFile } from "../owner-page.ts";
import { askConnect, closeOwnerPage, emit, endUnapproved, sol } from "./owner.ts";

const USAGE = `Usage: npx tsx budget/solana/setup.ts [--timeout <s>] [--no-open] [--owner-key-file <path>]

Create the agent key file (mode 600, never overwritten), let the owner connect their own wallet on the owner page, and write
the public address file. No owner key is created. Prints addresses only, never a key.

  --timeout <s>            how long the approval link stays open (default 600)
  --no-open                do not open the link in the default browser
  --owner-key-file <path>  tests and automation only: record this key file's address instead of asking the wallet
  -h, --help               show this help`;
parseStrict(process.argv.slice(2), { timeout: "value", "no-open": "bool", "owner-key-file": "value" }, { usage: USAGE });
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
let owner: string;
let finish: ((v: { ok: boolean; message: string }) => void) | null = null;
if (OWNER_KEY_FILE) {
  checkOwnerKeyFile(OWNER_KEY_FILE);
  owner = loadOwner(OWNER_KEY_FILE).keypair.publicKey.toBase58();
  console.log(`owner address from --owner-key-file: ${owner}`);
} else if (pub.owner && pub.agent?.toBase58() === agent) {
  owner = pub.owner.toBase58();
  console.log(`${PUBLIC_PATH} already records owner ${owner} for this agent; not asking again (move the file away to connect another wallet)`);
} else {
  const { handle, outcome } = await askConnect("setup", {
    title: "connect your wallet",
    summary: "Connect the wallet that will own this agent's budget. The command records its address on this computer. Nothing is sent and no budget is granted yet.",
    rows: [
      { label: "Your agent", value: agent, mono: true },
      { label: "Agent key", value: `on this computer only, in ${AGENT_KEY_PATH}` },
    ],
    enforced: [],
    notEnforced: [],
    notes: [
      "Your wallet asks you to sign a short message. It proves the address is yours. It sends nothing and costs nothing.",
      "Your wallet keeps its key. The agent never gets it: every budget you grant later, you approve here in your wallet.",
    ],
  }, `Superstables budget: record this wallet as the owner of agent ${agent} on Solana devnet (testnet).`);
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved("setup", outcome, { agent });
  if (outcome.status !== "connected") throw new Error(`unexpected owner page outcome ${outcome.status}`);
  owner = outcome.address;
  finish = handle.finish;
  console.log(`the owner connected ${owner} and signed the sign-in message`);
}
const bound = existing.SOLANA_OWNER_ADDRESS;
if (owner === agent || (bound && bound !== owner)) {
  const reason = owner === agent ? "the owner address is the agent's address" : `the agent key file is bound to another owner (${bound})`;
  finish?.({ ok: false, message: owner === agent ? "That is the agent's own address. Connect your own wallet instead." : `This agent is already bound to another owner (${bound}). Nothing was changed.` });
  await closeOwnerPage();
  process.exit(result(3, { state: "refused_precheck", reason, next: owner === agent ? "connect the owner's own wallet" : `move ${AGENT_KEY_PATH} away if you mean to start over` }));
}

// 3. the owner's public address, in the agent file (buy reads it) and the public file
if (!bound) {
  const text = readFileSync(AGENT_KEY_PATH, "utf8");
  writeFileSync(AGENT_KEY_PATH, `${text.endsWith("\n") ? text : `${text}\n`}SOLANA_OWNER_ADDRESS=${owner}\n`, { mode: 0o600 });
  chmodSync(AGENT_KEY_PATH, 0o600);
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
finish?.({ ok: true, message: `Done. ${owner} is recorded as the owner of agent ${agent}. You can close this page. Next: fund your wallet with devnet SOL and USDC, give the agent SOL for fees, then grant a budget (the terminal lists the commands).` });
await closeOwnerPage();
process.exit(result(0, { state: "ok", owner, agent, publicFile: PUBLIC_PATH, agentKeyFile: AGENT_KEY_PATH, steps, next: "fund the owner, then superstables budget fund-agent --rail solana, then superstables budget doctor --rail solana" }));
