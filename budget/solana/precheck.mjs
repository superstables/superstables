// Purchase prechecks (contract rule 4). Pure functions: no key, no RPC, no signing.
// A purchase is refused, before anything is signed, when
//   - the price is missing, not an integer number of base units (more precision than USDC allows), or zero;
//   - the price exceeds --max;
//   - the offered token is not the devnet USDC mint, or the offered decimals are not 6;
//   - the recipient is not a valid address, or is not the --pay-to address when one is given.
// and, once the owner's USDC token account has been read (checkDelegation), when
//   - the account does not exist or is frozen;
//   - the agent is not its delegate (revoked, never granted, or granted to another key);
//   - the delegated amount left, or the account's balance, is below the price.
import { PublicKey } from "@solana/web3.js";
import { USDC_MINT, USDC_DECIMALS, formatUnits } from "./lib.mjs";

export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const isSolanaDevnetNetwork = (n) => n === SOLANA_DEVNET_CAIP2 || n === "solana-devnet";

function validKey(s) {
  try {
    return new PublicKey(s);
  } catch {
    return null;
  }
}

// Pick the accept entry to evaluate: exact + Solana devnet, preferring one that already offers
// the USDC mint (a seller may list several tokens).
export function selectRequirement(accepts) {
  const cands = (accepts ?? []).filter((a) => a?.scheme === "exact" && isSolanaDevnetNetwork(a.network));
  return cands.find((a) => a.asset === USDC_MINT.toBase58()) ?? cands[0] ?? null;
}

// Returns { ok, reasons, amountBase, payTo, mint }.
export function checkOffer(requirement, { maxBase, payTo }) {
  const reasons = [];
  if (!requirement) {
    return { ok: false, reasons: ["no exact-scheme Solana devnet offer in the seller's challenge"], amountBase: null };
  }

  const raw = requirement.amount ?? requirement.maxAmountRequired;
  let amountBase = null;
  if (raw === undefined || raw === null || raw === "") {
    reasons.push("the offer has no amount");
  } else if (!/^\d+$/.test(String(raw))) {
    reasons.push(`offer amount '${raw}' is not an integer number of base units (more precision than ${USDC_DECIMALS} decimals, or not a number)`);
  } else {
    amountBase = BigInt(String(raw));
    if (amountBase === 0n) reasons.push("offer amount is zero");
  }

  if (amountBase !== null && maxBase !== null && maxBase !== undefined && amountBase > maxBase) {
    reasons.push(`price ${formatUnits(amountBase)} USDC exceeds --max ${formatUnits(maxBase)} USDC`);
  }

  const asset = requirement.asset;
  if (asset !== USDC_MINT.toBase58()) {
    reasons.push(`offered token ${asset ?? "(none)"} is not the devnet USDC mint ${USDC_MINT.toBase58()}`);
  }
  const dec = requirement.extra?.decimals;
  if (dec !== undefined && Number(dec) !== USDC_DECIMALS) {
    reasons.push(`offered decimals ${dec} do not match USDC's ${USDC_DECIMALS}`);
  }

  const to = validKey(requirement.payTo);
  if (!to) reasons.push(`recipient '${requirement.payTo ?? ""}' is not a valid address`);
  else if (payTo && !to.equals(payTo)) {
    reasons.push(`recipient ${to.toBase58()} is not the expected --pay-to ${payTo.toBase58()}`);
  }

  const fp = requirement.extra?.feePayer;
  if (fp !== undefined && !validKey(fp)) reasons.push(`fee payer '${fp}' is not a valid address`);

  return { ok: reasons.length === 0, reasons, amountBase, payTo: to };
}

// `account` is the owner's USDC token account as read from the chain (token.mjs getAccount shape:
// { delegate: PublicKey|null, delegatedAmount: bigint, amount: bigint, isFrozen: boolean }), or
// null when it does not exist. Returns { ok, reasons }.
export function checkDelegation(account, { agent, amountBase }) {
  if (!account) return { ok: false, reasons: ["the owner has no USDC token account on devnet"] };
  const reasons = [];
  if (account.isFrozen) reasons.push("the owner's USDC token account is frozen");
  if (!account.delegate) {
    reasons.push("the owner's USDC account has no delegate: the budget is revoked or was never granted");
  } else if (!account.delegate.equals(agent)) {
    reasons.push(`the delegate is ${account.delegate.toBase58()}, not this agent ${agent.toBase58()}`);
  } else if (account.delegatedAmount < amountBase) {
    reasons.push(`price ${formatUnits(amountBase)} USDC exceeds the remaining budget ${formatUnits(account.delegatedAmount)} USDC`);
  }
  if (account.amount < amountBase) {
    reasons.push(`price ${formatUnits(amountBase)} USDC exceeds the owner's USDC balance ${formatUnits(account.amount)} USDC`);
  }
  return { ok: reasons.length === 0, reasons };
}
