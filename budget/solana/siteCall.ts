// siteCall (recovery): one request to the site's recovery API, signed with the Solana agent key (ed25519), for the dispatcher.
// It opens the agent key file only, signs only the site request (never a payment), and prints what the site answered as one
// RESULT line. Nothing here pays or sends.
// npx tsx budget/solana/siteCall.ts --site <origin> --path /api/v1/recovery/advice|report --body <json>
import { CHAIN, loadAgent, mainnetClosed, parseStrict, usageError } from "./lib.mjs";
import { signedSitePost, siteCallArgs } from "../site-request.ts";

const USAGE = "Usage: solana/siteCall.ts --site <origin> --path <recovery route> --body <json> [--method GET|POST] [--timeout-ms <n>]";
const flags = parseStrict(process.argv.slice(2), { site: "value", path: "value", body: "value", method: "value", "timeout-ms": "value" }, { usage: USAGE, required: ["site", "path"] });
const call = siteCallArgs((n) => flags[n]);
if (!call) usageError("a POST needs --body as JSON, --method is GET or POST, and --timeout-ms is 1 to 15000", USAGE);
// the mainnet boundary, read again right before the agent key signs
const closed = mainnetClosed();
if (closed) {
  console.error(`REFUSED: ${closed}. Nothing was signed or sent.`);
  console.log(`RESULT ${JSON.stringify({ ok: false, command: "siteCall", rail: "solana", chain: CHAIN.key, state: "refused_precheck", reason: closed, next: "nothing was signed or sent; ask the owner whether mainnet is open again" })}`);
  process.exit(3);
}
const { keypair } = loadAgent();
const key = { ed25519: keypair.secretKey, address: keypair.publicKey.toBase58() };
const reply = await signedSitePost(key, call!.site, call!.path, call!.body, call!.method, { timeoutMs: call!.timeoutMs });
console.log(`RESULT ${JSON.stringify({ ok: true, command: "siteCall", rail: "solana", chain: CHAIN.key, state: "ok", reply })}`);
process.exit(0);
