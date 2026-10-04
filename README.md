# Superstables client

Superstables connects service discovery, pricing and payment for AI agents. Approve one purchase
in your wallet, or grant a budget the agent can spend within.

This repository is the client: the `superstables` command with its `superstables budget` tool, an
MCP server, a TypeScript SDK and the `superstables-payments` agent skill. Agent payments use test
tokens on test networks: USDC, or pathUSD on Tempo Moderato. There is no mainnet mode.

## Get started

Use a budget when the agent should make several purchases within an owner-approved cap. Start
with [Install the client](docs/install.md) and a command-capable agent using the
`superstables-payments` skill or CLI. These docs describe client **0.3.0**.

The first guide uses local approvals on Arc Testnet, with no superstables.com account. You need
Node 20+, Linux or macOS (WSL on Windows), a browser wallet that can reach the client's local
approval page, and test USDC for the budget and gas. After installing, start with:

```bash
superstables budget setup --rail evm --chain arc-testnet
superstables budget fund-agent --rail evm --chain arc-testnet
superstables budget doctor --rail evm --chain arc-testnet
superstables budget grant --rail evm --chain arc-testnet --amount 0.06
```

The agent can start these commands and show you the approval links; you review and sign in your
wallet. Setup records the owner, funding transfers gas to the agent, and grant authorizes the
budget. Finish each owner approval before starting the next command. Follow
[Use a budget](docs/budget.md) to read a seller's price, buy within your ceiling, check what is
left and revoke when done. The chain enforces the total allowance; `--max` is a check in this
client, and a stolen EVM agent key can spend the remaining allowance to another address.

