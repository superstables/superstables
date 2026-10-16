import "./cli-guard.mjs";
import { SETUP_KEYS } from "../owner-binding.mjs";
// rotate (B4, any chain): the two small steps of `superstables budget rotate` that no other script does. It sends nothing.
//   --clear-agent <address>  remove the retired agent from this chain's public file. The owner, the approvals mode and the site
//                            stay, so setup connects the new key to the same owner. Refuses (exit 3) when the file names no agent
//                            or another one than <address>.
//   --address                print the address of the agent key file (the key itself is never printed)
// The orchestration (retire, recover, swap, clear, set up) is budget/rotate.mjs, run by budget/cli.mjs.
// npx tsx budget/evm/rotate.ts [--chain <name>] (--clear-agent <address> | --address)
import { isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AGENT_ENV, CFG, PUBLIC_ENV, agentFileValues, arg, emit, flag, publicEnv, usageError, writePublic } from "./lib.ts";

/** What a rotated chain forgets about the old agent: its address, its budget terms and the link that named it. */
export const CLEARED_KEYS = ["B4_AGENT_ADDRESS", "B4_CAP", "B4_SET_AT", "B4_EXPIRY", "B4_REVOKED_AT", "LINK_ID", "LINK_CODE", ...SETUP_KEYS];

const clear = arg("clear-agent");
const address = flag("address");
if ((clear === undefined) === !address) usageError("give exactly one of --clear-agent <address> and --address");

if (address) {
  const file = agentFileValues();
  if (file.problem !== undefined) process.exit(emit("rotate", 3, { state: "refused_precheck", reason: file.problem, next: `make ${AGENT_ENV} a regular file only you can read (chmod 600)` }));
  // the address line setup writes, else derived from the key; the key is never printed
  const key = file.env.B4_AGENT_KEY;
  const agent = key ? privateKeyToAccount(key as Hex).address : file.env.B4_AGENT_ADDRESS;
  if (!agent) process.exit(emit("rotate", 3, { state: "refused_precheck", reason: `no agent key in ${AGENT_ENV}`, next: "run superstables budget setup --rail evm" }));
  process.exit(emit("rotate", 0, { state: "ok", agent }));
}

if (!isAddress(clear!)) usageError(`--clear-agent "${clear}" is not an address`);
const named = publicEnv().B4_AGENT_ADDRESS;
if (!named || named.toLowerCase() !== clear!.toLowerCase()) {
  console.log(`REFUSED: ${PUBLIC_ENV} ${named ? `names another agent (${named})` : "names no agent"}, not ${clear}. Nothing was changed.`);
  process.exit(emit("rotate", 3, { state: "refused_precheck", reason: named ? `the public file names another agent (${named})` : "the public file names no agent", next: "nothing was changed on this chain" }));
}
writePublic({}, CLEARED_KEYS);
console.log(`${CFG.label}: removed agent ${clear} from ${PUBLIC_ENV}; the owner and the approvals mode stay.`);
process.exit(emit("rotate", 0, { state: "cleared", agent: clear }));
