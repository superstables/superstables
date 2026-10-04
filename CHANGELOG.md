# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0]

Approve one purchase in your wallet on superstables.com, or give an agent an on-chain budget to buy within. This release adds `superstables budget`, hosted approvals and a standalone agent skill, with clearer CLI outcomes and payment checks.

Testnet only. Mainnet chains are refused.

### Added

- **Hosted buy once: `superstables budget buy-once`.** Approve one service purchase in your own wallet on superstables.com, without setting up a budget. Supported networks: Base Sepolia, Arc Testnet and Solana devnet with test USDC; Tempo Moderato with test pathUSD. `superstables budget find --once` lists eligible services. The result distinguishes payment from delivery and saves the seller’s response to a file. A site account is required; the existing local `pay` flow needs no account.
- **On-chain budgets: `superstables budget`.** The owner grants spending permission once; the agent then buys without approval for each payment. EVM budgets use a USDC allowance, Solana budgets use a USDC token delegate, and Tempo budgets use a pathUSD access key. Local approvals open a page on `127.0.0.1`.

  | Network | Local budget approvals | Hosted budget approvals |
  | --- | --- | --- |
  | Base Sepolia | Yes | Yes |
  | Arc Testnet | Yes | Yes |
  | Arbitrum Sepolia | Yes | Yes |
  | Polygon Amoy | Yes | Yes |
  | SKALE Base Sepolia | Yes | Yes |
  | Ethereum Sepolia | Yes | No |
  | Tempo Moderato | Yes | Yes |
  | Solana devnet | Yes | Yes |

  EVM and Solana enforce a total spending cap, with no on-chain expiry, seller restriction or per-payment maximum. A stolen agent key can spend what remains to any address. Tempo supports expiry and optional period and seller limits. `--max` and `--pay-to` are client checks. Revocation ends permission once confirmed; it does not reverse payments or return funds already transferred. An EVM purchase whose price was already pulled can still settle. On Arc Testnet, where USDC pays the network fees, `fund-agent` sends the agent native USDC as a plain transfer and checks the agent’s native balance.
- **Hosted budget approvals: `setup --hosted`.** Add an agent to the owner’s account, then approve grants, revokes and gas transfers on superstables.com in the owner’s wallet. After picking the match code on the approval page, the owner uses **Sign with wallet** to sign an owner proof titled “Superstables: add an agent to my account”, naming the site, owner, agent, rail, chain, request ID and code. The client verifies this owner proof before recording an owner. Local approvals remain the default; EVM `recover` remains local.
- **Budget discovery and purchase controls.** `find` filters services by rail or chain and reports whether listings are marked simulated. `preflight` reads payment terms without signing; `buy` checks the price and payment terms before signing. `status`, `doctor`, `reconcile` and EVM `recover` help inspect budgets and resolve unfinished purchases. `reconcile` checks an existing purchase without paying again.
- **The `superstables-payments` agent skill.** The release zip bundles the CLI, including budgets, and needs Node 20 or newer. It guides agents through discovery, payment choice and owner approvals, including showing the approval link and match code before waiting. Git installs pinned to a full commit hash and checkout installs also include budgets. Budgets support Linux and macOS; Windows requires WSL.
- **CLI help and structured output.** Command help includes examples, payment effects and exit codes. Core payment commands accept `--json`; budget commands provide a final `RESULT` object or JSON-only output. `find` shows payment routes and suggested commands, and `quote` reports the policy checks it performed.

### Changed

- Pending `pay` approvals that end without a decision now use `abandoned`, with a cause identifying a stopped process, expired wait or closed page. Late signatures are not submitted. A payment already being sent can instead end `uncertain`.
- Local payment approvals use a free port when the default port, 4412, is busy. An explicitly configured busy port causes refusal before the owner is asked.
- **Payment failure reports preserve uncertainty.** If a seller reports failure but names a payment transaction, `pay` checks it on chain and reports payment when verified, or `uncertain` otherwise. CLI and MCP output include the transaction to check instead of saying nothing was paid. No payment result says nothing was paid while it names a transaction.
- Paying a quote that already has an attempt returns that attempt’s state and instructions for following it, in both the CLI and MCP.

