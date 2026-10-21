// siteCall (recovery): one request to the site's recovery API, signed with the Solana agent key (ed25519), for the dispatcher.
// It opens the agent key file only, signs only the site request (never a payment), and prints what the site answered as one
// RESULT line. Nothing here pays or sends.
// npx tsx budget/solana/siteCall.ts --site <origin> --path /api/v1/recovery/advice|report --body <json>
import { loadAgent, parseStrict, usageError } from "./lib.mjs";
import { signedSitePost, siteCallArgs } from "../site-request.ts";

const USAGE = "Usage: solana/siteCall.ts --site <origin> --path <recovery route> --body <json>";
const flags = parseStrict(process.argv.slice(2), { site: "value", path: "value", body: "value" }, { usage: USAGE, required: ["site", "path", "body"] });
const call = siteCallArgs((n) => flags[n]);
if (!call) usageError("--body must be JSON", USAGE);
const { keypair } = loadAgent();
const key = { ed25519: keypair.secretKey, address: keypair.publicKey.toBase58() };
const reply = await signedSitePost(key, call!.site, call!.path, call!.body);
console.log(`RESULT ${JSON.stringify({ ok: true, command: "siteCall", rail: "solana", chain: "devnet", state: "ok", reply })}`);
process.exit(0);
