// The owner's side of the evm rail: every owner action goes through the owner's own browser wallet, on the shared owner page
// (../owner-page.ts). This file binds that page to the evm chain and holds the evm reads: readSent, findApproval, the terms.
// A chain set up with --hosted (APPROVALS=hosted and SITE in its public file) asks through that site instead (../hosted.ts):
// the agent key signs each request, and the site must act for the owner recorded here.
import { encodeFunctionData, parseEventLogs, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_SITE } from "../site.mjs";
import { EVM_CHAINS } from "./chains.mjs";
import type { OwnerChain } from "../../src/core/signer/owner-approval-server.ts";
import { closeOwnerPage, ownerPageFor } from "../owner-page.ts";
import { delegatedCall } from "./delegation.ts";
import { CFG, GAS, SYM, USDC, USDC_DECIMALS, AGENT_ENV, emit, erc20Abi, publicClient, retry, sleep, usdc, gasFmt, allowanceOf, usdcBalance, nativeBalance, readUntil, publicEnv, agentEnv, need } from "./lib.ts";

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
    // the agent key signs each request to the site; it must be the agent this chain's public file names
    const agentKey = need(agentEnv(), "B4_AGENT_KEY", AGENT_ENV) as Hex;
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

export type Sent = { hash: Hex; status: "success" | "reverted"; blockNumber: bigint; logs: any[]; problems: string[] };
/**
 * Read a transaction the page reported, from the chain. Every difference from the plan is a problem: another sender,
 * another target, changed data (a wallet that let the owner edit the spending cap), another value, another chain, or a
 * transaction mined before this request started. Any problem makes the command a mismatch (exit 3, next step revoke),
 * even when the state read afterwards looks right: an edited allowance can be spent down to the planned cap before the
 * readback. `status` says whether it reverted. Null when the chain never shows the hash (replaced, dropped or never sent).
 */
