// setup for the solana rail: make this machine an agent and record who its owner is. No owner key is ever created or stored.
//   1. The agent key file ($SUPERSTABLES_HOME/keys/budget/solana-agent.env, mode 600): SOLANA_AGENT_SECRET_BASE58, its address
//      and, once known, the owner's public SOLANA_OWNER_ADDRESS. Created if missing, never overwritten.
//   2. The owner connects their own wallet (Phantom or any Wallet Standard wallet) on the owner page and signs a free sign-in
//      message (solana:signMessage, checked as an ed25519 signature): it proves the address is theirs and sends nothing. With
//      --owner-key-file <path> the address comes from that key instead (tests and automation only).
//   3. The public file: owner and agent addresses, no secret.
// Then it prints the next steps: fund the owner (devnet SOL and USDC), fund-agent, doctor, grant. Never prints a key.
//
// Setup is a trusted step: the signature proves control of the connected address, not that it is the intended owner, so
// the owner runs it or watches it run, and an agent must not complete it. A recorded owner never changes silently:
// --new-owner replaces it, refused while the agent is the delegate of the recorded owner's USDC account.
//
// --hosted [--site URL] [--grant <usdc>] [--fund | --fund-amount <sol>]: the owner approves on superstables.com instead.
// Step 2 is then a link: the agent key signs a link request (ed25519), the owner signs in to the site, connects their Solana
// wallet and signs one message for this agent, and picks the match code; that Solana address becomes the owner on record.
// The public file also gets APPROVALS=hosted and SITE, so grant, revoke and fund-agent ask through the site from then on.
// With --fund and --grant the same page then asks the owner's Solana wallet for the SOL (fund-agent's transfer) and the
// grant (ApproveChecked up to the cap), in that order; the site builds each when the owner is ready. The command reads each
// signature from the chain with fund-agent's and grant's checks before it reports it.
// npx tsx budget/solana/setup.ts [--new-owner] [--hosted [--site <url>] [--grant <usdc>] [--fund | --fund-amount <sol>]] [--timeout <s>] [--no-open]
//                                [--owner-key-file <path>]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { AGENT_KEY_PATH, PUBLIC_PATH, USDC_DECIMALS, USDC_MINT, connection, explorerTx, formatUnits, loadOwner, parseEnvFile, parseStrict, parseUnits, readPublic, replaceKeyFile, retryRead, parseEnvText, sleep, writePublic } from "./lib.mjs";
import { UNSAFE_SECRET_FILE, readSecretFile } from "../secret-file.mjs";
import { createApproveCheckedInstruction, getAssociatedTokenAddressSync, getAccount, getAccountOrNull } from "./token.mjs";
import { NEW_OWNER, OWNER_KEY_FILE, checkOwnerKeyFile } from "../owner-page.ts";
import type { HostedStep, HostedStepOutcome, PriorLink } from "../hosted.ts";
import { chosenSite, isSiteRequestId, siteOrigin } from "../site.mjs";
import { askConnect, closeOwnerPage, confirmHosted, emit, endUnapproved, sol, useApprovalSite } from "./owner.ts";

const USAGE = `Usage: npx tsx budget/solana/setup.ts [--new-owner] [--hosted [--site <url>] [--grant <usdc>] [--fund | --fund-amount <sol>]]
                                      [--timeout <s>] [--no-open] [--owner-key-file <path>]

Create the agent key file (mode 600, never overwritten), let the owner connect their own wallet on the owner page, and write
the public address file. No owner key is created. Prints addresses only, never a key.

  --new-owner              replace the recorded owner (refused while a budget is live on it)
  --hosted                 the owner approves on superstables.com (links this agent to their account) instead of a page here
  --site <url>             with --hosted: the site (default superstables.com, or SUPERSTABLES_SITE)
  --grant <usdc>           with --hosted: on the same page, a budget of this much USDC in total
  --fund, --fund-amount <sol>  with --hosted: on the same page, SOL for the agent's fees (default 0.01, at most 1)
  --timeout <s>            how long the approval link stays open (default 600)
  --no-open                do not open the link in the default browser
  --owner-key-file <path>  tests and automation only: record this key file's address instead of asking the wallet
  -h, --help               show this help`;
