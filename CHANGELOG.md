# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - Payment recovery and budget set-up on superstables.com

Draft release notes. Wording review is pending.

Testnet only.

### Before upgrading

Stop every 0.3.0 client process before upgrading, including agents, servers and approval processes. On macOS, a 0.3.0 process in another time zone can misjudge a live lock holder. Downgrading to 0.3.0 loses the new reorg and finality recovery rules.

### Added

- Payment results now include `chain_final`, and SDK attempts and receipts include `chainFinal`. These report chain finality separately. `final` still means command completion, and `chain: verified` still means a matching payment was found on chain. A completed command can describe a payment that is not final yet.
- The owner can clear a stale budget lock with `superstables budget unlock --confirm`. Run it in a terminal and type the operation ID when asked. It preserves the journal and permits reconciliation, never a second payment. Locks whose host or process identity cannot be read need the owner's decision.

### Changed

- The installation docs now use npm: `npm install -g @superstables/client`. The npm package holds the `superstables` command; install the agent skill separately. See [Installation](https://superstables.com/docs/client).
- When superstables.com's setup page brings an agent to the skill, the agent sets up a budget with approval on superstables.com (`setup --hosted`) without asking where to approve. Otherwise the page on your machine stays the default, and it remains the fallback.
- With no budget and no owner on record, `superstables budget status` and `superstables budget buy` also print the one-link set-up on superstables.com, after the steps on your machine.
- The package links to the public repository, `github.com/superstables/superstables`.

### Payment recovery

- A proven reorg turns an earlier `verified` payment into `uncertain`, with `chain: unchecked`. Report the unknown outcome and do not pay again. Missing receipts, pruned history and RPC errors preserve earlier payment evidence. `status` rechecks legacy and provisional payments while finality is unknown; final evidence remains final.
- An included payment counts against the daily cap once, on its paid day. Pending or unreadable finality does not charge later days. A removed inclusion stays uncertain and holds its approved amount across days.
- Before `pay`, earlier-day seller reports without matching inclusion or final unpaid evidence are rechecked, even when they no longer reserve today's cap. The current spend policy is also checked before refreshing the seller's terms.
- Mismatches still become uncertain and `status` searches by the original payment identity. The rejected transaction itself cannot count as payment. Non-final failed or empty-effect executions can be checked again after a reorg.
- Single purchases on superstables.com now check the payment's full identity and retain a durable claim to prevent the same transaction from counting for another purchase. Older paid records keep their paid result with an explicit note that attribution was not verified by the older client. Explicit conflicting payer evidence still invalidates them.
- A paid single purchase with pending finality keeps `final: true`; a later `wait` can check finality or detect removal. A non-final failed execution remains readable by `wait`, with `final: false`, until a final outcome. A removed inclusion stays unknown and may stay open indefinitely. `wait --abandon` ends local waiting without proving unpaid or permitting repayment.
- Budget recovery requires final chain evidence before concluding a cancellation, missing payment or return of funds. Solana history scans are bounded and resumable; Tempo reads check canonical inclusion. Recovery messages name installed `superstables budget reconcile` commands and show scan progress.
- Budget buys and reconciliation share operation locks. A busy operation returns `unknown` with `reason: op_in_progress` and exit 5. A crashed reconciliation that returns no result reports payment as unknown rather than unpaid. Concurrent SDK updates preserve final payment evidence.
- Record listings may include `chainReason` for pending finality, `paymentIncluded`, `paymentBlock`, and `chain_mismatch` in CLI JSON or `chainMismatch` in the SDK. These add evidence without changing payment identity, service responses or approval facts. No automatic payment retry is added.


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
