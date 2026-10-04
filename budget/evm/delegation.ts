// A wallet that runs the owner's account as a smart account does not always send the planned call itself. MetaMask, for
// example, can pay the network fee for the owner ("Paid by MetaMask") once the owner's address is upgraded to its smart
// account (EIP-7702): a relayer then sends DelegationManager.redeemDelegations, and the owner's account makes the call.
// The outer transaction has another sender, another target, other data and no value; the call the owner signed for is
// inside it. delegatedCall finds that call, and only when there is exactly one, made by the owner's own account.
//
// Decoding the call is not enough: anyone can send those bytes to that address. ownerEvidence (below) says whether a mined
// transaction is the owner's planned step, and accepts the delegated form only when all of these hold:
//   - the chain is one where MetaMask's DelegationManager is pinned (DELEGATION_DEPLOYMENTS), and the code at its address
//     in that block hashes to the pinned value;
//   - the receipt has exactly one RedeemedDelegation from the manager, for this owner and this transaction's sender;
//   - the receipt shows the effect for this owner: the token's Approval(owner, spender, amount) for a grant or a revoke,
//     its Transfer(owner, to, amount) for a token top-up. A native top-up leaves no log, so the owner's address must have
//     run MetaMask's pinned implementation during the transaction (codeDuring), which makes exactly the decoded call or
//     reverts the whole transaction.
// A read the chain does not answer leaves the evidence unresolved: the command reports unknown, never settled and never
// a mismatch on that read alone.
// No RPC here: owner.ts passes the reads in, so the tests drive every case with recorded transactions.
import { decodeAbiParameters, decodeFunctionData, keccak256, parseAbi, toEventSelector, type Address, type Hex } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";

/** MetaMask Delegation Framework's DelegationManager (v1.3.0): one address on every chain it is deployed to. */
export const DELEGATION_MANAGER: Address = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
/** MetaMask's EIP-7702 account implementation (EIP7702StatelessDeleGator), which the owner's address points to. */
export const DELEGATOR_IMPLEMENTATION: Address = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";

/**
 * Where a delegated call is accepted: the keccak256 of the manager's and the implementation's runtime code on each chain,
 * read on 3 October 2026. The code embeds the chain id and its EIP-712 domain, so each chain has its own hashes. A chain
 * not listed takes the owner's own transactions only: SKALE Base Sepolia has neither contract, and Ethereum Sepolia was
 * not checked. Tempo Moderato is listed for completeness: its owner steps are plain transactions (../tempo/owner.ts).
 */
export const DELEGATION_DEPLOYMENTS: Record<string, { manager: Hex; implementation: Hex }> = {
  "base-sepolia": { manager: "0xa6f025f7bb23ddc0e2546eec56400672c3dfac88c12963bfeb2b5e1121aeee4a", implementation: "0x83805f9ac7395294043b10c3b7c1839b7e4582a3e693028c36df84978b09d4e2" },
  "arc-testnet": { manager: "0x0384a5a10a4881213244c145d97f7fc4d4ffadcbe070ad5e5f53122f4df119ff", implementation: "0x8a03858f617a287f81741014e6d9244225a57b522bc12a3f2007a865c6baf794" },
  "arbitrum-sepolia": { manager: "0x890f38b0b962c5c171a0bebe053b14e641633b3cecb899f50ad1aec340c12204", implementation: "0x7f8a570cc9ebfd8d4dd86c7cc482bb30e9c669cc281352b131c94291747a58c8" },
  "polygon-amoy": { manager: "0x7f2a1a757879e5030b657f8d05823b96c75dfeb46633101e4d827ec2d346620c", implementation: "0xddc1c1b0583d57f3937d04c7bdacfaecb699d8aa27ee00040ab2c7b656ed239b" },
  moderato: { manager: "0x02e62098c4ad8843a4e80427a6f3fb586673e25245b8214547b3fd5dca6bc981", implementation: "0x18ca952e6ac1c28e535ab18e8403c9e3fcb4e7ecf7eaf4f3bf451c18f51af7d4" },
};

