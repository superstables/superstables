// A wallet that runs the owner's account as a smart account does not always send the planned call itself. MetaMask, for
// example, can pay the network fee for the owner ("Paid by MetaMask") once the owner's address is upgraded to its smart
// account (EIP-7702): a relayer then sends DelegationManager.redeemDelegations, and the owner's account makes the call.
// The outer transaction has another sender, another target, other data and no value; the call the owner signed for is
// inside it. delegatedCall finds that call, and only when there is exactly one, made by the owner's own account.
// Pure: no RPC, no files, so the evm owner reads (owner.ts) and the tests share it.
import { decodeAbiParameters, decodeFunctionData, parseAbi, type Address, type Hex } from "viem";

/** MetaMask Delegation Framework's DelegationManager: one address on every chain it is deployed to. */
export const DELEGATION_MANAGER: Address = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
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

/**
 * The one call `owner`'s account makes in this transaction through the DelegationManager, or null when the transaction is
 * anything else: another contract, more than one call or delegation, a batch, a call that may fail without reverting, or
 * a delegation the owner did not sign itself. The manager checks the owner's signature on the delegation; the caller still
 * compares the call with the plan and reads the receipt.
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
