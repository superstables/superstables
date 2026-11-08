// Fixtures shared by hosted-adopt.test.ts and hosted-adopt-property.test.ts.
import { encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Evidence } from "../../budget/hosted.js";
import { SITE_WORDS } from "../../budget/site.mjs";
import { evmOwner } from "./fake-site.js";

export const KEY = `0x${"11".repeat(32)}` as const;
export const OTHER_KEY = `0x${"44".repeat(32)}` as const;
export const AGENT = privateKeyToAccount(KEY).address;
export const OWNER = evmOwner("22");
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const GRANT_HASH = `0x${"b2".repeat(32)}`;
export const FUND_HASH = `0x${"a1".repeat(32)}`;
export const FUND_VALUE = 100_000_000_000_000n;
export const TERMS = { title: "Grant a spending budget", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };
const erc20 = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);
export const approveData = (agent: string, value: bigint) => encodeFunctionData({ abi: erc20, functionName: "approve", args: [agent as `0x${string}`, value] });
export const grantTx = (agent: string, cap: bigint) => ({ to: USDC, data: approveData(agent, cap), value: "0x0" });
export const NONE: Evidence = { walletAsked: false, hashes: [] };
export const isEvmTx = (h: unknown) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
/** The reason codes the site sets only before it asks the wallet (hosted.ts NEVER_SIGNED_CODES), and every other code it documents. */
export const NEVER_SIGNED_CODES = ["owner_rejected", "not_requested", "match_code_mismatch", "approval_expired", "agent_cancelled", "agent_removed", "cap_above_limit", "owner_frozen", "earlier_step", "link_not_done", "another_open"];
export const OTHER_CODES = [...SITE_WORDS.code].filter((c) => !NEVER_SIGNED_CODES.includes(c));
/** The reasons the site gives a request or step it closed after the wallet was handed the transaction, or may have been (flow.ts REASONS), and partly_done. */
export const AFTER_HANDOFF_CODES = ["reverted", "mismatch", "no_start_block", "stale_tx", "not_found", "wallet_timeout", "owner_stopped", "page_stopped_before_send", "not_signed", "not_landed", "network_refused", "partly_done"];
export const PROOF_HEADERS = ["superstables-agent", "superstables-agent-nonce", "superstables-agent-signature", "superstables-agent-timestamp"];
