---
name: superstables
description: Finds services that charge per request, requests a single purchase the owner approves on superstables.com, and reads or revokes a testnet budget through the Superstables tools; runs the superstables CLI for what needs a signature from this machine, or when the tools are missing. Use when this chat has the Superstables tools, or when asked to find a paid API, quote what a call costs, pay for one, make a single purchase, or set up, grant, check, revoke or recover a testnet budget. Testnet only.
---

# Superstables

Use the connected Superstables tools to find a service and request a purchase.
Testnet only: test tokens, no real money.

Only operations needing a local signature go through the CLI; everything else goes through the connector.

## The connector tools

- `get_my_account`: read the account and wallets connected to this chat.
- `find_services`: find services, prices, chains and required inputs. No sign-in needed. This pays nothing.
- `request_purchase`: request a service by its `service_id` and inputs. Use a new `operation_id` for each purchase; reuse it when retrying the same request on the same connection.
- `get_purchase_status`: read the purchase's payment status, service response and receipt using its `purchase_id`.
- `list_my_budgets`: read each agent's budget, what is left and its state.
- `get_budget_request`: read a budget approval on superstables.com from its complete approval link.
- `request_budget_revoke`: get the owner's link to revoke an agent's budget. The owner signs the revoke in their wallet.
- `submit_budget_request`: send a budget request that the CLI signed with `--sign-only` to superstables.com for the owner's approval. Pass the CLI's block unchanged.

Nothing is paid until an account member approves and signs in their wallet on
superstables.com. When `request_purchase` returns an approval link and match
code, show both to the user and end your turn. Do not approve for them or poll
while waiting. When they say they approved, call `get_purchase_status` and
report what it establishes. If the payment outcome is unknown, say so.

Budgets: read their status with `list_my_budgets`, follow an approval link with
`get_budget_request`, and revoke with `request_budget_revoke` (it returns the
owner's link on superstables.com and signs nothing).

## What stays on the CLI

Set-up, grant, buy and recover are signed on the CLI, because they need a
signature from this machine. When the connector offers `submit_budget_request`,
send `budget setup --hosted` and `grant` on the `evm` rail through it: sign with
`--sign-only`, send the block with `submit_budget_request`, then follow it with
`budget wait --site-request`, as "Sending a budget request through the
connector" in [references/budget.md](references/budget.md) describes. `budget find` and `budget preflight` also stay on
the CLI today, because the connector has no tool for them yet. `budget wait` and
`budget status` stay on it for a request this machine signed. Read
[references/cli.md](references/cli.md) before you run any CLI command. Write
each client command out in full, as shown in `references/cli.md`. Do not use a
shell variable or alias: these can prevent the host from checking the command
before it runs.

## When the connector is missing or signed out

If these tools are missing, the CLI does all of it, `budget revoke` included:
follow [references/cli.md](references/cli.md). If a call fails because the
connector is not signed in, ask the owner to connect it once and end your turn.
If they decline, use the CLI.

## References

- [references/cli.md](references/cli.md): the CLI skill: safety rules, the workflow, commands and exit codes.
- [references/once.md](references/once.md): Single purchase on superstables.com, step by step: `budget find --once`, `buy-once`, the result.
- [references/discovery.md](references/discovery.md): `find` and `quote`, listing fields, choosing a listing, how a listing maps to `pay` or a budget rail and chain.
- [references/pay.md](references/pay.md): how `pay` runs, its states, where the response is, retries, `--json` fields.
- [references/budget.md](references/budget.md): a budget on superstables.com step by step, the rails, buying, reconcile, recover and gotchas.
