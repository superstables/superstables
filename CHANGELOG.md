# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

Once a payment may have moved, the client reports it as unknown, never as unpaid:

- `superstables receipts` with no receipts names the attempts that may have paid (approved, in flight or uncertain), and otherwise says no receipt is recorded. It said no payment had been made. Whether any receipt exists is now read from all of them: `--limit 0` said no payment had been made even after a settled one.
- `superstables budget wait` answers `unknown` (exit 5, `final: false`) for an open owner approval once the owner's wallet was asked to send. It answered `waiting_owner` (exit 0) and said the owner had not finished approving.
- `superstables budget wait` without `--shown` reads an owner approval whose wallet was asked, and a single purchase on superstables.com that showed payment evidence. It answered that the purchase was not approved or paid yet. When this machine has not seen the owner act, `wait` without `--shown` still refuses (exit 2, `show_owner_first`), and now says it read nothing, so it says nothing about whether the owner approved or paid.
- `superstables budget buy` with the `--op` of a purchase that is still `submitted` or `unknown` answers `unknown` (exit 5) and points to `reconcile`, also when the agent key file is missing or unsafe. It answered `refused_precheck` (exit 3), and with a missing or unsafe key file also `paid: false`.
- `superstables budget buy` with an `--op` that another buy or reconcile is working on answers `unknown` (exit 5), since that process may be paying. It answered `refused_precheck` (exit 3).
- An owner command (`grant`, `fund-agent`, `revoke`, `setup` with `--grant` or `--fund`) whose transaction landed on chain but did not match the plan, such as another amount or recipient, answers `unknown` (exit 5) with the reason and the next step to revoke. It answered `refused_precheck` (exit 3), the answer for an approval that sent nothing.
- The owner approval page on this machine says the outcome is unknown, and its state reports `unknown` with `sending: true`, once the owner's wallet was asked to send and the approval was then rejected, expired, or could not be confirmed on chain. It reported `rejected`, `expired` or `failed`, and the page showed an expired link or a failure.
- `superstables budget buy-once --replace` whose cancel the site answers with the payment under way reports the open purchase as `pending.state: "unknown"`. It reported `waiting_owner`, from the record read before the cancel.
- On EVM chains, a purchase whose pull landed and can no longer settle stays `unknown` (exit 5) until the pulled price is back with the owner. It was `failed` with `paid: false`. `superstables budget recover` returns the price, and `superstables budget reconcile` names it as the next step.
- On EVM chains, `superstables budget recover` returns the rest of a price that an earlier return gave back only in part. It sent no further return, so the purchase stayed `unknown` however often `recover` ran.
- Once an owner command's wallet was asked to send, or the command began to broadcast with an owner key file, `failed` (exit 1) means the chain proved the transaction changed nothing. The new `proof` field says how: `reverted`, or on Solana `blockhash_expired`. Any other end is now `unknown` (exit 5), including a script that stopped with an error, a chain read that failed or disagreed with the plan after the transaction landed, and a later step of `setup` or `recover` refused after an earlier one sent. These answered `failed` (exit 1) or `refused_precheck` (exit 3). A finished approval that `superstables budget wait` reads back is answered the same way.
- On Solana, `superstables budget fund-agent` reports a transfer whose transaction moved the planned SOL as done, even when the agent's balance reads lower afterwards because it spent some or the node lags behind. It answered `failed` (exit 1). With an owner key file, where the command reads only the balance, a balance that does not show the transfer is `unknown` (exit 5).
- The owner approval page on this machine shows the outcome as unknown when the command stops with an error after the page reported the transaction, or when the chain still shows a budget after a revoke the wallet sent. The page stopped answering, or showed a failure.
- `superstables budget wait` for a `recover` whose background process stopped answers `unknown` (exit 5) when the owner's wallet was asked on its first approval page. It answered `refused_precheck` (exit 3) when the second page had not asked the wallet yet.
- A background `superstables budget recover` that sent the agent's own revoke before it needed the owner answers `unknown` (exit 5), and so does every later `superstables budget wait`, when its process stops without a result or opens no approval page in time. It answered `failed` (exit 1), or `refused_precheck` (exit 3) with no submission recorded. When it then opens the owner's page, it answers `unknown` (exit 5, `final: false`) with the approval link, not `waiting_owner`.
- `superstables budget setup` on superstables.com with `--grant` and `--fund` whose gas landed and whose grant then reverted answers `unknown` (exit 5), with a reason that starts with `partly_done`. It answered `failed` (exit 1). Each entry in `steps` keeps its own state.
- An owner command whose transaction reverted on chain, but was not the planned call from the owner (another sender, recipient, call or amount), answers `unknown` (exit 5). It answered `failed` (exit 1) with `proof: "reverted"`.
- On Solana, a transaction the owner's page sent counts as expired only when the chain reports no status for it from a node that has reached the block height that shows its blockhash expired. A node that lagged behind could make a transaction that later landed read as `failed` (exit 1).
- An owner command started in the background answers `unknown` (exit 5) when its background process opened no approval page and could not be stopped, because that process may still send a transaction. It answered `failed` (exit 1).
- When the owner's transaction is not the planned call, the owner approval page on this machine and the command's `reason` name what differs, such as the spender or the amount its call approves, without nested parentheses. When that transaction reverted or failed on chain, they say so. They said only that the wallet changed the transaction data, with the spending cap as an example.