/** The code an EIP-7702 account carries when it points to MetaMask's implementation. */
export const DELEGATED_TO_METAMASK = `0xef0100${DELEGATOR_IMPLEMENTATION.slice(2).toLowerCase()}`;
/** RedeemedDelegation(address indexed rootDelegator, address indexed redeemer, Delegation delegation), from the manager. */
export const REDEEMED_DELEGATION = toEventSelector("RedeemedDelegation(address,address,(address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))");
const APPROVAL = toEventSelector("Approval(address,address,uint256)");
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
/** The authority of a delegation the delegator signed itself (not one passed on by another delegate). */
const ROOT_AUTHORITY = `0x${"f".repeat(64)}`;
/** ERC-7579 mode: one call, and the whole transaction reverts if that call fails. */
const SINGLE_CALL_REVERTING = `0x${"0".repeat(64)}`;

const managerAbi = parseAbi(["function redeemDelegations(bytes[] _permissionContexts, bytes32[] _modes, bytes[] _executionCallDatas)"]);
const delegationsType = [{
  type: "tuple[]",
  components: [
    { name: "delegate", type: "address" },
    { name: "delegator", type: "address" },
    { name: "authority", type: "bytes32" },
    { name: "caveats", type: "tuple[]", components: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }, { name: "args", type: "bytes" }] },
    { name: "salt", type: "uint256" },
    { name: "signature", type: "bytes" },
  ],
}] as const;

export type Call = { to: Address; value: bigint; data: Hex };

const same = (a?: string | null, b?: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * The one call `owner`'s account makes in this transaction through the DelegationManager, or null when the transaction is
 * anything else: another contract, more than one call or delegation, a batch, a call that may fail without reverting, or
 * a delegation the owner did not sign itself. This only decodes: ownerEvidence decides whether the call happened.
 */
export function delegatedCall(t: { to?: string | null; input: Hex }, owner: string): Call | null {
  if ((t.to ?? "").toLowerCase() !== DELEGATION_MANAGER.toLowerCase()) return null;
  try {
    const { functionName, args } = decodeFunctionData({ abi: managerAbi, data: t.input });
    if (functionName !== "redeemDelegations") return null;
    const [contexts, modes, executions] = args;
    if (contexts.length !== 1 || modes.length !== 1 || executions.length !== 1) return null;
    if (modes[0].toLowerCase() !== SINGLE_CALL_REVERTING) return null;
    const [delegations] = decodeAbiParameters(delegationsType, contexts[0]);
    if (delegations.length !== 1) return null;
    const d = delegations[0];
    if (d.delegator.toLowerCase() !== owner.toLowerCase() || d.authority.toLowerCase() !== ROOT_AUTHORITY) return null;
    // ERC-7579 single call: target (20 bytes), value (32 bytes), then the calldata
    const packed = executions[0];
    if (packed.length < 2 + 2 * 52) return null;
    return {
      to: `0x${packed.slice(2, 42)}` as Address,
      value: BigInt(`0x${packed.slice(42, 106)}`),
      data: `0x${packed.slice(106)}` as Hex,
    };
  } catch {
    return null;
  }
}

export type Log = { address: string; topics: readonly (string | null)[]; data: string };

const word = (address: string) => `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const logsOf = (logs: readonly Log[], emitter: string, topic0: string, a: string, b: string) =>
  logs.filter((l) => same(l.address, emitter) && same(l.topics[0], topic0) && same(l.topics[1], word(a)) && same(l.topics[2], word(b)));
const amountOf = (data: string) => {
  try {
    return BigInt(data === "0x" ? "0x0" : data.slice(0, 66));
  } catch {
    return -1n;
  }
};

/**
 * What the receipt must show the planned call did, for `owner`: null when it shows it, "native" for a native transfer
 * (no log to read), else why not. approve(spender, amount) on the token: the token's last Approval(owner, spender) in the
 * transaction (the allowance it left) is `amount`. transfer(to, amount) on the token: a Transfer(owner, to, amount) from it.
 */
export function effectProblem(logs: readonly Log[], token: string, owner: string, want: Call): string | null | "native" {
  if (want.data === "0x" && want.value > 0n) return "native";
  const m = /^0x(095ea7b3|a9059cbb)000000000000000000000000([0-9a-f]{40})([0-9a-f]{64})$/.exec(want.data.toLowerCase());
  if (!m || !same(want.to, token) || want.value !== 0n) return "it is not a call this command can check";
  const [, selector, to, amountHex] = m;
  const amount = BigInt(`0x${amountHex}`);
  if (selector === "095ea7b3") {
    const last = logsOf(logs, token, APPROVAL, owner, `0x${to}`).at(-1);
    if (!last) return "its receipt has no Approval from the owner to this spender";
    return amountOf(last.data) === amount ? null : `its receipt's Approval from the owner to this spender is for ${amountOf(last.data)}, not ${amount}`;
  }
  return logsOf(logs, token, TRANSFER, owner, `0x${to}`).some((l) => amountOf(l.data) === amount) ? null : "its receipt has no Transfer of this amount from the owner";
}

