import "./cli-guard.mjs";
// setup (B4, any chain): make this machine an agent and record who its owner is. No owner key is ever created or stored.
//   1. The agent key file ($SUPERSTABLES_HOME/keys/budget/evm-agent.env, mode 600). Created if it is missing, never overwritten:
//      the same agent key works on every EVM chain, so a second chain reuses it.
//   2. The owner connects their own wallet on the owner page and signs a free sign-in message (it proves the address is theirs;
//      nothing is sent). With --owner-key-file <path> the owner address comes from that key instead (tests and automation).
//   3. This chain's public file: owner and agent addresses, no secret. Refuses (exit 3) if it already names another agent.
// Then it prints what to do next: fund the owner, give the agent gas, doctor, grant. Never prints a key.
//
// Setup is a trusted step. The signature proves the connected wallet controls its address, not that it is the intended
// owner: whoever completes setup becomes the owner on record. The owner runs it, or watches it run; an agent must not
// complete it. Once recorded, the owner never changes silently: --new-owner replaces it explicitly, and only while no
// budget is live (allowance 0).
// npx tsx budget/evm/setup.ts [--chain <name>] [--new-owner] [--timeout <s>] [--no-open] [--owner-key-file <path>]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { EVM_CHAINS } from "./chains.mjs";
import { SYM, CFG, GAS, emit, AGENT_ENV, PUBLIC_ENV, OWNER_KEY_FILE, agentEnv, publicEnv, writePublic, need, newKey, ownerKeyEnv, usdcBalance, nativeBalance, usdc, gasFmt, allowanceOf } from "./lib.ts";
import { askConnect, endUnapproved, closeOwnerPage, chainFlag } from "./owner.ts";
import { NEW_OWNER } from "../owner-page.ts";

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
const recorded = p.B4_OWNER_ADDRESS && same(p.B4_AGENT_ADDRESS, agentAddr) ? (p.B4_OWNER_ADDRESS as Address) : undefined;
if (NEW_OWNER && recorded) {
  // never move the owner while the agent can still spend from the old one
  const live = await allowanceOf(recorded, agentAddr).catch(() => null);
  if (live === null || live > 0n) {
    const reason = live === null ? `could not read the allowance of the recorded owner ${recorded}; the owner is not replaced` : `a budget is live: the recorded owner ${recorded} still allows the agent ${usdc(live)} ${SYM}`;
    console.log(`REFUSED: ${reason}. Nothing was changed.`);
    process.exit(emit("setup", 3, { state: "refused_precheck", reason, owner: recorded, next: live === null ? `superstables budget doctor --rail evm${chainFlag}, then setup --new-owner again` : `revoke first (superstables budget revoke --rail evm${chainFlag}, approved by ${recorded}), then setup --new-owner` }));
  }
  console.log(`replacing the recorded owner ${recorded} (no budget is live): the new owner connects on the page`);
}
let ownerAddr: Address;
let finish: ((v: { ok: boolean; message: string }) => void) | null = null;
if (OWNER_KEY_FILE) {
  ownerAddr = privateKeyToAccount(need(ownerKeyEnv(), "B4_OWNER_KEY", OWNER_KEY_FILE) as Hex).address;
  console.log(`owner address from --owner-key-file: ${ownerAddr}`);
  if (recorded && !same(recorded, ownerAddr) && !NEW_OWNER) {
    console.log(`REFUSED: ${PUBLIC_ENV} records owner ${recorded}, not ${ownerAddr}. Nothing was changed.`);
    process.exit(emit("setup", 3, { state: "refused_precheck", reason: `another owner (${recorded}) is recorded`, owner: recorded, next: `superstables budget setup --rail evm${chainFlag} --new-owner replaces it (refused while a budget is live)` }));
  }
} else if (recorded && !NEW_OWNER) {
  ownerAddr = recorded;
  console.log(`${PUBLIC_ENV} already records owner ${ownerAddr} for this agent; not asking again. If this isn't your wallet, stop: superstables budget setup --rail evm${chainFlag} --new-owner replaces it`);
} else {
  const { handle, outcome } = await askConnect("setup", {
    title: "Connect your wallet",
    summary: "Connect your wallet and sign a message to record its address as the budget owner on this computer. This does not grant a budget or send a transaction.",
    rows: [
      { label: "Your agent", value: agentAddr, mono: true },
      { label: "Agent key", value: `on this computer only, in ${AGENT_ENV}` },
    ],
    enforced: [],
    notEnforced: [],
    notes: [
      "Signing the message proves control of this address. It grants no spending permission and has no network fee.",
      "You will review and approve any later budget grant separately.",
    ],
  }, `Superstables budget: record this wallet as the owner of agent ${agentAddr} on ${CFG.label} (testnet).`, NEW_OWNER ? recorded : undefined);
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

// 3. the public file (a new owner starts with no budget terms)
const replaced = recorded && !same(recorded, ownerAddr) ? recorded : undefined;
writePublic({ B4_OWNER_ADDRESS: ownerAddr, B4_AGENT_ADDRESS: agentAddr }, replaced ? ["B4_CAP", "B4_SET_AT", "B4_EXPIRY", "B4_REVOKED_AT"] : []);
if (replaced) console.log(`the recorded owner changed: ${replaced} -> ${ownerAddr}`);
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
finish?.({ ok: true, message: `Done. The owner on record is now ${ownerAddr}. Check that this is your own wallet's address: if it is not, someone else connected, so grant nothing. Agent: ${agentAddr}. You can close this page. Next: fund your wallet with test ${SYM}, give the agent gas, then grant a budget (the terminal lists the commands).` });
await closeOwnerPage();
process.exit(emit("setup", 0, { state: "ok", owner: ownerAddr, ...(replaced ? { replacedOwner: replaced } : {}), agent: agentAddr, publicFile: PUBLIC_ENV, agentKeyFile: AGENT_ENV, steps, next: `superstables budget fund-agent --rail evm${chainFlag} (gas for the agent key), then superstables budget doctor --rail evm${chainFlag} (it says what the owner still needs), then superstables budget grant --rail evm${chainFlag} --amount A` }));
