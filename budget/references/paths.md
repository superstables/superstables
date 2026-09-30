# The rails, in detail

Load this file when you choose a rail, explain what a budget allows, or compare rails. `superstables budget --rail evm` is a plain ERC-20 approve with pull then pay (`evm/`, Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy and SKALE Base Sepolia; the chain table is `evm/chains.mjs`). `--rail tempo` is a Tempo keychain access key (`tempo/`, Moderato). `--rail solana` is an SPL token delegate (`solana/`, devnet).

## Methods

Every rail implements the same four methods.

| Method | Signer | Effect |
| --- | --- | --- |
| `setBudget(amount, expiry?, sellers?)` (`grant`) | owner | Lets one agent key spend up to `amount` USDC (pathUSD on Tempo), until `expiry` and only to the listed sellers where the rail supports them. A rail refuses a constraint it can't enforce on chain. It prints the true maximum that can move. The owner approves it in their own wallet. |
| `pay(seller, amount)` (`buy`) | agent | Moves the token from the owner to the seller under the budget. |
| `revokeBudget()` (`revoke`) | owner | Ends the authorization on chain. |
| `readBudget()` (`status`) | anyone | Reads the remaining amount, expiry and revoked state from the chain. |

The agent key lives in `$SUPERSTABLES_HOME/keys/budget/<rail>-agent.env` (mode 600). No rail has an owner key file: owner actions go through the owner's own wallet on an approval page on `127.0.0.1` (any EVM browser wallet on `evm`, one that can add a custom network on `tempo`, any Solana wallet on `solana`). Reads need no secret file (public addresses in `$SUPERSTABLES_HOME/budget/public/<rail>-<chain>.env`). Safety rules: [CONTRACT.md](../CONTRACT.md).

## What each rail enforces

| | evm (ERC-20 `approve`) | tempo (AccountKeychain access key) | solana (SPL delegate) |
| --- | --- | --- | --- |
| Grant | Owner transaction `approve(agent, cap)`, sent by the owner's own wallet from the approval page | Owner transaction `authorizeKey` with limit, expiry and optional seller scopes | Owner transaction `ApproveChecked` |
| Pay | Agent `transferFrom(owner, agent, price)`, then a normal EIP-3009 payment it signs itself | The agent's access key signs a `transferWithMemo` from the owner's account | The agent signs `TransferChecked` as delegate |
| Revoke | Owner transaction `approve(agent, 0)` | Owner transaction `revokeKey`. Permanent for that key | Owner transaction `Revoke` |
| Total cap | Yes, on chain | Yes, on chain. Fees count against it | Yes, on chain (`delegatedAmount`) |
| Expiry | No: `grant` refuses `--expiry` | Yes, on chain (default 24 hours) | No: `grant` refuses `--expiry` |
| Period cap | No: `grant` refuses `--period` | Yes, on chain; the plan prints the true maximum by expiry | No: `grant` refuses `--period` |
| Seller list | No: `grant` refuses `--sellers` | Yes, on chain | No: `grant` refuses `--sellers` |
| Per-payment maximum | No, only `--max` in our code | No, only `--max` in our code | No, only `--max` in our code |
| Several budgets per owner | One per agent key | Yes, one per access key | No: one delegate per token account |
| Funds stay with the owner | Until each pull. The agent holds 0 between purchases | Yes | Yes |
| Remaining readable on chain | Yes, `allowance` | Yes | Yes, `delegatedAmount` |
| Change in place | No: revoke first, then grant | No: revoke, then grant a fresh key (`--agent LABEL`) | No: revoke first, then grant |
| Kill switch under a stolen agent key | `revoke`. Not covered: a pull already mined, and USDC already in the agent key (`recover` returns it) | `revoke`. Not covered: payment sessions the key opened elsewhere | `revoke` |

A payment signed before the revoke and submitted after it is refused on all three rails.

## Paying real sellers

| Rail | Seller protocol | How the agent pays | Fees on a purchase |
| --- | --- | --- | --- |
| evm | x402 `exact`, EIP-3009 | **Pull then pay.** Per purchase the agent pulls the exact price from the owner, then pays as a standard EIP-3009 payment it signs itself. A failed purchase returns the price. `recover` uses the agent key to lower its allowance and return funds; the owner approves in the wallet only what the agent cannot do. | The agent pays gas for the pull (about 0.0000004 ETH on Base Sepolia; USDC on Arc). The seller's facilitator pays for settlement. |
| tempo | MPP `tempo` charge (`transferWithMemo`) | **Direct.** The agent's access key signs the payment from the owner's account. | Paid by the seller's fee payer with the sellers we tested. A fee the owner's account pays counts against the limit. |
| solana | x402 `exact` | **Direct.** The agent signs `TransferChecked` as SPL delegate of the owner's USDC account; the facilitator reports the agent as payer. | Paid by the seller's facilitator. |

Trade-offs on `evm`: two transactions per purchase; after the pull the chain no longer binds the seller; the price sits in the agent key for a few seconds. On Arc a chain's USDC may need allowing in the x402 client's spend controls, and gas is paid in USDC.

Command on every rail: `buy --url <seller url> --max <amount> [--pay-to <address>] [--op <id>]`. It refuses before signing if the price is over `--max`, the token or chain is wrong, or the recipient doesn't match (exit 3). On `evm` and `solana` it also reads the budget on chain first and refuses (exit 3) when the agent is not approved or the price is over what is left; on `tempo` the chain refuses that payment at estimation (exit 1, nothing signed). After a crash or an unclear result, run `reconcile --op <id>`: it reads the chain and never pays. A seller error after payment is `settled` with `delivered: false`, never a retry.
