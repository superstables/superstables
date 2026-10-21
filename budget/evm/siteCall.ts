import "./cli-guard.mjs";
// siteCall (recovery): one request to the site's recovery API, signed with the agent key, for the dispatcher. It opens the agent
// key file only, signs only the site request (never a payment), and prints what the site answered as one RESULT line. The
// dispatcher decides what the answer means; nothing here pays, pulls or sends.
// npx tsx budget/evm/siteCall.ts --site <origin> --path /api/v1/recovery/advice|report --body <json> [--chain <name>]
import { agentCtx, arg, emit } from "./lib.ts";
import { signedSitePost, siteCallArgs } from "../site-request.ts";

const call = siteCallArgs(arg);
if (!call) {
  console.log(`RESULT ${JSON.stringify({ ok: false, command: "siteCall", rail: "evm", state: "refused_precheck", reason: "needs --site, --path and a JSON --body", next: "nothing was signed or sent" })}`);
  process.exit(3);
}
const c = await agentCtx();
const reply = await signedSitePost(c.agentKey, call!.site, call!.path, call!.body);
process.exit(emit("siteCall", 0, { state: "ok", reply }));
