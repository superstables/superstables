// A smart-account wallet (MetaMask paying the fee, EIP-7702) sends the owner's call inside a relayer's transaction to
// MetaMask's DelegationManager. delegatedCall finds that call only when the owner's own account makes exactly one call.
// The fixture is the transaction MetaMask sent for a fund-agent of 0.0001 ETH on Base Sepolia:
// 0x4d10d7474ea1d04e06b3d9456bfa32bbc23678822baa0e08b33ff01eae65ccfc.

import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeFunctionData, encodePacked, formatTransaction, formatTransactionReceipt, keccak256, pad, parseAbi, toEventSelector, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  DELEGATED_TO_METAMASK, DELEGATION_DEPLOYMENTS, DELEGATION_MANAGER, DELEGATOR_IMPLEMENTATION, REDEEMED_DELEGATION, authorityOf, codeDuring, delegatedCall,
  effectProblem, ownerEvidence, validSignature, type Authorization, type Call, type EvidenceReads,
} from "../../budget/evm/delegation.js";

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

// ── what makes a decoded call count ──────────────────────────────────────────────────────────────────────────────────
// Recorded on Base Sepolia on 3 October 2026 (test/budget/fixtures/): MetaMask's sponsored top-ups (the first one upgrades
// the owner's address with an EIP-7702 authorization in the same transaction), grant and revoke, and the same three sent
// by the owner directly, with the manager's and the implementation's code and the owner's code and nonce around each
// top-up block. Each case below changes one thing and must stop the transaction from counting.

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const CODE = fixture("base-delegation-code") as { manager: Hex; executor: Hex };
const REC_OWNER = "0x37DeDeEa845A7772BD4decfe573EaaBf660ad537" as const;
const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const SKALE_USDC = "0x2e08028E3C4c2356572E096d8EF835cD5C6030bD" as const;
const RELAYER = "0x3333333333333333333333333333333333333333" as const;
const FUND_AGENT = "0x5A7E31B9ab6D47Ca3F195Ff737ffe6105bAe3FEd" as const; // base-sponsored-fund
const FIRST_FUND_AGENT = "0x7fc2aE5b9739FA788D11f3Bb07a67D6b80445999" as const; // base-sponsored-fund-2, grant, revoke
const DIRECT_AGENT = "0xcef1fac5270ad5f173e8c38f6034c27d93ff04a2" as const; // base-direct-*
const GAS_TOPUP = 100_000_000_000_000n;
const CAP = 20_000n;
const approveData = (spender: string, value: bigint) => encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: [spender as Hex, value] });
const transferData = (to: string, value: bigint) => encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), args: [to as Hex, value] });
const plan = {
  gas: (agent: string): Call => ({ to: agent as Hex, value: GAS_TOPUP, data: "0x" }),
  approve: (agent: string, value: bigint, token: Hex = BASE_USDC): Call => ({ to: token, value: 0n, data: approveData(agent, value) }),
};
const word = (a: string) => pad(a.toLowerCase() as Hex);
const approvalLog = (token: string, owner: string, spender: string, value: bigint) => ({ address: token, topics: [toEventSelector("Approval(address,address,uint256)"), word(owner), word(spender)], data: pad(`0x${value.toString(16)}`) });
const transferLog = (token: string, from: string, to: string, value: bigint) => ({ address: token, topics: [toEventSelector("Transfer(address,address,uint256)"), word(from), word(to)], data: pad(`0x${value.toString(16)}`) });
const redeemedLog = (owner: string, sender: string, emitter: string = DELEGATION_MANAGER) => ({ address: emitter, topics: [REDEEMED_DELEGATION, word(owner), word(sender)], data: "0x" });

type OwnerState = { codeBefore: Hex; codeAfter: Hex; nonceBefore: number; nonceAfter: number };
/**
 * The chain's answers, from the recordings unless a case replaces one. A value of undefined is a read the chain did not
 * answer; `calls` counts the reads.
 */