An owner's sign-in on the approval page, which signs a message and sends nothing, no longer counts as the wallet being asked to send. For a `setup` whose page log recorded the sign-in, `superstables budget wait` answered `unknown` (exit 5) and said the owner's wallet was asked to send.

## [0.3.1] - Safer payment recovery

This release makes budget payments and single purchases on superstables.com safer to recover. Agents arriving from superstables.com's setup page are directed to approval there.

Testnet only.

Stop every 0.3.0 client process before upgrading, including agents, servers and approval processes.

On Linux, run commands sharing a client home either inside the same sandbox or outside it. Mixing the two can exceed the daily cap or misreport an approval as "abandoned"; do not pay again on that status alone. To clear a lock, the owner must first stop every process working on that operation, then run `superstables budget unlock --confirm` in their own terminal, outside any agent's sandbox.

- For scripts: the additive `chain_final` CLI and `chainFinal` SDK fields report chain finality. `final` and `verified` keep their 0.3.0 meanings. An included payment with provisional or legacy evidence can become uncertain again after a reorg; treat uncertain as "don't pay again". Established final proof stays final.

The installation docs cover `npm install -g @superstables/client`.

For cap accounting, chain evidence rules and recovery commands, see [`budget/CLI.md`](https://github.com/superstables/superstables/blob/v0.3.1/budget/CLI.md).


## [0.3.0] - Agent budgets and single purchases

Give an agent a budget to buy compatible services without approving each purchase. Approve the budget in your wallet, and revoke it by signing a transaction.

Testnet only: test tokens, no real money.

### Added

- Budgets on eight chains, with budget approvals on superstables.com or on your machine. Limits differ by chain. See [Budgets](https://superstables.com/docs/client/budget).

  | Chain | Approve on your machine | Approve on superstables.com |
  | --- | --- | --- |
  | Base Sepolia | Yes | Yes |
  | Arc Testnet | Yes | Yes |
  | Arbitrum Sepolia | Yes | Yes |
  | Polygon Amoy | Yes | Yes |
  | SKALE Base Sepolia | Yes | Yes |
  | Ethereum Sepolia | Yes | Yes |
  | Tempo Moderato | Yes | Yes |
  | Solana devnet | Yes | Yes |

- Single purchase on superstables.com, with wallet approval for each purchase and no budget or agent key required. Available on Base Sepolia, Arc Testnet, Solana devnet and Tempo Moderato. See [Single purchase](https://superstables.com/docs/client/buy-once).
- A standalone agent skill that includes the CLI. See [Installation](https://superstables.com/docs/client).

### Changed

- Single purchase on your machine (`pay`) expands from Base Sepolia to all eight supported chains. See [Single purchase](https://superstables.com/docs/client/buy-once).
- Unresolved payments remain uncertain until evidence resolves them, and count against the daily cap while they can still move money. See [Payment records](https://superstables.com/docs/client/records).
- Scripts need updates for changed exit codes, `status` and `find` JSON, and the `abandoned` outcome. Replace `wallet init --import-key` with `--import-key-file`. Approval links may use a different port; over SSH, forward the port shown. See [CLI reference](https://superstables.com/docs/client/cli).

### Security

- Added checks for approval requests, payment amounts, chain confirmation and key-file permissions. Budget authority differs by chain: on EVM and Solana, anyone holding the agent key can spend the remaining budget to any address. Read the [security model](https://superstables.com/docs/client/security).

## [0.2.0] - 2026-09-22

Discovery reads the hosted catalogue of prepared demo services and ranks matches by
relevance; the docs say where the Claude Desktop bundle comes from.

### Added

- **The hosted catalogue, behind a demo switch.** With `SUPERSTABLES_DEMO_SERVICES=on` (set by
  the Claude Desktop bundle, the demo setup snippets and `find --demo`), discovery also reads
  `https://www.superstables.com/api/demo/catalogue`, where the website publishes its prepared
  demo services with their request parameters, so a new demo service there reaches demo users
  without a client release. Off, the default, the catalogue is never read and no simulated
  listing appears. Simulated listings (`mock: true`) always come after the real sellers. The
  built-in listings stay authoritative for the ids they know and still work with no network. A hosted entry this release cannot pay (another network, no payout
  address configured) is listed with the reason. When the catalogue cannot be read, discovery
  carries on from the built-in listings and says so in `warnings`. `SUPERSTABLES_CATALOGUE_URL`
  points at another deployment; the empty string or `off` disables it. Listings gained two
  optional fields, `mock` (the seller says its output is prepared, simulated data) and
  `examplePrompts`. A hosted entry whose endpoint is not https (other than on this machine) is
  listed but not payable, with the reason.

### Changed

- **Ranking.** `find` and `find_services` now order catalogue matches by how well the words of
  the query match each listing's own id, name, description and parameters (stopwords ignored,
  word stems matched), put index listings after them, and reserve the demo vocabulary
  ("bitcoin", "price", "testnet"...) for the market data service alone, so a dozen prepared
  services no longer crowd out the index. The hosted catalogue and the index are read side by
  side, only the listings being returned are probed, in parallel, and a failed catalogue read
  is remembered for a minute rather than retried on every call. The CLI's `find` table gained a
  `simulated` column.
- The README and `docs/install.md` now say where the Claude Desktop bundle comes from: the
  `.mcpb` is never committed to the repository, users download it from the GitHub Release,
  where it is built from the exact tagged commit, and `npm run bundle` exists only to install
  an unreleased build from a checkout.

## [0.1.0] - 2026-09-18

The first release of the Superstables client: a TypeScript SDK, a local MCP server and a CLI
that let an agent find a service that charges per request, ask it what a call costs, and pay for
it — only after the owner has looked at the amount, the asset, the network and the recipient and
said yes.

The key stays where it already was. In the default mode that is MetaMask: the client serves an
approval page on `127.0.0.1`, the owner connects their wallet there, and MetaMask signs. The
agent can ask for a payment and can never approve one. This release is a testnet
demonstration — it pays in test USDC on Base Sepolia over [x402](https://x402.org) — so no real
money moves.

### The flow

- **Find.** List services that can be paid for, and say which ones the client can actually call
  and why the others cannot be.
- **Quote.** Read a service's HTTP 402 challenge and write down its exact terms. Free, and
  nothing is signed.
- **Approve.** `pay` stops and hands back an approval link. The page shows the amount, the
  asset, the network and the recipient, all derived from the seller's own payment requirement
  rather than from anything the agent said; what the agent claims the payment is *for* is shown
  separately and marked unverified. The owner approves in MetaMask, or in a local wallet
  process on a machine with no browser.
- **Pay.** A public facilitator submits the transfer and pays the gas, the service answers, and
  a receipt with the transaction hash is written.
- **Refuse.** A rejected payment — on the page or in MetaMask's own popup — signs nothing,
  submits nothing, and never calls the service. The agent is told so plainly.

### In pictures

Installing the Claude Desktop bundle and running `superstables setup`:

![Install](https://raw.githubusercontent.com/superstables/superstables-client/main/docs/images/0-install.png)

Claude Desktop asking permission before the agent uses a tool:

![Tool permissions](https://raw.githubusercontent.com/superstables/superstables-client/main/docs/images/1-permissions.png)

The approval page next to MetaMask's signature request, both showing the same payment:

![Approve in MetaMask](https://raw.githubusercontent.com/superstables/superstables-client/main/docs/images/2-approve.png)

The agent returning the service's answer and the transaction link:

![The result](https://raw.githubusercontent.com/superstables/superstables-client/main/docs/images/3-result.png)

### What is supported

x402 with the `exact` scheme, on Base Sepolia (`eip155:84532`), paying in USDC. Any other
scheme, network or asset is refused before the owner is asked to sign anything. There is no
mainnet switch and no unattended mode.

### Interfaces

Six MCP tools over stdio, for Claude Code, Claude Desktop or any other MCP client:

- `find_services` — search for payable services and say which are actionable
- `quote` — read a service's terms and record them; nothing is signed
- `pay` — ask the owner to approve a quote, return the `approval_url`, then pay and return the
  service's answer
- `payment_status` — wait for an attempt to finish and report where it got to
- `wallet_status` — which signer is in use, and its address, network, balance and policy, plus
  the `client_version` and `home` of the server that answered, so a host running an older build
  than the one just installed can be told apart from one running the new one
- `list_receipts` — the payments that settled on this machine

The `superstables` CLI does the same work from a terminal: `setup`, `doctor`, `find`, `quote`,
`pay`, `status`, `receipts`, `attempts`, `policy show` / `policy init`, `mcp`, `demo-service`,
and `wallet init` / `wallet serve` / `wallet status` for the local wallet. `superstables
--version` prints the version of the build that is running, `doctor` prints it and the home
directory above its checks, and the MCP server logs the same three facts to stderr on start.
The same code is published as a TypeScript SDK.

### Records and state

Every quote, attempt, approval and receipt is appended to JSONL files in `~/.superstables`, mode
0600, and nothing outside that directory is written. An attempt is an explicit state machine:
`awaiting_approval` → `denied`, `expired`, `failed`, or `approved` → `submitting` → `settled`,
`paid_service_failed`, `failed` or `uncertain`. `failed` means the money did not move and that
is known; `uncertain` means the credential left the machine and what became of it is not, and
the client never retries it automatically. A receipt exists exactly when money moved.

`policy.yaml` holds a per-payment cap, a daily cap, an allowed-host list and a kill switch.
These are checks in this software, on the owner's machine — not on-chain limits.

### Something to buy

Superstables hosts the demo seller, a real x402 market-data service on the testnet, so there is
something to pay for without anyone running a seller. The catalogue also lists a third-party
x402 service on Base Sepolia, run by an independent developer, so a payment to a seller nobody
at Superstables controls can be shown too. `superstables demo-service` runs the seller locally
for anyone who wants to watch that side of a payment.

### Claude Desktop bundle

`npm run bundle` builds `build/superstables-<version>.mcpb`, an MCP bundle that installs into
Claude Desktop through Settings → Extensions → Advanced → Install Extension…. Both Claude Code
and Claude Desktop have been tested end to end with the MetaMask flow.

`npm run bundle -- --dev` stamps the staged bundle — never the repository's own files — with a
version derived from the commit, for example `0.1.0-dev.14+gabc1234`, so that two development
builds of the same release are never called the same thing and a host cannot silently keep the
copy it already has. [docs/install.md](docs/install.md) says how to update an installed
extension and how to confirm which build is running.

### Known limitations

- Testnet only: one network (Base Sepolia), one asset (USDC), one scheme (x402 `exact`).
- MetaMask's signature popup shows the value in USDC's smallest unit, so `10000` is 0.01 USDC.
  The approval page prints the conversion, but the popup is what it is.
- Listings from the public Superstables index are shown but cannot be paid yet: the index does
  not record the request parameters a service needs, and each listing says so.
- An attempt that ends `uncertain` is never retried automatically; it has to be looked at.
- With `--wallet local` the key is a file on the machine, readable by any process running as the
  owner. That mode exists for a machine with no browser.

[Unreleased]: https://github.com/superstables/superstables-client/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/superstables/superstables-client/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/superstables/superstables-client/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/superstables/superstables-client/releases/tag/v0.1.0
