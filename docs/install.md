# Install the client

The Superstables client is a command, `superstables`, with an MCP server (`superstables mcp`) and a
TypeScript SDK built from the same code. It pays for services in two ways:
[one purchase at a time](buy-once.md), where the owner approves each purchase (hosted buy once on
superstables.com, or `pay` on a page on this computer), and [budget](budget.md), where the owner
grants an on-chain budget once. Testnet only: test USDC, or pathUSD for Tempo budgets. No real money.

## What you need

- Node 20 or newer.
- Linux or macOS. On Windows, use WSL: `superstables budget` refuses to run on native Windows.
- For the owner, a browser wallet on the computer that runs the client: MetaMask or another EVM
  browser wallet, or a Solana wallet for a Solana budget. The approval pages are served on
  `127.0.0.1`, so the wallet is a browser extension on that computer. Over SSH, the owner forwards
  the page's port first (`ssh -L PORT:127.0.0.1:PORT user@host`, with the port from the approval link and your SSH destination).

The client runs on your computer and contacts sellers, the facilitators that settle x402 payments,
testnet RPCs, the Superstables index and, when switched on, the hosted demo catalogue.

## Install

Pick one. All of them run the same commands on the same state, in `~/.superstables`.

**The agent skill, from Get started.** The one-line prompt on superstables.com's Get started page
has the agent download the skill zip, check its SHA-256 checksum and install it. The skill bundles
the whole CLI; [The agent skill](#the-agent-skill-with-the-whole-cli-bundled) below installs it by
hand.

The examples on these pages write the command as `superstables`. A checkout with `npm link` puts
that command on your PATH. For a git install pinned to a commit, use `npx --no superstables …` in
the installation folder, as shown below.

Don't type `npx superstables` to run the client. Where npx doesn't find this client's command, it
downloads whatever package the npm registry has under the name `superstables`, which is not this
client.

### From a checkout

To run the client from its sources, for example to work on it:

```bash
git clone https://github.com/superstables/superstables-client.git
cd superstables-client
npm ci
npm run build
npm link
superstables --version
```

`npm link` puts the checkout's `superstables` command on your PATH, so every command in these
docs works as written. Without it, run `node <checkout>/dist/cli/main.js …`, or
`npx --no superstables …` at the repository root. Keep the `--no`: when npx doesn't find this
checkout's command, it downloads whatever package the npm registry has under that name, and
`--no` makes it stop instead.

### With npm, from git

In any folder, with `<commit>` replaced by the full commit hash of the version you want (a
release's page on GitHub names its commit):

```bash
npm install github:superstables/superstables-client#<commit>
npx --no superstables --version
```

npm clones the repository at that commit, installs its development packages, builds the client
on your computer with them and installs the result, `superstables budget` included. That build
runs the repository's build scripts and the TypeScript compiler on your machine. Name a commit hash: without one, npm installs whatever the default branch holds
at that moment, and a branch or tag name can later point somewhere else.
Run it as `npx --no superstables …` in that folder, or as `node_modules/.bin/superstables …`.

### The agent skill, with the whole CLI bundled

`npm run skill` in a checkout builds `build/superstables-payments-skill-<version>.zip`, and
releases attach the same zip. Unzip it into your agent's skills folder, `~/.claude/skills/` for
Claude Code or `~/.agents/skills/` for Codex. It unpacks to `superstables-payments/`, and needs
only Node:

```bash
node ~/.claude/skills/superstables-payments/scripts/superstables.mjs --version
```

Use that path wherever these pages say `superstables`. `scripts/THIRD_PARTY_NOTICES.txt` lists
the bundled packages and their licences.

`superstables --version` names the build that is running.

## Set up

For `pay`, the owner runs `setup` once; hosted buy once and budgets don't need it. It creates `~/.superstables`, writes a starting spend
policy (`policy.yaml`, at most 0.05 USDC per payment and 1 USDC per day) and prints the command
that sets up your agent app. In the default browser mode it creates no key: the owner's key stays in their wallet. Running it
again keeps the existing policy.

```bash
superstables setup
superstables doctor
```

`doctor` checks the machine, one line per item: that the home directory and policy are in place,
which account last connected, that the approval port is free, and that the demo service, the
index and the facilitators answer:

```
  client version           0.3.0
  home                     /home/you/.superstables

✓ home directory           /home/you/.superstables (writable)
✓ spend policy             /home/you/.superstables/policy.yaml: up to 0.05 USDC per payment, 1 USDC per day
✓ browser wallet           no account connected yet: MetaMask connects when the first approval link opens
✓ approval page            http://127.0.0.1:4412 is free; the agent serves the page itself
✓ demo service             https://www.superstables.com/api/demo/market asks for payment (HTTP 402)
✓ Superstables index       https://www.superstables.com/api/v1/services answered HTTP 200
✓ facilitator.x402.rs      settles exact payments on Base Sepolia (testnet)
✓ facilitator.payai.network settles exact payments on Base Sepolia (testnet)
✓ x402.org                 settles exact payments on Base Sepolia (testnet)

Everything this machine needs is in place.
```

Not having connected an account yet is fine and is not a failure. A budget has its own setup:
see [Budget](budget.md).

In browser mode there is no approval process to start. When a payment needs approval, the process that asked for it (the
MCP server, or `superstables pay`) serves the approval page on `127.0.0.1:4412` and hands the agent
an approval link of the form `http://127.0.0.1:4412/approve/<id>`. If another payment is already waiting on
4412, the page takes a free port instead, and the approval link names that port.

## Set up your agent app

An agent can use the client in two ways: through the skill and a shell, or through MCP.

**The skill.** `superstables-payments` guides an agent through finding a service, pricing it and
both ways to pay, with their safety rules. Use the skill zip installed above, or link the
`skills/superstables-payments/` folder from a checkout into your agent's skills folder. Keep
`SKILL.md`, `references/` and `agents/openai.yaml` together. The agent needs a shell. Budgets need
the CLI: the MCP server has no budget tools.

**MCP.** The server has six tools for approving each payment (`pay`): `find_services`, `quote`, `pay`,
`payment_status`, `wallet_status` and `list_receipts`.

### Claude Code

```bash
claude mcp add superstables -e SUPERSTABLES_DEMO_SERVICES=on -- superstables mcp
```

`superstables setup` prints the same line with the absolute paths of Node and the client filled
in, which also works when Claude Code starts with a different PATH. From a checkout, at the
repository root:

```bash
claude mcp add superstables -e SUPERSTABLES_DEMO_SERVICES=on -- node "$(pwd)/dist/mcp/main.js"
```

Then, in Claude Code, run `/mcp`: `superstables` should be listed as connected, with six tools.
If it is not, `claude mcp list` shows the configured command, and the server logs to stderr —
start it by hand with `superstables mcp` to see what it says.

To keep the server's state somewhere else, pass `SUPERSTABLES_HOME` through:

```bash
claude mcp add superstables --env SUPERSTABLES_HOME=/path/to/home -- superstables mcp
```

Claude Code has been tested end to end with the MetaMask flow: find, quote, approve, pay,
receipt, and a rejected payment that signs nothing.

### Any other MCP client

The MCP server is part of the CLI: `superstables mcp` runs it on stdio. Any MCP client that can
start a local stdio server can use it. Most take a JSON entry like this one; where the file lives
and what the top-level key is called depend on the client, so check its documentation.

With `superstables` on your PATH (after `npm link` in a checkout):

```json
{
  "mcpServers": {
    "superstables": {
      "command": "superstables",
      "args": ["mcp"],
      "env": { "SUPERSTABLES_DEMO_SERVICES": "on" }
    }
  }
}
```

Straight from a checkout, with the absolute path to it:

```json
{
  "mcpServers": {
    "superstables": {
      "command": "node",
      "args": ["/absolute/path/to/superstables-client/dist/cli/main.js", "mcp"],
      "env": { "SUPERSTABLES_DEMO_SERVICES": "on" }
    }
  }
}
```

Leave out `SUPERSTABLES_DEMO_SERVICES` to leave out the hosted catalogue, and add `SUPERSTABLES_HOME` or
`SUPERSTABLES_WALLET` to `env` to change where state lives or which signer is used (see
[Environment](#environment-variables)).

The server logs to stderr only, because stdout is the protocol. Its first line says which build
is running, where its state lives and which signer it is using:

```
superstables client 0.3.0 · home /Users/you/.superstables · wallet browser
```

### Which build is running

After an update, restart the Superstables MCP server from your MCP client: a server process that
keeps running keeps answering with the old build. Then ask the agent for the wallet
status. The answer carries `client_version` and `home`: the first must be the version you just
built or installed, the second the directory you expect (`~/.superstables` unless you changed it).
`superstables --version` and `superstables doctor` answer the same question from a terminal.

Releases are tagged `v<version>` on GitHub, with the release notes taken from
[../CHANGELOG.md](../CHANGELOG.md).

## The paid service

The demo buys from a small x402 service Superstables hosts at
`https://www.superstables.com/api/demo/market` (`HOSTED_DEMO_SERVICE_URL` in
`src/core/discovery.ts`), so there is something to buy without anyone running a seller.

The seller is in this repository too, and `superstables demo-service` runs it, which is worth
doing to watch the seller's side of a payment. `SUPERSTABLES_DEMO_SERVICE_URL` then points the
client at that instance, or at any other one:

```bash
superstables demo-service --pay-to 0xYourSellerAddress
SUPERSTABLES_DEMO_SERVICE_URL="http://127.0.0.1:4402/v1/market" superstables find
```

A real x402 seller on `127.0.0.1:4402`. It answers `GET /v1/market?asset=BTC` with HTTP 402 and
its terms, verifies and settles the credential you send through a public facilitator, and only
then returns the data. 0.01 USDC per request by default.

| Option | Meaning |
| --- | --- |
| `--port <n>` | Listen somewhere other than 4402. Set `SUPERSTABLES_DEMO_SERVICE_URL` to match |
| `--pay-to <0x…>` | Where the money goes. Defaults to `SUPERSTABLES_DEMO_PAY_TO` |
| `--price <decimal>` | USDC per request. Default 0.01 |

Point `--pay-to` at an address you control. With no `--pay-to` and no environment variable it
generates a throwaway address, prints it and warns you: anything paid there is unrecoverable.

## The local wallet, for a machine with no browser

The second signer keeps a key in a file and serves its own approval page, protected by the owner
secret. It is the fallback, not the default.

```bash
superstables --wallet local setup          # creates ~/.superstables/wallet/key, prints the address
superstables --wallet local wallet serve   # leave it running
```

It binds `127.0.0.1:4411` and opens the approval page in your browser, already signed in. It
does that through a launcher file only you can read, in `~/Superstables-wallet-open/`, and
prints its path in case the browser does not open; the file, and the folder once empty, are
deleted once the page is open. It never prints the owner secret itself. The page sends the secret to the wallet process in an Authorization header, so the owner
can approve.

Over SSH, or with a browser that cannot open the launcher file, forward the port
(`ssh -L 4411:127.0.0.1:4411 user@host`), open `http://127.0.0.1:4411/` and paste the owner
secret, which `cat ~/.superstables/wallet/owner-secret` prints on the wallet's machine. Keep the
secret to yourself: it approves payments.

| Option | Meaning |
| --- | --- |
| `--port <n>` | Listen somewhere other than 4411. Set `SUPERSTABLES_WALLET_URL` to match |
| `--approval-timeout <seconds>` | How long a request waits for you. Default 120 |
| `--no-open` | Do not open a browser; print where the page and the launcher are |

Every other command needs `--wallet local` too, or `SUPERSTABLES_WALLET=local` in the
environment — including the one that starts the MCP server, which is how an agent gets it.
Fund the address it prints with test USDC on Base Sepolia from <https://faucet.circle.com>. Stopping the wallet is the off switch: with no
wallet, `pay` fails with "the wallet is not running", and nothing can be signed.

## Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `SUPERSTABLES_HOME` | `~/.superstables` | Where the policy, the records and the remembered account live |
| `SUPERSTABLES_WALLET` | `browser` | Who signs: `browser` (a browser wallet) or `local` (the local wallet process) |
| `SUPERSTABLES_APPROVE_PORT` | unset: `4412`, or a free port when 4412 is busy | Fixes the approval page's port, browser mode. A fixed port that is busy fails at once, without asking the owner or using up the quote. `0` picks a free port |
| `SUPERSTABLES_POLICY` | `$SUPERSTABLES_HOME/policy.yaml` | Read the policy from somewhere else |
| `SUPERSTABLES_WALLET_URL` | `http://127.0.0.1:4411` | Where the client looks for the local wallet |
| `SUPERSTABLES_WALLET_AGENT_TOKEN` | read from `wallet/agent-token` | The agent's bearer token for the local wallet, when it is not on this filesystem |
| `SUPERSTABLES_DEMO_SERVICE_URL` | `https://www.superstables.com/api/demo/market` | Where the built-in catalogue says the paid service is |
| `SUPERSTABLES_DEMO_PAY_TO` | none | Default recipient for `demo-service` |
| `SUPERSTABLES_DEMO_HOST` | `127.0.0.1` | Which interface `demo-service` binds |
| `SUPERSTABLES_MCP_WAIT_MS` | `20000` | How long the MCP tools wait for a payment before answering "still waiting" |
| `SUPERSTABLES_RPC_URL` | `https://sepolia.base.org` | Base Sepolia RPC, used to read the USDC balance and to check a settlement on chain (https, or http on this computer) |
| `SUPERSTABLES_INDEX_URL` | `https://www.superstables.com/api/v1/services` | The service index `find` reads. Point it at another index that answers the same API, or set it to `off` to list the built-in catalogue only |
| `SUPERSTABLES_DEMO_SERVICES` | unset (off) | `on` includes Superstables' testnet services from the hosted catalogue in discovery. Most return prepared sample output, carry `mock: true` and come after the listings not marked simulated; the market data service returns live prices. The demo setup snippets set it; leave it off to list no simulated services |
| `SUPERSTABLES_CATALOGUE_URL` | `https://www.superstables.com/api/demo/catalogue` | Where those services are published, read only when `SUPERSTABLES_DEMO_SERVICES` is on. Point it at another deployment, or set it to `off` |
| `SUPERSTABLES_SITE` | `https://www.superstables.com` | The site `setup --hosted` uses when `--site` is not given; `budget find` and `buy-once` use it before the site a hosted setup recorded. `setup --hosted` records its site as `SITE=` in the chain's public file, and later owner commands on that chain use that one and refuse a different `--site`. The owner's approvals happen on this site. Only superstables.com, its subdomains and this computer are accepted, unless `SUPERSTABLES_ALLOW_SITE` names the origin |
| `SUPERSTABLES_ALLOW_SITE` | unset | The owner's opt-in for a site outside superstables.com: the exact `https` origin, or a comma-separated list. Set it yourself, in your own environment, only for a site you have checked; an agent never sets it |
| `SUPERSTABLES_DOCTOR_OFFLINE` | unset | `1` makes `doctor` skip every check that needs a network |

`SUPERSTABLES_HOME` is read when state is first touched, so set it before starting a process
rather than during one. The CLI's `--home <dir>` sets it for you, and `--wallet <mode>` sets
`SUPERSTABLES_WALLET` the same way.

## Ports

| Port | What binds it | When | Bound to |
| --- | --- | --- | --- |
| 4412, or a free port when it is busy | the approval page, inside the agent's own process | browser mode, from the first payment | `127.0.0.1` |
| 4411 | the local wallet | `--wallet local` only | `127.0.0.1` |
| 4402 | the demo service | only if you run the seller yourself; the hosted one needs no port | `127.0.0.1` |

With these defaults, none is reachable from another machine; `SUPERSTABLES_DEMO_HOST` can bind
the demo service to another interface. If a port is busy, move it with the matching
variable or `--port`. The approval page moves by itself: a busy 4412 usually means another
payment is waiting there for its owner, so leave that process running.

## Uninstalling

Revoke each budget first: deleting an agent key does not end its allowance on chain. Run
`superstables budget revoke --rail <rail> --chain <chain> --wait` for each budget's rail and chain,
have the owner approve it, then check that `superstables budget status --rail <rail> --chain <chain>`
says `revoked: true`. For a named Tempo key, add `--agent <label>` to both.

For each chain you set up with `setup --hosted`, also remove the agent on your account page on that
site: that is what removes it from your account, and no command does it. Revoking on chain stops the
spending but leaves the agent on your account.

Then remove the MCP server (`claude mcp remove superstables`, or delete its entry from your MCP
client's configuration), delete the skill folder if you installed it, and delete `~/.superstables`
(or your `SUPERSTABLES_HOME`). If you linked a checkout with `npm link`, remove the
command with `npm uninstall -g @superstables/client`.

With `pay` in the default browser mode, that directory holds no key, and your funds in your wallet are
not affected. It can hold keys in two cases, and deleting it makes any funds those keys hold
unreachable. They are testnet funds, but check before you delete:

- `wallet/key`, with `--wallet local`;
- `keys/budget/`, the agent keys of `superstables budget`, which can hold gas the owner sent with
  `fund-agent`.
