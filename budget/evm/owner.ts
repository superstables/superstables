// The owner's side of the evm rail: every owner action goes through the owner's own browser wallet, on the shared owner page
// (../owner-page.ts). This file binds that page to the evm chain and holds the evm reads: readSent, findApproval, the terms.
// A chain set up with --hosted (APPROVALS=hosted and SITE in its public file) asks through that site instead (../hosted.ts):
// the agent key signs each request, and the site must act for the owner recorded here.
import { encodeFunctionData, parseEventLogs, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_SITE, mismatchPage, mismatchReason } from "../site.mjs";
import { EVM_CHAINS } from "./chains.mjs";
import type { OwnerChain } from "../../src/core/signer/owner-approval-server.ts";
import { closeOwnerPage, ownerPageFor } from "../owner-page.ts";
import { ownerEvidence, type EvidenceReads } from "./delegation.ts";
import { CFG, GAS, SYM, USDC, AGENT_ENV, emit, erc20Abi, publicClient, retry, sleep, usdc, gasFmt, allowanceOf, usdcBalance, nativeBalance, readUntil, publicEnv, agentFileValues, need } from "./lib.ts";

export { closeOwnerPage };
export const OWNER_CHAIN: OwnerChain = {
  chainId: CFG.chainId,
  chainName: CFG.label,
  rpcUrl: CFG.rpc,
  explorer: CFG.explorer,
  nativeCurrency: { name: GAS.symbol, symbol: GAS.symbol, decimals: GAS.decimals },
  testnet: true,
};
/** A flag for next-step commands: nothing on the default chain. */
export const chainFlag = CFG.key === "base-sepolia" ? "" : ` --chain ${CFG.key}`;
/** How the owner revokes, in words the page and the logs share. */
export const REVOKE_HINT = `superstables budget revoke --rail evm${chainFlag}. You approve that in your wallet too.`;

/** undefined: read the public file. setup decides for itself (--hosted), before the file says anything. */
let chosenSite: string | null | undefined;
/** setup: hosted on `site`, or null for the page on this computer, whatever the public file says. */
export function useApprovalSite(site: string | null) {
  chosenSite = site;
}
/** The site that hosts this chain's owner approvals, or null for the page on this computer. */
export function approvalSite(): string | null {
  if (chosenSite !== undefined) return chosenSite;
  const p = publicEnv();
  return p.APPROVALS === "hosted" ? p.SITE || DEFAULT_SITE : null;
}

export const { askConnect, askTransaction, endUnapproved } = ownerPageFor({
  chain: OWNER_CHAIN,
  walletWords: "any EVM browser wallet, such as MetaMask, Rabby or Coinbase Wallet",
  statusCommand: `superstables budget status --rail evm${chainFlag}`,
  emit,
  hostedSite: approvalSite,
  hosted: () => {
    const site = approvalSite()!;
    const agentFile = agentFileValues();
    if (agentFile.problem !== undefined) {
      console.log(`REFUSED: ${agentFile.problem}. Nothing was requested.`);
      process.exit(emit("owner", 3, { state: "refused_precheck", reason: agentFile.problem, next: `make ${AGENT_ENV} a regular file only you can read (chmod 600), then run the command again` }));
    }
    // the agent key signs each request to the site; it must be the agent this chain's public file names
    const agentKey = need(agentFile.env, "B4_AGENT_KEY", AGENT_ENV) as Hex;
    const agent = privateKeyToAccount(agentKey).address;
    const recorded = publicEnv().B4_AGENT_ADDRESS;
    if (recorded && recorded.toLowerCase() !== agent.toLowerCase()) {
      const reason = `the agent key in ${AGENT_ENV} is ${agent}, not the agent ${recorded} this chain was set up with`;
      console.log(`REFUSED: ${reason}. Nothing was requested.`);
      process.exit(emit("owner", 3, { state: "refused_precheck", reason, next: "restore the agent key file, or set this chain up again" }));
    }
    return { site, rail: "evm" as const, chain: CFG.key, agentKey };
  },
});

export type Sent = { hash: Hex; status: "success" | "reverted"; blockNumber: bigint; logs: any[]; problems: string[]; unresolved?: string; siteFailed?: string };