export async function readSent(hash: Hex, want: { from: Address; to: Address; data?: Hex; value?: bigint; afterBlock: bigint }, waitMs = 120_000): Promise<Sent | null> {
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
  const same = (a?: string | null, b?: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  // A smart-account wallet (MetaMask paying the fee) has a relayer send the call through the owner's account: compare
  // the call the owner's account made, not the relayer's envelope. Anything else in the envelope stays a problem.
  const inner = delegatedCall(t, want.from);
  if (inner) console.log(`the wallet sent this through the owner's smart account: ${t.from} sent it to the delegation manager ${t.to}, and the owner's account made the call checked below`);
  const call = inner ? { from: want.from, ...inner } : { from: t.from, to: t.to, data: t.input, value: BigInt(t.value) };
  const problems: string[] = [];
  if (!same(call.from, want.from)) problems.push(`it was sent from ${call.from}, not the owner ${want.from}`);
  if (!same(call.to, want.to)) problems.push(`it was sent to ${call.to}, not ${want.to}`);
  if (!same(call.data, want.data ?? "0x")) problems.push("the wallet changed the transaction data (for example the spending cap)");
  if (call.value !== (want.value ?? 0n)) problems.push(`it sent a value of ${call.value}, not ${want.value ?? 0n}`);
  if (t.chainId !== undefined && t.chainId !== null && Number(t.chainId) !== CFG.chainId) problems.push(`it was signed for chain ${t.chainId}, not ${CFG.label} (${CFG.chainId})`);
  if (BigInt(r.blockNumber) <= want.afterBlock) problems.push(`it was mined in block ${r.blockNumber}, before this request started (block ${want.afterBlock})`);
  await sleep(2500); // public RPC nodes lag a moment behind a block they just served
  return { hash, status: r.status, blockNumber: BigInt(r.blockNumber), logs: r.logs, problems };
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
 * The gas transfer: from the owner, exactly `t` (to, data, value), mined after `afterBlock`, and successful. The agent's
 * balance after it is read for the log (a node may lag a moment behind the receipt).
 */
export async function checkFundSent(hash: Hex, o: { owner: Address; agent: Address; t: { to: Address; data?: Hex; value?: bigint }; value: bigint; agentHad: bigint; afterBlock: bigint }): Promise<SentCheck> {
  const sent = await readSent(hash, { from: o.owner, to: o.t.to, data: o.t.data, value: o.t.value ?? 0n, afterBlock: o.afterBlock });
  if (!sent) return { state: "unknown", tx: hash, reason: "the wallet reported a transaction the chain does not show" };
  if (sent.problems.length || sent.status !== "success") {
    const why = [...sent.problems, ...(sent.status !== "success" ? ["it reverted on chain"] : [])].join("; ");
    const mismatch = sent.status === "success";
    console.log(`${mismatch ? "MISMATCH" : "FAILED"}: ${why}`);
    return { state: mismatch ? "mismatch" : "failed", tx: sent.hash, reason: mismatch ? `the transaction on chain is not the one planned: ${why}` : why };
  }
  const after = await readUntil(() => nativeBalance(o.agent), (v) => v >= o.agentHad + o.value);
  console.log(`agent balance after the transfer: ${gasFmt(after)} ${GAS.symbol}`);
  return { state: "settled", tx: sent.hash, agentGas: after };
}

/**
 * The grant: USDC.approve(agent, cap) from the owner, mined after `afterBlock`, successful, and the allowance on chain
 * exactly `cap` afterwards. A hash the chain never shows (a wallet's "speed up") is looked up as the latest approval since
 * `afterBlock`. Any difference from the plan is a mismatch: the owner revokes it.
 */
export async function checkGrantSent(hash: Hex, o: { owner: Address; agent: Address; cap: bigint; afterBlock: bigint }): Promise<SentCheck> {
  const { to, data } = grantTx(o.agent, o.cap);
  let sent = await readSent(hash, { from: o.owner, to, data, afterBlock: o.afterBlock });
  if (!sent) {
    const alt = await findApproval(o.owner, o.agent, o.afterBlock);
    if (alt) {
      console.log(`the reported transaction is not on chain, but ${alt.hash} approved the agent after this request started; reading that one`);
      sent = await readSent(alt.hash, { from: o.owner, to, data, afterBlock: o.afterBlock });
    }
  }
  if (!sent) return { state: "unknown", tx: hash, reason: "the wallet reported a transaction the chain does not show (replaced, dropped or still pending)" };
  const events = approvalsIn(sent.logs, o.owner, o.agent);
  console.log(`receipt: ${sent.status}, block ${sent.blockNumber}, Approval events: ${events.map((v) => usdc(v)).join(", ") || "none"} ${SYM}`);
  if (sent.status !== "success") return { state: "failed", tx: sent.hash, reason: "the approve reverted on chain" };
  if (sent.problems.length) {
    const reason = `the transaction on chain is not the one planned: ${sent.problems.join("; ")}. The budget was not recorded.`;
    console.log(`MISMATCH: ${reason}`);
    const now = await allowanceOf(o.owner, o.agent).catch(() => undefined);
    return { state: "mismatch", tx: sent.hash, reason, allowance: now };
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

/** Owner approve(agent, 0) through the wallet page. Returns the verified transaction hash, or exits with a RESULT. */
export async function revokeInWallet(command: string, owner: Address, agent: Address, title?: string): Promise<Hex> {
  const before = await allowanceOf(owner, agent);
  const held = await usdcBalance(agent);
  if (!GAS.isUsdc && (await nativeBalance(owner)) === 0n) {
    const reason = `the owner ${owner} has no ${GAS.symbol} to pay the fee for the revoke`;
    console.log(`REFUSED: ${reason}`);
    process.exit(emit(command, 3, { state: "refused_precheck", reason, allowance: usdc(before), next: `fund the owner with ${CFG.label} ${GAS.symbol}, then revoke again` }));
  }
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [agent, 0n] });
  const startBlock = await publicClient.getBlockNumber();
  const { handle, outcome } = await askTransaction(command === "recover" ? "recover-revoke" : "revoke", owner, { to: USDC, data }, revokeTerms(owner, agent, before, held, title));
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved(command, outcome, { allowance: usdc(before) });
  if (outcome.status !== "sent") throw new Error(`unexpected owner page outcome ${outcome.status}`);
  console.log(`the wallet reported transaction ${outcome.hash}; checking it on chain`);
  let sent = await readSent(outcome.hash as Hex, { from: owner, to: USDC, data, afterBlock: startBlock });
  if (!sent) {
    const alt = await findApproval(owner, agent, startBlock);
    if (alt && alt.value === 0n) sent = await readSent(alt.hash, { from: owner, to: USDC, data, afterBlock: startBlock });
  }
  if (!sent) {
    handle.finish({ ok: false, message: "The transaction did not show up on chain. Check your wallet's activity.", hash: outcome.hash });
    await closeOwnerPage();
    process.exit(emit(command, 5, { state: "unknown", tx: outcome.hash, reason: "the wallet reported a transaction the chain does not show (replaced, dropped or still pending)", next: `superstables budget status --rail evm${chainFlag}` }));
  }
  const events = approvalsIn(sent.logs, owner, agent);
  console.log(`receipt: ${sent.status}, block ${sent.blockNumber}, Approval events: ${events.map((v) => usdc(v)).join(", ") || "none"} ${SYM}`);
  if (sent.status === "success" && sent.problems.length) {
    const reason = `the transaction on chain is not the one planned: ${sent.problems.join("; ")}`;
    console.log(`MISMATCH: ${reason}`);
    const now = await allowanceOf(owner, agent).catch(() => null);
    handle.finish({ ok: false, message: `The chain shows a different transaction than planned (${sent.problems.join("; ")}). Check the allowance and revoke again: ${REVOKE_HINT}`, hash: sent.hash });
    await closeOwnerPage();
    process.exit(emit(command, 3, { state: "mismatch", tx: sent.hash, allowance: now === null ? null : usdc(now), reason, next: `revoke again (superstables budget revoke --rail evm${chainFlag}) and check superstables budget status --rail evm${chainFlag}` }));
  }
  const after = await readUntil(() => allowanceOf(owner, agent), (v) => v === 0n);
  if (sent.status !== "success" || after !== 0n) {
    handle.finish({ ok: false, message: `The chain still shows an allowance of ${usdc(after)} ${SYM}. Run the revoke again.`, hash: sent.hash });
    await closeOwnerPage();
    process.exit(emit(command, 1, { state: "not_revoked", tx: sent.hash, allowance: usdc(after), reason: sent.status !== "success" ? "the revoke reverted on chain" : "the allowance still reads above 0", next: "run revoke again" }));
  }
  handle.finish({ ok: true, message: `Confirmed. This allowance is 0. Funds already withdrawn remain under the agent key. You can close this page.`, hash: sent.hash });
  await closeOwnerPage();
  return sent.hash;
}

/**
 * How the owner sends the agent `value` of the gas token. A plain transfer, except where the gas token is the budget token
 * (Arc) and the approval is hosted: there the site takes the token's own transfer(agent, amount), so the command sends that.
 * It moves the same balance: Arc's native balance is the ERC-20 balance in 18 decimals.
 */
export function fundingTx(agent: Address, value: bigint, hosted: boolean): { to: Address; data?: Hex; value?: bigint; words: string } {
  if (!(hosted && GAS.isUsdc)) return { to: agent, value, words: "" };
  const scale = 10n ** BigInt(GAS.decimals - USDC_DECIMALS);
  if (value % scale !== 0n) throw new Error(`on ${CFG.label} a hosted fund-agent sends ${SYM} with at most ${USDC_DECIMALS} decimals`);
  const atomic = value / scale;
  return { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [agent, atomic] }), words: `${SYM}.transfer(${agent}, ${atomic})` };
}

