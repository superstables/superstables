---
name: superstables
description: Find services and request a single purchase through the Superstables MCP server, with account-member approval on superstables.com. Use when this chat has the Superstables tools. Testnet only.
---

# Superstables

Use the connected Superstables tools to find a service and request a purchase.
Testnet only: test tokens, no real money.

- `get_my_account`: read the account and wallets connected to this chat.
- `find_services`: find services, prices, chains and required inputs. No sign-in needed. This pays nothing.
- `request_purchase`: request a service by its `service_id` and inputs. Use a new `operation_id` for each purchase; reuse it when retrying the same request on the same connection.
- `get_purchase_status`: read the purchase's payment status, service response and receipt using its `purchase_id`.

Nothing is paid until an account member approves and signs in their wallet on
superstables.com. When `request_purchase` returns an approval link and match
code, show both to the user and end your turn. Do not approve for them or poll
while waiting. When they say they approved, call `get_purchase_status` and
report what it establishes. If the payment outcome is unknown, say so.

If these tools are missing, or a call fails because the connector is not signed
in, ask the owner to connect it once. If they decline, use the
`superstables-payments` skill and its CLI. Budgets (set up, grant, buy, revoke,
recover) always go through that CLI.