/** Code and nonce reads at a block for the delegation evidence: a few tries, then undefined (not known), never a guess. */
const evidenceReads: EvidenceReads = {
  codeAt: (address, block) => retry(() => publicClient.getCode({ address, blockNumber: block }), 3).then((c) => ((c ?? "0x").toLowerCase() as Hex), () => undefined),
  nonceAt: (address, block) => retry(() => publicClient.getTransactionCount({ address, blockNumber: block }), 3).then((n) => Number(n), () => undefined),
};

/**
 * Read a transaction the page reported, from the chain. Every difference from the plan is a problem: another sender,
 * another target, changed data (a wallet that let the owner edit the spending cap), another value, another chain, a
 * transaction mined before this request started, or a receipt without the planned effect (ownerEvidence in delegation.ts).
 * A wallet that sends the step through the owner's smart account counts only through the delegation manager pinned for
 * this chain, with its RedeemedDelegation for this owner and sender. `siteFailed`: the site reported this transaction as
 * failed, in words; it is a problem too, so a step the site reported as failed is never settled here. Any problem makes the
 * command a mismatch (exit 3, next step revoke), even when the state read afterwards looks right: an edited allowance can
 * be spent down to the planned cap before the readback. `unresolved`: no problem was found, but a read the evidence needs
 * did not answer; the command reports unknown. `status` says whether it reverted. Null when the chain never shows the hash
 * (replaced, dropped or never sent).
 */
export async function readSent(hash: Hex, want: { from: Address; to: Address; data?: Hex; value?: bigint; afterBlock: bigint; siteFailed?: string }, waitMs = 120_000): Promise<Sent | null> {
  const until = Date.now() + waitMs;
  let t: any = null;
  while (!t && Date.now() < until) {
    try { t = await publicClient.getTransaction({ hash }); } catch { await sleep(1500); }
  }
  if (!t) return null;
  let r: any = null;
  while (!r && Date.now() < until + 60_000) {
    try { r = await publicClient.getTransactionReceipt({ hash }); } catch { await sleep(1500); }
  }
  if (!r) return null;
  const block = BigInt(r.blockNumber);
  const problems: string[] = [];
  let unresolved: string | undefined;
  // a reverted transaction did nothing: the callers report it as failed, whatever it was
  if (r.status === "success") {
    const e = await ownerEvidence({
      chainKey: CFG.key, chainLabel: CFG.label, chainId: CFG.chainId, token: USDC, owner: want.from,
      want: { to: want.to, data: want.data ?? "0x", value: want.value ?? 0n }, tx: t, block, logs: r.logs,
    }, evidenceReads);
    if (e.via === "delegation") console.log(`the wallet sent this through the owner's smart account: ${t.from} sent it to the delegation manager ${t.to}, for the owner's account to make the call checked below`);
    problems.push(...e.problems);
    unresolved = e.unresolved;
  }
  if (t.chainId !== undefined && t.chainId !== null && Number(t.chainId) !== CFG.chainId) problems.push(`it was signed for chain ${t.chainId}, not ${CFG.label} (${CFG.chainId})`);
  if (block <= want.afterBlock) problems.push(`it was mined in block ${r.blockNumber}, before this request started (block ${want.afterBlock})`);
  if (want.siteFailed) problems.push(want.siteFailed);
  await sleep(2500); // public RPC nodes lag a moment behind a block they just served
  return { hash, status: r.status, blockNumber: block, logs: r.logs, problems, ...(problems.length === 0 && unresolved ? { unresolved } : {}), ...(want.siteFailed ? { siteFailed: want.siteFailed } : {}) };
}

/** The Approval(owner, spender, value) events of this token in a receipt. */
export function approvalsIn(logs: any[], owner: Address, spender: Address): bigint[] {
  return (parseEventLogs({ abi: erc20Abi, logs, eventName: "Approval" }) as any[])
    .filter((l) => l.address.toLowerCase() === USDC.toLowerCase() && l.args.owner.toLowerCase() === owner.toLowerCase() && l.args.spender.toLowerCase() === spender.toLowerCase())
    .map((l) => l.args.value as bigint);
}