If your agent runs on a server and you want to approve from another device, choose
[hosted approvals inside the same guide](docs/budget.md#approve-on-superstablescom-instead).
The client and its budget key still run on your machine. Owners using the site can follow the
[owner guide](https://www.superstables.com/docs/owner) for approval and account checkpoints.
For a single purchase, follow
[Single purchase](docs/buy-once.md).

## What it does

**Budgets.** With `superstables budget`, you grant an agent key a budget on chain once, from your
own wallet. The agent then buys from x402 or MPP sellers without asking you again, until the budget
is spent or you revoke it; on Tempo, it can also expire. Budget purchases need no hosted approval
for each payment. The client sends the payment request directly to the seller, which may be
Superstables or a third party. Budgets run on Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon
Amoy, SKALE Base Sepolia, Ethereum Sepolia, Tempo Moderato and Solana devnet.

**Single purchase.** `superstables budget buy-once` buys one service from the Superstables service
catalogue. You approve that one purchase on superstables.com, in your own wallet, after picking
the match code the agent shows you. Hosted single purchase works on four networks: Base Sepolia (test
USDC), Arc Testnet (test USDC), Tempo Moderato (test pathUSD) and Solana devnet (test USDC). It
needs no `setup` command, budget or agent key. It requires a superstables.com account, which you
create by signing in with an Ethereum wallet. Solana purchases also need a Solana wallet to sign
the payment transaction. Solana sign-in is not supported in 0.3.0. `superstables budget find --once` lists the services.

**Single purchase on this computer.** Local `quote`/`pay`, the payment MCP server and the SDK
payment core use Base Sepolia and a local approval page. Run `setup` for that flow. See
[Single purchase on this computer](#approve-each-payment-on-this-computer).

The tested services use x402 on EVM and Solana, and MPP on Tempo.

## Where you approve

Owner actions happen in your own wallet, on one of two kinds of page:

- **On this computer.** `pay` and the budget owner commands open a page on `127.0.0.1`. You
  approve there with a browser extension wallet on the same computer, with no account. Every
  budget network uses these local approvals by default, and `recover` is always local and EVM
  only.
- **On superstables.com.** Hosted single purchase always uses the site. For a budget, `superstables budget
  setup --hosted` moves the owner approvals for that chain to the site, where you approve from a
  device where you are signed in and have a compatible wallet. Hosted budget approvals support Base Sepolia, Arc Testnet, Arbitrum
  Sepolia, Polygon Amoy, SKALE Base Sepolia, Ethereum Sepolia, Tempo Moderato and Solana devnet.

Hosted approvals require Ethereum wallet sign-in. Solana actions additionally need a Solana
wallet to sign transactions; Solana sign-in is not supported in 0.3.0.

To use hosted budget approvals, you add the agent to your account. The agent gives you an approval link
and a match code. On the site you pick that code and choose **Sign with wallet**: your wallet signs
an owner proof that names the site, your address, the agent, its network, the request and the
match code. The
client verifies that signature before it records you as the owner. Hosted budget setup can combine
adding the agent, gas funding where needed and granting on one page. The wallet may ask for several
approvals.

In browser-wallet flows, your private key stays in your wallet. Superstables prepares requests and
relays signed authorizations or transactions. Budget agents hold separate local spending keys.
Check the wallet's network, token, amount, recipient and permission before signing.

## Testnet only

Agent payments use test tokens on test networks: USDC, or pathUSD on Tempo Moderato. Mainnet
chains are refused, and no configuration turns them on.

## Install

Node 20 or newer, on Linux or macOS. On Windows, use WSL: `superstables budget` refuses to run on
native Windows. Each route below includes `superstables budget` and the MCP server.

**The agent skill.** When client 0.3.0 is released, use its skill zip from [GitHub Releases](https://github.com/superstables/superstables-client/releases)
(`superstables-payments-skill-0.3.0.zip`), with the whole CLI bundled. Unzip
it into `~/.claude/skills/` (Claude Code) or `~/.agents/skills/` (Codex), and run the CLI by its
path:

```bash
node ~/.claude/skills/superstables-payments/scripts/superstables.mjs --help
```

Check `scripts/VERSION.json` in the skill for the version and commit.

**From git, pinned to a commit.** When 0.3.0 is released, replace `<commit>` with its full release commit hash:

```bash
npm install github:superstables/superstables-client#<commit>
npx --no superstables --version
```

npm builds the client on your computer during the install, running this repository's build
scripts there.

**From a checkout.** Clone the repository, check out that 0.3.0 release commit, then run
`npm ci`, `npm run build` and `npm link` to put the
`superstables` command on your PATH. Details for every route are in
[docs/install.md](docs/install.md).

Don't type `npx superstables` outside a checkout or a git install: npx would download whatever
package the npm registry has under that name, which is not this client.

## Security

[docs/security.md](docs/security.md) is the security model: what each way to pay protects and
what it does not, what superstables.com can and cannot do in hosted approvals, and what a
compromised agent, client process or stolen agent key could do. EVM and Solana budgets enforce a
remaining token amount, without an on-chain expiry or seller restriction. A stolen agent key can
spend that remaining allowance to another address. Revocation ends future use of the permission
once confirmed on chain; it does not reverse payments or return transferred funds.

## Documentation

Step by step: [Use a budget](docs/budget.md), then [Single purchase](docs/buy-once.md).
[Install and connect an agent](docs/install.md) covers the skill, CLI and local payment MCP. Every command's help is in
[docs/cli.md](docs/cli.md) and [docs/cli-budget.md](docs/cli-budget.md). Records and recovery
after an interrupted payment: [docs/records.md](docs/records.md). What changed in each release:
[CHANGELOG.md](CHANGELOG.md). To stop using the client, [revoke and uninstall](docs/install.md#uninstalling);
EVM funds held by an agent key have a separate [recovery step](docs/budget.md#recovery-and-ending-use).

<a id="approve-each-payment-on-this-computer"></a>

## Single purchase on this computer

`pay` uses [x402](https://x402.org) with the `exact` scheme and test USDC on Base Sepolia
(`eip155:84532`, USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`). Unsupported payment
schemes, networks and assets are rejected before approval.

1. **Find.** The agent lists paid services and identifies which ones this client can call.
2. **Quote.** The client reads the service's HTTP 402 challenge and records its payment terms.
   No payment is made and nothing is signed.
3. **Approve.** You open the local approval page and review the amount, asset, network and
   recipient. These details come from the seller's payment requirement. Check the same
   transfer in your wallet before signing.
4. **Pay.** The client sends the signed authorization to the seller, whose facilitator settles it
   and pays the gas. The client returns the service's response, records a receipt and reads the
   transaction on Base Sepolia.
5. **Reject.** Reject a request on the approval page or in your wallet before signing. No
   signature is produced, no payment is submitted, and the paid service request is not sent.
   The agent reports the rejection.

With the `superstables` command on your PATH (a checkout after `npm link`), set it up and register
it with Claude Code as an MCP server:

```bash
superstables setup
claude mcp add superstables -e SUPERSTABLES_DEMO_SERVICES=on -- superstables mcp
```

`setup` creates `~/.superstables`, writes a starting `policy.yaml`, and prints the connection
steps with your local paths. In the default browser-wallet mode, it does not create a signing key.
Another MCP client: point its configuration at `superstables mcp`;
[docs/install.md](docs/install.md#any-other-mcp-client) has example entries. Fund your wallet
address with test USDC on Base Sepolia from <https://faucet.circle.com>. You do not need ETH for
this flow because the facilitator covers the gas.

Then ask the agent, in your own words:

> Find a paid service for BTC market data, quote it, tell me the price, and pay it if I say yes.

When you say yes, the agent answers with an approval link like
`http://127.0.0.1:4412/approve/<id>` (another port if a second payment is already waiting on
4412). Open it, press **Connect wallet**, then **Review in wallet**, and check the recipient and
the amount in your wallet before you sign. The agent reports the transaction and the data it paid
for.

The built-in catalogue points to the demo seller hosted by Superstables at
`https://www.superstables.com/api/demo/market`. You do not need to start a separate seller.
To run it locally, see [Run the seller yourself](#run-the-seller-yourself).

## The CLI

In a checkout, run `npm link` once to put `superstables` on your PATH; from a git install, run
`npx --no superstables …` in that folder; from the skill, run
`node <skill folder>/scripts/superstables.mjs …`. The examples below write it as `superstables …`.
`superstables --help` and each command's `--help` are written to be enough on their own:
what the command does, whether it can move money, who runs it, an example, what it prints and
its exit codes. Two options go before the command: `--home <dir>` puts all state somewhere other
than `~/.superstables`, and `--wallet browser|local` chooses who signs (browser by default;
`SUPERSTABLES_WALLET` does the same). In both modes the owner approves each payment.

### Which way to pay

| Task | Approval and runtime | Networks | Start with |
| --- | --- | --- | --- |
| [Use a budget](docs/budget.md) | Owner grants once; client and agent key buy directly from sellers. Local approval by default; hosted approval optional | EVM/x402: Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia, Ethereum Sepolia. Tempo/MPP: Tempo Moderato. Solana/x402: Solana devnet | `superstables budget setup --rail evm` |
| [Single purchase on the site](docs/buy-once.md#hosted-buy-once-superstables-budget-buy-once) | Owner approves each purchase on superstables.com; the site coordinates that purchase. No budget setup or agent key | Base Sepolia, Arc Testnet, Tempo Moderato, Solana devnet | `superstables budget find --once` |
| [Single purchase locally](docs/buy-once.md#approve-each-payment-on-this-computer-pay) | Owner approves each payment on a local page; CLI, payment MCP or SDK submits it | Base Sepolia only, test USDC, x402 `exact` | `superstables setup` |

All networks are testnets. Hosted budget approvals support all the budget networks above. EVM and Solana budgets use test USDC (bridged USDC on SKALE); Tempo uses test
pathUSD. A seller must accept the selected network and protocol. See [rails, gas and faucets](budget/README.md#the-rails).
`superstables setup` prepares local `pay` only; budgets use `budget setup`.

### Commands

| Command | What it does | Run by | Moves money |
| --- | --- | --- | --- |
| `setup` | Create the home directory and the policy, and print what to do next | owner | no |
| `doctor` | Check everything `pay` needs and print ✓/✗ per item | either | no |
| `find [query]` | List services, their chains, whether `pay` or a budget rail could pay each, and the commands to pay it each way, pay first (`--budget`, `--all`, `--limit`) | either | no |
| `quote <url>` / `quote --service <id> --param k=v` | Retrieve payment terms and show each policy rule they were checked against. Nothing is signed | either | no |
| `pay <quote-id>` | Ask the owner to approve a quote, print the approval link once, then pay and print the service's answer (`--wait`) | agent | yes, after the owner approves |
| `status <attempt-id>` | Where a payment attempt got to, the service's answer, and what to run next | either | no |
| `receipts` / `attempts` | List payment receipts or attempts (`--limit`) | either | no |
| `policy show` / `policy init` | Read or create `policy.yaml` | either / owner | no |
| `mcp` | Run the MCP server on stdio, the same one Claude talks to | the agent's MCP host | through its `pay` tool, after the owner approves |
| `demo-service` | Run the paid service yourself (`--port`, `--pay-to`, `--price`) | developer | receives only |
| `wallet init` / `wallet serve` / `wallet status` | The local wallet, for `--wallet local` only | owner | `serve` signs what the owner approves |
| `budget …` | On-chain agent budgets, a separate testnet tool. See [On-chain budgets](#on-chain-budgets-superstables-budget) | owner and agent | yes, within the grant |

`pay` waits until the owner decides or the approval window closes: five minutes on the browser
approval page, which `pay` itself serves on `127.0.0.1` and which stops working when `pay` exits.
`--wait <seconds>` stops waiting sooner. An attempt nobody decided on ends `abandoned`, which is
not a rejection; `denied` means the owner rejected it and `expired` means nobody approved in time.
None of the three moved money. A quote starts at most one attempt, so to ask again, take a new
quote. An agent whose tool shows output only when a command ends should run `pay` in the
background and read the approval link from its output, or use the MCP server, which returns it at
once.

### Discovery and self-hosted indexes

`find` reads a built-in catalogue and the public index at
`https://www.superstables.com/api/v1/services`. The index records each service's payment
protocols (`rails`, for example `["x402"]`) and `chains` (for example
`["base-sepolia", "solana"]`), and `find` keeps both. It marks a listing payable by `pay` when it
accepts x402 on Base Sepolia, and names the budget rail and chain that could pay it. Only testnet
chain names count: in the index, `base` and `solana` are mainnets, and nothing on a mainnet is
marked payable. Under the table, `find` prints the commands for each way to pay each listing, pay
first: `quote` then `pay`; on a budget, `budget preflight` then `budget buy`. `--json` has them as `commands`, and `next` is the first one. Index
listings do not record request parameters yet, so their URLs end in `?<parameters>` for the ones
the seller documents. A mainnet listing gets no command.

`SUPERSTABLES_INDEX_URL` points discovery at another index that answers the same API, such as a
self-hosted one; `SUPERSTABLES_INDEX_URL=off` switches the index off and leaves the built-in
catalogue. `SUPERSTABLES_DEMO_SERVICES=on` adds Superstables' testnet services from the hosted catalogue,
read from `SUPERSTABLES_CATALOGUE_URL` (`off` skips it). Most return prepared sample output and
are marked simulated; the market data service returns live prices.

### Exit codes and `--json`

`find`, `quote`, `pay`, `status`, `receipts` and `attempts` take `--json`. Each prints one JSON
value on stdout; progress, the approval link and notes go to stderr. `pay --json` and
`status --json` print the same object: `attempt_id`, `quote_id`, `state`, `final`, `message`,
`next`, `exit_code`, `reason`, `refusal`, `receipt`, `service_response`, `price`, `recipient` and
`history`. `attempts --json` and `receipts --json` print the records with `transaction`,
`transactionUrl` and `payer` only when they are well formed. The seller's own text is kept apart:
an attempt's service answer and reason under `untrusted_seller_data`, a receipt's settlement report
as retained by the client under `untrusted_seller_report`. An error under
`--json` prints `{"error", "exit_code"}`.

`superstables budget` commands take `--json` too. Without it, a budget command ends stdout with
one line `RESULT {json}`; with it, stdout is that same object alone, without the `RESULT ` prefix,
and an owner command's `APPROVE` line goes to stderr with the logs. The fields and exit codes do
not change, and errors keep the `RESULT` shape (`ok: false`, `state`, `reason`, `next`).

The exit codes are the same numbers `superstables budget` uses:

| Code | Meaning |
| --- | --- |
| 0 | Done. For `pay`, the payment settled and the service answered; `chain` says whether the client confirmed it on chain |
| 1 | Failed. Includes an approval that expired or was abandoned, and a service or wallet that could not be reached. After a payment was sent, `failed` can rest on the seller's report that it did not settle: read `reason` before saying nothing was paid |
| 2 | Bad input: an unknown command or flag, a missing or wrong parameter, an unknown id, or a used or expired quote. Nothing was done |
| 3 | Refused: the owner rejected the payment, or a spend policy refused it (for `quote`, the policy would refuse it). For a budget owner command, an owner-transaction mismatch can be detected after the transaction has landed: check the reported reason, transaction identifier and chain status before claiming nothing was sent |
| 4 | Paid, not delivered: the payment settled but the service answered with an error, or its answer did not arrive in full. Do not pay again |
| 5 | Unknown: the payment may or may not have settled. Do not pay again until you have checked |

`status <attempt-id>` exits with the attempt's own code, and 0 while it is not final.

## The MCP tools

| Tool | What it does |
| --- | --- |
| `find_services` | Search for payable services and say which are actionable |
| `quote` | Read a service's terms and record them. Nothing is signed |
| `pay` | Ask you to approve a quote, returning `approval_url`; then pay it and return the service's answer |
| `payment_status` | Wait for a payment attempt and report its state |
| `wallet_status` | Which signer is in use; address, network, balance, policy |
| `list_receipts` | Payments made from this machine, each with `chain`: verified, unchecked or mismatch after a later check |

These six tools cover local Base Sepolia payments. Budgets and hosted single purchase use the
command-capable skill or CLI; they have no payment MCP tools.

Of these tools, only `pay` can initiate a payment. It returns an `approval_url` and waits in
`awaiting_approval` for your decision. The agent must show the complete approval link unchanged so you
can open the correct payment request.

## Where state lives

```
~/.superstables/
  policy.yaml            your spend policy (see policy.example.yaml)
  records/               quotes, attempts, receipts and approvals, append-only JSONL, 0600
  browser-wallet.json    which MetaMask account last connected. A name, not a secret
  wallet/                only with --wallet local: key, agent token, owner secret, audit log
  keys/budget/           only with superstables budget: the agent key file, 0600
  budget/                only with superstables budget: public addresses, purchase journals, approval log
```

`SUPERSTABLES_HOME` changes the base directory for this state. Hosted approvals also keep the
budget key and purchase journals here; the site account shows linked agents and hosted one-off
requests, not a complete ledger of budget purchases. Pending hosted request records can contain
access tokens; [Records](docs/records.md#budget-records) gives the full file inventory and recovery commands.

## What is enforced, and by what

**Blockchain.** Settlement checks the signed payment authorization and the account's balance.
The amount, asset and recipient are part of the authorization. A facilitator cannot change
those signed terms.

**MetaMask.** You review and sign the authorization in your wallet. MetaMask displays the
`to` address and `value` from the signing request. In browser mode, the client does not
generate, read or store your private key.

**Approval page.** The page derives the amount, asset, network and recipient from the seller's
payment requirement using the same code as the payment core. It shows the agent's description
separately under "Reported by the agent (not verified)". That description does not change the
signed payment terms. Before using a returned signature, the client checks that it matches the
connected account.

**Local policy.** `policy.yaml` defines per-payment and daily caps, host rules and a kill
switch. The client applies these checks using local records. They are software checks, not
limits enforced by the blockchain or MetaMask. Host rules use the URL reported by the agent,
so they cannot protect against an agent that misreports it.

See [docs/security.md](docs/security.md) for the full security model, including the limits of
local policy and what a compromised agent or client process could do.

## Limitations

- Testnet only: agent payments use test tokens on test networks, USDC or pathUSD on Tempo
  Moderato. `pay` supports Base Sepolia, test USDC and the x402 `exact` scheme. There is no
  mainnet mode.
- MetaMask displays the amount in USDC's smallest unit: `10000` represents 0.01 USDC. The
  approval page shows the conversion. Check the amount and recipient in MetaMask before signing.
- In browser mode, an approval link opens one payment request and expires after five minutes.
  The page is served on `127.0.0.1`, and signing still requires MetaMask. Treat it as
  access to that request.
- Each payment through the MCP tools and `pay` requires approval. There is no unattended mode
  in that flow. On-chain budgets for an agent that buys on its own are a separate testnet tool,
  [`superstables budget`](#on-chain-budgets-superstables-budget).
- With `--wallet local`, the signing key is stored in a file that any process running as your
  user can read. This mode is intended for machines without a browser.
- Public-index listings without the required request parameters can be displayed but cannot be
  called by this release. The client identifies these listings.
- An interrupted payment can end in `uncertain` and is never retried automatically. See
  [docs/records.md](docs/records.md) for the checks to make before trying again.
- A receipt records payment and service outcomes separately. A settled payment does not
  guarantee a successful service response. For `pay`, the client reads the seller's transaction
  on Base Sepolia: `chain: "verified"` when it is this payment (the signed nonce used, the exact
  amount to the checked recipient), `"unchecked"` when the chain could not say yet
  (`superstables status` checks again). A transaction that is not this payment makes the attempt
  `uncertain`. If the facilitator has not returned a transaction
  hash, the receipt records its pending reference instead.
- Hosted approvals (`superstables budget setup --hosted`), `superstables budget buy-once` and
  `superstables budget find` need superstables.com, or a compatible deployment the owner names
  with `--site` or `SUPERSTABLES_SITE`. An origin outside superstables.com and its subdomains
  also needs the owner to set `SUPERSTABLES_ALLOW_SITE` to that exact origin in their own
  environment; an agent never sets it. Everything else, local approvals and budgets on every rail
  included, works with no account. What a compatible site must do is in
  [budget/CLI.md](budget/CLI.md#hosted-approvals-what-a-compatible-site-must-do).

## Run the seller yourself

The built-in catalogue includes the hosted Superstables demo seller and a third-party x402
service. With the demo services switch on (`SUPERSTABLES_DEMO_SERVICES=on`, which the demo
setup snippets set), discovery also reads the hosted catalogue at
`https://www.superstables.com/api/demo/catalogue`, where Superstables publishes its testnet
services. Most return prepared sample output: those listings carry `mock: true` and are listed
after the listings not marked simulated. The market data service returns live prices. With the switch off, the default, the catalogue is never read and no simulated listing
appears. To inspect the seller side of the flow, run the demo seller from this repository. You can
observe its HTTP 402 response, facilitator interaction and log entry for each paid call:

```bash
superstables demo-service --pay-to 0xYourSellerAddress
SUPERSTABLES_DEMO_SERVICE_URL="http://127.0.0.1:4402/v1/market" superstables find
```

Set `--pay-to` to an address you control. Test funds sent to an address you do not control
cannot be recovered by this client. `SUPERSTABLES_DEMO_SERVICE_URL` points discovery, the CLI
and the MCP server at your seller instance.

## A local wallet instead of MetaMask

There is a second signer for machines with no browser: a small wallet process that holds a key
in `~/.superstables/wallet/key` and serves its own approval page, protected by an owner secret
that it never prints (see [the local wallet](docs/install.md#the-local-wallet-for-a-machine-with-no-browser)).

```bash
superstables --wallet local setup        # creates the key, prints the address
superstables --wallet local wallet serve # leave it running
```

Set `SUPERSTABLES_WALLET=local` when starting the MCP server to select this mode for Claude.
The agent requests a payment, you approve it through the wallet's approval page, and the client
writes the same types of payment records. The signing key is stored on the local machine
rather than in MetaMask, so processes running as your user can read it.

## On-chain budgets: `superstables budget`

`superstables budget` is a separate testnet tool with its own agent key. The owner grants an
agent key a budget on chain once, from their own wallet. The agent then buys from x402 or MPP sellers with no approval
per payment, until the budget runs out, expires on Tempo, or the owner revokes it. The chain enforces the cap. Budget
purchases need no hosted approval for each payment: the client sends the payment request directly to the seller, which
may be Superstables or a third party. The tool has three rails: `evm`, a USDC `approve` on
Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia or Ethereum Sepolia; `tempo`, an access key on Tempo Moderato with a cap, expiry and
optional period and seller list enforced on chain; and `solana`, an SPL token delegate on Solana devnet.

```bash
superstables budget setup      --rail evm                        # agent key; the owner connects a wallet
superstables budget fund-agent --rail evm                        # gas for the agent key, approved in the wallet
superstables budget doctor     --rail evm                        # keys, addresses, balances; what to top up
superstables budget grant      --rail evm --amount 0.01          # an allowance from the owner's wallet
superstables budget status     --rail evm                        # is there a budget here, and what is left
superstables budget preflight  --rail evm --url <seller url>     # the seller's price and address; signs nothing (every rail)
superstables budget buy        --rail evm --url <seller url> --max 0.002
superstables budget revoke     --rail evm                        # the kill switch, approved in the wallet
```

`superstables budget --help` is enough to use it: where the owner and the agent start, which rail and `--chain` serve
each chain (Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia and Ethereum Sepolia are
`evm`; Tempo Moderato is `tempo`; Solana devnet is `solana`), the owner's steps per rail, exit codes and where state lives. Each
command's `--help` says what it does, whether it can move money, who runs it, an example, what it prints and its exit
codes. On `evm`, `fund-agent` sends the agent key a little of the chain's gas token, and the grant is an allowance: the
USDC stays in the owner's wallet until a purchase pulls exactly its price to the agent address, before settlement.
Gas reserves, refunds or interrupted purchases can leave USDC at the agent address; the owner's `recover` attempts to
return it. `--max` is the most one purchase may cost, in
the budget token (`--max 0.002` is 0.002 USDC). A `buy` before setup and grant is refused (exit 3) with nothing signed,
and its `next` names the owner's commands.

Every [install](#install) includes it: the skill bundles it, and a git install or a checkout (after `npm ci` and
`npm run build`) builds it as a self-contained copy. It runs on Linux and macOS; on Windows, run it in WSL. Owner actions use a local page on `127.0.0.1` and a
compatible browser extension wallet on the same computer: an EVM wallet such as MetaMask, Rabby or Coinbase Wallet on
`evm`; an EVM wallet that can add a custom network on `tempo`; and a Solana Wallet Standard wallet such as Phantom,
Solflare or Backpack on `solana`, with no account. `setup --hosted` moves them to
superstables.com instead, after you add the agent to your account (see
[Where you approve](#where-you-approve)): you approve from a device where you are signed in and have a compatible
wallet, after picking the match code the agent shows you. That needs a superstables.com account. Setup records your address; grants, revokes and funding require wallet
approval. Over SSH, the owner forwards the local page's port first (`ssh -L PORT:127.0.0.1:PORT`, with the port from the
approval link). `superstables budget find` lists the services superstables.com says a budget can pay. Without a budget,
`superstables budget buy-once --service ID --max M` buys one listed service that you approve on superstables.com (on
the network its listing names: Base Sepolia, Arc Testnet, Tempo Moderato or Solana devnet; `superstables budget find --once` lists them). The default flow stores only the agent key in `~/.superstables/keys/budget/`. An agent may start an owner
command and hand the owner the approval link; only the owner approves. Run by an agent, an owner command returns at once with
the approval link and an approval id. The agent writes it in its reply to the owner and ends its turn; when the owner says
they have approved, it runs `superstables budget wait --id <id> --shown`; if the approval is still open, it says so and
ends its turn again, rather than polling.
`waiting_owner` is not approval or settlement. An approval link that expires before the owner's wallet is asked to send ends the command refused,
and that approval sent nothing (an earlier step of `recover`, or of a hosted setup with `--grant` or `--fund`, may have
completed); running the command again gives a new one. An expired approval link does not cancel a
wallet request or transaction: once the wallet was asked, an unfinished outcome is `unknown` (exit 5), so check the
result, chain status and wallet activity before requesting another approval. Every command ends with one
`RESULT {json}` line (with `--json`, the object alone) and a fixed exit code, so an agent can act on it. EVM and Solana allowances have no automatic expiry or seller restriction. Revoke stops
further use of the permission once it takes effect on chain; it does not reverse confirmed
transfers. Setup, funding, wallet verification limits, the safety model and the agent skill are in [budget/README.md](budget/README.md).

## Development

```bash
npm run typecheck
npm test          # no network: the tests stand up their own servers on loopback
npm run build
npm run install-check   # installs the client four ways (tarball, checkout, no dev packages, git URL) and runs it
```

`npm run test:live` checks real testnet sellers. Paid checks require explicit
test wallet homes; see [Live testnet checks](test/live/README.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE). The built `dist/budget` also contains third-party packages under their own
licences, one of them LGPL-3.0; `dist/budget/THIRD_PARTY_NOTICES.txt` lists them with their licence texts. The skill
zip lists the packages it bundles in `scripts/THIRD_PARTY_NOTICES.txt`.
