// A smart-account wallet (MetaMask paying the fee, EIP-7702) sends the owner's call inside a relayer's transaction to
// MetaMask's DelegationManager. delegatedCall finds that call only when the owner's own account makes exactly one call.
// The fixture is the transaction MetaMask sent for a fund-agent of 0.0001 ETH on Base Sepolia:
// 0x4d10d7474ea1d04e06b3d9456bfa32bbc23678822baa0e08b33ff01eae65ccfc.

import { encodeAbiParameters, encodeFunctionData, encodePacked, pad, parseAbi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { DELEGATION_MANAGER, delegatedCall } from "../../budget/evm/delegation.js";

const OWNER = "0x123CB4710126ea6d12d07E861D54fcC51DA265Ee";
const AGENT = "0xb8c8c5f5efdca14a8b76a5f905693ff6b82f4425";
const SPONSORED: Hex = "0xcef6d2090000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000046000000000000000000000000000000000000000000000000000000000000004a00000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000003a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000a11000000000000000000000000123cb4710126ea6d12d07e861d54fcc51da265eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000000000000000000000000000000000000000000000000000000000c02beb0424f0d42fe1e73f641c76b5968a2109c7203b1d7807d724996cf9742c1500000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000010000000000000000000000000004658b29f6b82ed55274221a06fc97d318e25416000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000146713078d39ecc1f5338309c28405ccf85abfbb000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000034b8c8c5f5efdca14a8b76a5f905693ff6b82f442500000000000000000000000000000000000000000000000000005af3107a400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000041e038a2c415794895d06e24b1243f7eace2b1a7c7a51b13c55089fec06479d8712ec79597b90b6ddc5e93047528861df24e34ad3e1f0285788b1f9b5a877220db1b0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000034b8c8c5f5efdca14a8b76a5f905693ff6b82f442500000000000000000000000000000000000000000000000000005af3107a4000000000000000000000000000";

const abi = parseAbi(["function redeemDelegations(bytes[] _permissionContexts, bytes32[] _modes, bytes[] _executionCallDatas)"]);
const delegationsType = [{
  type: "tuple[]",
  components: [
    { name: "delegate", type: "address" }, { name: "delegator", type: "address" }, { name: "authority", type: "bytes32" },
    { name: "caveats", type: "tuple[]", components: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }, { name: "args", type: "bytes" }] },
    { name: "salt", type: "uint256" }, { name: "signature", type: "bytes" },
  ],
}] as const;
const ROOT = `0x${"f".repeat(64)}` as Hex;
const SINGLE = `0x${"0".repeat(64)}` as Hex;
const delegation = (delegator: string, authority: Hex = ROOT) => ({ delegate: "0x0000000000000000000000000000000000000a11" as const, delegator: delegator as Hex, authority, caveats: [], salt: 1n, signature: "0x1234" as Hex });
function redeem(o: { delegations?: ReturnType<typeof delegation>[]; modes?: Hex[]; executions?: Hex[]; contexts?: number } = {}): Hex {
  const ctx = encodeAbiParameters(delegationsType, [o.delegations ?? [delegation(OWNER)]]);
  const executions = o.executions ?? [encodePacked(["address", "uint256", "bytes"], [AGENT, 100n, "0x"])];
  return encodeFunctionData({ abi, args: [Array(o.contexts ?? 1).fill(ctx), o.modes ?? [SINGLE], executions] });
}

describe("a call sent through the owner's smart account", () => {
  it("is the one call MetaMask's sponsored transaction made from the owner's account", () => {
    expect(delegatedCall({ to: DELEGATION_MANAGER.toLowerCase(), input: SPONSORED }, OWNER)).toEqual({ to: AGENT, value: 100_000_000_000_000n, data: "0x" });
  });

  it("keeps the calldata of the inner call, so a changed spending cap is still caught", () => {
    const approve = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: [AGENT, 50_000n] });
    const input = redeem({ executions: [encodePacked(["address", "uint256", "bytes"], ["0x036CbD53842c5426634e7929541eC2318f3dCF7e", 0n, approve])] });
    expect(delegatedCall({ to: DELEGATION_MANAGER, input }, OWNER)?.data).toBe(approve);
  });

  it("is not found for another owner, another contract, or a delegation passed on by someone else", () => {
    expect(delegatedCall({ to: DELEGATION_MANAGER, input: SPONSORED }, AGENT)).toBeNull();
    expect(delegatedCall({ to: AGENT, input: SPONSORED }, OWNER)).toBeNull();
    expect(delegatedCall({ to: DELEGATION_MANAGER, input: redeem({ delegations: [delegation(OWNER, pad("0x01"))] }) }, OWNER)).toBeNull();
    expect(delegatedCall({ to: DELEGATION_MANAGER, input: redeem({ delegations: [delegation(AGENT), delegation(OWNER)] }) }, OWNER)).toBeNull();
  });

  it("is not found when the transaction holds more than one call, or a call that may fail without reverting", () => {
    expect(delegatedCall({ to: DELEGATION_MANAGER, input: redeem({ modes: [pad("0x01", { dir: "right", size: 32 })] }) }, OWNER)).toBeNull();
    expect(delegatedCall({ to: DELEGATION_MANAGER, input: redeem({ modes: [pad("0x0001", { dir: "right", size: 32 })] }) }, OWNER)).toBeNull();
    expect(delegatedCall({ to: DELEGATION_MANAGER, input: redeem({ contexts: 2, modes: [SINGLE, SINGLE], executions: [encodePacked(["address", "uint256", "bytes"], [AGENT, 1n, "0x"]), encodePacked(["address", "uint256", "bytes"], [AGENT, 1n, "0x"])] }) }, OWNER)).toBeNull();
  });

  it("is not found in data that does not decode", () => {
    expect(delegatedCall({ to: DELEGATION_MANAGER, input: "0x" }, OWNER)).toBeNull();
    expect(delegatedCall({ to: DELEGATION_MANAGER, input: SPONSORED.slice(0, 400) as Hex }, OWNER)).toBeNull();
    expect(delegatedCall({ to: DELEGATION_MANAGER, input: redeem({ executions: ["0x1234"] }) }, OWNER)).toBeNull();
  });
});