/**
 * A wallet's "speed up" or "cancel" replaces the transaction under a new hash, so the reported hash may never land.
 * Find the latest Approval(owner, spender) since `fromBlock` instead (searched in the RPC's log-range windows).
 */
export async function findApproval(owner: Address, spender: Address, fromBlock: bigint): Promise<{ hash: Hex; value: bigint } | null> {
  const head = await retry(() => publicClient.getBlockNumber());
  const step = BigInt(CFG.logRange ?? 1000);
  let found: { hash: Hex; value: bigint } | null = null;
  for (let from = fromBlock + 1n; from <= head; from += step) {
    const to = from + step - 1n < head ? from + step - 1n : head;
    const logs = (await retry(() => publicClient.getLogs({ address: USDC, event: erc20Abi.find((x: any) => x.name === "Approval") as any, args: { owner, spender } as any, fromBlock: from, toBlock: to }))) as any[];
    for (const l of logs) found = { hash: l.transactionHash, value: l.args.value };
  }
  return found;
}

// ---- the grant and the gas, shared by grant (setBudget.ts), fund-agent (fundAgent.ts) and setup --hosted --grant --fund ----

/** USDC.approve(agent, cap): the transaction a grant asks the owner's wallet for. */
export const grantTx = (agent: Address, cap: bigint): { to: Address; data: Hex } => ({ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [agent, cap] }) });

/** What the chain enforces for an evm grant of `cap`, and what it does not: the page's terms. */
export const grantEnforced = (cap: bigint) => [
  `Withdrawals under this allowance total at most ${capWords(cap)}. Spending the allowance does not recover funds already withdrawn.`,
  "Each withdrawal is limited by your token balance at that time. Later deposits can also be withdrawn while allowance remains.",
];
export const GRANT_NOT_ENFORCED = [
  "No expiry. The budget stays until it is spent or you revoke it.",
  "No seller list or purchase requirement. Whoever holds the agent key can withdraw the allowance to any address.",
  "No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it.",
];

/** What fund-agent sends by default on this chain, in the gas token. */
export const DEFAULT_FUND_AMOUNT: string = (EVM_CHAINS as Record<string, any>)[CFG.key].doctor.fundAgent;
/** The amount of gas token to send, in its smallest units: above 0 and at most 5. Throws the words for a bad amount. */
export function fundValue(amt: string): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(amt)) throw new Error(`--amount "${amt}" is not a decimal amount of ${GAS.symbol}`);
  const value = parseUnits(amt, GAS.decimals);
  if (value === 0n || value > parseUnits("5", GAS.decimals)) throw new Error(`--amount must be above 0 and at most 5 ${GAS.symbol}`);
  return value;
}

/** What the chain shows for a transaction the owner's wallet reported, checked against the plan. */
export type SentCheck = { state: "settled" | "mismatch" | "failed" | "unknown"; tx: string; reason?: string; allowance?: bigint; agentGas?: bigint };

/**
 * The gas transfer: the owner's account sent exactly `t` (to, data, value), mined after `afterBlock`, and successful: sent
 * by the owner itself, or through the owner's smart account with the proof readSent asks for. Settled only when the
 * agent's balance then shows the amount on top of what it had; a balance that does not (a lagging node, or the agent
 * spending meanwhile) leaves it unknown. `siteFailed`: the site reported this transaction as failed (never settled here).
 */
