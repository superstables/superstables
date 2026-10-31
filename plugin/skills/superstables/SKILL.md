---
name: superstables
description: Finds services that charge per request, requests a single purchase the owner approves on superstables.com, and reads or follows a testnet budget and gets the owner's link to revoke it, through the Superstables tools; runs the superstables CLI for what needs a signature from this machine, or when the tools are missing. Use when this chat has the Superstables tools, or when asked to find a paid API, quote what a call costs, pay for one, make a single purchase, or set up, grant, check, revoke or recover a testnet budget. Testnet-first.
---

# Superstables

Use the connected Superstables tools to find a service and request a purchase.
Testnet-first: test tokens, no real money. Mainnet is off, and only the operator turns it on (`SUPERSTABLES_ALLOW_MAINNET`); you never set it, and when a refusal names it you report the refusal and stop.

Only operations needing a local signature go through the CLI; everything else goes through the connector.

## The connector tools

- `get_my_account`: read the account and wallets connected to this chat.
- `find_services`: find services, prices, chains and required inputs. No sign-in needed. This pays nothing.
- `request_purchase`: request a service by its `service_id` and inputs. Use a new `operation_id` for each purchase; reuse it when retrying the same request on the same connection.
- `get_purchase_status`: read the purchase's payment status, service response and receipt using its `purchase_id`.
- `find_budget_services`: list the services a budget can pay, or with `once` what Single purchase on superstables.com can buy. `chain` narrows the list.
- `preflight_budget_purchase`: the listed price, recipient and chain for one service from `find_budget_services`; with `agent`, whether what is left of that agent's budget covers it.
- `list_my_budgets`: read each agent's budget, what is left and its state.
- `get_budget_status`: one agent's budget read from the chain now, with the owner's last action and whether it is final.
- `get_budget_request`: read a budget approval on superstables.com from its complete approval link.
- `wait_budget_request`: follow a budget approval until it is final; pass `wait_seconds` 25 and call it again while it is not final.
- `request_budget_revoke`: get the owner's link to revoke an agent's budget. The owner signs the revoke in their wallet.
- `remove_budget_agent`: remove an agent from the account, off chain, once it has no spending permission. Moves no funds.
- `submit_budget_request`: send a budget request that the CLI signed with `--sign-only` to superstables.com for the owner's approval. Pass the CLI's block unchanged.

Before you request a purchase or a budget, call `get_my_account` and tell the owner
which account and wallet you are connected as, by the wallet's last four
characters (for example "wallet ending 1065"). Go on only if that is the one they
expect. A sign-in that worked does not show it was the right account: the browser
may have been signed in to another wallet. If it is not theirs, stop. Ask them to
sign the connector in again with the right wallet, then call `get_my_account`
again. If it still shows the old account, the app is holding the old sign-in: in
Codex, tell them to start a new session (the running one keeps its token); Claude
Code follows the new sign-in, and a new session fixes it if not. Never go on with
the old account.

Nothing is paid until an account member approves and signs in their wallet on
superstables.com. When `request_purchase` returns an approval link and match
code, show both to the user in your reply now. Then, in the same turn, call
`get_purchase_status` with `wait_seconds` 25, and keep calling it while the result
says to keep waiting, until the outcome is final. Report what it establishes.
Do not approve for the user. If your app shows your reply only when the turn
ends, end your turn after showing the link and match code instead, and call
`get_purchase_status` when the user says they approved. If the payment outcome
is unknown, say so.

Budgets: read their status with `list_my_budgets` or `get_budget_status`, follow
an approval link with `get_budget_request` or `wait_budget_request`, and revoke
with `request_budget_revoke` (it returns the owner's link on superstables.com
and signs nothing). Check a revoke with `get_budget_status`, and count it done
only when its `revoke` says it is final.

## What stays on the CLI

Use the CLI for what needs this machine: creating the agent key, `--sign-only`
signing, `budget buy` (the agent key signs), `pay`, `recover`, `reconcile` and
records kept here. Use the tools above wherever one exists.

Set-up and grant are signed on the CLI. When the connector offers
`submit_budget_request`, use it for `budget setup --hosted` and grants approved
on superstables.com, on the `evm` rail only. Sign with `--sign-only` and send
the block unchanged with `submit_budget_request`. Show the owner the approval
details, then call `wait_budget_request` with `wait_seconds` 25 until `final` is
`true`. End the turn first only if your app shows your reply only when the turn
ends; then call it when they say they've approved. Follow "Sending a budget request
through the connector" in [references/budget.md](references/budget.md) for the
full steps and command arguments. `budget wait` and `budget status` stay on the
CLI only for an approval page on this machine, which the connector cannot read.
Read [references/cli.md](references/cli.md) before you run any CLI command. Write
each client command out in full, as shown in `references/cli.md`. Do not use a
shell variable or alias: these can prevent the host from checking the command
before it runs.

In a chat app without a terminal, there is no budget set-up, grant, fund, buy
or `pay`. Chat can find services, request a purchase the owner approves on
superstables.com, and read, follow or revoke a budget through the tools above.

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
