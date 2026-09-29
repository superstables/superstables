// Setup step 1: create the devnet key files. Idempotent: a key that already exists is left alone.
// Never prints a secret key, only addresses.
//
// Writes (mode 600 for the two key files; paths from ../paths.mjs):
//   solana-owner.env   owner secret + public addresses. Owner commands only.
//   solana-agent.env   agent secret + public addresses. buy only.
//   public file        public addresses only, for read commands.
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { OWNER_KEY_PATH, AGENT_KEY_PATH, PUBLIC_PATH, parseEnvFile, writePublic, parseStrict } from "./lib.mjs";

const USAGE = `Usage: node budget/solana/generate-keys.mjs

Create solana-owner.env and solana-agent.env (mode 600) and the public address file. Idempotent.
Prints addresses only, never a key.

  -h, --help      show this help`;
parseStrict(process.argv.slice(2), {}, { usage: USAGE });

mkdirSync(dirname(OWNER_KEY_PATH), { recursive: true, mode: 0o700 });
const read = (p) => (existsSync(p) ? parseEnvFile(p) : {});
const ownerFile = read(OWNER_KEY_PATH);
const agentFile = read(AGENT_KEY_PATH);

function keyPair(existingSecret, label) {
  if (existingSecret) {
    const kp = Keypair.fromSecretKey(bs58.decode(existingSecret));
    console.log(`${label}: already present, address ${kp.publicKey.toBase58()}`);
    return { secret: existingSecret, address: kp.publicKey.toBase58() };
  }
  const kp = Keypair.generate();
  console.log(`${label}: generated, address ${kp.publicKey.toBase58()}`);
  return { secret: bs58.encode(kp.secretKey), address: kp.publicKey.toBase58() };
}

const owner = keyPair(ownerFile.SOLANA_OWNER_SECRET_BASE58, "OWNER");
const agent = keyPair(agentFile.SOLANA_AGENT_SECRET_BASE58, "AGENT");

const publicPairs = { SOLANA_OWNER_ADDRESS: owner.address, SOLANA_AGENT_ADDRESS: agent.address };
const lines = (head, secretName, secret) =>
  [head, `${secretName}=${secret}`, ...Object.entries(publicPairs).map(([k, v]) => `${k}=${v}`)].join("\n") + "\n";
function writeSecretFile(path, body) {
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}
if (!ownerFile.SOLANA_OWNER_SECRET_BASE58) {
  writeSecretFile(OWNER_KEY_PATH, lines("# Solana devnet OWNER key. Only owner commands (setBudget, revokeBudget, fund) open this file.", "SOLANA_OWNER_SECRET_BASE58", owner.secret));
}
if (!agentFile.SOLANA_AGENT_SECRET_BASE58) {
  writeSecretFile(AGENT_KEY_PATH, lines("# Solana devnet AGENT key. Only buy opens this file. No owner secret here.", "SOLANA_AGENT_SECRET_BASE58", agent.secret));
}
writePublic(publicPairs);

console.log(`\nOwner key file: ${OWNER_KEY_PATH} (mode 600)`);
console.log(`Agent key file: ${AGENT_KEY_PATH} (mode 600)`);
console.log(`Public addresses: ${PUBLIC_PATH}`);
console.log("No secret keys were printed above, only addresses.");
