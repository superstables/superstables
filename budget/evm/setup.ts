import "./cli-guard.mjs";
// setup (B4, any chain): make this machine an agent and record who its owner is. No owner key is ever created or stored.
//   1. The agent key file ($SUPERSTABLES_HOME/keys/budget/evm-agent.env, mode 600). Created if it is missing, never overwritten:
//      the same agent key works on every EVM chain, so a second chain reuses it.
//   2. The owner connects their own wallet on the owner page and signs a free sign-in message (it proves the address is theirs;
//      nothing is sent). With --owner-key-file <path> the owner address comes from that key instead (tests and automation).
//   3. This chain's public file: owner and agent addresses, no secret. Refuses (exit 3) if it already names another agent.
// Then it prints what to do next: fund the owner, give the agent gas, doctor, grant. Never prints a key.
//
// --hosted [--site URL] (tests: an http site on 127.0.0.1): the owner approves on superstables.com instead of the page on
// this computer. Step 2 is then a link: the agent key signs a link request, the owner signs in to the site with their wallet,
// picks the match code and links this agent to their account, and the account's address becomes the owner on record. The
// public file also gets APPROVALS=hosted and SITE, so every later owner command on this chain asks through the site
// (recover excepted). Setup without --hosted keeps a recorded owner and its mode; with --new-owner it asks on this computer
// and drops APPROVALS and SITE.
//
// Setup is a trusted step. The signature proves the connected wallet controls its address, not that it is the intended
// owner: whoever completes setup becomes the owner on record. The owner runs it, or watches it run; an agent must not
// complete it. Once recorded, the owner never changes silently: --new-owner replaces it explicitly, and only while no
// budget is live (allowance 0).
// npx tsx budget/evm/setup.ts [--chain <name>] [--new-owner] [--hosted [--site <url>]] [--timeout <s>] [--no-open] [--owner-key-file <path>]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { EVM_CHAINS } from "./chains.mjs";
import { SYM, CFG, GAS, emit, arg, flag, AGENT_ENV, PUBLIC_ENV, OWNER_KEY_FILE, agentEnv, publicEnv, writePublic, need, newKey, ownerKeyEnv, usdcBalance, nativeBalance, usdc, gasFmt, allowanceOf } from "./lib.ts";
import { askConnect, endUnapproved, closeOwnerPage, chainFlag, useApprovalSite } from "./owner.ts";
import { NEW_OWNER } from "../owner-page.ts";
import { chosenSite } from "../site.mjs";

const d = (EVM_CHAINS as Record<string, any>)[CFG.key].doctor;
const same = (x?: string, y?: string) => !!x && !!y && x.toLowerCase() === y.toLowerCase();

