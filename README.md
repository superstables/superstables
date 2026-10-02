# Superstables client

![Superstables testnet payment demo in Claude Desktop with MetaMask](docs/images/client-demo-cover.png)

**Payments belong in the agent workflow.**

Superstables connects service discovery, pricing and payment for AI agents. The client offers
two ways to pay:

- **Approve each payment.** Through MCP, a CLI or a TypeScript SDK, an agent finds a paid
  service, retrieves its payment terms and requests your approval. Once you approve and sign
  with your wallet, the client sends the signed request and records the payment outcome and the
  service's response. The agent can request a payment, but it cannot approve one.
- **Grant a budget once.** With [`superstables budget`](#on-chain-budgets-superstables-budget), a
  separate tool, you give an agent key a spending budget on chain from your own wallet. The agent
  then buys without asking you again, within an allowance the chain enforces, until it is spent or
  you revoke it. On Tempo, it also expires, and can refill each period.

Both are testnet only. Per-payment approval uses [x402](https://x402.org) with the `exact`
scheme and test USDC on Base Sepolia. Budgets run on Base Sepolia and five other EVM testnets,
Tempo Moderato and Solana devnet. With browser-wallet approval, your signing key remains in your
wallet; budget purchases use a separate agent key stored on this computer.

## What the demo shows

1. **Find.** The agent lists paid services and identifies which ones this client can call.
2. **Quote.** The client reads the service's HTTP 402 challenge and records its payment terms.
   No payment is made and nothing is signed.
3. **Approve.** You open the local approval page and review the amount, asset, network and
   recipient. These details come from the seller's payment requirement. Check the same
   transfer in MetaMask before signing.
4. **Pay.** A public facilitator submits the signed transfer and covers the gas. The client
   returns the service's response and records a receipt with the transaction details.
5. **Reject.** Reject a request on the approval page or in MetaMask before signing. No
   signature is produced, no payment is submitted, and the paid service request is not sent.
   The agent reports the rejection.

## What it looks like

The owner approves on a page the client serves on `127.0.0.1`. The amount, recipient and network on
the left come from the seller's payment requirement; MetaMask shows the same `TransferWithAuthorization`
it is about to sign on the right.

![The approval page next to MetaMask's signature request](docs/images/2-approve.png)

After the signature, the facilitator settles the transfer and the agent returns the service's answer
with the transaction on the explorer.

![The agent reporting the price paid for and the transaction link](docs/images/3-result.png)

## What this release supports

| | |
| --- | --- |
| Rail | x402, `exact` scheme |
| Network | Base Sepolia testnet (`eip155:84532`) |
| Asset | Test USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 decimals) |
| Approval | MetaMask signs each payment, on an approval page the client serves on `127.0.0.1`. For purchases without an approval each time, see [On-chain budgets](#on-chain-budgets-superstables-budget) |
| Alternative | A local wallet process that holds a key in a file, for a browser-free machine: `--wallet local` |
| Clients | Claude Code, tested end to end with the MetaMask flow. The server uses MCP over stdio and starts with `superstables mcp`, so other MCP clients can run it too |
| Also usable as | a CLI (`superstables`) and a TypeScript SDK |

Unsupported payment schemes, networks and assets are rejected before approval. This includes
mainnet.

## Quick start

You need MetaMask in your browser and Node 20 or newer. The client runs from a checkout:

```bash
git clone https://github.com/superstables/superstables-client.git
cd superstables-client
npm install
npm run build
npx superstables setup
```

`setup` creates `~/.superstables`, writes a starting `policy.yaml`, and prints the connection
steps with your local paths. In the default MetaMask mode, it does not create a signing key.

**Connect an agent.** Claude Code:

```bash
claude mcp add superstables -e SUPERSTABLES_DEMO_SERVICES=on -- node "$(pwd)/dist/mcp/main.js"
```

Another MCP client: point its configuration at `superstables mcp`, or at
`node <checkout>/dist/cli/main.js mcp`. [docs/install.md](docs/install.md#any-other-mcp-client)
has example entries.

**Get MetaMask ready.** Install it from <https://metamask.io/download> if needed. Add Base
Sepolia, or accept the approval page's network prompt when you first connect. Fund your
MetaMask address with test USDC from <https://faucet.circle.com>. You do not need ETH for this
demo flow because the facilitator covers the gas.

**Talk to the agent**, in your own words:

> Find a paid service for BTC market data, quote it, tell me the price, and pay it if I say yes.

When you say yes, the agent answers with a link like `http://127.0.0.1:4412/approve/<id>` (another
port if a second payment is already waiting on 4412). Open it. Press **Connect wallet**, then **Review in wallet**, and check the recipient and the
amount in MetaMask's popup before you sign. The agent reports the transaction and the data it
paid for.

The built-in catalogue points to the demo seller hosted by Superstables at
`https://www.superstables.com/api/demo/market`. You do not need to start a separate seller.
To run it locally, see [Run the seller yourself](#run-the-seller-yourself).

Full details, including every environment variable, are in [docs/install.md](docs/install.md).
Step by step: [docs/buy-once.md](docs/buy-once.md) for approving each payment and
[docs/budget.md](docs/budget.md) for a budget. Every command's help is in
[docs/cli.md](docs/cli.md) and [docs/cli-budget.md](docs/cli-budget.md), and the security model in
[docs/security.md](docs/security.md). The presenter's script is in [docs/demo.md](docs/demo.md).
What changed in each release is in [CHANGELOG.md](CHANGELOG.md).

## The CLI

Run as `npx superstables …` from the repository root, or `npm link` once and then `superstables`
anywhere. `superstables --help` and each command's `--help` are written to be enough on their own:
what the command does, whether it can move money, who runs it, an example, what it prints and
its exit codes. Two options go before the command: `--home <dir>` puts all state somewhere other
than `~/.superstables`, and `--wallet browser|local` chooses who signs (browser by default;
`SUPERSTABLES_WALLET` does the same). In both modes the owner approves each payment.

### Which way to pay

| | `pay` | `budget` |
| --- | --- | --- |
| Who approves | The owner, in their own wallet, for every payment | The owner, once, when granting the budget |
| What limits spending | The local spend policy and the owner's decision | The chain: an allowance, access key or delegate |
| Protocol and chains | x402, USDC on Base Sepolia | `evm`: x402 on Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia, Ethereum Sepolia. `tempo`: MPP on Tempo Moderato. `solana`: x402 on Solana devnet |
| Start with | `superstables setup` | `superstables budget setup --rail evm` |

Use `pay` when the owner is there to approve. Use `budget` when the agent should buy on its own
within a limit the owner set. `superstables setup` prepares `pay` only.

### Commands

| Command | What it does | Run by | Moves money |
| --- | --- | --- | --- |
| `setup` | Create the home directory and the policy, and print what to do next | owner | no |
| `doctor` | Check everything `pay` needs and print ✓/✗ per item | either | no |
| `find [query]` | List services, their chains, whether `pay` or a budget rail could pay each, and the commands to pay it each way, pay first (`--budget`, `--all`, `--limit`) | either | no |
| `quote <url>` / `quote --service <id> --param k=v` | Retrieve payment terms and show each policy rule they were checked against. Nothing is signed | either | no |
| `pay <quote-id>` | Ask the owner to approve a quote, print the link once, then pay and print the service's answer (`--wait`) | agent | yes, after the owner approves |
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
background and read the link from its output, or use the MCP server, which returns the link at
once.

### Discovery and self-hosted indexes

`find` reads a built-in catalogue and the public index at
`https://www.superstables.com/api/v1/services`. The index records each service's payment
protocols (`rails`, for example `["x402"]`) and `chains` (for example
`["base-sepolia", "solana"]`), and `find` keeps both. It marks a listing payable by `pay` when it
accepts x402 on Base Sepolia, and names the budget rail and chain that could pay it. Only testnet
chain names count: in the index, `base` and `solana` are mainnets, and nothing on a mainnet is
marked payable. Under the table, `find` prints the commands for each way to pay each listing, pay
first: `quote` then `pay`; on an `evm` budget, `budget preflight` then `budget buy`; on `tempo` and
`solana`, `budget buy` alone. `--json` has them as `commands`, and `next` is the first one. Index
listings do not record request parameters yet, so their URLs end in `?<parameters>` for the ones
the seller documents. A mainnet listing gets no command.

`SUPERSTABLES_INDEX_URL` points discovery at another index that answers the same API, such as a
self-hosted one; `SUPERSTABLES_INDEX_URL=off` switches the index off and leaves the built-in
catalogue. `SUPERSTABLES_DEMO_SERVICES=on` adds Superstables' simulated demo services, read from
`SUPERSTABLES_CATALOGUE_URL` (`off` skips it).

### Exit codes and `--json`

`find`, `quote`, `pay`, `status`, `receipts` and `attempts` take `--json`. Each prints one JSON
value on stdout; progress, the approval link and notes go to stderr. `pay --json` and
`status --json` print the same object: `attempt_id`, `quote_id`, `state`, `final`, `message`,
`next`, `exit_code`, `reason`, `refusal`, `receipt`, `service_response`, `price`, `recipient` and
`history`. `receipts --json` and `attempts --json` print the records as stored. An error under
`--json` prints `{"error", "exit_code"}`.

`superstables budget` commands take `--json` too. Without it, a budget command ends stdout with
one line `RESULT {json}`; with it, stdout is that same object alone, without the `RESULT ` prefix,
and an owner command's `APPROVE` line goes to stderr with the logs. The fields and exit codes do
not change, and errors keep the `RESULT` shape (`ok: false`, `state`, `reason`, `next`).

The exit codes are the same numbers `superstables budget` uses:

| Code | Meaning |
| --- | --- |
| 0 | Done. For `pay`, the payment settled and the service answered |
| 1 | Failed: nothing was paid. Includes an approval that expired or was abandoned, and a service or wallet that could not be reached |
| 2 | Bad input: an unknown command or flag, a missing or wrong parameter, an unknown id, or a used or expired quote. Nothing was done |
| 3 | Refused: the owner rejected the payment, or a spend policy refused it (for `quote`, the policy would refuse it). Nothing was paid |
| 4 | Paid, not delivered: the payment settled but the service answered with an error. Do not pay again |
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
| `list_receipts` | Payments that settled on this machine |

Of these tools, only `pay` can initiate a payment. It returns an `approval_url` and waits in
`awaiting_approval` for your decision. The agent must show the complete link unchanged so you
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

`SUPERSTABLES_HOME` changes the base directory for this state.

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

- Testnet only: Base Sepolia, test USDC and the x402 `exact` scheme. There is no mainnet mode.
- MetaMask displays the amount in USDC's smallest unit: `10000` represents 0.01 USDC. The
  approval page shows the conversion. Check the amount and recipient in MetaMask before signing.
- In browser mode, an approval link opens one payment request and expires after five minutes.
  The page is served on `127.0.0.1`, and signing still requires MetaMask. Treat the link as
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
  guarantee a successful service response. If the facilitator has not returned a transaction
  hash, the receipt records its pending reference instead.

## Run the seller yourself

The built-in catalogue includes the hosted Superstables demo seller and a third-party x402
service. With the demo services switch on (`SUPERSTABLES_DEMO_SERVICES=on`, which the demo
setup snippets set), discovery also reads the hosted catalogue at
`https://www.superstables.com/api/demo/catalogue`, where Superstables publishes its prepared
demo services: simulated answers, each marked `mock` in the listing and listed after the real
sellers. With the switch off, the default, the catalogue is never read and no simulated listing
appears. To inspect the seller side of the flow, run the demo seller from this repository. You can
observe its HTTP 402 response, facilitator interaction and log entry for each paid call:

```bash
npx superstables demo-service --pay-to 0xYourSellerAddress
SUPERSTABLES_DEMO_SERVICE_URL="http://127.0.0.1:4402/v1/market" npx superstables find
```

Set `--pay-to` to an address you control. Test funds sent to an address you do not control
cannot be recovered by this client. `SUPERSTABLES_DEMO_SERVICE_URL` points discovery, the CLI
and the MCP server at your seller instance.

## A local wallet instead of MetaMask

There is a second signer for machines with no browser: a small wallet process that holds a key
in `~/.superstables/wallet/key` and serves its own approval page, protected by a secret in the
URL fragment.

```bash
npx superstables --wallet local setup        # creates the key, prints the address
npx superstables --wallet local wallet serve # leave it running
```

Set `SUPERSTABLES_WALLET=local` when starting the MCP server to select this mode for Claude.
The agent requests a payment, you approve it through the wallet's approval page, and the client
writes the same types of payment records. The signing key is stored on the local machine
rather than in MetaMask, so processes running as your user can read it.

## On-chain budgets: `superstables budget`

`superstables budget` is a separate testnet tool with its own agent key. The owner grants an
agent key a budget on chain once, from their own wallet. The agent then buys from x402 or MPP sellers with no approval
per payment, until the budget runs out, expires on Tempo, or the owner revokes it. The chain enforces the cap; no
Superstables server is in the path. The tool has three rails: `evm`, a USDC `approve` on
Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia or Ethereum Sepolia; `tempo`, an access key on Tempo Moderato with a cap, expiry and
optional period and seller list enforced on chain; and `solana`, an SPL token delegate on Solana devnet.

```bash
npx superstables budget setup      --rail evm                        # agent key; the owner connects a wallet
npx superstables budget fund-agent --rail evm                        # gas for the agent key, approved in the wallet
npx superstables budget doctor     --rail evm                        # keys, addresses, balances; what to top up
npx superstables budget grant      --rail evm --amount 0.01          # an allowance from the owner's wallet
npx superstables budget status     --rail evm                        # is there a budget here, and what is left
npx superstables budget preflight  --rail evm --url <seller url>     # the seller's price and address; signs nothing
npx superstables budget buy        --rail evm --url <seller url> --max 0.002
npx superstables budget revoke     --rail evm                        # the kill switch, approved in the wallet
```

`superstables budget --help` is enough to use it: where the owner and the agent start, which rail and `--chain` serve
each chain (Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia and Ethereum Sepolia are
`evm`; Tempo Moderato is `tempo`; Solana devnet is `solana`), the owner's steps per rail, exit codes and where state lives. Each
command's `--help` says what it does, whether it can move money, who runs it, an example, what it prints and its exit
codes. On `evm`, `fund-agent` sends the agent key a little of the chain's gas token, and the grant is an allowance: the
USDC stays in the owner's wallet until a purchase pulls exactly its price. `--max` is the most one purchase may cost, in
the budget token (`--max 0.002` is 0.002 USDC). A `buy` before setup and grant is refused (exit 3) with nothing signed,
and its `next` names the owner's commands.

An npm install of the client includes it as a self-contained build, and it runs from a
checkout of this repository too, after `npm ci` and `npm run build`. It runs on Linux and macOS; on Windows, run it in WSL. Owner actions use a local page on `127.0.0.1` and a
browser extension wallet on the same computer: any EVM browser wallet (MetaMask, Rabby, Coinbase
Wallet, ...) on `evm`, any EVM browser wallet that can add a custom network on `tempo`, and any
Solana wallet (Phantom, Solflare, Backpack, ...) on `solana`. Setup records your address; grants, revokes and funding require wallet
approval. Over SSH, the owner forwards the page's port first (`ssh -L PORT:127.0.0.1:PORT`, with the port from the
link). The default flow stores only the agent key in `~/.superstables/keys/budget/`. An agent may start an owner
command and hand the owner the link; only the owner approves. Run by an agent, an owner command returns at once with
the link and an approval id, and the agent polls `superstables budget wait --id <id>` until `final` is `true`.
`waiting_owner` is not approval or settlement. A link that expires before the owner approves ends the command refused,
with nothing sent; running the command again gives a new link. Every command ends with one
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

## Licence

Apache-2.0. See [LICENSE](LICENSE). The built `dist/budget` in the npm package also contains
third-party packages under their own licences, one of them LGPL-3.0; `dist/budget/THIRD_PARTY_NOTICES.txt`
lists them with their licence texts.
