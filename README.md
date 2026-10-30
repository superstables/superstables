# Superstables client

Superstables lets coding agents find paid services, check prices and pay for what they need.
With Budgets, you approve an amount in your wallet and the agent can spend within it. Single purchase lets you approve each purchase, both available on your machine or on superstables.com.

**Testnet by default.** Uses test tokens, no real money. Mainnet is off unless the operator sets `SUPERSTABLES_ALLOW_MAINNET`.

## Get started with your agent

You need Node 22+, Linux or macOS, or WSL on Windows, and an agent that can run commands.
Payments also need a compatible wallet and test funds, as described in the guides below.

### The plugin

The [plugin](plugin/) adds one Superstables skill and the Superstables tools at `https://mcp.superstables.com`.
From the next release, each GitHub Release carries one plugin zip per app, `superstables-plugin-<app>-<version>.zip`, with a `.sha256` file beside it:

| App | Zip | Install |
| --- | --- | --- |
| Claude Code | `superstables-plugin-claude-code-<version>.zip` | Unzip it, then `claude plugin marketplace add <folder>` and `claude plugin install superstables@superstables` |
| Codex | `superstables-plugin-codex-<version>.zip` | Unzip it, then `codex plugin marketplace add <folder>` and `codex plugin add superstables@superstables` |
| Claude apps | `superstables-plugin-claude-apps-<version>.zip` | Add the zip as a plugin in the app's plugin settings |
| Cursor | `superstables-plugin-cursor-<version>.zip` | Unzip it into `~/.cursor/plugins/local/superstables`, then reload the window |

In Claude Code or Codex you can also add this repository as the marketplace:

```bash
# Claude Code
claude plugin marketplace add superstables/superstables
claude plugin install superstables@superstables

# Codex
codex plugin marketplace add superstables/superstables
codex plugin add superstables@superstables
```

Start a new session and ask for the service you need. If your agent asks you to connect Superstables, follow its sign-in instructions. The plugin uses the website for everything that needs no key on your machine, and the CLI (run with `npx`) only for what needs a signature from it. If you decline to connect, the CLI does it all.

### Or the connector

An app that takes connectors can add `https://mcp.superstables.com` on its own, without the plugin. It can find services, request a purchase you approve on superstables.com, and read or follow a budget, or get the link to revoke it. Budget set-up, grants, buying under a budget and `pay` need the CLI, which a chat app without a terminal can't run.

### Or the skill zip

1. Follow [Install the client](docs/install.md) to download the skill zip from the GitHub Release.
   It includes the CLI. Unzip it into `~/.claude/skills/` for Claude Code or `~/.agents/skills/` for Codex.
2. Ask your agent:

   > Use the superstables-payments skill to help me set up a small budget for paid services.
   > Explain what I need and show me the approval links. I'll review and sign in my wallet.

For one purchase instead, ask it to find a service, check the price and request your approval.
The agent starts the request; you approve in your wallet.

Keep budgets small. A stolen agent key can spend the remaining budget.
Only the operator turns on mainnet, with `SUPERSTABLES_ALLOW_MAINNET`; leave it unset. Which site and which RPCs your approvals use is set in your own terminal with `superstables owner settings`.
Read the [security model](docs/security.md) before granting a budget: it says what each way of paying protects and what it doesn't, and what mainnet would still need.

## Use the CLI

Install the CLI from npm:

```bash
npm install -g @superstables/client
superstables --help
superstables budget --help
superstables seller credit
```

A seller account at superstables.com keeps prepaid credit, and the fees of referred sales come out
of it. `superstables seller credit` shows the balance and recent top-ups; `superstables seller top-up 25`
adds to it with test USDC on Base Sepolia, paid like any other purchase. The seller API key comes
from `SUPERSTABLES_SELLER_API_KEY` and is never printed. See
[Seller referrals](docs/seller-referrals.md#credit-and-top-ups).

To build it from source instead, follow [Install from a checkout](docs/install.md#from-a-checkout).
Continue with [Budgets](docs/budget.md) or [Single purchase](docs/buy-once.md).
Don't run `npx superstables`; it can download a different package.

## Next steps

- [Installation and agent setup](docs/install.md)
- [Budgets: grant, buy, check and revoke](docs/budget.md)
- [Single purchase: on your machine or on superstables.com](docs/buy-once.md)
- [CLI reference](docs/cli.md) and [budget commands](docs/cli-budget.md)
- [Receipts and interrupted payments](docs/records.md)
- [Seller referrals: claim a listing and verify referrals](docs/seller-referrals.md)
- [Security and spending limits](docs/security.md)
- [Revoke and uninstall](docs/install.md#uninstalling)
- [Contributing](README.md#contributing) and [Changelog](CHANGELOG.md)

## Contributing

From a checkout, run `npm run typecheck`, `npm test`, `npm run build` and `npm run install-check`.
See [Live testnet checks](test/live/README.md) for tests that contact real sellers.

## Open source

[Apache 2.0](LICENSE). Bundled dependencies have their own licences, including LGPL-3.0.
See `dist/budget/THIRD_PARTY_NOTICES.txt` in the build or `scripts/THIRD_PARTY_NOTICES.txt` in the skill zip.