const cli = parseStrict(process.argv.slice(2), { "new-owner": "bool", hosted: "bool", site: "value", grant: "value", fund: "bool", "fund-amount": "value", timeout: "value", "no-open": "bool", "owner-key-file": "value" }, { usage: USAGE });
const newOwner = NEW_OWNER || cli["new-owner"] === true;
const result = (exit: number, o: Record<string, unknown>) => emit("setup", exit, o);
const usage = (message: string): never => {
  console.error(`setup.ts: ${message}\n\n${USAGE}`);
  process.exit(2);
};

// hosted approvals: the site, chosen here (--site, else SUPERSTABLES_SITE, else superstables.com)
const HOSTED = cli.hosted === true;
let SITE: string | null = null;
if (HOSTED) {
  if (OWNER_KEY_FILE) usage("--hosted asks the owner on the site; with --owner-key-file there is no owner to ask");
  const s = chosenSite(cli.site);
  if (s.error) usage(`--site: ${s.error}`);
  SITE = s.origin as string;
} else if (cli.site !== undefined) usage("--site goes with --hosted");
useApprovalSite(SITE);
const HOST = SITE ? new URL(SITE).host.replace(/^www\./, "") : "";
// --grant and --fund: the same link asks for the SOL and the grant (hosted only)
const FUND = cli.fund === true || cli["fund-amount"] !== undefined;
if ((cli.grant !== undefined || FUND) && !HOSTED) usage("--grant and --fund go with --hosted: without it, run setup, then fund-agent and grant, each with its own approval");
let CAP: bigint | undefined;
let LAMPORTS: bigint | undefined;
try {
  if (cli.grant !== undefined) CAP = parseUnits(cli.grant);
  if (FUND) LAMPORTS = parseUnits(cli["fund-amount"] ?? "0.01", 9);
} catch (e) {
  usage((e as Error).message);
}
if (CAP === 0n) usage("--grant must be above 0");
if (LAMPORTS !== undefined && (LAMPORTS === 0n || LAMPORTS > 1_000_000_000n)) usage("--fund must be above 0 and at most 1 SOL");

