# The rails, in detail

Load this file when you choose a rail, explain what a budget allows, or compare rails. `superstables budget --rail evm` is a plain ERC-20 approve with pull then pay (`evm/`, Base Sepolia and Arc Testnet).

## Methods

Every rail implements the same four methods.

| Method | Signer | Effect |
| --- | --- | --- |
| `setBudget(amount, expiry?, sellers?)` (`grant`) | owner | Lets one agent key spend up to `amount` USDC, until `expiry` and only to the listed sellers where the rail supports them. A rail refuses a constraint it can't enforce on chain. It prints the true maximum that can move. |
| `pay(seller, amount)` (`buy`) | agent | Moves USDC from the owner to the seller under the budget. |
| `revokeBudget()` (`revoke`) | owner | Ends the authorization on chain. |
| `readBudget()` (`status`) | anyone | Reads the remaining amount, expiry and revoked state from the chain. |

Keys live in `$SUPERSTABLES_HOME/keys/budget/<rail>-owner.env` and `<rail>-agent.env` (mode 600). Agent commands never open the owner file, and reads need no secret file (public addresses in `$SUPERSTABLES_HOME/budget/public/<rail>-<chain>.env`). Safety rules: [CONTRACT.md](../CONTRACT.md).

## What each rail enforces

| | evm (ERC-20 `approve`) |
| --- | --- |
| Grant | Owner transaction `approve(agent, cap)`, from any wallet |
| Pay | Agent `transferFrom(owner, agent, price)`, then a normal EIP-3009 payment it signs itself |
| Revoke | Owner transaction `approve(agent, 0)` |
| Total cap | Yes, on chain |
| Expiry | No: `grant` refuses `--expiry` |
| Period cap | No: `grant` refuses `--period` |
| Seller list | No: `grant` refuses `--sellers` |
| Per-payment maximum | No, only `--max` in our code |
| Funds stay with the owner | Until each pull. The agent holds 0 between purchases |
| Remaining readable on chain | Yes, `allowance` |
| Kill switch under a stolen agent key | `revoke`. Not covered: a pull already mined, and USDC already in the agent key (`recover` returns it) |

A payment signed before the revoke and submitted after it is refused.

## Paying real sellers

| Rail | Seller protocol | How the agent pays | Fees on a purchase |
| --- | --- | --- | --- |
| evm | x402 `exact`, EIP-3009 | **Pull then pay.** Per purchase the agent pulls the exact price from the owner, then pays as a standard EIP-3009 payment it signs itself. A failed purchase returns the price. The owner keeps an escrow copy of the agent key so `recover` works without the agent. | The agent pays gas for the pull (about 0.0000004 ETH on Base Sepolia; USDC on Arc). The seller's facilitator pays for settlement. |

Trade-offs on `evm`: two transactions per purchase; after the pull the chain no longer binds the seller; the price sits in the agent key for a few seconds. On Arc a chain's USDC may need allowing in the x402 client's spend controls, and gas is paid in USDC.

Command on every rail: `buy --url <seller url> --max <amount> [--pay-to <address>] [--op <id>]`. It refuses before signing if the price is over `--max`, the token or chain is wrong, or the recipient doesn't match (exit 3). After a crash or an unclear result, run `reconcile --op <id>`: it reads the chain and never pays. A seller error after payment is `settled` with `delivered: false`, never a retry.
