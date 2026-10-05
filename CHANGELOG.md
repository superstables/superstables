# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0]

Give an agent a budget. You approve a spending limit once, in your own wallet, and the agent then buys compatible services within it without asking you each time. You can revoke the budget by signing a transaction in your wallet. Budgets work on eight chains, and you can approve them on your machine or on superstables.com. Single purchase, where you approve one purchase in your wallet, now works on superstables.com as well as on your machine. This release also adds a standalone agent skill.

Testnet support only. Mainnet chains are refused.

### Added

- **Budgets: `superstables budget`.** The owner grants a budget once; the agent then buys from compatible sellers without approval for each payment, until the budget is spent, revoked or, on Tempo, expired. Budgets pay compatible x402 sellers on EVM chains and Solana, and MPP sellers on Tempo. Approvals happen in the owner's own wallet, on a page on this machine (`127.0.0.1`) by default, or on superstables.com with `setup --hosted`.

  | Chain | Approve on this machine | Approve on superstables.com |
  | --- | --- | --- |
  | Base Sepolia | Yes | Yes |
  | Arc Testnet | Yes | Yes |
  | Arbitrum Sepolia | Yes | Yes |
  | Polygon Amoy | Yes | Yes |
  | SKALE Base Sepolia | Yes | Yes |
  | Ethereum Sepolia | Yes | Yes |
  | Tempo Moderato | Yes | Yes |
  | Solana devnet | Yes | Yes |

  Budgets use test USDC, or test pathUSD on Tempo Moderato. A budget stays on the chain it was granted on. On every chain except Tempo, the chain enforces only the total amount: there is no expiry, seller restriction or per-purchase maximum, and anyone holding the agent's key can spend what remains, to any address. On Tempo, a budget expires after 24 hours by default and can be limited to certain sellers. A period limit refills each period, so total spending before expiry can exceed one period's amount. `--max` and `--pay-to` are checks made by the client, not by the chain. Revoking ends the permission once the transaction is confirmed; it does not reverse or refund payments already made, and an EVM purchase whose payment was already taken can still complete. On Tempo, a revoked or expired agent key must be replaced, and revoking doesn't close payment sessions the key already opened.
- **Approving budgets on superstables.com: `setup --hosted`.** The owner adds the agent to their superstables.com account, then approves grants, revokes and gas transfers there in their wallet. The agent shows an approval link and a match code. The owner picks that code on the site and chooses **Sign with wallet** to sign an owner proof titled “Superstables: add an agent to my account”, which names the site, owner, agent, chain, request and code. The client checks this proof before it records an owner. Approving on this machine remains the default, and EVM `recover` is always local. If a Solana or Tempo agent key is missing or unsafe, the CLI can't revoke on the site; revoke on superstables.com or from your wallet instead.
- **Single purchase:** approve one purchase in your wallet, on your machine or on superstables.com. New in this release, `superstables budget buy-once` lets you approve on superstables.com, with no budget, `setup` or agent key. It works on Base Sepolia, Arc Testnet and Solana devnet with test USDC, and on Tempo Moderato with test pathUSD. A superstables.com account is required; on your machine, `pay` needs none. `superstables budget find --once` lists the services you can buy this way. The result says separately whether the payment was made and whether the service delivered, and saves the seller's response to a file.
- **Owner approvals an agent starts.** Owner commands that need wallet approval normally wait in a terminal and return once the approval link is ready outside a terminal. Use `--wait` to make them wait, or `--detach` to return once the link is ready. The agent writes the link, the match code when there is one, and the terms in a reply the owner can read, then follows the approval with `wait --id ID --shown`. `--shown` declares that it has done so. `wait` exits 0 while the approval is still open (`final: false`).
- **Finding and checking purchases.** `find` filters services by chain; listings still say whether they are marked as simulated. `preflight` reads a service's payment terms without signing; `buy` checks the price and terms before signing. `status`, `doctor`, `reconcile` and EVM `recover` help inspect budgets and settle unfinished purchases; `reconcile` checks a purchase without paying again. If a later owner step in `recover` (a gas transfer, or the owner's own revoke) expires, is rejected, fails or ends unknown, the result still lists the revoke transactions already sent and what was read before that step, instead of saying nothing was sent.
- **The `superstables-payments` agent skill.** The release zip bundles the whole CLI, including budgets, and needs Node 20 or newer on Linux or macOS (Windows through WSL). It guides an agent through finding a service, choosing how to pay and asking the owner for approval, including showing the approval link and match code before it waits. For a first budget it uses the chain the owner named, or otherwise proposes Base Sepolia. Before proposing a chain for a service, it checks that the service accepts a budget there, and asks rather than switching. Approving on this machine stays the default; owners who come from the setup page on superstables.com are offered approval there first. Git installs pinned to a full commit hash, and installs from a checkout, include budgets too.
- **CLI help and structured output.** Command help includes examples, what each command can pay and its exit codes. Core payment commands accept `--json`; budget commands end with a `RESULT` object or print JSON only. `find` shows how each service can be paid and the command to use, and `quote` reports the policy checks it made.

### Changed