### Removed

- The Claude Desktop `.mcpb` bundle and `npm run bundle`. Configure your MCP client to run `superstables mcp`; existing bundles receive no update.

### Security

- **Hosted request checks.** Agent signatures include the site origin and a nonce; compatible sites must enforce origin matching and nonce reuse checks. `--site`, `SUPERSTABLES_SITE` and recorded sites are limited to superstables.com, its subdomains and loopback unless the owner explicitly allows another origin through `SUPERSTABLES_ALLOW_SITE`.
- **Buy-once amount and outcome checks.** The integer amount to be signed must match the displayed decimal amount, use six decimals and stay within `--max`. Only one purchase may remain open at a time across processes sharing the same state. An unconfirmed cancellation remains `unknown`. A purchase is reported paid only after the configured RPC shows the expected token transfer, amount and recipient.
- **Hosted approvals preserve uncertainty.** Incomplete or mismatched site responses are refused. Once the site reports that the wallet was asked, an unfinished outcome is `unknown`. Hosted Solana transactions are checked against the planned instructions after submission; this detects differences but cannot undo them.
- **Sponsored owner transactions.** On EVM, an owner step sent through a wallet that pays the fee for the owner (MetaMask’s sponsored transactions, relayed through MetaMask’s DelegationManager) counts only on chains where the client pins that contract’s code: Base Sepolia, Arc Testnet, Arbitrum Sepolia and Polygon Amoy. The receipt must carry exactly one `RedeemedDelegation` event from the manager, naming the owner and the transaction’s sender, and the chain must show the step’s effect. On SKALE Base Sepolia and Ethereum Sepolia, only transactions the owner sends itself count. A step the site reports as failed, or a reverted owner transaction, is never reported as settled; missing evidence is `unknown`.
- **Untrusted output.** Seller and listing text is labelled as data in MCP and CLI output. Buy-once results do not repeat arbitrary site text, and hosted access tokens are kept out of output.
- **Payment settlement and spending caps.** Requests carrying payment credentials refuse redirects. `pay` checks Base Sepolia settlement and reports `chain` as `verified`, `unchecked` or `mismatch`; a mismatch makes the attempt `uncertain`. These checks trust the configured RPC. The daily cap now counts pending, in-flight and uncertain payments under a cross-process lock.
- **Key and approval-page handling.** Key loaders refuse files accessible to other users or files that are not regular files. Key writes use private temporary files and atomic replacement. The local wallet keeps the owner secret out of printed output and browser command-line arguments. Local payment approval pages check Host and Origin.
- **Release and package checks.** The skill is built from the exact release export. `prepack` rebuilds from an empty output directory; `prepublishOnly` checks for a clean checkout, release notes, a successful build and current CLI references. These checks do not imply publication to npm.

### Breaking changes

- **Exit codes:** 0 done, 1 failed, 2 bad input, 3 refused, 4 paid but not delivered, 5 unknown. Usage errors now exit 2. `quote` exits 3 for a policy refusal. `pay` and final `status` results use the outcome’s code; non-final `status` results exit 0.
- **`status --json`** now returns the same outcome object as `pay --json`, rather than the stored attempt record. Use `attempts --json` for stored records.
- **`find --json`** adds payment routes, commands and next steps. `mock` is always present as `true`, `false` or `null`. Text table columns have changed.
- **CLI, MCP and TypeScript SDK consumers** must handle `abandoned` separately from `denied`.
- **Approval links may use a different port.** Over SSH, forward the port shown in the link using the same local and remote port number.
- **`wallet init --import-key` is removed.** Use `--import-key-file` with a private, regular file instead.

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
