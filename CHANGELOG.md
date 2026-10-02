# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-01

An owner can now give an agent an on-chain budget once, and the agent buys within it without
an approval per payment: `superstables budget`, on testnets, across three payment rails and
eight chains. The client is now on npm as `@superstables/client`. The release also ships a
standalone agent skill with the whole CLI, makes the CLI usable from its own help and exit codes,
and removes the Claude Desktop bundle.

### Added

- **On-chain budgets: `superstables budget`.** The owner grants a budget once, from their own
  wallet. The agent then buys from sellers on its own, one purchase at a time, until the budget
  is spent, the owner revokes it, or, on Tempo, it expires. The limit is enforced by the chain,
  not by this software. There are three rails:
  - `evm`: a USDC allowance (an ERC-20 approve) from the owner's wallet to an agent key, for
    x402 sellers on Base Sepolia (the default), Arc Testnet, Arbitrum Sepolia, Polygon Amoy,
    SKALE Base Sepolia and Ethereum Sepolia. The USDC stays in the owner's wallet until a
    purchase pulls its price.
  - `tempo`: an access key on Tempo Moderato, spending the owner's pathUSD, for MPP sellers. The
    chain enforces a total cap and an expiry (24 hours by default), plus a period and a seller
    list when the owner sets them. The agent needs no gas.
  - `solana`: the agent key as delegate of the owner's USDC account on Solana devnet, for x402
    sellers.

  On `evm` and `solana` the chain enforces a total cap only: no expiry, no seller list and no
  per-payment maximum, so a stolen agent key could pay any address up to what is left. `buy`'s
  `--max` and `--pay-to` are checks in this CLI, made before it signs. Testnets only: mainnet
  chains are refused.
- **The owner approves budget steps in their own wallet.** `setup`, `fund-agent`, `grant`,
  `revoke` and, on `evm`, `recover` open a page on `127.0.0.1` that shows the terms, including
  what the chain enforces and what it does not. The owner approves there with any EVM browser
  wallet on `evm`, one that can add a custom network on `tempo`, or any Wallet Standard wallet
  (Phantom, Solflare, Backpack, ...) on `solana`. The command then reads the result back from
  the chain and refuses a transaction that does not match the plan. No owner key is created or
  stored on this computer. Run by an agent, an owner command returns at once with the link and an
  approval id; `superstables budget wait --id ID --shown` reports the outcome. `wait` reads
  nothing until the caller passes `--shown`, meaning it has written the link and the terms in a
  reply the owner can read; without it, `wait` exits 2 with `state: "show_owner_first"`. An agent
  can start these commands; only the owner approves. For unattended tests only,
  `--owner-key-file PATH --yes` signs with an owner key file instead.
- **Hosted owner approvals.** `setup --rail R --hosted` links the agent to the owner's
  superstables.com account (Sign-In with Ethereum) and records that account's address as the owner
  (on Solana devnet, the Solana wallet the owner connects there). It works on every rail: EVM
  chains, Tempo Moderato and Solana devnet. Grants, revokes and gas transfers on that chain are
  then approved on superstables.com, in the owner's wallet, from any device where they are signed
  in, after they pick the match code the agent shows them. Each request is signed by the agent key, which stays
  on this computer, and the command still reads the chain before it reports success. A request
  the site would put to another account than the recorded owner is refused. Approvals on
  `127.0.0.1` remain the default and need no account. `recover` uses them only.
  Every `superstables budget` command accepts `--site`; where a site is recorded and it differs,
  the command refuses.
- **One purchase without a budget: `superstables budget buy-once`.** It buys one service the
  owner approves on superstables.com, with no setup, no gas and no budget. The agent names the
  service, its inputs and the most it accepts (`--max`); the owner approves that one payment in
  their wallet, after picking the match code. The result says whether it was paid and delivered,
  and the seller's answer is saved as a file. `superstables budget find --once` lists the
  services that can be bought this way, with the network of each: Base Sepolia or Solana devnet
  (test USDC) or Tempo Moderato (test pathUSD).
- **`superstables budget find`** lists the services superstables.com says a budget can pay, with
  price, chain and URL. Any other seller URL still works.
- **Buying within a budget.** `status` says whether a budget is set up and what is left.
  `preflight` (`evm`) reads a seller's price and payee from its 402 and signs nothing. `buy`
  checks the price against `--max`, and the token, chain and, with `--pay-to`, the payee, before
  it signs; one `--op` id is never paid twice. On `evm` it saves the seller's answer next to the
  purchase journal (at most 1 MB, mode 600) and names it as `responseFile`. Also on `evm`, it
  signs nothing unless the agent key can pay the gas, at the current fee, for the purchase and
  for the steps that return the price if it fails; otherwise it is refused (exit 3) and `next`
  names `fund-agent`. A `buy` with no budget set up is refused with nothing signed, and names
  the owner's steps. `reconcile` reads the chain for a purchase whose outcome is unknown,
  without paying again. `doctor` checks keys, RPC and balances, sizing the `evm` gas minimums
  from the current fee, and `recover` (`evm`) returns stranded USDC to the owner. Every command
  ends with one `RESULT {json}` line, with `final` and a fixed exit code; with `--json`, stdout
  is that object alone.
- **Installs that include the budget.** The package npm builds from this repository includes
  `superstables budget` as a self-contained build, with `THIRD_PARTY_NOTICES.txt`, so its chain
  libraries are not installed as separate packages. It runs from a checkout (`npm ci`; a checkout
  without dev packages runs the built copy), from a package made with `npm pack`, and from git:
  `npm install github:superstables/superstables-client` builds the client during the install.
  Linux and macOS are supported; on Windows, use WSL. `superstables budget` refuses to run on
  native Windows.
