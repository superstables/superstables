// What a settled purchase tells the agent to do next. Pure: the dispatcher passes the purchase's amount and what is left.

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