export async function checkFundSent(hash: Hex, o: { owner: Address; agent: Address; t: { to: Address; data?: Hex; value?: bigint }; value: bigint; agentHad: bigint; afterBlock: bigint; siteFailed?: string }): Promise<SentCheck> {
  const sent = await readSent(hash, { from: o.owner, to: o.t.to, data: o.t.data, value: o.t.value ?? 0n, afterBlock: o.afterBlock, siteFailed: o.siteFailed });
  if (!sent) return { state: "unknown", tx: hash, reason: "the wallet reported a transaction the chain does not show" };
  if (sent.problems.length || sent.status !== "success") {
    const why = [...sent.problems, ...(sent.status !== "success" ? ["it reverted on chain"] : [])].join("; ");
    const mismatch = sent.status === "success";
    console.log(`${mismatch ? "MISMATCH" : "FAILED"}: ${why}`);
    return { state: mismatch ? "mismatch" : "failed", tx: sent.hash, reason: mismatch ? mismatchReason(sent.problems, sent.siteFailed, sent.hash) : why };
  }
  if (sent.unresolved) {
    console.log(`UNKNOWN: ${sent.unresolved}`);
    return { state: "unknown", tx: sent.hash, reason: `the transaction is on chain, but whether it moved the funds is not known yet: ${sent.unresolved}` };
  }
  const after = await readUntil(() => nativeBalance(o.agent), (v) => v >= o.agentHad + o.value).catch(() => undefined);
  if (after === undefined || after < o.agentHad + o.value) {
    const reason = after === undefined
      ? "the transaction is on chain, but the agent's balance could not be read"
      : `the transaction is on chain, but the agent's balance reads ${gasFmt(after)} ${GAS.symbol}, not at least ${gasFmt(o.agentHad + o.value)} ${GAS.symbol} (the node may lag behind, or the agent spent some meanwhile)`;
    console.log(`UNKNOWN: ${reason}`);
    return { state: "unknown", tx: sent.hash, reason, ...(after === undefined ? {} : { agentGas: after }) };
  }
  console.log(`agent balance after the transfer: ${gasFmt(after)} ${GAS.symbol}`);
  return { state: "settled", tx: sent.hash, agentGas: after };
}

/**
 * The grant: USDC.approve(agent, cap) from the owner, mined after `afterBlock`, successful, and the allowance on chain
 * exactly `cap` afterwards. A hash the chain never shows (a wallet's "speed up") is looked up as the latest approval since
 * `afterBlock`. Any difference from the plan is a mismatch: the owner revokes it.
 */
export async function checkGrantSent(hash: Hex, o: { owner: Address; agent: Address; cap: bigint; afterBlock: bigint; siteFailed?: string }): Promise<SentCheck> {
  const { to, data } = grantTx(o.agent, o.cap);
  let sent = await readSent(hash, { from: o.owner, to, data, afterBlock: o.afterBlock, siteFailed: o.siteFailed });
  if (!sent) {
    const alt = await findApproval(o.owner, o.agent, o.afterBlock);
    if (alt) {
      console.log(`the reported transaction is not on chain, but ${alt.hash} approved the agent after this request started; reading that one`);
      sent = await readSent(alt.hash, { from: o.owner, to, data, afterBlock: o.afterBlock, siteFailed: o.siteFailed });
    }
  }
  if (!sent) return { state: "unknown", tx: hash, reason: "the wallet reported a transaction the chain does not show (replaced, dropped or still pending)" };
  const events = approvalsIn(sent.logs, o.owner, o.agent);
  console.log(`receipt: ${sent.status}, block ${sent.blockNumber}, Approval events: ${events.map((v) => usdc(v)).join(", ") || "none"} ${SYM}`);
  if (sent.status !== "success") return { state: "failed", tx: sent.hash, reason: "the approve reverted on chain" };
  if (sent.problems.length) {
    const reason = `${mismatchReason(sent.problems, sent.siteFailed, sent.hash)}. The budget was not recorded.`;
    console.log(`MISMATCH: ${reason}`);
    const now = await allowanceOf(o.owner, o.agent).catch(() => undefined);
    return { state: "mismatch", tx: sent.hash, reason, allowance: now };
  }
  if (sent.unresolved) {
    console.log(`UNKNOWN: ${sent.unresolved}`);
    return { state: "unknown", tx: sent.hash, reason: `the transaction is on chain, but whether it set the allowance is not known yet: ${sent.unresolved}. The budget was not recorded.` };
  }
  const allowance = await readUntil(() => allowanceOf(o.owner, o.agent), (v) => v === o.cap);
  console.log(`allowance read back: ${usdc(allowance)} ${SYM} (requested ${usdc(o.cap)})`);
  if (allowance !== o.cap) {
    const reason = `the allowance on chain is ${usdc(allowance)} ${SYM}, not the requested cap ${usdc(o.cap)}${allowance > o.cap ? ": the agent can spend MORE than the cap (the spending cap was changed in the wallet, or another amount was approved)" : ""}. The budget was not recorded.`;
    console.log(`REFUSED: ${reason}`);
    return { state: "mismatch", tx: sent.hash, reason, allowance };
  }
  return { state: "settled", tx: sent.hash, allowance };
}

