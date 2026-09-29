// Setup step 2: give the agent key a little SOL for transaction fees. The owner pays.
//
// Owner command: opens only solana-owner.env.
//
// Usage:
//   node budget/solana/fund.mjs --agent-sol 0.05
import { SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { connection, loadOwner, getSolBalance, explorerTx, parseStrict, usageError } from "./lib.mjs";

const USAGE = `Usage: node budget/solana/fund.mjs --agent-sol <sol>

Owner command. Tops the agent up to <sol> SOL for transaction fees (the owner pays). Devnet only.
Opens only the owner key file.

  --agent-sol <sol>   SOL balance to top the agent up to (e.g. 0.05, at most 1)
  -h, --help          show this help`;
const flags = parseStrict(process.argv.slice(2), { "agent-sol": "value" }, { usage: USAGE, required: ["agent-sol"] });
const agentSolTarget = Number(flags["agent-sol"]);
if (!Number.isFinite(agentSolTarget) || agentSolTarget < 0 || agentSolTarget > 1) usageError("--agent-sol must be a number from 0 to 1", USAGE);

const conn = connection();
const ownerInfo = loadOwner();
const owner = ownerInfo.keypair;
const agentPk = ownerInfo.agent;

if (!agentPk) {
  console.error("Missing the agent address. Run `node budget/solana/generate-keys.mjs` first.");
  process.exit(1);
}

const ownerSol = await getSolBalance(conn, owner.publicKey);
console.log(`Owner ${owner.publicKey.toBase58()} SOL balance: ${ownerSol}`);

if (ownerSol <= 0) {
  console.log(
    "\nOwner has 0 SOL. Nothing can be funded yet. Send devnet SOL to the owner address:\n" +
      `  ${owner.publicKey.toBase58()}\n` +
      "Re-run this script once the owner shows a positive balance."
  );
  process.exit(0);
}

const agentSolBefore = await getSolBalance(conn, agentPk);
console.log(`Agent ${agentPk.toBase58()} SOL balance before: ${agentSolBefore}`);

if (agentSolBefore >= agentSolTarget) {
  console.log("\nNothing to do, the agent already has that much SOL.");
  process.exit(0);
}

const lamports = Math.round((agentSolTarget - agentSolBefore) * 1e9);
console.log(`Sending ${lamports / 1e9} SOL owner -> agent`);
const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agentPk, lamports }));
const sig = await sendAndConfirmTransaction(conn, tx, [owner], { commitment: "confirmed" });
console.log(`\nFund tx signature: ${sig}`);
console.log(`Explorer: ${explorerTx(sig)}`);
console.log(`\nOwner SOL after: ${await getSolBalance(conn, owner.publicKey)}`);
console.log(`Agent SOL after: ${await getSolBalance(conn, agentPk)}`);
