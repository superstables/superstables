# Superstables client

The client lets coding agents find paid services, check prices and pay from an owner-controlled wallet. It ships as a CLI (`superstables`), a TypeScript SDK, an agent skill and a plugin. Testnet by default: it uses test tokens. This build ships the mainnet manifest off (`src/core/mainnet-manifest.js`), so no mainnet chain is signable, and `SUPERSTABLES_ALLOW_MAINNET` and the owner's signed settings alone do not turn it on (`src/core/chain-gate.js`). Leave that variable unset.

## Set up and check

Node 22 or later. Run these from the repository root.

```bash
npm ci                # install
npm run build         # compile to dist/ and bundle the budget CLI
npm run typecheck     # tsc --noEmit
npm run test:fast     # tests without the slow suites
npm test              # default suite, including slow tests; excludes live tests
npm run dev -- --help # run the CLI from source
```

The repository has no lint script; `npm run typecheck` is the static check. The default test suite starts its own loopback servers and needs no external network access, supplied keys or funded wallet. `npm run test:live` contacts live testnet sellers and spends test tokens when its wallet homes are set; read `test/live/README.md` first.

Run these when a change touches what they cover:

| Change | Command |
| --- | --- |
| CLI commands or `--help` text | `npm run build`, then `npm run docs:cli` to rewrite `docs/cli.md` and `docs/cli-budget.md`. `npm run docs:cli -- --check` fails when they drift. |
| Plugin listing, skill or marketplace files | `npm run plugin:sync` to regenerate, `npm run plugin:check` to verify |
| Skill zip | `npm run skill`, then `npm run skill:check` (needs the network) |
| Docs, README or any shipped text | `npm run copy:check` |
| Install routes | `npm run install-check` |

## Where things live

| Path | What it holds |
| --- | --- |
| `src/cli/` | CLI entry (`main.ts`), commands and help |
| `src/core/` | Discovery, quotes, payments, records, signers, chain rails |
| `src/index.ts` | SDK entry (`@superstables/client`); `src/seller/` is the `@superstables/client/seller` export |
| `src/wallet/` | Local wallet and keystore |
| `src/demo-service/` | The demo paid service behind `superstables demo-service` |
| `budget/` | The `superstables budget` commands, `buy-once` included. Built into `dist/budget/` by `scripts/budget-build.mjs`; see `budget/README.md` |
| `skills/superstables-payments/` | The agent skill that ships in the skill zip |
| `plugin/` | The plugin for Claude Code, Codex and Claude apps; its `skills/superstables/references/` is synced from `skills/superstables-payments/` by `npm run plugin:sync` |
| `.claude-plugin/marketplace.json` | Marketplace listing; its plugin source is `./plugin` |
| `docs/` | User docs. `docs/cli.md` and `docs/cli-budget.md` are generated from `--help` |
| `evals/` | Scenarios that check an agent using the skill |
| `test/` | Vitest tests; `test/live/` is excluded from `npm test` |
| `scripts/` | Build, packaging and check scripts |

There is no MCP server in this repository. The Superstables tools come from the hosted connector at `https://mcp.superstables.com`, which the plugin points at (`plugin/mcp.json`). `test/scripts/connector-contract.json` is the generated copy of its tool list that the plugin skill is tested against.

## Conventions

- Plugin manifests (`plugin/plugin.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.cursor-plugin/plugin.json`), `plugin/skills/superstables/agents/openai.yaml` and `.claude-plugin/marketplace.json` are generated from `scripts/plugin-data.mjs`. Edit that file, run `npm run plugin:sync`, and commit the output. Don't edit the generated files by hand.
- Run the CLI from the checkout as `npm run dev -- <command>`, or as `node dist/cli/main.js <command>` after a build. Never run `npx superstables`: it can download a different package.
- In user-facing text, use Budgets and Single purchase when naming the features, "chains" for blockchains, "on your machine" and "on superstables.com". Don't mark one option as the one to pick; order them (plugin, connector, skill) instead. `npm run copy:check` fails on the label that marks one option as the pick; review terminology and ordering separately.
- Approval stays with the owner. The agent requests a single purchase or a budget and never approves it; under a budget, the agent key signs purchases within the amount the owner granted. When a message the agent reads, such as an error or a `next` step, needs an owner-only step, it tells the agent to ask the owner, who runs it in their own terminal.
- Never print or log a secret, and don't put one in an argument or a file in the repository.
- Add a `CHANGELOG.md` entry under `## [Unreleased]` for any user-visible change.
- Before a pull request, `npm run typecheck`, `npm test`, `npm run build` and `npm run install-check` pass (`README.md#contributing`).