/** Why the receipt is not the manager's own record that `sender` redeemed one delegation `owner` signed, or null. */
export function redeemedProblem(logs: readonly Log[], owner: string, sender: string): string | null {
  const found = logs.filter((l) => same(l.address, DELEGATION_MANAGER) && same(l.topics[0], REDEEMED_DELEGATION));
  if (found.length === 0) return "its receipt has no RedeemedDelegation from the delegation manager";
  if (found.length > 1) return `its receipt has ${found.length} RedeemedDelegation events, not one`;
  if (!same(found[0].topics[1], word(owner))) return "its RedeemedDelegation is for another delegator than the owner";
  if (!same(found[0].topics[2], word(sender))) return "its RedeemedDelegation names another redeemer than the transaction's sender";
  return null;
}

/** secp256k1's group order: EIP-7702 skips an authorization whose s is above half of it. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The signature checks EIP-7702 makes before it recovers an authorization's signer. */
export function validSignature(a: { r: string; s: string; yParity?: number; nonce: number | bigint }): boolean {
  try {
    const r = BigInt(a.r);
    const s = BigInt(a.s);
    return r > 0n && r < SECP256K1_N && s > 0n && s <= SECP256K1_N / 2n && (a.yParity === 0 || a.yParity === 1) && BigInt(a.nonce) < 2n ** 64n - 1n;
  } catch {
    return false;
  }
}

/** An EIP-7702 authorization as viem formats it, and who signed it: null when the chain would skip it for its signature. */
export type Authorization = { address: string; chainId: number; nonce: number; r: Hex; s: Hex; yParity?: number };
export async function authorityOf(a: Authorization): Promise<string | null> {
  if (!validSignature(a)) return null;
  return recoverAuthorizationAddress({ authorization: a as any }).catch(() => null);
}

/**
 * The code the owner's address ran during this transaction, from what the chain shows without a trace: its code and nonce
 * before the block (N-1) and after it (N), and the authorizations the owner signed in this transaction. Every EIP-7702
 * authorization that applies bumps the owner's nonce, so:
 *   - the nonce did not move in the block, and the transaction carries no authorization by the owner: nothing changed the
 *     code; it ran the code it had before;
 *   - the nonce moved by one, and the transaction carries exactly one authorization by the owner, for this chain (or any
 *     chain) and that nonce, and the code after the block is that authorization's: that was the one change in the block,
 *     and it applied before the call (MetaMask's first sponsored transaction upgrades the address this way);
 *   - anything else: undefined (not known).
 * An authorization to the zero address clears the code.
 */
export function codeDuring(
  authorities: readonly { address: string; chainId: number; nonce: number; authority: string | null }[],
  owner: string,
  chainId: number,
  state: { codeBefore: string; codeAfter: string; nonceBefore: number; nonceAfter: number },
): string | undefined {
  const own = authorities.filter((a) => same(a.authority, owner));
  if (state.nonceAfter === state.nonceBefore) return own.length === 0 && same(state.codeBefore, state.codeAfter) ? state.codeBefore.toLowerCase() : undefined;
  if (state.nonceAfter !== state.nonceBefore + 1 || own.length !== 1) return undefined;
  const a = own[0];
  if ((a.chainId !== 0 && a.chainId !== chainId) || a.nonce !== state.nonceBefore) return undefined;
  const code = /^0x0{40}$/i.test(a.address) ? "0x" : `0xef0100${a.address.slice(2).toLowerCase()}`;
  return same(code, state.codeAfter) ? code : undefined;
}

/** Chain reads at a block. undefined: the chain did not answer (the evidence stays unresolved). Code is "0x" for none. */
export type EvidenceReads = {
  codeAt(address: Address, block: bigint): Promise<Hex | undefined>;
  nonceAt(address: Address, block: bigint): Promise<number | undefined>;
};

