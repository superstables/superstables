// What a command tells the agent and the owner to do next. Pure: the dispatcher passes the values.
import { siteName } from "./site.mjs";

/**
 * After a purchase that settled and was delivered: "none" while the budget left covers another purchase at the same price;
 * otherwise the words that stop an agent from proposing a new grant (rule 10 of the skill). A purchase the owner asked for
 * twice on a budget that covers one is reported, not worked around.
 * @param {{ amount: string | null, remaining: string | null, unit: string }} p
 */
export function afterPurchase({ amount, remaining, unit }) {
  const price = Number(amount), left = Number(remaining);
  if (amount === null || remaining === null || !(price > 0) || !Number.isFinite(left) || left >= price) return "none";
  return `This purchase settled and was delivered. The remaining budget is ${remaining} ${unit}, less than this purchase's price of ${amount} ${unit}. If another purchase was requested, use its preflight price to check whether the remaining budget covers it. If it does not, report what you bought, the remaining budget and that next purchase's price in one reply, then end your turn. Do not switch to another way of paying to complete it. Do not propose or start a revoke, a new or bigger grant, or more gas unless the owner explicitly asks for that action. "Carry on" is not such a request`;
}

/**
 * After setup recorded an owner: what the owner checks, for `next` (`next`) and for stderr (`words`). Hosted (`site` is the
 * site recorded in the public file), the agent now belongs to that account on the site: a new owner is recorded only once
 * it is removed there and added again with setup --hosted --new-owner. The command always names --site with the recorded
 * site: without it, setup takes SUPERSTABLES_SITE or the default, and could move the chain to another site. --new-owner
 * without --hosted would move the chain to the page on this computer.
 * @param {{ rail: string, chain: string, owner: string, site: string | null }} p
 */
export function ownerCheck({ rail, chain, owner, site }) {
  if (!site) {
    return {
      next: `the owner on record is now ${owner}: the owner checks that this is their own wallet's address. If it is not, stop: grant nothing, and run superstables budget setup --rail ${rail} --chain ${chain} --new-owner with the owner present`,
      words: `OWNER CONNECTED: ${owner}\n  Check that this is your own wallet's address. If it is not, someone else completed setup: grant nothing, and run setup --new-owner yourself.`,
    };
  }
  const host = siteName(site);
  const again = `superstables budget setup --rail ${rail} --chain ${chain} --hosted --site ${site} --new-owner`;
  return {
    next: `the owner on record is now ${owner}, the ${host} account this agent was added to: the owner checks that this is their own wallet's address. If it is not, stop: grant nothing. The agent stays on that account until it is removed on that account's page on ${host}; then run ${again} with the owner present`,
    words: `AGENT ADDED to the ${host} account ${owner}\n  Check that this is your own wallet's address. If it is not, someone else added this agent to their account: grant nothing. Once the agent is removed on that account's page on ${host}, run ${again} yourself.`,
  };
}

/**
 * The words for an evm purchase the chain refused at the pull. A pull that was mined and reverted keeps its hash: the
 * words say what happened to it, never "nothing was paid" beside a transaction. Without one, nothing was sent.
 * @param {string | null | undefined} pullTx
 */
export function refusedChainWords(pullTx) {
  return pullTx
    ? { line: `PURCHASE REFUSED. The pull ${pullTx} reverted on chain: no USDC was pulled from the owner. Gas fees still apply.`, next: `no payment tokens were pulled from the owner: the pull ${pullTx} reverted on chain; gas fees still apply` }
    : { line: "PURCHASE REFUSED. Nothing was paid.", next: "nothing moved; the chain refused the pull" };
}
