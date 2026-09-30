import "./cli-guard.mjs";
// setup (B4, any chain): write this chain's PUBLIC state file (owner and agent addresses, no secret) from the B4 key files that
// already exist (evm-owner.env, evm-agent.env). The same EVM keys work on every EVM chain, so no key is generated or copied:
// each key must derive the address recorded next to it, and the owner and agent files must agree. Never prints a key.
// Refuses (exit 3) if the public file already names different addresses.
// npx tsx budget/evm/setup.ts --chain <name> --from-keys
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { SYM, CFG, emit, OWNER_ENV, AGENT_ENV, PUBLIC_ENV, ownerEnv, agentEnv, publicEnv, writePublic, need, usdcBalance, nativeBalance, usdc, gasFmt, GAS } from "./lib.ts";

const o = ownerEnv(), a = agentEnv();
const ownerAddr = privateKeyToAccount(need(o, "B4_OWNER_KEY", OWNER_ENV) as Hex).address;
const agentAddr = privateKeyToAccount(need(a, "B4_AGENT_KEY", AGENT_ENV) as Hex).address;
const same = (x?: string, y?: string) => !!x && !!y && x.toLowerCase() === y.toLowerCase();
if (!same(o.B4_OWNER_ADDRESS, ownerAddr) || !same(a.B4_OWNER_ADDRESS, ownerAddr)) { console.error("error: the owner key does not derive the owner address recorded in the key files"); process.exit(1); }
if (!same(o.B4_AGENT_ADDRESS, agentAddr) || !same(a.B4_AGENT_ADDRESS, agentAddr)) { console.error("error: the agent key does not derive the agent address recorded in the key files"); process.exit(1); }
const p = publicEnv();
if ((p.B4_OWNER_ADDRESS && !same(p.B4_OWNER_ADDRESS, ownerAddr)) || (p.B4_AGENT_ADDRESS && !same(p.B4_AGENT_ADDRESS, agentAddr))) {
  console.error(`REFUSED: ${PUBLIC_ENV} already names different addresses. Nothing was changed.`);
  process.exit(emit("setup", 3, { state: "refused_precheck", reason: "the public file already names different addresses", next: "none" }));
}
writePublic({ B4_OWNER_ADDRESS: ownerAddr, B4_AGENT_ADDRESS: agentAddr });
console.log(`${CFG.label}: wrote ${PUBLIC_ENV} (no secret).`);
console.log(`owner ${ownerAddr}: ${SYM} ${usdc(await usdcBalance(ownerAddr))}, native ${GAS.symbol} ${gasFmt(await nativeBalance(ownerAddr))}`);
console.log(`agent ${agentAddr}: ${SYM} ${usdc(await usdcBalance(agentAddr))}, native ${GAS.symbol} ${gasFmt(await nativeBalance(agentAddr))}`);
process.exit(emit("setup", 0, { state: "ok", owner: ownerAddr, agent: agentAddr, publicFile: PUBLIC_ENV, next: "none" }));
