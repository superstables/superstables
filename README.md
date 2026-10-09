# Superstables client

Superstables lets coding agents find paid services, check prices and pay for what they need.
With Budgets, you approve an amount in your wallet and the agent can spend within it. Single purchase lets you approve each purchase, both available on your machine or on superstables.com.

**Testnet only.** Uses test tokens, no real money.

## Get started with your agent

You need Node 20+, Linux or macOS, or WSL on Windows, and an agent that can run commands.
Payments also need a compatible wallet and test funds, as described in the guides below.

1. Follow [Install the client](docs/install.md) to download the skill zip from the GitHub Release.
   It includes the CLI. Unzip it into `~/.claude/skills/` for Claude Code or `~/.agents/skills/` for Codex.
2. Ask your agent:

   > Use the superstables-payments skill to help me set up a small budget for paid services.
   > Explain what I need and show me the approval links. I'll review and sign in my wallet.

For one purchase instead, ask it to find a service, check the price and request your approval.
The agent starts the request; you approve in your wallet.

Keep budgets small. A stolen agent key can spend the remaining budget.
Read the [security model](docs/security.md) before granting one.

## Use the CLI

Install the CLI from npm:

```bash
npm install -g @superstables/client
superstables --help
superstables budget --help
```

To build it from source instead, follow [Install from a checkout](docs/install.md#from-a-checkout).
Continue with [Budgets](docs/budget.md) or [Single purchase](docs/buy-once.md).
Don't run `npx superstables`; it can download a different package.

## Next steps

- [Installation and agent setup](docs/install.md)
- [Budgets: grant, buy, check and revoke](docs/budget.md)
- [Single purchase: on your machine or on superstables.com](docs/buy-once.md)
- [CLI reference](docs/cli.md) and [budget commands](docs/cli-budget.md)
- [Receipts and interrupted payments](docs/records.md)
- [Security and spending limits](docs/security.md)
- [Revoke and uninstall](docs/install.md#uninstalling)
- [Contributing](README.md#contributing) and [Changelog](CHANGELOG.md)

## Contributing

From a checkout, run `npm run typecheck`, `npm test`, `npm run build` and `npm run install-check`.
See [Live testnet checks](test/live/README.md) for tests that contact real sellers.

## Open source

[Apache 2.0](LICENSE). Bundled dependencies have their own licences, including LGPL-3.0.
See `dist/budget/THIRD_PARTY_NOTICES.txt` in the build or `scripts/THIRD_PARTY_NOTICES.txt` in the skill zip.
