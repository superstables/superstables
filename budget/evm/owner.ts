// The owner's side of the evm rail: every owner action goes through the owner's own browser wallet, on the shared owner page
// (../owner-page.ts). This file binds that page to the evm chain and holds the evm reads: readSent, findApproval, the terms.
import { encodeFunctionData, parseEventLogs, type Address, type Hex } from "viem";
import type { OwnerChain } from "../../src/core/signer/owner-approval-server.ts";
import { closeOwnerPage, ownerPageFor } from "../owner-page.ts";
import { CFG, GAS, SYM, USDC, emit, erc20Abi, publicClient, retry, sleep, usdc, gasFmt, allowanceOf, usdcBalance, nativeBalance, readUntil } from "./lib.ts";

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

export const { askConnect, askTransaction, endUnapproved } = ownerPageFor({
  chain: OWNER_CHAIN,
  walletWords: "MetaMask or another",
  statusCommand: `superstables budget status --rail evm${chainFlag}`,
  emit,
});

export type Sent = { hash: Hex; status: "success" | "reverted"; blockNumber: bigint; logs: any[]; problems: string[] };
/**
 * Read a transaction the page reported, from the chain. Every difference from the plan is a problem: another sender,
 * another target, changed data (a wallet that let the owner edit the spending cap), another value, or a transaction
 * mined before this request started. Null when the chain never shows the hash (replaced, dropped or never sent).
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
  const problems: string[] = [];
  if (!same(t.from, want.from)) problems.push(`it was sent from ${t.from}, not the owner ${want.from}`);
  if (!same(t.to, want.to)) problems.push(`it was sent to ${t.to}, not ${want.to}`);
  if (!same(t.input, want.data ?? "0x")) problems.push("the wallet changed the transaction data (for example the spending cap)");
  if (BigInt(t.value) !== (want.value ?? 0n)) problems.push(`it sent a value of ${t.value}, not ${want.value ?? 0n}`);
  if (BigInt(r.blockNumber) <= want.afterBlock) problems.push(`it was mined in block ${r.blockNumber}, before this request started (block ${want.afterBlock})`);
  if (r.status !== "success") problems.push("it reverted on chain");
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

/** The plain words shared by every allowance page. */
export const tokenRow = () => ({ label: "Token", value: `${SYM} ${USDC}`, mono: true });
export const approveRow = (agent: Address, atomic: bigint) => ({ label: "Transaction", value: `${SYM}.approve(${agent}, ${atomic})`, mono: true });
export const capWords = (cap: bigint) => `${usdc(cap)} ${SYM}`;

/** The owner page terms for approve(agent, 0), shared with recover. */
export function revokeTerms(owner: Address, agent: Address, allowance: bigint, held: bigint, title = "end your agent's budget") {
  return {
    title,
    amount: usdc(allowance),
    unit: SYM,
    summary: `This ends your agent's budget: the ${usdc(allowance)} ${SYM} it has left goes to 0. From the block it lands in, the agent can pull nothing more from your wallet.`,
    rows: [
      { label: "Agent", value: agent, mono: true },
      { label: "From your wallet", value: owner, mono: true },
      tokenRow(),
      approveRow(agent, 0n),
    ],
    enforced: ["From that block on, every pull by the agent key fails, even with a stolen key."],
    notEnforced: [
      `${SYM} the agent already pulled and still holds (${usdc(held)} ${SYM} now). superstables budget recover --rail evm${chainFlag} returns it.`,
      "A pull that was mined before this transaction.",
    ],
    notes: ["This costs a small network fee and moves no money. You can grant a new budget later."],
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
  console.log(`the wallet sent ${outcome.hash}; reading it from the chain`);
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
  if (sent.problems.length) console.log(`note: ${sent.problems.join("; ")}`);
  const events = approvalsIn(sent.logs, owner, agent);
  console.log(`receipt: ${sent.status}, block ${sent.blockNumber}, Approval events: ${events.map((v) => usdc(v)).join(", ") || "none"} ${SYM}`);
  const after = await readUntil(() => allowanceOf(owner, agent), (v) => v === 0n);
  if (sent.status !== "success" || after !== 0n) {
    handle.finish({ ok: false, message: `The chain still shows an allowance of ${usdc(after)} ${SYM}. Run the revoke again.`, hash: sent.hash });
    await closeOwnerPage();
    process.exit(emit(command, 1, { state: "not_revoked", tx: sent.hash, allowance: usdc(after), reason: sent.status !== "success" ? "the revoke reverted on chain" : "the allowance still reads above 0", next: "run revoke again" }));
  }
  handle.finish({ ok: true, message: `Done. The chain shows an allowance of 0: your agent can pull nothing more. You can close this page.`, hash: sent.hash });
  await closeOwnerPage();
  return sent.hash;
}

/** Owner sends the agent `value` of the gas token through the wallet page. Returns the verified hash, or exits with a RESULT. */
export async function fundInWallet(command: string, owner: Address, agent: Address, value: bigint, amt: string, agentHas: bigint): Promise<Hex> {
  const startBlock = await publicClient.getBlockNumber();
  const { handle, outcome } = await askTransaction(command === "recover" ? "recover-gas" : "fund-agent", owner, { to: agent, value }, {
    title: "send your agent gas",
    amount: amt,
    unit: GAS.symbol,
    summary: command === "recover"
      ? `Your agent needs a little ${GAS.symbol} to send your ${SYM} back to you. This sends it ${amt} ${GAS.symbol} from your wallet.`
      : `Your agent pays a small ${GAS.symbol} network fee for each purchase. This sends it ${amt} ${GAS.symbol} from your wallet, once.`,
    rows: [
      { label: "To your agent", value: agent, mono: true },
      { label: "From your wallet", value: owner, mono: true },
      { label: "Agent has now", value: `${gasFmt(agentHas)} ${GAS.symbol}` },
      { label: "Transaction", value: `a plain transfer of ${amt} ${GAS.symbol}` },
    ],
    enforced: [],
    notEnforced: [],
    notes: [
      "This is a plain transfer. It gives the agent no budget: you grant that separately, and approve it in your wallet too.",
      `superstables budget recover returns ${SYM} only, not gas. Send the agent only what it needs.`,
    ],
  });
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved(command, outcome);
  if (outcome.status !== "sent") throw new Error(`unexpected owner page outcome ${outcome.status}`);
  console.log(`the wallet sent ${outcome.hash}; reading it from the chain`);
  const sent = await readSent(outcome.hash as Hex, { from: owner, to: agent, value, afterBlock: startBlock });
  if (!sent) {
    handle.finish({ ok: false, message: "The transaction did not show up on chain. Check your wallet's activity.", hash: outcome.hash });
    await closeOwnerPage();
    process.exit(emit(command, 5, { state: "unknown", tx: outcome.hash, reason: "the wallet reported a transaction the chain does not show", next: "superstables budget doctor --rail evm: read the agent's gas" }));
  }
  if (sent.problems.length || sent.status !== "success") {
    const why = sent.problems.join("; ") || "it reverted on chain";
    console.log(`FAILED: ${why}`);
    handle.finish({ ok: false, message: `The chain shows something other than planned: ${why}.`, hash: sent.hash });
    await closeOwnerPage();
    process.exit(emit(command, 1, { state: "failed", tx: sent.hash, reason: why, next: "superstables budget doctor --rail evm" }));
  }
  handle.finish({ ok: true, message: `Done. Your agent received ${amt} ${GAS.symbol}. You can close this page.`, hash: sent.hash });
  await closeOwnerPage();
  return sent.hash;
}
