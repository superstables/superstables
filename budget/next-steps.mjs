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
  return `none for this purchase. The budget left (${remaining} ${unit}) cannot cover another one at this price (${amount} ${unit}): if another was asked for, report what you bought, what is left and the price in one reply, and end your turn. Do not propose or start a new or bigger grant unless the owner explicitly asks for one`;
}
