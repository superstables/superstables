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
// --hosted --grant <usdc> and/or --fund [--fund-amount <amount>]: one link for the whole set-up. After the owner links this agent, the
// same page asks their wallet for the gas (fund-agent's transfer, default amount as fund-agent's) and then the grant
// (USDC.approve(agent, cap)), built exactly as fund-agent and grant build them. The command records the link as above, then
// reads each transaction from the chain itself, with the same checks fund-agent and grant make (receipt, sender = the owner
// on record, target, data, value, mined after the block read before the request), and records the budget only when the
// allowance reads exactly the cap. A step that did not complete is reported as it is; the link stays recorded.
//
// Setup is a trusted step. The signature proves the connected wallet controls its address, not that it is the intended
// owner: whoever completes setup becomes the owner on record. The owner runs it, or watches it run; an agent must not
// complete it. Once recorded, the owner never changes silently: --new-owner replaces it explicitly, and only while no
// budget is live (allowance 0).
// npx tsx budget/evm/setup.ts [--chain <name>] [--new-owner] [--hosted [--site <url>] [--grant <usdc>] [--fund [--fund-amount <amount>]]] [--timeout <s>]
//                             [--no-open] [--owner-key-file <path>]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { EVM_CHAINS } from "./chains.mjs";
import { SYM, CFG, GAS, emit, arg, flag, AGENT_ENV, PUBLIC_ENV, OWNER_KEY_FILE, publicEnv, writePublic, need, newKey, ownerKeyEnv, agentFileValues, usdcBalance, nativeBalance, usdc, gasFmt, allowanceOf, toUsdc, usageError, assertRpcChain, publicClient, tx } from "./lib.ts";
import { askConnect, endUnapproved, closeOwnerPage, chainFlag, useApprovalSite, fundingTx, fundValue, DEFAULT_FUND_AMOUNT, grantTx, grantEnforced, GRANT_NOT_ENFORCED, approveRow, capWords, checkFundSent, checkGrantSent, REVOKE_HINT, type SentCheck } from "./owner.ts";
import { NEW_OWNER } from "../owner-page.ts";
import { siteFailedWords, type HostedStep, type HostedStepOutcome, type PriorLink } from "../hosted.ts";
import { chosenSite, isSiteRequestId, siteOrigin } from "../site.mjs";

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
// The setup command that replaces the owner. On a hosted chain it names --hosted and the exact site: without them, setup
// would ask on the page on this computer and move the chain's approvals there, or take SUPERSTABLES_SITE.
const newOwnerCmd = (site: string | null | undefined) => `superstables budget setup --rail evm${chainFlag}${site ? ` --hosted --site ${site}` : ""} --new-owner`;
useApprovalSite(SITE);
const HOST = SITE ? new URL(SITE).host.replace(/^www\./, "") : "";

// --grant and --fund: the same link asks for the gas and the grant (hosted only)
const GRANT = arg("grant");
const FUND = flag("fund") || arg("fund-amount") !== undefined;
const BUNDLE = GRANT !== undefined || FUND;
if (BUNDLE && !HOSTED) usageError("--grant and --fund go with --hosted: without it, run setup, then fund-agent and grant, each with its own approval");
const CAP = GRANT !== undefined ? toUsdc(GRANT) : undefined;
if (CAP === 0n) usageError("--grant must be above 0");
const FUND_AMT = FUND ? arg("fund-amount") ?? DEFAULT_FUND_AMOUNT : undefined;
let FUND_VALUE = 0n;
if (FUND_AMT !== undefined) {
  try { FUND_VALUE = fundValue(FUND_AMT); } catch (e) { usageError((e as Error).message.replace("--amount", "--fund")); }
}