/** The plain words shared by every allowance page. */
export const tokenRow = () => ({ label: "Token", value: `${SYM} ${USDC}`, mono: true });
export const approveRow = (agent: Address, atomic: bigint) => ({ label: "Transaction", value: `${SYM}.approve(${agent}, ${atomic})`, mono: true });
export const capWords = (cap: bigint) => `${usdc(cap)} ${SYM}`;

/** The owner page terms for approve(agent, 0), shared with recover. */
export function revokeTerms(owner: Address, agent: Address, allowance: bigint, held: bigint, title = "Revoke spending permission") {
  return {
    title,
    amount: usdc(allowance),
    unit: SYM,
    summary: `Set this allowance to 0. It currently permits another ${usdc(allowance)} ${SYM} in withdrawals. Once confirmed on chain, this agent can no longer withdraw using this allowance.`,
    rows: [
      { label: "Agent", value: agent, mono: true },
      { label: "From your wallet", value: owner, mono: true },
      tokenRow(),
      approveRow(agent, 0n),
    ],
    enforced: ["Once this revoke takes effect, the agent cannot withdraw more under this allowance, even if its key is stolen."],
    notEnforced: [
      `No return of ${SYM} already withdrawn (${usdc(held)} ${SYM} held by the agent when this request was created). superstables budget recover --rail evm${chainFlag} attempts to return recoverable funds.`,
      "No reversal of withdrawals confirmed before this revoke.",
    ],
    notes: ["This changes spending permission; it does not return funds. You pay the network fee shown in your wallet. You can grant a new budget later."],
  };
}

/**
 * What a multi-step command (recover) completed before this owner step: `result` (its transactions) goes into every RESULT
 * this step ends with, and `done` says it in words, so a later step that fails or expires never reads as "nothing was sent".
 */
export type Earlier = { result: Record<string, unknown>; done?: string; stepTx?: string };
/** `stepTx`: the key this step's own transaction is also reported under (recover: ownerRevokeTx, gasTx), next to the earlier ones. */
const withEarlier = (earlier: Earlier | undefined, o: Record<string, unknown>) =>
  earlier ? { ...earlier.result, ...(earlier.stepTx && o.tx ? { [earlier.stepTx]: o.tx } : {}), ...o, ...(earlier.done ? { next: `${earlier.done}. ${o.next}` } : {}) } : o;