- **Single purchase on your machine (`pay`) on every budget chain.** `pay` was Base Sepolia only. It now pays x402 sellers with test USDC on Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia, Ethereum Sepolia and Solana devnet, and MPP sellers with test pathUSD on Tempo Moderato. On Tempo the owner's wallet sends the payment itself, and `pay` reads it on chain before it calls the seller. On the EVM chains and Tempo, the approval page asks your wallet to switch to the payment's chain. For Solana payments, use a Solana wallet such as Phantom and select Solana devnet before signing. The default spend policy accepts pathUSD, and the daily cap counts USDC and pathUSD together. `--wallet local` signs on the EVM chains only.
- **Single purchase on your machine (`pay`):** an approval that ends without a decision is now `abandoned`, with a cause: the process stopped, the wait expired or the approval server was closed. A signature that arrives late is not submitted. A payment already being sent can end `uncertain` instead.
- Local payment approvals use a free port when the default, 4412, is busy. If you configured a port explicitly and it is busy, the client refuses before asking the owner.
- **Single purchase on your machine (`pay`):** once a payment has left your machine, a seller's refusal no longer ends it `failed`. It stays `uncertain` until `superstables status` finds the payment on chain, or the chain shows it can no longer happen (`failed`, with chain `unpaid`). A success the seller reports without a transaction the chain confirms is reported as the seller's word. An unresolved payment counts against the daily cap on later days too while it can still move money: an EVM authorization until its expiry plus two minutes, a Tempo or Solana payment until a chain check resolves it. That includes one with a receipt the chain has not confirmed.
- **Single purchase on your machine (`pay`):** when a seller reports a failure but names a payment transaction, `pay` checks that transaction on chain and reports the payment when it is confirmed, or `uncertain` otherwise. CLI and MCP output then show the transaction to check. A transaction hash alone never establishes that nothing was paid. A later chain check can report `failed` with `chain: "unpaid"` while keeping a transaction the seller reported.
- `quote` no longer follows redirects, and it stops reading a response past a size limit.
- Paying a quote that already has an attempt returns that attempt's state and how to follow it, in both the CLI and MCP.
- **Single purchase on superstables.com (`buy-once`):** when a purchase no longer needs action from the owner but its payment outcome is not known, `wait` and a blocking `buy-once` report `unknown` (exit 5), never “waiting for the owner”. A new `buy-once` is refused (exit 3) while that purchase is still open. If the site never ends it, the owner can run `superstables budget wait --id ID --abandon` to mark its local record abandoned so another purchase can start. This doesn't cancel it on the site, and its payment stays unknown.

### Removed

- The Claude Desktop `.mcpb` bundle and `npm run bundle`. Configure your MCP client to run `superstables mcp`; existing bundles receive no update.

### Security

The full model is in [docs/security.md](docs/security.md).

- **Requests to superstables.com.** Requests that set up hosted budget approvals are signed and include the site's origin and a one-time value, so a compatible site can refuse a request meant for another site or sent twice. The site for hosted approvals can only be superstables.com, its subdomains or this machine, unless the owner allows another with `SUPERSTABLES_ALLOW_SITE`. Incomplete or mismatched answers from the site are refused, and access tokens are kept out of output.
- **Single purchase on superstables.com checks.** The client checks that the amount the site asks you to sign matches the amount it displays and stays within `--max`; still check the request in your wallet. Only one single purchase on superstables.com can be open at a time among processes sharing the same client state. A purchase is reported paid only after the chain shows the expected transfer, amount and recipient; a cancellation that isn't confirmed stays `unknown`.
- **Outcomes stay honest.** Once the site reports that the owner's wallet was asked, an unfinished outcome is `unknown`, not failed. On Solana, transactions approved on the site are checked against the plan after they are sent; this detects a difference but cannot undo it. A step the site reports as failed, or a reverted owner transaction, is never reported as settled.
- **Wallet-sponsored owner transactions.** On EVM chains, an owner step sent through a wallet that pays the fee for the owner, such as MetaMask's sponsored transactions, counts only on Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy and Ethereum Sepolia. The transaction must go through MetaMask's delegation contract, whose code the client pins. The receipt must contain that contract's record of the redemption, and the chain must show the step's effect. Chain evidence that can't be read is `unknown`; a readable receipt without the required evidence is refused. On SKALE Base Sepolia, only transactions the owner sends directly count.
- **Recorded owners on Solana and Tempo.** A recorded owner is replaced only with `--new-owner`. `revoke` refuses while the client's two records of the owner disagree.
- **Seller text is data.** Seller and listing text is labelled as data in MCP and CLI output, and results of Single purchase on superstables.com don't repeat arbitrary site text.
- **Payments and the daily cap.** Requests that carry a payment refuse redirects. `pay` checks settlement on the payment's chain and reports `chain` as `verified`, `unchecked` or `mismatch`; a mismatch makes the attempt `uncertain`. These checks trust the configured RPC; on Solana, a custom RPC address is not checked to be devnet. The daily cap now counts pending, in-flight and uncertain payments, across processes.
- **Keys and approval pages.** Key files that other users can read, or that aren't regular files, are refused. Key files are created private, and replacements are written atomically. The local wallet keeps the owner secret out of printed output and browser command lines. Local approval pages check Host and Origin.
- **Release builds.** The skill is built from the exact release export. `npm pack` rebuilds from an empty output directory, and `npm publish` also checks for a clean checkout, release notes, a successful build and current CLI references. This release is not published to npm.

### Breaking changes

- **Exit codes:** 0 done (or, for `wait`, `buy-once` and owner commands, still waiting with `final: false`), 1 failed, 2 bad input, 3 refused, 4 paid but not delivered, 5 unknown. Usage errors now exit 2, and `quote` exits 3 when policy refuses. `pay` and final `status` results use the outcome's code; non-final `status` results exit 0.
- **`status --json`** returns the same outcome object as `pay --json`, not the stored attempt record. Use `attempts --json` for stored records.
- **`find --json`** adds payment routes, commands and next steps, and `mock` is always present as `true`, `false` or `null`. Text table columns have changed.
- **CLI, MCP and TypeScript SDK users** must handle `abandoned` separately from `denied`.
- **Approval links may use a different port.** Over SSH, forward the port shown in the link, with the same local and remote port number.
- **`wallet init --import-key` is removed.** Use `--import-key-file` with a private, regular file.

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
