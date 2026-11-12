---
name: superstables
description: Finds services that charge per request, requests a single purchase the owner approves on superstables.com, and reads or follows a testnet budget and gets the owner's link to revoke it, through the Superstables tools; runs the superstables CLI for what needs a signature from this machine, or when the tools are missing. Use when this chat has the Superstables tools, or when asked to find a paid API, quote what a call costs, pay for one, make a single purchase, or set up, grant, check, revoke or recover a testnet budget. Testnet-first.
---

# Superstables

Use the connected Superstables tools to find a service and request a purchase.
Testnet-first: test tokens, no real money. Mainnet is off until a release approves a chain and the operator allows it (`SUPERSTABLES_ALLOW_MAINNET`); you never set it, and when a refusal names it you report the refusal and stop.

Only operations needing a local signature go through the CLI; everything else goes through the connector.

## Update or remove

When the owner asks to update or remove Superstables, use their install route:

- Claude Code, Git marketplace: update with `claude plugin marketplace update superstables`, then `claude plugin update superstables@superstables`; remove with `claude plugin uninstall superstables@superstables`.
- Codex, Git marketplace: run `codex plugin marketplace upgrade superstables`, then remove and reinstall with `codex plugin remove superstables@superstables` and `codex plugin add superstables@superstables`. To remove it, run the remove command.
- Claude Code or Codex, plugin zip: download and verify the latest zip, unpack it to a new folder, remove the installed plugin in Codex, remove the old marketplace, then add the new folder and install the plugin.
- Claude: delete the plugin in Customize › Plugins, then upload the verified new zip there. To remove it, delete it there and disconnect its connector separately in Customize › Connectors.
- Skill zip: download and verify the new zip, then replace the installed `superstables` skill folder; to uninstall, remove that folder.
- npm CLI: update with `npm install -g @superstables/client@latest`; remove with `npm uninstall -g @superstables/client`.
- Chat connectors: ask the owner to end access on their [account page](https://www.superstables.com/account). They can disconnect in Claude, choose Actions › Disconnect in ChatGPT, or choose Remove account in Grok Bot.

Removing a connector or plugin does not revoke agent budgets; ask the owner to revoke those separately before deleting keys. The [install guide](https://github.com/superstables/superstables/blob/main/docs/install.md#update-or-remove) has the detailed steps.

## The connector tools

- `get_my_account`: read the account and wallets connected to this chat.
- `find_services`: find services, prices, chains and required inputs. No sign-in needed. This pays nothing.
- `request_purchase`: request a service by its `service_id` and inputs. Use a new `operation_id` for each purchase; reuse it when retrying the same request on the same connection.
- `get_purchase_status`: read the purchase's payment status, service response and receipt using its `purchase_id`.
- `list_my_purchases`: list up to 50 recent purchase requests from this connection, newest first. Use `get_purchase_status` for the current status and result.
- `cancel_purchase`: cancel a request from this connection while it waits for approval. If payment may have been sent, the outcome is unknown; use `get_purchase_status`.
- `find_budget_services`: list the services a budget can pay, or with `once` what Single purchase on superstables.com can buy. `chain` narrows the list.
- `preflight_budget_purchase`: the listed price, recipient and chain for one service from `find_budget_services`; with `agent`, whether what is left of that agent's budget covers it.
- `list_my_budgets`: read each agent's budget, what is left and its state.
- `get_budget_status`: one agent's budget read from the chain now, with the owner's last action and whether it is final.
- `get_budget_request`: read a budget approval on superstables.com from its complete approval link.
- `wait_budget_request`: follow a budget approval until it is final; pass `wait_seconds` 25 and call it again while it is not final.
- `request_budget_revoke`: get the owner's link to revoke an agent's budget. The owner signs the revoke in their wallet.
- `remove_budget_agent`: remove an agent from the account, off chain, once it has no spending permission. Moves no funds.
- `submit_budget_request`: for coding agents only (Claude Code, Codex). Send a budget request that the CLI signed with `--sign-only` to superstables.com for the owner's approval. Pass the CLI's block unchanged. A chat app never uses it and never asks the owner to paste a signed block.

With every approval link, `request_purchase` and `submit_budget_request` return
a line naming the request account's wallets by their last four characters, or
saying it has no wallet. Show that line with the link. If that is not the account
the owner meant, tell them not to approve and stop to resolve the mismatch. For
a purchase, tell them to sign the connector in to the intended account and, in
Codex, start a new session because the running session keeps the old token. Then
request the purchase again.

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

**A refused budget purchase is the answer.** When a budget purchase is refused (the budget is revoked, has nothing left, or the price is over the per-purchase limit), say so and stop. A single purchase, which the owner approves on superstables.com or on their machine, may be offered only as a question. Request it only when the owner says yes: with `request_purchase`, or, in a coding agent on the owner's machine, `buy-once` or `pay`. They asked for the budget, so do not switch the way of paying on your own.

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

In a chat app (Claude, ChatGPT, Grok Bot or any other hosted app), don't run
commands to check what is available: decline budget set-up, grant, fund, budget
buy and the CLI's `pay` straight away, because each needs a signature on the
owner's machine. Don't offer to send a signed block either. Say so and point the owner to Claude Code, Codex or
another agent that can run commands. The tools can find services, request a purchase the owner approves on
superstables.com, read budgets, follow a budget approval and give the revoke
link: offer those.

## When the connector is missing or signed out

If these tools are missing, the CLI does all of it, `budget revoke` included:
follow [references/cli.md](references/cli.md). If a call fails because the
connector is not signed in, ask the owner to connect it once and end your turn.
Only an agent on the owner's machine, such as Claude Code or Codex, falls back to
the CLI when the owner declines. In a chat app, stop without running commands.

## References

- [references/cli.md](references/cli.md): the CLI skill: safety rules, the workflow, commands and exit codes.
- [references/once.md](references/once.md): Single purchase on superstables.com, step by step: `budget find --once`, `buy-once`, the result.
- [references/discovery.md](references/discovery.md): `find` and `quote`, listing fields, choosing a listing, how a listing maps to `pay` or a budget rail and chain.
- [references/pay.md](references/pay.md): how `pay` runs, its states, where the response is, retries, `--json` fields.
- [references/budget.md](references/budget.md): a budget on superstables.com step by step, the rails, buying, reconcile, recover and gotchas.