export type MinedTx = { from: Address; to?: Address | null; input: Hex; value: bigint; authorizationList?: readonly Authorization[] };

/**
 * Whether a mined, successful transaction is `owner`'s planned call `want`, with its effect. `call` is the call compared with
 * the plan (the owner's account's call inside a delegation, else the transaction itself); `problems` are definite
 * differences (a mismatch); `unresolved` says which read the chain did not answer, when nothing definite was found.
 */
export async function ownerEvidence(
  x: { chainKey: string; chainLabel: string; chainId: number; token: Address; owner: Address; want: Call; tx: MinedTx; block: bigint; logs: readonly Log[] },
  reads: EvidenceReads,
): Promise<{ via: "direct" | "delegation"; call: { from: string; to?: string | null; data: Hex; value: bigint }; problems: string[]; unresolved?: string }> {
  const { tx, owner, want } = x;
  const inner = delegatedCall(tx, owner);
  const via = inner ? "delegation" : "direct";
  const call = inner ? { from: owner as string, ...inner } : { from: tx.from as string, to: tx.to, data: tx.input, value: tx.value };
  const problems: string[] = [];
  if (!same(call.from, owner)) problems.push(`it was sent from ${call.from}, not the owner ${owner}`);
  if (!same(call.to, want.to)) problems.push(`it was sent to ${call.to}, not ${want.to}`);
  if (!same(call.data, want.data)) problems.push("the wallet changed the transaction data (for example the spending cap)");
  if (call.value !== want.value) problems.push(`it sent a value of ${call.value}, not ${want.value}`);
  if (problems.length) return { via, call, problems };
  const effect = effectProblem(x.logs, x.token, owner, want);
  if (effect && effect !== "native") problems.push(effect);
  if (!inner) return { via, call, problems };

  // Through a delegation: only the pinned manager, with its own record of this redemption.
  const pinned = DELEGATION_DEPLOYMENTS[x.chainKey];
  if (!pinned) return { via, call, problems: [...problems, `it went through a delegation manager, which is not accepted on ${x.chainLabel}: the owner's wallet sends the transaction itself there`] };
  const redeemed = redeemedProblem(x.logs, owner, tx.from);
  if (redeemed) problems.push(redeemed);
  if (problems.length) return { via, call, problems };
  const hash = (code: Hex | undefined) => (code === undefined ? undefined : code === "0x" ? "0x" : keccak256(code));
  const manager = hash(await reads.codeAt(DELEGATION_MANAGER, x.block));
  if (manager === undefined) return { via, call, problems, unresolved: "the delegation manager's code could not be read" };
  if (manager !== pinned.manager) return { via, call, problems: [manager === "0x" ? "there is no delegation manager at that address on this chain" : "the delegation manager's code is not the known one"] };
  if (effect !== "native") return { via, call, problems };

  // A native top-up leaves no log: the owner's account must have run MetaMask's implementation in this transaction.
  const [codeBefore, codeAfter, nonceBefore, nonceAfter, implementation] = await Promise.all([
    reads.codeAt(owner, x.block - 1n),
    reads.codeAt(owner, x.block),
    reads.nonceAt(owner, x.block - 1n),
    reads.nonceAt(owner, x.block),
    reads.codeAt(DELEGATOR_IMPLEMENTATION, x.block).then(hash),
  ]);
  if (codeBefore === undefined || codeAfter === undefined || nonceBefore === undefined || nonceAfter === undefined || implementation === undefined) {
    return { via, call, problems, unresolved: "the owner's account code and nonce around that block could not be read" };
  }
  if (implementation !== pinned.implementation) return { via, call, problems: ["MetaMask's smart account implementation on this chain is not the known code"] };
  const authorities = await Promise.all((tx.authorizationList ?? []).map(async (a) => ({ address: a.address, chainId: a.chainId, nonce: a.nonce, authority: await authorityOf(a) })));
  const during = codeDuring(authorities, owner, x.chainId, { codeBefore, codeAfter, nonceBefore, nonceAfter });
  if (during === undefined) return { via, call, problems, unresolved: "the owner's account changed in that block in a way the chain cannot show without a trace" };
  if (during !== DELEGATED_TO_METAMASK) return { via, call, problems: ["the owner's account was not MetaMask's smart account in that transaction, so the transfer inside it cannot be confirmed"] };
  return { via, call, problems };
}