// hosted approvals: the site, chosen here (--site, else SUPERSTABLES_SITE, else superstables.com)
const HOSTED = flag("hosted");
let SITE: string | null = null;
if (HOSTED) {
  if (OWNER_KEY_FILE) { console.error("error: --hosted asks the owner on the site; with --owner-key-file there is no owner to ask"); process.exit(2); }
  const s = chosenSite(arg("site"));
  if (s.error) { console.error(`error: --site: ${s.error}`); process.exit(2); }
  SITE = s.origin as string;
} else if (arg("site")) { console.error("error: --site goes with --hosted"); process.exit(2); }
useApprovalSite(SITE);
const HOST = SITE ? new URL(SITE).host.replace(/^www\./, "") : "";

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
} else if (recorded && !NEW_OWNER && !HOSTED) {
  ownerAddr = recorded;
  console.log(`${PUBLIC_ENV} already records owner ${ownerAddr} for this agent; not asking again. If this isn't your wallet, stop: superstables budget setup --rail evm${chainFlag} --new-owner replaces it`);
} else if (HOSTED) {
  // the owner links this agent to their account on the site; the account's address becomes the owner on record
  const { outcome } = await askConnect("setup", {
    title: `Link this agent to your ${HOST} account`,
    summary: `Sign in to ${HOST} with your wallet and link this agent to your account. Your account's address is recorded as the budget owner on this computer. This does not grant a budget or send a transaction.`,
    rows: [
      { label: "Your agent", value: agentAddr, mono: true },
      { label: "Chain", value: `${CFG.label} (testnet)` },
      { label: "Agent key", value: `on this computer only, in ${AGENT_ENV}` },
    ],
    enforced: [],
    notEnforced: [],
    notes: [
      `Grants, revokes and gas for this agent are then approved on ${HOST}, in your wallet. You pick the match code your agent shows you before anything is linked or sent.`,
      `The agent key stays on this computer; ${HOST} does not receive it. Your signing key stays in your wallet.`,
    ],
  }, "", NEW_OWNER ? recorded : undefined);
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved("setup", outcome, { agent: agentAddr });
  if (outcome.status !== "connected") throw new Error(`unexpected approval outcome ${outcome.status}`);
  ownerAddr = outcome.address as Address;
  console.log(`${HOST} linked this agent to the account ${ownerAddr}`);
  if (recorded && !same(recorded, ownerAddr) && !NEW_OWNER) {
    await closeOwnerPage(0);
    const reason = `${HOST} linked this agent to ${ownerAddr}, but this computer records the owner ${recorded}. Nothing was changed on this computer`;
    console.log(`REFUSED: ${reason}.`);
    process.exit(emit("setup", 3, { state: "refused_precheck", reason, owner: recorded, next: `if ${ownerAddr} is the right owner: superstables budget setup --rail evm${chainFlag} --hosted --new-owner (refused while a budget is live). If not, remove this agent from that account on ${HOST}` }));
  }
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

// 3. the public file (a new owner starts with no budget terms). Hosted: APPROVALS and SITE. Asked on this computer: neither.
const replaced = recorded && !same(recorded, ownerAddr) ? recorded : undefined;
const asked = !OWNER_KEY_FILE && !(recorded && !NEW_OWNER && !HOSTED);
const drop = [...(replaced ? ["B4_CAP", "B4_SET_AT", "B4_EXPIRY", "B4_REVOKED_AT"] : []), ...(asked && !HOSTED ? ["APPROVALS", "SITE"] : [])];
writePublic({ B4_OWNER_ADDRESS: ownerAddr, B4_AGENT_ADDRESS: agentAddr, ...(HOSTED ? { APPROVALS: "hosted", SITE: SITE! } : {}) }, drop);
if (replaced) console.log(`the recorded owner changed: ${replaced} -> ${ownerAddr}`);
console.log(`${CFG.label}: wrote ${PUBLIC_ENV} (no secret).${HOSTED ? ` Owner approvals on this chain: hosted on ${SITE}.` : ""}`);
// balances are for the next steps only: a slow or failing RPC does not undo the setup
const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`no answer within ${ms / 1000} s`)), ms).unref())]);
try {
  const [oTok, oGas, aGas] = await within(Promise.all([usdcBalance(ownerAddr), nativeBalance(ownerAddr), nativeBalance(agentAddr)]), 20_000);
  console.log(`owner ${ownerAddr}: ${SYM} ${usdc(oTok)}, ${GAS.symbol} ${gasFmt(oGas)}`);
  console.log(`agent ${agentAddr}: ${GAS.symbol} ${gasFmt(aGas)}`);
} catch (e) {
  console.log(`could not read the balances (${(e as Error).message}); superstables budget doctor --rail evm${chainFlag} checks them`);
}

const where = HOSTED || (recorded && !NEW_OWNER && publicEnv().APPROVALS === "hosted") ? `on ${HOST || "the site"}, in your wallet` : "in your wallet";
const steps = [
  `Fund your wallet ${ownerAddr} with test ${SYM} (${d.tokenFaucet}; at least ${d.minOwnerToken})${GAS.isUsdc ? "" : ` and ${GAS.symbol} for fees (${d.gasFaucet}; at least ${d.minOwnerGas})`}.`,
  `Give the agent gas: superstables budget fund-agent --rail evm${chainFlag} sends ${d.fundAgent} ${GAS.symbol} from your wallet (you approve it ${where}). Or send ${d.fundAgent} ${GAS.symbol} to ${agentAddr} from any wallet.`,
  `Check everything: superstables budget doctor --rail evm${chainFlag}`,
  `Grant a budget: superstables budget grant --rail evm${chainFlag} --amount 0.01 (you approve it ${where}).`,
];
console.log("\nNext:");
steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
finish?.({ ok: true, message: `Done. The owner on record is now ${ownerAddr}. Check that this is your own wallet's address: if it is not, someone else connected, so grant nothing. Agent: ${agentAddr}. You can close this page. Next: fund your wallet with test ${SYM}, give the agent gas, then grant a budget (the terminal lists the commands).` });
await closeOwnerPage();
process.exit(emit("setup", 0, { state: "ok", owner: ownerAddr, ...(replaced ? { replacedOwner: replaced } : {}), agent: agentAddr, publicFile: PUBLIC_ENV, agentKeyFile: AGENT_ENV, steps, next: `superstables budget fund-agent --rail evm${chainFlag} (gas for the agent key), then superstables budget doctor --rail evm${chainFlag} (it says what the owner still needs), then superstables budget grant --rail evm${chainFlag} --amount A` }));