/** Owner sends the agent `value` of the gas token through the wallet page. Returns the verified hash, or exits with a RESULT. */
export async function fundInWallet(command: string, owner: Address, agent: Address, value: bigint, amt: string, agentHas: bigint): Promise<Hex> {
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
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved(command, outcome);
  if (outcome.status !== "sent") throw new Error(`unexpected owner page outcome ${outcome.status}`);
  console.log(`the wallet reported transaction ${outcome.hash}; checking it on chain`);
  const c = await checkFundSent(outcome.hash as Hex, { owner, agent, t, value, agentHad: agentHas, afterBlock: startBlock });
  if (c.state === "unknown") {
    handle.finish({ ok: false, message: "The transaction did not show up on chain. Check your wallet's activity.", hash: outcome.hash });
    await closeOwnerPage();
    process.exit(emit(command, 5, { state: "unknown", tx: outcome.hash, reason: c.reason, next: "superstables budget doctor --rail evm: read the agent's gas" }));
  }
  if (c.state !== "settled") {
    handle.finish({ ok: false, message: `The chain shows something other than planned: ${c.reason!.replace(/^the transaction on chain is not the one planned: /, "")}.`, hash: c.tx });
    await closeOwnerPage();
    process.exit(emit(command, c.state === "mismatch" ? 3 : 1, { state: c.state, tx: c.tx, reason: c.reason, next: "check wallet activity, then superstables budget doctor --rail evm" }));
  }
  handle.finish({ ok: true, message: `Done. Your agent received ${amt} ${GAS.symbol} and now has ${gasFmt(c.agentGas!)} ${GAS.symbol}. You can close this page.`, hash: c.tx });
  await closeOwnerPage();
  return c.tx as Hex;
}
