import "./cli-guard.mjs";
// setup (B4, any chain): make this machine an agent and record who its owner is. No owner key is ever created or stored.
//   1. The agent key file ($SUPERSTABLES_HOME/keys/budget/evm-agent.env, mode 600). Created if it is missing, never overwritten:
//      the same agent key works on every EVM chain, so a second chain reuses it.
//   2. The owner connects their own wallet on the owner page and signs a free sign-in message (it proves the address is theirs;
//      nothing is sent). With --owner-key-file <path> the owner address comes from that key instead (tests and automation).
//   3. This chain's public file: owner and agent addresses, no secret. Refuses (exit 3) if it already names another agent.
// Then it prints what to do next: fund the owner, give the agent gas, doctor, grant. Never prints a key.
// npx tsx budget/evm/setup.ts [--chain <name>] [--timeout <s>] [--no-open] [--owner-key-file <path>]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { EVM_CHAINS } from "./chains.mjs";
import { SYM, CFG, GAS, emit, AGENT_ENV, PUBLIC_ENV, OWNER_KEY_FILE, agentEnv, publicEnv, writePublic, need, newKey, ownerKeyEnv, usdcBalance, nativeBalance, usdc, gasFmt } from "./lib.ts";
import { askConnect, endUnapproved, closeOwnerPage, chainFlag } from "./owner.ts";

const d = (EVM_CHAINS as Record<string, any>)[CFG.key].doctor;
const same = (x?: string, y?: string) => !!x && !!y && x.toLowerCase() === y.toLowerCase();

// 1. the agent key
let agentAddr: Address;
if (existsSync(AGENT_ENV)) {
  agentAddr = privateKeyToAccount(need(agentEnv(), "B4_AGENT_KEY", AGENT_ENV) as Hex).address;
  console.log(`agent key file ${AGENT_ENV} exists; reusing it (agent ${agentAddr})`);
} else {
  const key = newKey();
  agentAddr = privateKeyToAccount(key).address;
  mkdirSync(dirname(AGENT_ENV), { recursive: true, mode: 0o700 });
  writeFileSync(AGENT_ENV, `B4_AGENT_KEY=${key}\nB4_AGENT_ADDRESS=${agentAddr}\n`, { mode: 0o600, flag: "wx" });
  console.log(`created the agent key file ${AGENT_ENV} (mode 600): agent ${agentAddr}`);
}

const p = publicEnv();
if (p.B4_AGENT_ADDRESS && !same(p.B4_AGENT_ADDRESS, agentAddr)) {
  console.error(`REFUSED: ${PUBLIC_ENV} already names another agent (${p.B4_AGENT_ADDRESS}). Nothing was changed.`);
  process.exit(emit("setup", 3, { state: "refused_precheck", reason: "the public file already names another agent", next: `move ${PUBLIC_ENV} away if you mean to start over` }));
}

// 2. the owner address
let ownerAddr: Address;
let finish: ((v: { ok: boolean; message: string }) => void) | null = null;
if (OWNER_KEY_FILE) {
  ownerAddr = privateKeyToAccount(need(ownerKeyEnv(), "B4_OWNER_KEY", OWNER_KEY_FILE) as Hex).address;
  console.log(`owner address from --owner-key-file: ${ownerAddr}`);
} else if (p.B4_OWNER_ADDRESS && same(p.B4_AGENT_ADDRESS, agentAddr)) {
  ownerAddr = p.B4_OWNER_ADDRESS as Address;
  console.log(`${PUBLIC_ENV} already records owner ${ownerAddr} for this agent; not asking again (move the file away to connect another wallet)`);
} else {
  const { handle, outcome } = await askConnect("setup", {
    title: "connect your wallet",
    summary: "Connect the wallet that will own this agent's budget. The command records its address on this computer. Nothing is sent and no budget is granted yet.",
    rows: [
      { label: "Your agent", value: agentAddr, mono: true },
      { label: "Agent key", value: `on this computer only, in ${AGENT_ENV}` },
    ],
    enforced: [],
    notEnforced: [],
    notes: [
      "Your wallet asks you to sign a short message. It proves the address is yours. It sends nothing and costs nothing.",
      "Your wallet keeps its key. The agent never gets it: every budget you grant later, you approve here in your wallet.",
    ],
  }, `Superstables budget: record this wallet as the owner of agent ${agentAddr} on ${CFG.label} (testnet).`);
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved("setup", outcome, { agent: agentAddr });
  if (outcome.status !== "connected") throw new Error(`unexpected owner page outcome ${outcome.status}`);
  ownerAddr = outcome.address as Address;
  finish = handle.finish;
  console.log(`the owner connected ${ownerAddr} and signed the sign-in message`);
}
if (same(ownerAddr, agentAddr)) {
  finish?.({ ok: false, message: "That is the agent's own address. Connect your own wallet instead." });
  await closeOwnerPage();
  process.exit(emit("setup", 3, { state: "refused_precheck", reason: "the owner address is the agent's address", next: "connect the owner's own wallet" }));
}

// 3. the public file
writePublic({ B4_OWNER_ADDRESS: ownerAddr, B4_AGENT_ADDRESS: agentAddr });
console.log(`${CFG.label}: wrote ${PUBLIC_ENV} (no secret).`);
const [oTok, oGas, aGas] = [await usdcBalance(ownerAddr), await nativeBalance(ownerAddr), await nativeBalance(agentAddr)];
console.log(`owner ${ownerAddr}: ${SYM} ${usdc(oTok)}, ${GAS.symbol} ${gasFmt(oGas)}`);
console.log(`agent ${agentAddr}: ${GAS.symbol} ${gasFmt(aGas)}`);

const steps = [
  `Fund your wallet ${ownerAddr} with test ${SYM} (${d.tokenFaucet}; at least ${d.minOwnerToken})${GAS.isUsdc ? "" : ` and ${GAS.symbol} for fees (${d.gasFaucet}; at least ${d.minOwnerGas})`}.`,
  `Give the agent gas: superstables budget fund-agent --rail evm${chainFlag} sends ${d.fundAgent} ${GAS.symbol} from your wallet (you approve it there). Or send ${d.fundAgent} ${GAS.symbol} to ${agentAddr} from any wallet.`,
  `Check everything: superstables budget doctor --rail evm${chainFlag}`,
  `Grant a budget: superstables budget grant --rail evm${chainFlag} --amount 0.01 (you approve it in your wallet).`,
];
console.log("\nNext:");
steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
finish?.({ ok: true, message: `Done. ${ownerAddr} is recorded as the owner of agent ${agentAddr}. You can close this page. Next: fund your wallet with test ${SYM}, give the agent gas, then grant a budget (the terminal lists the commands).` });
await closeOwnerPage();
process.exit(emit("setup", 0, { state: "ok", owner: ownerAddr, agent: agentAddr, publicFile: PUBLIC_ENV, agentKeyFile: AGENT_ENV, steps, next: `fund the owner, then superstables budget fund-agent --rail evm${chainFlag}, then superstables budget doctor --rail evm${chainFlag}` }));