// 1. the agent key
let agentAddr: Address;
const agentFile = agentFileValues();
if (agentFile.problem !== undefined) {
  // reusing it would hand the owner's budget to a key other users on this machine may already hold
  console.log(`REFUSED: ${agentFile.problem}. Nothing was changed on this computer.`);
  process.exit(emit("setup", 3, { state: "refused_precheck", reason: agentFile.problem, next: `make ${AGENT_ENV} a regular file only you can read (chmod 600), then run setup again` }));
}
if (existsSync(AGENT_ENV)) {
  agentAddr = privateKeyToAccount(need(agentFile.env, "B4_AGENT_KEY", AGENT_ENV) as Hex).address;
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
// on record for this agent: a public file that names another agent was refused above; one that names no agent (an edit)
// still records its owner, which only --new-owner replaces
const recorded = p.B4_OWNER_ADDRESS && (!p.B4_AGENT_ADDRESS || same(p.B4_AGENT_ADDRESS, agentAddr)) ? (p.B4_OWNER_ADDRESS as Address) : undefined;
if (NEW_OWNER && recorded) {
  // never move the owner while the agent can still spend from the old one
  const live = await allowanceOf(recorded, agentAddr).catch(() => null);
  if (live === null || live > 0n) {
    const reason = live === null ? `could not read the allowance of the recorded owner ${recorded}; the owner is not replaced` : `a budget is live: the recorded owner ${recorded} still allows the agent ${usdc(live)} ${SYM}`;
    console.log(`REFUSED: ${reason}. Nothing was changed.`);
    process.exit(emit("setup", 3, { state: "refused_precheck", reason, owner: recorded, next: live === null ? `superstables budget doctor --rail evm${chainFlag}, then ${newOwnerCmd(SITE)} again` : `revoke first (superstables budget revoke --rail evm${chainFlag}, approved by ${recorded}), then ${newOwnerCmd(SITE)}` }));
  }
  // nor while the agent key holds the budget token: recover returns it to the owner on record, which would then be the new one
  const reserve = GAS.isUsdc ? (CFG.gas.reserveMax ?? 0n) : 0n;
  const held = await usdcBalance(agentAddr).catch(() => null);
  if (held === null || held > reserve) {
    const reason = held === null ? `could not read the ${SYM} the agent ${agentAddr} holds; the owner is not replaced` : `the agent ${agentAddr} holds ${usdc(held)} ${SYM} from the recorded owner's budget; recover returns it to the owner on record, so the owner is not replaced while it is there`;
    console.log(`REFUSED: ${reason}. Nothing was changed.`);
    process.exit(emit("setup", 3, { state: "refused_precheck", reason, owner: recorded, next: held === null ? `superstables budget doctor --rail evm${chainFlag}, then ${newOwnerCmd(SITE)} again` : `return it first (superstables budget recover --rail evm${chainFlag}, approved by ${recorded}), then ${newOwnerCmd(SITE)}` }));
  }
  console.log(`replacing the recorded owner ${recorded} (no budget is live): the new owner connects on the page`);
}
// The link recorded with the owner (setup --hosted), on this same site: an "already linked" answer is checked against it.
// None with --new-owner, or when the site changes: then only a fresh link the owner signs records an owner.
const recordedSite = p.APPROVALS === "hosted" && p.SITE ? siteOrigin(p.SITE).origin : undefined;
const prior: PriorLink | null = recorded && !NEW_OWNER && SITE && recordedSite === SITE && isSiteRequestId(p.LINK_ID) && typeof p.LINK_CODE === "string" && p.LINK_CODE ? { owner: recorded, linkId: p.LINK_ID, linkCode: p.LINK_CODE } : null;
if (HOSTED && recordedSite && recordedSite !== SITE) console.log(`this chain's approvals are hosted on ${recordedSite}; moving them to ${SITE} means adding the agent there, with a new owner proof`);
let linked: { id: string; code: string } | undefined;
// The steps after the link, built exactly as fund-agent and grant build them, and the block they must be mined after.
let then: HostedStep[] | undefined;
let fundTx: ReturnType<typeof fundingTx> | undefined;
let startBlock = 0n;
let agentHad = 0n;
if (BUNDLE) {
  then = [];
  if (FUND_VALUE > 0n) {
    try { fundTx = fundingTx(agentAddr, FUND_VALUE, true); } catch (e) { usageError((e as Error).message); }
    then.push({ kind: "fund_agent", transaction: { to: fundTx.to, data: fundTx.data ?? "0x", value: `0x${(fundTx.value ?? 0n).toString(16)}` } });
  }
  if (CAP !== undefined) {
    // a live allowance is never overwritten silently (grant refuses the same way)
    const live = recorded && !NEW_OWNER ? await allowanceOf(recorded, agentAddr).catch(() => null) : 0n;
    if (live !== null && live > 0n) {
      const reason = `a budget is live: the owner on record ${recorded} still allows the agent ${usdc(live)} ${SYM}. A grant overwrites it in place, so it is not asked for here`;
      console.log(`REFUSED: ${reason}. Nothing was requested.`);
      process.exit(emit("setup", 3, { state: "refused_precheck", reason, owner: recorded, next: `revoke first (superstables budget revoke --rail evm${chainFlag}), then superstables budget grant --rail evm${chainFlag} --amount A` }));
    }
    const g = grantTx(agentAddr, CAP);
    then.push({ kind: "grant", transaction: { to: g.to, data: g.data, value: "0x0" } });
  }
  try {
    await assertRpcChain();
    startBlock = await publicClient.getBlockNumber();
  } catch (e) {
    const reason = `could not read ${CFG.label} before asking (${(e as Error).message.split("\n")[0]}); the transactions could not be checked afterwards`;
    console.log(`REFUSED: ${reason}. Nothing was requested.`);
    process.exit(emit("setup", 3, { state: "refused_precheck", reason, next: `superstables budget doctor --rail evm${chainFlag} checks the RPC; then run the same command again` }));
  }
  agentHad = await nativeBalance(agentAddr).catch(() => 0n);
  console.log(`one approval link: the owner adds this agent, then their wallet ${[FUND_AMT ? `sends it ${FUND_AMT} ${GAS.symbol} for gas` : "", CAP !== undefined ? `approves a budget of ${capWords(CAP)}` : ""].filter(Boolean).join(", then ")}. Transactions are checked from block ${startBlock + 1n} on.`);
}

let ownerAddr: Address;
let finish: ((v: { ok: boolean; message: string }) => void) | null = null;
let bundle: { steps: HostedStepOutcome[] } | undefined;
if (OWNER_KEY_FILE) {
  ownerAddr = privateKeyToAccount(need(ownerKeyEnv(), "B4_OWNER_KEY", OWNER_KEY_FILE) as Hex).address;
  console.log(`owner address from --owner-key-file: ${ownerAddr}`);
  if (recorded && !same(recorded, ownerAddr) && !NEW_OWNER) {
    console.log(`REFUSED: ${PUBLIC_ENV} records owner ${recorded}, not ${ownerAddr}. Nothing was changed.`);
    process.exit(emit("setup", 3, { state: "refused_precheck", reason: `another owner (${recorded}) is recorded`, owner: recorded, next: `${newOwnerCmd(recordedSite)} replaces it (refused while a budget is live)` }));
  }
} else if (recorded && !NEW_OWNER && !HOSTED) {
  ownerAddr = recorded;
  console.log(`${PUBLIC_ENV} already records owner ${ownerAddr} for this agent; not asking again. If this isn't your wallet, stop: ${newOwnerCmd(recordedSite)} replaces it`);
} else if (HOSTED && then) {
  // one link: the owner links this agent, then the same page asks their wallet for the gas and the grant, in that order
  const what = [FUND_AMT ? "send it gas" : "", CAP !== undefined ? `approve a budget of ${usdc(CAP)} test ${SYM}` : ""].filter(Boolean);
  const r = await askConnect("setup", {
    title: `Add this agent${what.length === 2 ? `, ${what[0]} and ${what[1]}` : ` and ${what[0]}`}`,
    amount: CAP !== undefined ? usdc(CAP) : FUND_AMT,
    unit: CAP !== undefined ? SYM : GAS.symbol,
    summary: [
      `1. Add this agent to your ${HOST} account: your account's address is recorded as the budget owner on this computer.`,
      FUND_AMT ? `${2}. Send ${FUND_AMT} ${GAS.symbol} from your wallet to the agent for network fees.` : "",
      CAP !== undefined ? `${FUND_AMT ? 3 : 2}. Allow the agent to withdraw up to ${capWords(CAP)} from your wallet in total.` : "",
      "Your wallet asks you to approve each transaction in turn.",
    ].filter(Boolean).join(" "),
    rows: [
      { label: "Your agent", value: agentAddr, mono: true },
      { label: "Chain", value: `${CFG.label} (testnet)` },
      ...(fundTx ? [{ label: "Gas for the agent", value: fundTx.words || `a plain transfer of ${FUND_AMT} ${GAS.symbol}`, mono: !!fundTx.words }] : []),
      ...(CAP !== undefined ? [approveRow(agentAddr, CAP)] : []),
    ],
    enforced: CAP !== undefined ? grantEnforced(CAP) : [],
    notEnforced: CAP !== undefined ? GRANT_NOT_ENFORCED : [],
    notes: [
      `You pick the match code your agent shows you before the agent is added or anything is sent. The agent key stays on this computer; ${HOST} does not receive it.`,
      ...(FUND_AMT ? ["The agent controls the gas it receives and can send it elsewhere."] : []),
      ...(CAP !== undefined ? [`The grant gives permission; it does not transfer the budget now. Do not change the spending cap in your wallet. To end the budget at any time: ${REVOKE_HINT}`] : []),
      "You pay the network fee for each transaction, shown in your wallet.",
    ],
  }, "", NEW_OWNER ? recorded : undefined, then, { prior, newOwner: NEW_OWNER });
  bundle = r.bundle;
  linked = r.link;
  const outcome = r.outcome;
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved("setup", outcome, { agent: agentAddr, linked: false });
  if (outcome.status !== "connected") throw new Error(`unexpected approval outcome ${outcome.status}`);
  ownerAddr = outcome.address as Address;
  console.log(`Agent added to the ${HOST} account ${ownerAddr}`);
  if (recorded && !same(recorded, ownerAddr) && !NEW_OWNER) {
    await closeOwnerPage(0);
    const sent = bundle?.steps.filter((s) => s.hash).map((s) => `${s.kind} ${s.hash}`) ?? [];
    const reason = `${HOST} added this agent to the account ${ownerAddr}, but this computer records the owner ${recorded}. Nothing was changed on this computer${sent.length ? `; that account's wallet reported ${sent.join(", ")}` : ""}`;
    console.log(`REFUSED: ${reason}.`);
    process.exit(emit("setup", 3, { state: "refused_precheck", reason, owner: recorded, next: `if ${ownerAddr} is the right owner: ${newOwnerCmd(SITE)} (refused while a budget is live). If not, remove this agent from that account on ${HOST}${sent.length ? ", and check that account's wallet activity" : ""}` }));
  }
} else if (HOSTED) {
  // the owner links this agent to their account on the site; the account's address becomes the owner on record
  const r = await askConnect("setup", {
    title: `Add this agent to your ${HOST} account`,
    summary: `Sign in to ${HOST} with your wallet and add this agent to your account. Your account's address is recorded as the budget owner on this computer. This does not grant a budget or send a transaction.`,
    rows: [
      { label: "Your agent", value: agentAddr, mono: true },
      { label: "Chain", value: `${CFG.label} (testnet)` },
      { label: "Agent key", value: `on this computer only, in ${AGENT_ENV}` },
    ],
    enforced: [],
    notEnforced: [],
    notes: [
      `Grants, revokes and gas for this agent are then approved on ${HOST}, in your wallet. You pick the match code your agent shows you before the agent is added or anything is sent.`,
      `The agent key stays on this computer; ${HOST} does not receive it. Your signing key stays in your wallet.`,
    ],
  }, "", NEW_OWNER ? recorded : undefined, undefined, { prior, newOwner: NEW_OWNER });
  const outcome = r.outcome;
  linked = r.link;
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved("setup", outcome, { agent: agentAddr });
  if (outcome.status !== "connected") throw new Error(`unexpected approval outcome ${outcome.status}`);
  ownerAddr = outcome.address as Address;
  console.log(`Agent added to the ${HOST} account ${ownerAddr}`);
  if (recorded && !same(recorded, ownerAddr) && !NEW_OWNER) {
    await closeOwnerPage(0);
    const reason = `${HOST} added this agent to the account ${ownerAddr}, but this computer records the owner ${recorded}. Nothing was changed on this computer`;
    console.log(`REFUSED: ${reason}.`);
    process.exit(emit("setup", 3, { state: "refused_precheck", reason, owner: recorded, next: `if ${ownerAddr} is the right owner: ${newOwnerCmd(SITE)} (refused while a budget is live). If not, remove this agent from that account on ${HOST}` }));
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

// 3. the public file (a new owner starts with no budget terms). Hosted: APPROVALS, SITE, and the link the owner signed
// (LINK_ID, LINK_CODE: a later "already linked" answer is checked against them). Asked on this computer: none of them.
const replaced = recorded && !same(recorded, ownerAddr) ? recorded : undefined;
const asked = !OWNER_KEY_FILE && !(recorded && !NEW_OWNER && !HOSTED);
if (HOSTED && !linked) throw new Error("an add-agent request without its id and code");
const drop = [...(replaced ? ["B4_CAP", "B4_SET_AT", "B4_EXPIRY", "B4_REVOKED_AT"] : []), ...(asked && !HOSTED ? ["APPROVALS", "SITE", "LINK_ID", "LINK_CODE"] : replaced && !HOSTED ? ["LINK_ID", "LINK_CODE"] : [])];
writePublic({ B4_OWNER_ADDRESS: ownerAddr, B4_AGENT_ADDRESS: agentAddr, ...(HOSTED ? { APPROVALS: "hosted", SITE: SITE!, LINK_ID: linked!.id, LINK_CODE: linked!.code } : {}) }, drop);
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

if (BUNDLE) await finishBundle();

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

/**
 * The steps after the link: each transaction the site reports is read from the chain, with the checks fund-agent and grant
 * make. The link is already recorded. Ends the process with one RESULT: ok when every step is on chain as planned, else the
 * state of the first step that is not, with what did happen.
 */
async function finishBundle(): Promise<never> {
  const steps = bundle?.steps ?? [];
  type Report = { kind: string; state: SentCheck["state"] | "refused_precheck"; tx?: string; txUrl?: string; amount?: string; reason?: string; reasonCode?: string };
  const reports: Report[] = [];
  let grantDone: SentCheck | undefined;
  for (const s of steps) {
    const amount = s.kind === "grant" ? usdc(CAP!) : FUND_AMT;
    if (s.hash) {
      console.log(`${s.kind}: ${HOST} reports transaction ${s.hash} (${s.state}); checking it on chain`);
      // a step the site reported as failed is read too, but never settled
      const siteFailed = s.state === "failed" ? siteFailedWords(HOST, s.reasonCode) : undefined;
      const c = s.kind === "grant"
        ? await checkGrantSent(s.hash as Hex, { owner: ownerAddr, agent: agentAddr, cap: CAP!, afterBlock: startBlock, siteFailed })
        : await checkFundSent(s.hash as Hex, { owner: ownerAddr, agent: agentAddr, t: fundTx!, value: FUND_VALUE, agentHad, afterBlock: startBlock, siteFailed });
      if (s.kind === "grant" && c.state === "settled") grantDone = c;
      reports.push({ kind: s.kind, state: c.state, tx: c.tx, txUrl: tx(c.tx), amount, reason: c.reason });
    } else if (s.walletAsked || s.state === "unknown") {
      reports.push({ kind: s.kind, state: "unknown", amount, reason: s.reason || "the wallet was asked to send, but superstables.com reported no transaction" });
    } else {
      const why = s.state === "rejected"
        ? s.reasonCode === "cap_above_limit" ? `refused: the budget is above the limit set on the owner's ${HOST} account${s.reason ? ` (${s.reason})` : ""}` : `rejected${s.reason ? `: ${s.reason}` : " by the owner"}`
        : s.state === "skipped" ? "not asked, because an earlier step did not complete"
        : s.state === "expired" ? "not approved before the approval link expired"
        : s.state === "cancelled" ? "withdrawn on superstables.com when this command stopped waiting, before the owner's wallet was asked"
        : `${s.state}${s.reason ? `: ${s.reason}` : ""}`;
      reports.push({ kind: s.kind, state: "refused_precheck", amount, reason: `nothing was sent: ${why}`, reasonCode: s.reasonCode ?? undefined });
    }
  }
  if (grantDone) {
    const now = Math.floor(Date.now() / 1000);
    writePublic({ B4_CAP: String(CAP), B4_SET_AT: String(now) }, ["B4_REVOKED_AT", "B4_EXPIRY"]);
    console.log(`budget: ${usdc(CAP!)} ${SYM}, allowance == cap on chain.`);
  }
  await closeOwnerPage();
  const name = (k: string) => (k === "grant" ? "budget" : "gas");
  const line = (r: Report) => `${name(r.kind)}: ${r.state === "settled" ? `${r.kind === "grant" ? `${r.amount} ${SYM} approved` : `${r.amount} ${GAS.symbol} sent`} (tx ${r.tx})` : r.tx ? `${r.state} (tx ${r.tx}): ${r.reason}` : `${r.state}: ${r.reason}`}`;
  // the RESULT's reason is one short line (the dispatcher keeps 300 characters): the hashes are in steps and tx
  const short = (r: Report) => `${name(r.kind)}: ${r.state === "settled" ? (r.kind === "grant" ? `${r.amount} ${SYM} approved` : `${r.amount} ${GAS.symbol} sent`) : r.state === "refused_precheck" ? (r.reason ?? "").slice(0, 120) : `${r.state}, ${(r.reason ?? "").slice(0, 110)}`}`;
  const summary = ["agent added: yes", ...reports.map(short)].join("; ");
  for (const r of reports) console.log(`  ${line(r)}`);
  const txs = Object.fromEntries(reports.filter((r) => r.tx).map((r) => [r.kind === "grant" ? "grant" : "fundAgent", r.tx]));
  const base = { owner: ownerAddr, agent: agentAddr, linked: true, steps: reports, tx: txs, cap: grantDone ? usdc(CAP!) : undefined, allowance: grantDone?.allowance !== undefined ? usdc(grantDone.allowance) : undefined, sent: reports.find((r) => r.kind === "fund_agent" && r.state === "settled") ? FUND_AMT : undefined, publicFile: PUBLIC_ENV, agentKeyFile: AGENT_ENV };
  const first = reports.find((r) => r.state !== "settled");
  if (!first) {
    console.log(`\nDone with one approval link: the agent was added to the account${FUND_AMT ? ", has gas" : ""}${CAP !== undefined ? ` and has a budget of ${usdc(CAP)} ${SYM}` : ""}.`);
    process.exit(emit("setup", 0, { state: "ok", ...base, next: CAP !== undefined ? `none: the agent can buy under the budget. superstables budget status --rail evm${chainFlag} shows what is left` : `superstables budget grant --rail evm${chainFlag} --amount A, only when the owner asks for a budget` }));
  }
  const missing = reports.filter((r) => r.state !== "settled");
  const later = missing.map((r) => (r.kind === "grant" ? `superstables budget grant --rail evm${chainFlag} --amount A` : `superstables budget fund-agent --rail evm${chainFlag}`)).join(" and ");
  const next = first.state === "unknown"
    ? `superstables budget status --rail evm${chainFlag} and the owner's wallet activity: read whether ${first.kind === "grant" ? "the grant" : "the gas"} landed before running anything again. The agent has been added to the account`
    : first.state === "mismatch"
      ? first.kind === "grant" ? `the chain shows another approval than planned: the owner revokes it (superstables budget revoke --rail evm${chainFlag}); grant again only if the owner asks` : `check the owner's wallet activity, then superstables budget doctor --rail evm${chainFlag}`
      : `the agent has been added to the account${reports.some((r) => r.kind === "fund_agent" && r.state === "settled") ? " and has gas" : ""}. Tell the owner what happened in one reply and end your turn. Later, only if the owner asks: ${later}`;
  const exit = first.state === "unknown" ? 5 : first.state === "failed" ? 1 : 3;
  process.exit(emit("setup", exit, { state: first.state, ...base, reason: summary, next }));
}