// 1. the agent key
// Read through here each time: reusing a key file other users can read would hand the owner's budget to a key they may
// already hold, and the file can change while setup waits for the owner. "" when there is no file yet.
const agentFileTextOrRefuse = (): string => {
  try {
    return readSecretFile(AGENT_KEY_PATH, "the agent key file");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    if ((err as NodeJS.ErrnoException).code !== UNSAFE_SECRET_FILE) throw err;
    const reason = (err as Error).message;
    console.log(`REFUSED: ${reason}. Nothing was changed on this computer.`);
    process.exit(result(3, { state: "refused_precheck", reason, next: `make ${AGENT_KEY_PATH} a regular file only you can read (chmod 600), then run setup again` }));
  }
};
const existing = parseEnvText(agentFileTextOrRefuse()) as Record<string, string>;
let agent: string;
if (existing.SOLANA_AGENT_SECRET_BASE58) {
  agent = Keypair.fromSecretKey(bs58.decode(existing.SOLANA_AGENT_SECRET_BASE58)).publicKey.toBase58();
  console.log(`agent key file ${AGENT_KEY_PATH} exists; reusing it (agent ${agent})`);
} else {
  if (existsSync(AGENT_KEY_PATH)) process.exit(result(3, { state: "refused_precheck", reason: `${AGENT_KEY_PATH} has no SOLANA_AGENT_SECRET_BASE58`, next: `move ${AGENT_KEY_PATH} away if you mean to start over` }));
  const kp = Keypair.generate();
  agent = kp.publicKey.toBase58();
  mkdirSync(dirname(AGENT_KEY_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(AGENT_KEY_PATH, `# Solana devnet AGENT key. Only buy opens this file. No owner secret here.\nSOLANA_AGENT_SECRET_BASE58=${bs58.encode(kp.secretKey)}\nSOLANA_AGENT_ADDRESS=${agent}\n`, { mode: 0o600, flag: "wx" });
  console.log(`created the agent key file ${AGENT_KEY_PATH} (mode 600): agent ${agent}`);
}
const pub = readPublic();
if (pub.agent && pub.agent.toBase58() !== agent) {
  console.error(`REFUSED: ${PUBLIC_PATH} already names another agent (${pub.agent.toBase58()}). Nothing was changed.`);
  process.exit(result(3, { state: "refused_precheck", reason: "the public file already names another agent", next: `move ${PUBLIC_PATH} away if you mean to start over` }));
}

// 2. the owner address
const bound = existing.SOLANA_OWNER_ADDRESS;
const recorded: string | undefined = bound ?? (pub.owner && pub.agent?.toBase58() === agent ? pub.owner.toBase58() : undefined);
if (newOwner && recorded) {
  // never move the owner while the agent is still the delegate of the recorded owner's USDC account
  const acc = await retryRead(() => getAccountOrNull(connection(), getAssociatedTokenAddressSync(USDC_MINT, new PublicKey(recorded)))).then((a) => ({ ok: true as const, a }), (e) => ({ ok: false as const, e }));
  const live = !acc.ok ? null : Boolean(acc.a?.delegate && acc.a.delegate.toBase58() === agent && acc.a.delegatedAmount > 0n);
  if (live !== false) {
    const reason = live === null ? `could not read the USDC account of the recorded owner ${recorded}; the owner is not replaced` : `a budget is live: the agent is the delegate of ${recorded}'s USDC account with ${formatUnits(acc.ok ? acc.a!.delegatedAmount : 0n)} USDC left`;
    console.log(`REFUSED: ${reason}. Nothing was changed.`);
    process.exit(result(3, { state: "refused_precheck", reason, owner: recorded, next: live === null ? "superstables budget doctor --rail solana, then setup --new-owner again" : `revoke first (superstables budget revoke --rail solana, approved by ${recorded}), then setup --new-owner` }));
  }
  console.log(`replacing the recorded owner ${recorded} (no budget is live): the new owner connects on the page`);
}
// The link recorded with the owner (setup --hosted), on this same site: an "already linked" answer is checked against it.
// None with --new-owner, or when the site changes: then only a fresh link the owner signs records an owner.
const rawPub = parseEnvFile(PUBLIC_PATH) as Record<string, string>;
const recordedSite = rawPub.APPROVALS === "hosted" && rawPub.SITE ? siteOrigin(rawPub.SITE).origin : undefined;
const prior: PriorLink | null = recorded && !newOwner && SITE && recordedSite === SITE && isSiteRequestId(rawPub.LINK_ID) && rawPub.LINK_CODE ? { owner: recorded, linkId: rawPub.LINK_ID, linkCode: rawPub.LINK_CODE } : null;
if (HOSTED && recordedSite && recordedSite !== SITE) console.log(`this chain's approvals are hosted on ${recordedSite}; moving them to ${SITE} takes a fresh link that the owner signs there`);
let linked: { id: string; code: string } | undefined;
// The steps after the link, in the order fund-agent and grant come, and the slot they must land after.
let then: HostedStep[] | undefined;
let startSlot = 0;
let agentHad = 0n;
if (CAP !== undefined || LAMPORTS !== undefined) {
  then = [];
  if (LAMPORTS !== undefined) then.push({ kind: "fund_agent", solana: { amount_atomic: String(LAMPORTS) } });
  if (CAP !== undefined) {
    // a live delegate is never overwritten silently (grant refuses the same way)
    if (recorded && !newOwner) {
      const acc = await retryRead(() => getAccountOrNull(connection(), getAssociatedTokenAddressSync(USDC_MINT, new PublicKey(recorded)))).catch(() => null);
      if (acc?.delegate && acc.delegatedAmount > 0n) {
        const reason = `a budget is live: the owner on record ${recorded} has delegate ${acc.delegate.toBase58()} with ${formatUnits(acc.delegatedAmount)} USDC left. A grant overwrites it, so it is not asked for here`;
        console.log(`REFUSED: ${reason}. Nothing was requested.`);
        process.exit(result(3, { state: "refused_precheck", reason, owner: recorded, next: "revoke first (superstables budget revoke --rail solana), then superstables budget grant --rail solana --amount A" }));
      }
    }
    then.push({ kind: "grant", solana: { amount_atomic: String(CAP) } });
  }
  try {
    startSlot = await retryRead(() => connection().getSlot("confirmed"));
    agentHad = BigInt(await retryRead(() => connection().getBalance(new PublicKey(agent), "confirmed")));
  } catch (e) {
    const reason = `could not read Solana devnet before asking (${String((e as Error).message).split("\n")[0]}); the transactions could not be checked afterwards`;
    console.log(`REFUSED: ${reason}. Nothing was requested.`);
    process.exit(result(3, { state: "refused_precheck", reason, next: "superstables budget doctor --rail solana checks the RPC; then run the same command again" }));
  }
  console.log(`one link: the owner links this agent, then their Solana wallet ${[LAMPORTS !== undefined ? `sends it ${sol(LAMPORTS)} SOL for fees` : "", CAP !== undefined ? `approves a budget of ${formatUnits(CAP)} USDC` : ""].filter(Boolean).join(", then ")}. Signatures are checked from slot ${startSlot + 1} on.`);
}

let owner: string;
let finish: ((v: { ok: boolean; message: string }) => void) | null = null;
let bundle: { steps: HostedStepOutcome[] } | undefined;
if (OWNER_KEY_FILE) {
  checkOwnerKeyFile(OWNER_KEY_FILE);
  owner = loadOwner(OWNER_KEY_FILE).keypair.publicKey.toBase58();
  console.log(`owner address from --owner-key-file: ${owner}`);
} else if (pub.owner && pub.agent?.toBase58() === agent && !newOwner && !HOSTED) {
  owner = pub.owner.toBase58();
  console.log(`${PUBLIC_PATH} already records owner ${owner} for this agent; not asking again. If this isn't your wallet, stop: superstables budget setup --rail solana --new-owner replaces it`);
} else if (HOSTED) {
  // the owner links this agent on the site with their Solana wallet; that address becomes the owner on record
  const what = [LAMPORTS !== undefined ? "send it SOL for fees" : "", CAP !== undefined ? `approve a budget of ${formatUnits(CAP)} test USDC` : ""].filter(Boolean);
  const r = await askConnect("setup", {
    title: what.length ? `Link this agent${what.length === 2 ? `, ${what[0]} and ${what[1]}` : ` and ${what[0]}`}` : `Link this agent to your ${HOST} account`,
    ...(CAP !== undefined ? { amount: formatUnits(CAP), unit: "USDC" } : LAMPORTS !== undefined ? { amount: sol(LAMPORTS), unit: "SOL" } : {}),
    summary: what.length
      ? [
          `1. Link this agent to your ${HOST} account with your Solana wallet: its address is recorded as the budget owner on this computer.`,
          LAMPORTS !== undefined ? `2. Send ${sol(LAMPORTS)} SOL from your wallet to the agent for fees.` : "",
          CAP !== undefined ? `${LAMPORTS !== undefined ? 3 : 2}. Allow the agent to transfer up to ${formatUnits(CAP)} USDC from your USDC account in total.` : "",
          "Your wallet asks you to sign each transaction in turn.",
        ].filter(Boolean).join(" ")
      : `Sign in to ${HOST}, connect your Solana wallet and link this agent to your account. Your Solana address is recorded as the budget owner on this computer. This does not grant a budget or send a transaction.`,
    rows: [
      { label: "Your agent", value: agent, mono: true },
      { label: "Chain", value: "Solana devnet (testnet)" },
      ...(LAMPORTS !== undefined ? [{ label: "SOL for the agent", value: `a plain transfer of ${sol(LAMPORTS)} SOL` }] : []),
      ...(CAP !== undefined ? [{ label: "Transaction", value: `SPL Token ApproveChecked: delegate ${agent}, ${CAP} (${formatUnits(CAP)} USDC)`, mono: true }] : []),
    ],
    enforced: CAP !== undefined ? [`Transfers or burns under this delegation total at most ${formatUnits(CAP)} USDC.`] : [],
    notEnforced: CAP !== undefined ? ["No expiry. The budget stays until it is spent or you revoke it.", "No seller list. Whoever holds the agent key can transfer to any address, up to the cap."] : [],
    notes: [
      `You pick the match code your agent shows you before anything is linked or sent. The agent key stays on this computer; ${HOST} does not receive it.`,
      ...(what.length ? ["You pay the network fee for each transaction, shown in your wallet. To end the budget at any time: superstables budget revoke --rail solana."] : [`Grants, revokes and SOL for this agent are then approved on ${HOST}, in your Solana wallet.`]),
    ],
  }, "", newOwner ? recorded : undefined, then, { prior, newOwner });
  bundle = r.bundle;
  linked = r.link;
  const outcome = r.outcome;
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved("setup", outcome, { agent, linked: false });
  if (outcome.status !== "connected") throw new Error(`unexpected approval outcome ${outcome.status}`);
  owner = outcome.address;
  console.log(`${HOST} linked this agent to the Solana owner ${owner}`);
  if (recorded && recorded !== owner && !newOwner) {
    await closeOwnerPage(0);
    const sent = bundle?.steps.filter((s) => s.hash).map((s) => `${s.kind} ${s.hash}`) ?? [];
    const reason = `${HOST} linked this agent to ${owner}, but this computer records the owner ${recorded}. Nothing was changed on this computer${sent.length ? `; that wallet reported ${sent.join(", ")}` : ""}`;
    console.log(`REFUSED: ${reason}.`);
    process.exit(result(3, { state: "refused_precheck", reason, owner: recorded, next: `if ${owner} is the right owner: superstables budget setup --rail solana --hosted --new-owner (refused while a budget is live). If not, remove this agent from that account on ${HOST}${sent.length ? ", and check that wallet's activity" : ""}` }));
  }
} else {
  const { handle, outcome } = await askConnect("setup", {
    title: "Connect your wallet",
    summary: "Connect your wallet and sign a message to record its address as the budget owner on this computer. This does not grant a budget or send a transaction.",
    rows: [
      { label: "Your agent", value: agent, mono: true },
      { label: "Agent key", value: `on this computer only, in ${AGENT_KEY_PATH}` },
    ],
    enforced: [],
    notEnforced: [],
    notes: [
      "Signing the message proves control of this address. It grants no spending permission and has no network fee.",
      "You will review and approve any later budget grant separately.",
    ],
  }, `Superstables budget: record this wallet as the owner of agent ${agent} on Solana devnet (testnet).`, newOwner ? recorded : undefined);
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved("setup", outcome, { agent });
  if (outcome.status !== "connected") throw new Error(`unexpected owner page outcome ${outcome.status}`);
  owner = outcome.address;
  finish = handle.finish;
  console.log(`the owner connected ${owner} and signed the sign-in message`);
}
if (owner === agent || (bound && bound !== owner && !newOwner)) {
  const reason = owner === agent ? "the owner address is the agent's address" : `the agent key file is bound to another owner (${bound})`;
  finish?.({ ok: false, message: owner === agent ? "That is the agent's own address. Connect your own wallet instead." : `This agent is already bound to another owner (${bound}). Nothing was changed.` });
  await closeOwnerPage();
  process.exit(result(3, { state: "refused_precheck", reason, ...(owner === agent ? {} : { owner: bound }), next: owner === agent ? "connect the owner's own wallet" : "superstables budget setup --rail solana --new-owner replaces it (refused while a budget is live)" }));
}
const replaced = recorded && recorded !== owner ? recorded : undefined;
if (replaced) console.log(`the recorded owner changed: ${replaced} -> ${owner}`);

// 3. the owner's public address, in the agent file (buy reads it) and the public file. Hosted: APPROVALS and SITE. Asked on
// this computer: neither.
if (bound !== owner) {
  // checked again here, after the wait for the owner: the rewrite below is mode 600 and must not quietly replace a file
  // that other users could read in the meantime
  const text = agentFileTextOrRefuse();
  if (!text.includes("SOLANA_AGENT_SECRET_BASE58=")) {
    const reason = `${AGENT_KEY_PATH} changed while setup waited: it no longer holds the agent key`;
    console.log(`REFUSED: ${reason}. Nothing was changed on this computer.`);
    process.exit(result(3, { state: "refused_precheck", reason, next: `restore ${AGENT_KEY_PATH}, then run setup again` }));
  }
  const lines = text.split("\n").filter((l) => l !== "" && !l.startsWith("SOLANA_OWNER_ADDRESS="));
  replaceKeyFile(AGENT_KEY_PATH, `${[...lines, `SOLANA_OWNER_ADDRESS=${owner}`].join("\n")}\n`); // the only copy of the agent key: never truncated in place
}
const asked = !OWNER_KEY_FILE && !(pub.owner && pub.agent?.toBase58() === agent && !newOwner && !HOSTED);
if (HOSTED && !linked) throw new Error("a hosted link without its id and code");
// hosted: APPROVALS, SITE, and the link the owner signed (LINK_ID, LINK_CODE: a later "already linked" answer is checked
// against them)
writePublic({ SOLANA_OWNER_ADDRESS: owner, SOLANA_AGENT_ADDRESS: agent, ...(HOSTED ? { APPROVALS: "hosted", SITE: SITE!, LINK_ID: linked!.id, LINK_CODE: linked!.code } : {}) }, asked && !HOSTED ? ["APPROVALS", "SITE", "LINK_ID", "LINK_CODE"] : replaced && !HOSTED ? ["LINK_ID", "LINK_CODE"] : []);
console.log(`wrote ${PUBLIC_PATH} (no secret) and the owner's address into ${AGENT_KEY_PATH}.${HOSTED ? ` Owner approvals on this chain: hosted on ${SITE}.` : ""}`);

const conn = connection();
const ownerPk = new PublicKey(owner);
const [ownerSol, agentSol] = await Promise.all([retryRead(() => conn.getBalance(ownerPk, "confirmed")), retryRead(() => conn.getBalance(new PublicKey(agent), "confirmed"))]).catch(() => [null, null]);
const usdc = await retryRead(() => getAccount(conn, getAssociatedTokenAddressSync(USDC_MINT, ownerPk))).then((a) => a.amount, () => 0n);
console.log(`owner ${owner}: SOL ${ownerSol === null ? "unknown" : sol(ownerSol)}, USDC ${formatUnits(usdc)}`);
console.log(`agent ${agent}: SOL ${agentSol === null ? "unknown" : sol(agentSol)}`);

if (then) await finishBundle();

const where = HOSTED || (pub.owner && !newOwner && (parseEnvFile(PUBLIC_PATH) as Record<string, string>).APPROVALS === "hosted") ? `on ${HOST || "the site"}, in your wallet` : "in your wallet";
const steps = [
  `Fund your wallet ${owner} with devnet SOL (faucet.solana.com; at least 0.01) and devnet USDC (faucet.circle.com, Solana devnet; at least 0.05).`,
  `Give the agent SOL for fees: superstables budget fund-agent --rail solana sends 0.01 SOL from your wallet (you approve it ${where}).`,
  "Check everything: superstables budget doctor --rail solana",
  `Grant a budget: superstables budget grant --rail solana --amount 0.05 (you approve it ${where}).`,
];
console.log("\nNext:");
steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
finish?.({ ok: true, message: `Done. The owner on record is now ${owner}. Check that this is your own wallet's address: if it is not, someone else connected, so grant nothing. Agent: ${agent}. You can close this page. Next: fund your wallet with devnet SOL and USDC, give the agent SOL for fees, then grant a budget (the terminal lists the commands).` });
await closeOwnerPage();
process.exit(result(0, { state: "ok", owner, ...(replaced ? { replacedOwner: replaced } : {}), agent, publicFile: PUBLIC_PATH, agentKeyFile: AGENT_KEY_PATH, steps, next: "superstables budget fund-agent --rail solana (SOL for the agent's fees), then superstables budget doctor --rail solana (it says what the owner still needs), then superstables budget grant --rail solana --amount A" }));

/**
 * The steps after the link: each signature the site reports is read from the chain, with fund-agent's and grant's checks.
 * The link is already recorded. Ends the process with one RESULT: ok when every step is on chain as planned, else the
 * state of the first step that is not, with what did happen.
 */
async function finishBundle(): Promise<never> {
  type Report = { kind: string; state: "settled" | "mismatch" | "failed" | "unknown" | "refused_precheck"; tx?: string; txUrl?: string; amount?: string; reason?: string; reasonCode?: string };
  const reports: Report[] = [];
  let remaining: bigint | undefined;
  for (const s of bundle?.steps ?? []) {
    const amount = s.kind === "grant" ? formatUnits(CAP!) : sol(LAMPORTS!);
    if (s.hash) {
      console.log(`${s.kind}: ${HOST} reports ${s.hash} (${s.state}); reading it from the chain`);
      // exactly the instruction fund-agent or grant would build, plus at most a bounded wallet fee
      const ownerPk = new PublicKey(owner);
      const planned = s.kind === "grant"
        ? [createApproveCheckedInstruction(getAssociatedTokenAddressSync(USDC_MINT, ownerPk), USDC_MINT, new PublicKey(agent), ownerPk, CAP!, USDC_DECIMALS)]
        : [SystemProgram.transfer({ fromPubkey: ownerPk, toPubkey: new PublicKey(agent), lamports: LAMPORTS! })];
      const c = await confirmHosted(conn, s.hash, owner, startSlot, planned);
      console.log(`transaction: ${c.status}${c.slot ? `, slot ${c.slot}` : ""}${c.signer ? `, signer ${c.signer}` : ""}`);
      const report = (state: Report["state"], reason?: string) => reports.push({ kind: s.kind, state, tx: s.hash!, txUrl: explorerTx(s.hash!), amount, reason });
      if (c.status === "unknown") { report("unknown", "the site reported a signature the chain does not show yet"); continue; }
      if (c.status !== "success") { report("failed", `it failed on chain (${JSON.stringify(c.err)})`); continue; }
      if (c.problems.length) { report("mismatch", `the transaction on chain is not the one planned: ${c.problems.join("; ")}`); continue; }
      if (s.kind === "fund_agent") {
        const i = c.accountKeys?.indexOf(agent) ?? -1;
        const delta = i >= 0 ? BigInt(c.meta.postBalances[i]) - BigInt(c.meta.preBalances[i]) : null;
        if (delta !== LAMPORTS) { report("mismatch", delta === null ? "the transaction does not touch the agent" : `the transaction moved ${sol(delta)} SOL to the agent, not ${sol(LAMPORTS!)}`); continue; }
        console.log(`agent: +${sol(delta)} SOL (had ${sol(agentHad)})`);
        report("settled");
      } else {
        const ata = getAssociatedTokenAddressSync(USDC_MINT, new PublicKey(owner));
        let after = await retryRead(() => getAccount(conn, ata)).catch(() => null);
        const problems = () => (!after ? ["the owner's USDC account cannot be read"] : [
          !after.delegate?.equals(new PublicKey(agent)) && `the delegate is ${after.delegate?.toBase58() ?? "none"}, not the agent`,
          after.delegatedAmount !== CAP && `the delegated amount is ${formatUnits(after.delegatedAmount)} USDC, not ${formatUnits(CAP!)}`,
        ].filter(Boolean) as string[]);
        for (let i = 0; i < 8 && problems().length; i++) {
          await sleep(2000);
          after = await retryRead(() => getAccount(conn, ata)).catch(() => after);
        }
        if (problems().length) { report("mismatch", `the chain does not show the planned budget: ${problems().join("; ")}`); continue; }
        remaining = after!.delegatedAmount;
        console.log(`delegate ${agent}, delegatedAmount ${formatUnits(remaining)} USDC`);
        report("settled");
      }
    } else if (s.walletAsked || s.state === "unknown") {
      reports.push({ kind: s.kind, state: "unknown", amount, reason: s.reason || "the wallet was asked to sign, but superstables.com reported no signature" });
    } else {
      const why = s.state === "rejected"
        ? s.reasonCode === "cap_above_limit" ? `refused: the budget is above the limit set on the owner's ${HOST} account${s.reason ? ` (${s.reason})` : ""}` : `rejected${s.reason ? `: ${s.reason}` : " by the owner"}`
        : s.state === "skipped" ? "not asked, because an earlier step did not complete"
        : s.state === "expired" ? "not approved before the link expired"
        : s.state === "cancelled" ? "withdrawn on superstables.com when this command stopped waiting, before the owner's wallet was asked"
        : `${s.state}${s.reason ? `: ${s.reason}` : ""}`;
      reports.push({ kind: s.kind, state: "refused_precheck", amount, reason: `nothing was sent: ${why}`, reasonCode: s.reasonCode ?? undefined });
    }
  }
  await closeOwnerPage();
  const name = (k: string) => (k === "grant" ? "budget" : "SOL");
  const done = (r: Report) => (r.kind === "grant" ? `${r.amount} USDC approved` : `${r.amount} SOL sent`);
  for (const r of reports) console.log(`  ${name(r.kind)}: ${r.state === "settled" ? `${done(r)} (${r.tx})` : `${r.state}${r.tx ? ` (${r.tx})` : ""}: ${r.reason}`}`);
  const short = (r: Report) => `${name(r.kind)}: ${r.state === "settled" ? done(r) : r.state === "refused_precheck" ? (r.reason ?? "").slice(0, 120) : `${r.state}, ${(r.reason ?? "").slice(0, 110)}`}`;
  const summary = ["linked: yes", ...reports.map(short)].join("; ");
  const txs = Object.fromEntries(reports.filter((r) => r.tx).map((r) => [r.kind === "grant" ? "grant" : "fundAgent", r.tx]));
  const granted = reports.some((r) => r.kind === "grant" && r.state === "settled");
  const funded = reports.some((r) => r.kind === "fund_agent" && r.state === "settled");
  const base = { owner, agent, linked: true, steps: reports, tx: txs, cap: granted ? formatUnits(CAP!) : undefined, allowance: granted && remaining !== undefined ? formatUnits(remaining) : undefined, sent: funded ? sol(LAMPORTS!) : undefined, publicFile: PUBLIC_PATH, agentKeyFile: AGENT_KEY_PATH };
  const first = reports.find((r) => r.state !== "settled");
  if (!first && reports.length === (then?.length ?? 0)) {
    console.log(`\nDone with one link: the agent is linked${funded ? ", has SOL for fees" : ""}${granted ? ` and has a budget of ${formatUnits(CAP!)} USDC` : ""}.`);
    process.exit(result(0, { state: "ok", ...base, next: granted ? "none: the agent can buy under the budget. superstables budget status --rail solana shows what is left" : "superstables budget grant --rail solana --amount A, only when the owner asks for a budget" }));
  }
  const f = first ?? { kind: "grant", state: "unknown" as const, reason: "superstables.com reported fewer steps than asked for" };
  const later = reports.filter((r) => r.state !== "settled").map((r) => (r.kind === "grant" ? "superstables budget grant --rail solana --amount A" : "superstables budget fund-agent --rail solana")).join(" and ");
  const next = f.state === "unknown"
    ? `superstables budget status --rail solana and the owner's wallet activity: read whether ${f.kind === "grant" ? "the grant" : "the SOL"} landed before running anything again. The agent is linked`
    : f.state === "mismatch"
      ? f.kind === "grant" ? "the chain shows another delegation than planned: the owner revokes it (superstables budget revoke --rail solana); grant again only if the owner asks" : "check the owner's wallet activity, then superstables budget doctor --rail solana"
      : `the agent is linked${funded ? " and has SOL for fees" : ""}. Tell the owner what happened in one reply and end your turn. Later, only if the owner asks: ${later}`;
  process.exit(result(f.state === "unknown" ? 5 : f.state === "failed" ? 1 : 3, { state: f.state, ...base, reason: summary, next }));
}