- **The `superstables-payments` agent skill.** A skill that walks an agent through finding a
  service, pricing it without paying, and paying it, with safety rules and per-rail references.
  When the owner has not chosen how to pay, it asks once whether they want one purchase they
  approve or a budget. For every approval link, the agent writes the link, the match code and
  the terms in its reply and ends its turn, then checks the outcome when the owner says they
  have approved. `npm run skill` builds `superstables-payments-skill-<version>.zip`: the skill and
  the whole `superstables` CLI, budget included, bundled into plain JavaScript that needs only
  Node 20 or newer (`node <skill folder>/scripts/superstables.mjs`). `--version` names the
  build, and `THIRD_PARTY_NOTICES.txt` lists the bundled packages and their licences.
- **Install from npm.** `npm install -g @superstables/client` installs the `superstables`
  command, with `superstables budget` and the MCP server (`superstables mcp`); the package is
  also the TypeScript SDK. Until this release the client ran only from a checkout of this
  repository, which still works.
- **Help, `--json` and exit codes across the CLI.** Each command's `--help` says what it does,
  whether it can move money, who runs it, an example, what it prints and its exit codes. `find`,
  `quote`, `pay`, `status`, `receipts` and `attempts` take `--json` and print one JSON value on
  stdout; an error under `--json` is `{"error", "exit_code"}`. The CLI and `superstables budget`
  share one table of exit codes: 0 done, 1 failed, 2 bad input, 3 refused, 4 paid but not
  delivered, 5 unknown. `quote` lists each spend-policy rule it checked (`policy.checks` in
  `--json`).
- **`find` says how each listing could be paid.** The table shows each listing's chains, whether
  `pay` can call it, which budget rail and chain could pay it, and whether the seller returns
  simulated data (`yes`, `no` or `not said`). Under each listing it prints the commands to pay
  it each way: `quote` then `pay`, and `preflight` then `buy` (or `buy` alone on `tempo` and
  `solana`). `--budget` lists what a budget rail could pay. `SUPERSTABLES_INDEX_URL=off` turns
  the public index off.

### Changed

- **A payment nobody decided ends `abandoned`.** When `pay --wait` runs out, the `pay` process
  is stopped, or the approval page closes before the owner approves or rejects, the attempt ends
  in the new final state `abandoned`, with `abandoned_by` (`stopped`, `wait` or `page_closed`).
  It is not a rejection, and nothing was submitted. A signature that arrives afterwards is never
  sent.
- **The approval port.** When port 4412 is busy, usually because another payment is waiting for
  its owner, `pay` and the MCP server serve the approval page on a free port and the link names
  it. A port set with `SUPERSTABLES_APPROVE_PORT` is kept as set: when it is busy, the payment
  is refused before the owner is asked, and the same quote can still be paid. The same holds
  when the local wallet does not answer.
- **`pay`'s approval page checks Host and Origin.** It answers only to `127.0.0.1:PORT` or
  `localhost:PORT`, the address it is bound to, so a DNS name rebound to `127.0.0.1` cannot
  reach it. Requests that change state are accepted only from the page's own origin, with a JSON
  body.
- **`pay` on a quote that already started a payment** names that attempt and its state, and how
  to follow it, in the CLI and in the MCP server's `pay` tool.

### Removed

- **The Claude Desktop `.mcpb` bundle**, and `npm run bundle`. It is no longer built or attached
  to releases. The MCP server still runs with `superstables mcp`, from Claude Code or another MCP
  client; `docs/install.md` has example configurations.

### Breaking changes

- **Exit codes.** Usage errors, such as an unknown command or option, exit 2 instead of 1, and
  so does `superstables` with no command. `pay` exits with its outcome: 3 when the owner rejects
  it or a spend policy refuses it, 4 when it was paid but the service failed, 5 when the outcome
  is uncertain, and 1 when it failed, expired or was abandoned. It used to exit 1 for anything
  but `settled`. `quote` exits 3 when the spend policy refuses the payment (it exited 0).
  `status <attempt-id>` exits with the attempt's code, and 0 while it is not final (it exited 0
  for any attempt it found).
- **`status --json`** prints the same object as `pay --json` (`attempt_id`, `quote_id`,
  `state`, `final`, `message`, `next`, `exit_code` and the rest) instead of the stored attempt
  record. `attempts --json` still prints the records as stored.
- **`find --json`.** Every service now carries `mock` (`true`, `false`, or `null` when the
  listing does not say; it used to be absent unless set), `rails`, `chains`, `routes`,
  `commands` and `next` (the first command to run, or `null` when this client cannot pay the
  listing). The text table's columns changed to `chains`, `pay`, `budget`, `live` and
  `simulated`.
- **`abandoned` instead of `denied`.** An approval page that closes before anyone decides used
  to record the attempt as `denied`. It now records `abandoned`, in the CLI, the MCP server and
  the SDK. Code that reads `denied` as "not approved" needs to handle `abandoned` too.
- **The approval link.** It may name a port other than 4412, and the page answers only on the
  port in the link, on `127.0.0.1` or `localhost`. Over SSH, forward the same port number:
  `ssh -L PORT:127.0.0.1:PORT`.
- **No Claude Desktop bundle.** An installed `.mcpb` gets no update. Point the MCP client's
  configuration at `superstables mcp` instead; `docs/install.md` has examples.

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