/** Owner approve(agent, 0) through the wallet page. Returns the verified transaction hash, or exits with a RESULT. */
export async function revokeInWallet(command: string, owner: Address, agent: Address, title?: string, earlier?: Earlier): Promise<Hex> {
  const before = await allowanceOf(owner, agent);
  const held = await usdcBalance(agent);
  if (!GAS.isUsdc && (await nativeBalance(owner)) === 0n) {
    const reason = `the owner ${owner} has no ${GAS.symbol} to pay the fee for the revoke`;
    console.log(`REFUSED: ${reason}`);
    process.exit(emit(command, 3, withEarlier(earlier, { state: "refused_precheck", reason, allowance: usdc(before), next: `fund the owner with ${CFG.label} ${GAS.symbol}, then revoke again` })));
  }
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [agent, 0n] });
  const startBlock = await publicClient.getBlockNumber();
  const { handle, outcome } = await askTransaction(command === "recover" ? "recover-revoke" : "revoke", owner, { to: USDC, data }, revokeTerms(owner, agent, before, held, title));
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved(command, outcome, { ...earlier?.result, allowance: usdc(before) }, undefined, earlier?.done);
  if (outcome.status !== "sent") throw new Error(`unexpected owner page outcome ${outcome.status}`);
  console.log(`the wallet reported transaction ${outcome.hash}; checking it on chain`);
  let sent = await readSent(outcome.hash as Hex, { from: owner, to: USDC, data, afterBlock: startBlock, siteFailed: outcome.siteFailed });
  if (!sent) {
    const alt = await findApproval(owner, agent, startBlock);
    if (alt && alt.value === 0n) sent = await readSent(alt.hash, { from: owner, to: USDC, data, afterBlock: startBlock, siteFailed: outcome.siteFailed });
  }
  if (!sent) {
    handle.finish({ ok: false, message: "The transaction did not show up on chain. Check your wallet's activity.", hash: outcome.hash });
    await closeOwnerPage();
    process.exit(emit(command, 5, withEarlier(earlier, { state: "unknown", tx: outcome.hash, reason: "the wallet reported a transaction the chain does not show (replaced, dropped or still pending)", next: `superstables budget status --rail evm${chainFlag}` })));
  }
  const events = approvalsIn(sent.logs, owner, agent);
  console.log(`receipt: ${sent.status}, block ${sent.blockNumber}, Approval events: ${events.map((v) => usdc(v)).join(", ") || "none"} ${SYM}`);
  if (sent.status === "success" && sent.problems.length) {
    const reason = mismatchReason(sent.problems, sent.siteFailed, sent.hash);
    console.log(`MISMATCH: ${reason}`);
    const now = await allowanceOf(owner, agent).catch(() => null);
    handle.finish({ ok: false, message: `${mismatchPage(sent.problems, sent.siteFailed, sent.hash)} Check the allowance and revoke again: ${REVOKE_HINT}`, hash: sent.hash });
    await closeOwnerPage();
    process.exit(emit(command, 3, withEarlier(earlier, { state: "mismatch", tx: sent.hash, allowance: now === null ? null : usdc(now), reason, next: `revoke again (superstables budget revoke --rail evm${chainFlag}) and check superstables budget status --rail evm${chainFlag}` })));
  }
  // Reverted: this transaction set nothing. The allowance may still read 0 (another transaction did it), but this one is
  // never reported as the revoke.
  if (sent.status !== "success") {
    const now = await allowanceOf(owner, agent).catch(() => null);
    const state = now === null ? "could not be read" : now === 0n ? `reads 0, but not because of this transaction` : `still reads ${usdc(now)} ${SYM}`;
    const reason = `the revoke reverted on chain${sent.problems.length ? ` (${sent.problems.join("; ")})` : ""}; the allowance ${state}`;
    console.log(`FAILED: ${reason}`);
    handle.finish({ ok: false, message: `The transaction reverted, so it revoked nothing. The allowance ${state}. ${now === 0n ? "Check that this is what you expect." : "Run the revoke again."}`, hash: sent.hash });
    await closeOwnerPage();
    process.exit(emit(command, 1, withEarlier(earlier, { state: "failed", tx: sent.hash, allowance: now === null ? null : usdc(now), reason, next: now === 0n ? `superstables budget status --rail evm${chainFlag}: the allowance reads 0, set by another transaction` : "run revoke again" })));
  }
  if (sent.status === "success" && sent.unresolved) {
    const reason = `the transaction is on chain, but whether it revoked the allowance is not known yet: ${sent.unresolved}`;
    console.log(`UNKNOWN: ${reason}`);
    handle.finish({ ok: false, message: "The transaction is on chain, but the command could not yet confirm what it did. Check the allowance before relying on it.", hash: sent.hash });
    await closeOwnerPage();
    process.exit(emit(command, 5, withEarlier(earlier, { state: "unknown", tx: sent.hash, reason, next: `superstables budget status --rail evm${chainFlag}: read the allowance before running anything else` })));
  }
  const after = await readUntil(() => allowanceOf(owner, agent), (v) => v === 0n);
  if (after !== 0n) {
    handle.finish({ ok: false, message: `The chain still shows an allowance of ${usdc(after)} ${SYM}. Run the revoke again.`, hash: sent.hash });
    await closeOwnerPage();
    process.exit(emit(command, 1, withEarlier(earlier, { state: "not_revoked", tx: sent.hash, allowance: usdc(after), reason: "the allowance still reads above 0", next: "run revoke again" })));
  }
  handle.finish({ ok: true, message: `Confirmed. This allowance is 0. Funds already withdrawn remain under the agent key. You can close this page.`, hash: sent.hash });
  await closeOwnerPage();
  return sent.hash;
}

