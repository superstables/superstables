// The evm agent key file can hold a B4_OWNER_ADDRESS line from an older client. No current client writes it; the owner on record
// is the public file's, with the owner's signature naming the agent. Buy refuses, and doctor reports, when the two differ, and
// setup removes the line once the owner has signed for the owner it records. Plain ESM so lib.ts, setup.ts and doctor.mjs share it.
import { hostedFlags } from "./owner-binding.mjs";

/**
 * Null when the agent file has no owner line, or it names the public file's owner. Otherwise both owners and the setup command
 * that repairs the record (the one a refused plan names): `chain` is the chain key, `publicLines` the public file's values.
 */
export function staleOwnerLine(agentValues, publicLines, chain) {
  const fileOwner = agentValues.B4_OWNER_ADDRESS, publicOwner = publicLines.B4_OWNER_ADDRESS;
  if (!fileOwner || !publicOwner || fileOwner.toLowerCase() === publicOwner.toLowerCase()) return null;
  return { fileOwner, publicOwner, repair: `superstables budget setup --rail evm${chain === "base-sepolia" ? "" : ` --chain ${chain}`}${hostedFlags(publicLines)}` };
}