function chainReads(block: bigint, o: { manager?: Hex | undefined; implementation?: Hex | undefined; owner?: Partial<Record<keyof OwnerState, Hex | number | undefined>> & Partial<OwnerState> } = {}) {
  const calls: string[] = [];
  const pick = <T,>(k: string, obj: object | undefined, dflt: T): T => (obj && k in obj ? (obj as any)[k] : dflt);
  const reads: EvidenceReads = {
    codeAt: async (address, at) => {
      calls.push(`code ${address} ${at}`);
      if (same(address, DELEGATION_MANAGER)) return pick("manager", o, CODE.manager);
      if (same(address, DELEGATOR_IMPLEMENTATION)) return pick("implementation", o, CODE.executor);
      if (same(address, REC_OWNER)) return at === block - 1n ? pick("codeBefore", o.owner, DELEGATED_TO_METAMASK as Hex) : pick("codeAfter", o.owner, DELEGATED_TO_METAMASK as Hex);
      return "0x";
    },
    nonceAt: async (address, at) => {
      calls.push(`nonce ${address} ${at}`);
      return at === block - 1n ? pick("nonceBefore", o.owner, 1) : pick("nonceAfter", o.owner, 1);
    },
  };
  return { reads, calls };
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A recorded transaction, as viem's client returns it, and what the client makes of it. */
function recordedTx(name: string) {
  const f = fixture(name);
  return { f, tx: formatTransaction(f.tx) as any, receipt: formatTransactionReceipt(f.receipt) as any };
}
async function judge(name: string, want: Call, o: Parameters<typeof chainReads>[1] & { chainKey?: string; token?: Hex; logs?: any[]; tx?: object; ownerState?: OwnerState } = {}) {
  const { f, tx, receipt } = recordedTx(name);
  const state = o.ownerState ?? (f.owner ? { codeBefore: f.owner.codeBefore, codeAfter: f.owner.codeAfter, nonceBefore: Number(f.owner.nonceBefore), nonceAfter: Number(f.owner.nonceAfter) } : undefined);
  const { reads, calls } = chainReads(receipt.blockNumber, { ...o, owner: { ...state, ...o.owner } });
  const chainKey = o.chainKey ?? "base-sepolia";
  const e = await ownerEvidence({ chainKey, chainLabel: chainKey, chainId: 84532, token: o.token ?? BASE_USDC, owner: REC_OWNER, want, tx: { ...tx, ...o.tx }, block: receipt.blockNumber, logs: o.logs ?? receipt.logs }, reads);
  return { ...e, calls, receipt, tx };
}

describe("the recordings: the pinned code and event are the ones the chain has", () => {
  it("the manager's and the implementation's code hash to Base Sepolia's pinned values; the event topic is RedeemedDelegation's", () => {
    expect(keccak256(CODE.manager)).toBe(DELEGATION_DEPLOYMENTS["base-sepolia"].manager);
    expect(keccak256(CODE.executor)).toBe(DELEGATION_DEPLOYMENTS["base-sepolia"].implementation);
    expect(REDEEMED_DELEGATION).toBe("0x40dadaa36c6c2e3d7317e24757451ffb2d603d875f0ad5e92c5dd156573b1873");
    expect(Object.keys(DELEGATION_DEPLOYMENTS).sort()).toEqual(["arbitrum-sepolia", "arc-testnet", "base-sepolia", "moderato", "polygon-amoy"]);
  });
});

describe("MetaMask's sponsored transactions count, with the manager's code, its event and the effect", () => {
  it("a gas top-up: the owner's account ran MetaMask's implementation (code and nonce unchanged around the block)", async () => {
    const e = await judge("base-sponsored-fund", plan.gas(FUND_AGENT));
    expect(e).toMatchObject({ via: "delegation", problems: [] });
    expect(e.unresolved).toBeUndefined();
    expect(e.tx.from.toLowerCase()).not.toBe(REC_OWNER.toLowerCase()); // the relayer sent it
  });

  it("the first sponsored top-up: the owner's own authorization in the same transaction upgraded the address", async () => {
    const e = await judge("base-sponsored-fund-2", plan.gas(FIRST_FUND_AGENT));
    expect(e).toMatchObject({ via: "delegation", problems: [] });
    expect(e.unresolved).toBeUndefined();
    expect(fixture("base-sponsored-fund-2").owner).toMatchObject({ codeBefore: "0x", nonceBefore: "0x0", nonceAfter: "0x1" });
  });

  it("a grant and a revoke, each with Approval(owner, agent, amount) from the token", async () => {
    for (const [name, value] of [["base-sponsored-grant", CAP], ["base-sponsored-revoke", 0n]] as const) {
      const e = await judge(name, plan.approve(FIRST_FUND_AGENT, value));
      expect(e, name).toMatchObject({ via: "delegation", problems: [] });
      expect(e.unresolved, name).toBeUndefined();
      // the owner's code is not read for a step that leaves a log
      expect(e.calls.some((c) => c.includes(REC_OWNER)), name).toBe(false);
    }
  });

  it("the owner's own transactions count on any chain, without any code read", async () => {
    for (const [name, want] of [["base-direct-fund", plan.gas(DIRECT_AGENT)], ["base-direct-grant", plan.approve(DIRECT_AGENT, CAP)], ["base-direct-revoke", plan.approve(DIRECT_AGENT, 0n)]] as const) {
      for (const chainKey of ["base-sepolia", "skale-base-sepolia", "ethereum-sepolia"]) {
        const e = await judge(name, want, { chainKey });
        expect(e, `${name} on ${chainKey}`).toMatchObject({ via: "direct", problems: [] });
        expect(e.calls).toEqual([]);
      }
    }
  });
});

describe("a delegation counts only on a chain where the manager is pinned", () => {
  it("SKALE Base Sepolia, Ethereum Sepolia and any chain not listed refuse it, even with every log in place", async () => {
    for (const chainKey of ["skale-base-sepolia", "ethereum-sepolia", "some-new-chain"]) {
      const e = await judge("base-sponsored-grant", plan.approve(FIRST_FUND_AGENT, CAP), { chainKey });
      expect(e.problems.join(), chainKey).toMatch(/went through a delegation manager, which is not accepted on/);
      expect(e.calls, chainKey).toEqual([]);
    }
  });
});

describe("the manager's code", () => {
  it("no code at the manager's address, or other code: refused", async () => {
    expect((await judge("base-sponsored-grant", plan.approve(FIRST_FUND_AGENT, CAP), { manager: "0x" })).problems).toEqual(["there is no delegation manager at that address on this chain"]);
    expect((await judge("base-sponsored-grant", plan.approve(FIRST_FUND_AGENT, CAP), { manager: CODE.executor })).problems).toEqual(["the delegation manager's code is not the known one"]);
    // another chain's pinned manager is not this chain's
    expect((await judge("base-sponsored-fund", plan.gas(FUND_AGENT), { chainKey: "arc-testnet" })).problems).toEqual(["the delegation manager's code is not the known one"]);
  });

  it("is read at the receipt's block", async () => {
    const e = await judge("base-sponsored-grant", plan.approve(FIRST_FUND_AGENT, CAP));
    expect(e.calls).toEqual([`code ${DELEGATION_MANAGER} ${e.receipt.blockNumber}`]);
  });

  it("a read the chain does not answer: unresolved (unknown), never a problem", async () => {
    const e = await judge("base-sponsored-grant", plan.approve(FIRST_FUND_AGENT, CAP), { manager: undefined });
    expect(e.problems).toEqual([]);
    expect(e.unresolved).toBe("the delegation manager's code could not be read");
  });
});

describe("the manager's RedeemedDelegation event", () => {
  const grant = plan.approve(FIRST_FUND_AGENT, CAP);
  const logs = () => recordedTx("base-sponsored-grant").receipt.logs as any[];
  const without = () => logs().filter((l) => l.topics[0] !== REDEEMED_DELEGATION);
  const sender = () => recordedTx("base-sponsored-grant").tx.from as string;

  it("missing: refused", async () => {
    expect((await judge("base-sponsored-grant", grant, { logs: without() })).problems).toEqual(["its receipt has no RedeemedDelegation from the delegation manager"]);
  });
  it("two of them: refused", async () => {
    expect((await judge("base-sponsored-grant", grant, { logs: [...logs(), redeemedLog(REC_OWNER, sender())] })).problems).toEqual(["its receipt has 2 RedeemedDelegation events, not one"]);
  });
  it("emitted by another contract: does not count", async () => {
    expect((await judge("base-sponsored-grant", grant, { logs: [...without(), redeemedLog(REC_OWNER, sender(), RELAYER)] })).problems).toEqual(["its receipt has no RedeemedDelegation from the delegation manager"]);
  });
  it("for another delegator, or another redeemer than the transaction's sender: refused", async () => {
    expect((await judge("base-sponsored-grant", grant, { logs: [...without(), redeemedLog(RELAYER, sender())] })).problems).toEqual(["its RedeemedDelegation is for another delegator than the owner"]);
    expect((await judge("base-sponsored-grant", grant, { tx: { from: RELAYER } })).problems).toEqual(["its RedeemedDelegation names another redeemer than the transaction's sender"]);
  });
});

describe("the effect in the receipt", () => {
  const grant = plan.approve(FIRST_FUND_AGENT, CAP);
  const logs = () => recordedTx("base-sponsored-grant").receipt.logs as any[];
  const noApproval = () => logs().filter((l) => !same(l.address, BASE_USDC));

  it("a grant or revoke without Approval(owner, agent) from the token: refused, sponsored or direct", async () => {
    expect((await judge("base-sponsored-grant", grant, { logs: noApproval() })).problems).toEqual(["its receipt has no Approval from the owner to this spender"]);
    expect((await judge("base-direct-grant", plan.approve(DIRECT_AGENT, CAP), { logs: [] })).problems).toEqual(["its receipt has no Approval from the owner to this spender"]);
    // from another token, or for another spender: not this approval
    expect((await judge("base-sponsored-grant", grant, { logs: [...noApproval(), approvalLog(RELAYER, REC_OWNER, FIRST_FUND_AGENT, CAP)] })).problems).toEqual(["its receipt has no Approval from the owner to this spender"]);
    expect((await judge("base-sponsored-grant", grant, { logs: [...noApproval(), approvalLog(BASE_USDC, REC_OWNER, RELAYER, CAP)] })).problems).toEqual(["its receipt has no Approval from the owner to this spender"]);
  });

  it("the last Approval is the allowance left: another amount is refused", async () => {
    expect((await judge("base-sponsored-grant", grant, { logs: [...logs(), approvalLog(BASE_USDC, REC_OWNER, FIRST_FUND_AGENT, 10n ** 12n)] })).problems).toEqual([`its receipt's Approval from the owner to this spender is for ${10n ** 12n}, not ${CAP}`]);
    expect((await judge("base-sponsored-revoke", plan.approve(FIRST_FUND_AGENT, 0n), { logs: [...recordedTx("base-sponsored-revoke").receipt.logs, approvalLog(BASE_USDC, REC_OWNER, FIRST_FUND_AGENT, 5n)] })).problems).toEqual(["its receipt's Approval from the owner to this spender is for 5, not 0"]);
  });

  it("a token top-up needs Transfer(owner, agent, amount) from the planned token", () => {
    const want: Call = { to: BASE_USDC, value: 0n, data: transferData(FUND_AGENT, 100_000n) };
    expect(effectProblem([transferLog(BASE_USDC, REC_OWNER, FUND_AGENT, 100_000n)], BASE_USDC, REC_OWNER, want)).toBeNull();
    expect(effectProblem([], BASE_USDC, REC_OWNER, want)).toBe("its receipt has no Transfer of this amount from the owner");
    expect(effectProblem([transferLog(SKALE_USDC, REC_OWNER, FUND_AGENT, 100_000n)], BASE_USDC, REC_OWNER, want)).toBe("its receipt has no Transfer of this amount from the owner");
    expect(effectProblem([transferLog(BASE_USDC, REC_OWNER, FUND_AGENT, 99_999n)], BASE_USDC, REC_OWNER, want)).toBe("its receipt has no Transfer of this amount from the owner");
    expect(effectProblem([transferLog(BASE_USDC, RELAYER, FUND_AGENT, 100_000n)], BASE_USDC, REC_OWNER, want)).toBe("its receipt has no Transfer of this amount from the owner");
    // a call to another contract is nothing this command can check
    expect(effectProblem([], BASE_USDC, REC_OWNER, { ...want, to: SKALE_USDC })).toBe("it is not a call this command can check");
  });
});

describe("a native top-up through a delegation: MetaMask's implementation must have run it", () => {
  const first = plan.gas(FIRST_FUND_AGENT);
  const auth = () => recordedTx("base-sponsored-fund-2").tx.authorizationList as Authorization[];
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  it("the owner's address had no code, or other code: refused", async () => {
    const plain = { codeBefore: "0x" as Hex, codeAfter: "0x" as Hex, nonceBefore: 1, nonceAfter: 1 };
    expect((await judge("base-sponsored-fund", plan.gas(FUND_AGENT), { ownerState: plain })).problems).toEqual(["the owner's account was not MetaMask's smart account in that transaction, so the transfer inside it cannot be confirmed"]);
    const other = `0xef0100${"12".repeat(20)}` as Hex;
    expect((await judge("base-sponsored-fund", plan.gas(FUND_AGENT), { ownerState: { ...plain, codeBefore: other, codeAfter: other } })).problems).toEqual(["the owner's account was not MetaMask's smart account in that transaction, so the transfer inside it cannot be confirmed"]);
  });

  it("the implementation's code is not the pinned one: refused", async () => {
    expect((await judge("base-sponsored-fund", plan.gas(FUND_AGENT), { implementation: CODE.manager })).problems).toEqual(["MetaMask's smart account implementation on this chain is not the known code"]);
  });

  it("any of the reads unanswered: unresolved, never a problem and never accepted", async () => {
    for (const o of [{ implementation: undefined }, { owner: { codeBefore: undefined } }, { owner: { codeAfter: undefined } }, { owner: { nonceBefore: undefined } }, { owner: { nonceAfter: undefined } }] as const) {
      const e = await judge("base-sponsored-fund", plan.gas(FUND_AGENT), o as any);
      expect(e.problems, JSON.stringify(o)).toEqual([]);
      expect(e.unresolved, JSON.stringify(o)).toBe("the owner's account code and nonce around that block could not be read");
    }
  });

  it("the first top-up without the owner's authorization in it: the change in that block is not known", async () => {
    const e = await judge("base-sponsored-fund-2", first, { tx: { authorizationList: [] } });
    expect(e.problems).toEqual([]);
    expect(e.unresolved).toMatch(/cannot show without a trace/);
  });

  it("an authorization the chain would skip does not count: high s, another chain, another nonce, or not the owner's", async () => {
    const a = auth()[0];
    const cases: [string, Authorization][] = [
      ["high s", { ...a, s: `0x${(N - BigInt(a.s)).toString(16).padStart(64, "0")}` as Hex, yParity: a.yParity === 0 ? 1 : 0 }],
      ["y parity 2", { ...a, yParity: 2 }],
      ["another chain", { ...a, chainId: 1 }],
      ["another nonce", { ...a, nonce: 1 }],
    ];
    for (const [what, bad] of cases) {
      const e = await judge("base-sponsored-fund-2", first, { tx: { authorizationList: [bad] } });
      expect(e.problems, what).toEqual([]);
      expect(e.unresolved, what).toMatch(/cannot show without a trace/);
    }
    // the high-s twin recovers the same signer: only the EIP-7702 check stops it
    expect((await authorityOf(cases[0][1]))).toBeNull();
    expect((await authorityOf(a))?.toLowerCase()).toBe(REC_OWNER.toLowerCase());
  });

  it("the nonce moved by more than one in that block: not known", async () => {
    const e = await judge("base-sponsored-fund-2", first, { owner: { nonceAfter: 2 } });
    expect(e.unresolved).toMatch(/cannot show without a trace/);
  });

  it("code after the block that is not what the owner's authorization set, or that changed without one: not known", async () => {
    expect((await judge("base-sponsored-fund-2", first, { owner: { codeAfter: "0x" } })).unresolved).toMatch(/cannot show without a trace/);
    const e = await judge("base-sponsored-fund", plan.gas(FUND_AGENT), { ownerState: { codeBefore: DELEGATED_TO_METAMASK as Hex, codeAfter: "0x", nonceBefore: 1, nonceAfter: 1 } });
    expect(e.unresolved).toMatch(/cannot show without a trace/);
  });

  it("an authorization to the zero address clears the code: the account then ran no implementation, so it is refused", async () => {
    const a = auth()[0];
    expect(codeDuring([{ ...a, address: "0x0000000000000000000000000000000000000000", authority: REC_OWNER }], REC_OWNER, 84532, { codeBefore: DELEGATED_TO_METAMASK, codeAfter: "0x", nonceBefore: 0, nonceAfter: 1 })).toBe("0x");
    expect(codeDuring([{ ...a, authority: REC_OWNER }], REC_OWNER, 84532, { codeBefore: "0x", codeAfter: DELEGATED_TO_METAMASK, nonceBefore: 0, nonceAfter: 1 })).toBe(DELEGATED_TO_METAMASK);
  });
});

describe("a fabricated redemption on a chain without the manager (the SKALE case)", () => {
  // what anyone can send: redeemDelegations to the manager's address with an unsigned delegation of the owner's. On SKALE
  // there is no code there, so it succeeds and does nothing.
  const fabricated = (want: Call) => ({
    from: RELAYER, to: DELEGATION_MANAGER, value: 0n,
    input: redeem({ delegations: [{ ...delegation(REC_OWNER), signature: "0x" }], executions: [encodePacked(["address", "uint256", "bytes"], [want.to, want.value, want.data])] }),
  });
  const cases = (token: Hex) => [["fund", plan.gas(FUND_AGENT)], ["grant", plan.approve(FUND_AGENT, CAP, token)], ["revoke", plan.approve(FUND_AGENT, 0n, token)]] as const;
  const run = (chainKey: string, token: Hex, want: Call, logs: any[], reads = chainReads(100n, { manager: "0x", implementation: "0x" }).reads) =>
    ownerEvidence({ chainKey, chainLabel: chainKey, chainId: 1, token, owner: REC_OWNER, want, tx: fabricated(want), block: 100n, logs }, reads);

  it("decodes as the owner's call: the decoder alone would have accepted it", () => {
    for (const [, want] of cases(SKALE_USDC)) expect(delegatedCall(fabricated(want), REC_OWNER)).toEqual({ ...want, to: want.to.toLowerCase() });
  });

  it("is refused on SKALE for the top-up, the grant and the revoke, even with forged logs", async () => {
    for (const [what, want] of cases(SKALE_USDC)) {
      for (const logs of [[], [approvalLog(SKALE_USDC, REC_OWNER, FUND_AGENT, want.data === "0x" ? 0n : BigInt(`0x${want.data.slice(-64)}`)), redeemedLog(REC_OWNER, RELAYER)]]) {
        const e = await run("skale-base-sepolia", SKALE_USDC, want, logs);
        expect(e.problems.length, what).toBeGreaterThan(0);
        expect(e.unresolved, what).toBeUndefined();
      }
    }
  });

  it("is refused on a pinned chain too: no event from a manager with no code, and no code where one is claimed", async () => {
    for (const [what, want] of cases(BASE_USDC)) {
      const bare = await run("base-sepolia", BASE_USDC, want, []);
      expect(bare.problems.length, what).toBeGreaterThan(0);
      const forged = await run("base-sepolia", BASE_USDC, want, [approvalLog(BASE_USDC, REC_OWNER, FUND_AGENT, want.data === "0x" ? 0n : BigInt(`0x${want.data.slice(-64)}`)), redeemedLog(REC_OWNER, RELAYER)]);
      expect(forged.problems, what).toEqual(["there is no delegation manager at that address on this chain"]);
    }
  });
});

describe("validSignature: the checks EIP-7702 makes before it recovers a signer", () => {
  it("refuses r or s of 0, s above n/2, a y parity other than 0 or 1, and the largest nonce", () => {
    const ok = { r: "0x1", s: "0x1", yParity: 0, nonce: 0 };
    expect(validSignature(ok)).toBe(true);
    expect(validSignature({ ...ok, r: "0x0" })).toBe(false);
    expect(validSignature({ ...ok, s: "0x0" })).toBe(false);
    expect(validSignature({ ...ok, s: "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a1" })).toBe(false);
    expect(validSignature({ ...ok, s: "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0" })).toBe(true);
    expect(validSignature({ ...ok, yParity: 27 })).toBe(false);
    expect(validSignature({ ...ok, nonce: 2n ** 64n - 1n })).toBe(false);
  });
});
