# Sample Lend Protocol Whitepaper

Fictional sample document for the Superstables demo.

Version 1.2. Sample Lend Protocol, the SLP token and every figure below are invented for demonstration purposes and describe no real project, company or person.

## Summary

Sample Lend Protocol is a fictional over-collateralised lending market. Lenders deposit assets into shared pools and earn interest; borrowers lock collateral and draw loans against it. The contracts hold every position on chain, and the protocol never lends out or re-uses a borrower's collateral.

At launch the protocol lists three markets: USDC, EURC and ETH. Each market has its own interest-rate curve, driven by utilisation, the share of deposits currently lent out. Below the 80% utilisation kink, rates rise gently; above it, they rise steeply to draw in deposits and encourage repayment. The maximum loan-to-value ratio for ETH collateral is 75%, and a position becomes liquidatable at 80%. Liquidators repay part of the debt and receive the collateral at a 5% discount.

The protocol charges a 10% fee on interest paid, which flows to the treasury. Governance is held by SLP token holders, who vote on new markets, risk parameters and treasury spending. A minimum of 2% of circulating SLP must vote for a proposal to pass, with a 48-hour timelock before execution.

The design goal is simplicity: a small set of markets, conservative parameters and no rehypothecation of collateral. The team expects the protocol to be boring, and considers that a feature.

## Tokenomics

SLP is the governance and staking token of Sample Lend Protocol. The supply is fixed at 1,000,000,000 SLP and no further tokens can be minted.

The allocation is as follows:

- 40% community rewards, distributed to lenders and borrowers over four years.
- 25% treasury, controlled by governance.
- 20% team, with a one-year cliff and three-year linear vesting.
- 10% early backers, with a one-year cliff and two-year linear vesting.
- 5% initial liquidity, unlocked at launch.

Community rewards are emitted at 5,000,000 SLP per month in the first year and decline by 10% every quarter afterwards. Emissions are split between markets in proportion to their share of total deposits, so a market that attracts more deposits earns a larger share of rewards.

SLP holders may stake their tokens in the safety module. Stakers receive 50% of protocol fees, paid in the fee asset, and in return their stake can be slashed by up to 30% to cover bad debt. Unstaking requires a 14-day cooldown.

The team expects that at launch roughly 15% of the supply will be circulating: the 5% liquidity allocation plus the first months of community rewards and the unlocked portion of the treasury.

## Risks

Sample Lend Protocol carries the risks common to lending markets, and this whitepaper names them plainly rather than pretending they are small.

Smart contract risk. The contracts have been audited twice, but an audit is not a guarantee. A bug in the interest accrual or liquidation logic could lose funds. The team runs a bug bounty capped at 500,000 USDC.

Oracle risk. Prices come from a single oracle feed with a 30-minute heartbeat and a 1% deviation threshold. If the oracle reports a stale or wrong price, positions can be liquidated unfairly or bad debt can build up unnoticed.

Liquidity risk. Deposits are lent out, so lenders cannot always withdraw at once. When utilisation exceeds 95%, withdrawals wait for repayments or new deposits. There is no guarantee of when that happens.

Bad debt. If collateral falls faster than liquidators act, a position can end up worth less than its debt. The safety module covers bad debt up to 30% of staked SLP; beyond that, losses fall on lenders in the affected market.

Governance concentration. The team and early backers together hold 30% of the supply. Once vested, they can pass or block proposals if community participation stays near the 2% quorum.

Testnet status. The protocol described here exists only as a demo. Nothing in this document is an offer, a forecast or investment advice.