/**
 * How the owner sends the agent `value` of the gas token: a plain transfer of the chain's native token, on this computer and
 * on the site alike. On Arc the gas top-up is a plain native USDC transfer: the value in 18 decimals, and no data.
 */
export function fundingTx(agent: Address, value: bigint, _hosted: boolean): { to: Address; data?: Hex; value?: bigint; words: string } {
  return { to: agent, value, words: "" };
}

/** Owner sends the agent `value` of the gas token through the wallet page. Returns the verified hash, or exits with a RESULT. */
export async function fundInWallet(command: string, owner: Address, agent: Address, value: bigint, amt: string, agentHas: bigint, earlier?: Earlier): Promise<Hex> {
  const startBlock = await publicClient.getBlockNumber();
  const action = command === "recover" ? "recover-gas" : "fund-agent";
  // recover's owner steps stay on this computer, so only fund-agent can be hosted
  const t = fundingTx(agent, value, action === "fund-agent" && approvalSite() !== null);
  const { handle, outcome } = await askTransaction(action, owner, { to: t.to, data: t.data, value: t.value }, {
    title: "Send funds for network fees",
    amount: amt,
    unit: GAS.symbol,
    summary: command === "recover"
      ? `Send ${amt} ${GAS.symbol} to the agent so it can pay the network fee to return recoverable ${SYM}. This step does not itself return those funds.`
      : `Send ${amt} ${GAS.symbol} from your wallet to the agent for network fees. You also pay the fee for this transfer, shown in your wallet.`,
    rows: [
      { label: "To your agent", value: agent, mono: true },
      { label: "From your wallet", value: owner, mono: true },
      { label: "Agent balance before this transfer", value: `${gasFmt(agentHas)} ${GAS.symbol}` },
      { label: "Transaction", value: t.words || `a plain transfer of ${amt} ${GAS.symbol}`, mono: !!t.words },
    ],
    enforced: [],
    notEnforced: [],
    notes: [
      "The agent controls the transferred funds and can send them elsewhere. This does not grant permission to withdraw more from your wallet.",
      `superstables budget recover returns recoverable ${SYM}. It leaves a gas reserve on Arc and does not return other gas tokens. Revoking a budget does not undo this transfer.`,
    ],
  });
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved(command, outcome, { ...earlier?.result }, undefined, earlier?.done);
  if (outcome.status !== "sent") throw new Error(`unexpected owner page outcome ${outcome.status}`);
  console.log(`the wallet reported transaction ${outcome.hash}; checking it on chain`);
  const c = await checkFundSent(outcome.hash as Hex, { owner, agent, t, value, agentHad: agentHas, afterBlock: startBlock, siteFailed: outcome.siteFailed });
  if (c.state === "unknown") {
    handle.finish({ ok: false, message: "The command could not confirm this transfer on chain yet. Check your wallet's activity.", hash: outcome.hash });
    await closeOwnerPage();
    process.exit(emit(command, 5, withEarlier(earlier, { state: "unknown", tx: c.tx, reason: c.reason, next: "superstables budget doctor --rail evm: read the agent's gas" })));
  }
  if (c.state !== "settled") {
    // the RESULT's reason, as a sentence for the page: a chain mismatch about the transfer, or the site's verdict as it is
    const prefix = "the transaction was not accepted as the planned step: ";
    handle.finish({ ok: false, message: c.reason!.startsWith(prefix) ? `The transfer was not confirmed as the planned step: ${c.reason!.slice(prefix.length)}.` : `${c.reason}.`, hash: c.tx });
    await closeOwnerPage();
    process.exit(emit(command, c.state === "mismatch" ? 3 : 1, withEarlier(earlier, { state: c.state, tx: c.tx, reason: c.reason, next: "check wallet activity, then superstables budget doctor --rail evm" })));
  }
  handle.finish({ ok: true, message: `Done. Your agent received ${amt} ${GAS.symbol} and now has ${gasFmt(c.agentGas!)} ${GAS.symbol}. You can close this page.`, hash: c.tx });
  await closeOwnerPage();
  return c.tx as Hex;
}
