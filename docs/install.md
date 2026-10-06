# Install the client

The Superstables client is a command, `superstables`, and the `superstables-payments` agent skill
that guides an agent through it. Start with a [budget](budget.md), where the owner
grants an on-chain budget once, or [Single purchase](buy-once.md), where the owner approves
each purchase (Single purchase on superstables.com, or Single purchase on your machine: `pay` on a page on this machine). Testnet only. Test USDC, or pathUSD on Tempo Moderato. No real money.

## What you need

- Node 20 or newer.
- Linux or macOS. On Windows, use WSL: `superstables budget` refuses to run on native Windows.
- Network access to sellers and testnet RPCs, and to the approval site when using approvals on superstables.com.
- For **local approvals**, an owner browser wallet that can reach the client's `127.0.0.1` page:
  an EVM wallet for EVM/Tempo, or a Solana wallet for a Solana budget. On the same machine, use
  a browser extension wallet. Over SSH, forward the approval link's port first:
  `ssh -L PORT:127.0.0.1:PORT user@host`. No superstables.com account is needed.
- For **approvals on superstables.com**, the owner can use a wallet on another device. They need a
  superstables.com account, created by signing in with an Ethereum wallet; Solana also needs a
  Solana wallet for the budget or payment. An ordinary remote browser without a compatible
  wallet cannot sign. Choose [budget approvals on superstables.com](budget.md#approve-on-superstablescom-instead)
  or [Single purchase on superstables.com](buy-once.md#hosted-buy-once-superstables-budget-buy-once).

These instructions describe **client 0.3.0** and require that release build. Install it from npm
as `@superstables/client`, or use the released commit and skill from
[GitHub Releases](https://github.com/superstables/superstables-client/releases).
The CLI/skill runs on your own machine or server,
even with approvals on superstables.com. EVM `recover` still needs a reachable local approval page and the
agent key on that runtime. Test-token and gas requirements belong to the chosen
[budget](budget.md#what-you-need) or [Single purchase](buy-once.md) flow.

The client runs on your machine and contacts sellers, the facilitators that settle x402 payments,
testnet RPCs, the Superstables index and, when switched on, the demo catalogue on superstables.com.

## Install

Pick one. All of them run the same commands on the same state, in `~/.superstables`.

**The agent skill, from Get started.** The one-line prompt on superstables.com's Get started page
has the agent download the skill zip, check its SHA-256 checksum and install it. The skill bundles
the whole CLI; [The agent skill](#the-agent-skill-with-the-whole-cli-bundled) below installs it by
hand.

The examples on these pages write the command as `superstables`. Installing from npm with `-g`, or
a checkout with `npm link`, puts that command on your PATH. For a git install pinned to a commit,
use `npx --no superstables …` in the installation folder, as shown below.

Don't type `npx superstables` to run the client. Where npx doesn't find this client's command, it
downloads whatever package the npm registry has under the name `superstables`, which is not this
client. The client's package is `@superstables/client`.

### From npm

```bash
npm install -g @superstables/client@0.3.0
superstables --version
```

This installs the `superstables` command, `superstables budget` included. The npm package holds
the command, not the agent skill: to connect an agent, also install the skill, as described in
[Set up your agent app](#set-up-your-agent-app).

### From a checkout

To run the client from its sources, for example to work on it, replace `<commit>` with the full
commit hash of the 0.3.0 release:

```bash
git clone https://github.com/superstables/superstables-client.git
cd superstables-client
git checkout --detach <commit>
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

In any folder, with `<commit>` replaced by the full commit hash of the 0.3.0 release (its
page on GitHub names the commit):

```bash
npm install github:superstables/superstables-client#<commit>
npx --no superstables --version
```

npm clones the repository at that commit, installs its development packages, builds the client
on your machine with them and installs the result, `superstables budget` included. That build
runs the repository's build scripts and the TypeScript compiler on your machine. Name a commit hash: without one, npm installs whatever the default branch holds
at that moment, and a branch or tag name can later point somewhere else.
Run it as `npx --no superstables …` in that folder, or as `node_modules/.bin/superstables …`.

### The agent skill, with the whole CLI bundled

`npm run skill` in a checkout builds `build/superstables-payments-skill-<version>.zip`, and
the 0.3.0 release uses that versioned zip. Unzip it into your agent's skills folder, `~/.claude/skills/` for
Claude Code or `~/.agents/skills/` for Codex. It unpacks to `superstables-payments/`, and needs
only Node:

```bash
node ~/.claude/skills/superstables-payments/scripts/superstables.mjs --version
```

Use that path wherever these pages say `superstables`. `scripts/THIRD_PARTY_NOTICES.txt` lists
the bundled packages and their licences.

`superstables --version` names the build that is running.

## Set up

For `pay`, the owner runs `setup` once; Single purchase on superstables.com and budgets don't need it. It creates `~/.superstables`, writes a starting spend
policy (`policy.yaml`, at most 0.05 USDC per payment and 1 USDC per day) and prints how the owner
approves payments. In the default browser mode it creates no key: the owner's key stays in their wallet. Running it
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

In browser mode there is no approval process to start. When a payment needs approval,
`superstables pay` serves the approval page on `127.0.0.1:4412` and prints an approval link of the
form `http://127.0.0.1:4412/approve/<id>`. If another payment is already waiting on
4412, the page takes a free port instead, and the approval link names that port.

## Set up your agent app

An agent uses the client through the `superstables-payments` skill and a shell. The skill guides
it through finding a service, pricing it and both ways to pay, with their safety rules. Use the
skill zip installed above, or link the `skills/superstables-payments/` folder from a checkout into
your agent's skills folder. Keep `SKILL.md`, `references/` and `agents/openai.yaml` together.

### Which build is running

After an update, `superstables --version` names the build that is running, and `superstables doctor`
prints it with the home directory it uses (`~/.superstables` unless you changed it). In the skill,
`scripts/VERSION.json` names the version and commit.

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
environment the agent's commands run in.
Fund the address it prints with test USDC on the EVM chain you pay on: on SKALE Base Sepolia, Base
Sepolia test USDC bridged over the SKALE bridge; on the other EVM chains, test USDC from
<https://faucet.circle.com> with the payment's chain selected. The local wallet signs on the EVM
chains only (Tempo and Solana payments are approved in a browser wallet on the approval page). Stopping the wallet is the off switch: with no
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
| `SUPERSTABLES_RPC_URL` | `https://sepolia.base.org` | Base Sepolia RPC, used to read the USDC balance and to check a settlement on chain (https, or http on this machine) |
| `SUPERSTABLES_TEMPO_RPC` | `https://rpc.moderato.tempo.xyz` | Tempo Moderato RPC, used to check a `pay` on chain and to search for one whose transaction the page did not report (https, or http on this machine). The budget's tempo rail reads it too |
| `SUPERSTABLES_SOLANA_RPC` | `https://api.devnet.solana.com` | Solana devnet RPC, used to check a `pay` on chain (https, or http on this machine). The budget's solana rail reads it too |
| `SUPERSTABLES_INDEX_URL` | `https://www.superstables.com/api/v1/services` | The service index `find` reads. Point it at another index that answers the same API, or set it to `off` to list the built-in catalogue only |
| `SUPERSTABLES_DEMO_SERVICES` | unset (off) | `on` includes Superstables' testnet services from the catalogue on superstables.com in discovery. Most return prepared sample output, carry `mock: true` and come after the listings not marked simulated; the market data service returns live prices. `find --demo` does the same for one search; leave it off to list no simulated services |
| `SUPERSTABLES_CATALOGUE_URL` | `https://www.superstables.com/api/demo/catalogue` | Where those services are published, read only when `SUPERSTABLES_DEMO_SERVICES` is on. Point it at another deployment, or set it to `off` |
| `SUPERSTABLES_SITE` | `https://www.superstables.com` | The site `setup --hosted` uses when `--site` is not given; `budget find` and `buy-once` use it before the site a setup on superstables.com recorded. `setup --hosted` records its site as `SITE=` in the chain's public file, and later owner commands on that chain use that one and refuse a different `--site`. The owner's approvals happen on this site. Only superstables.com, its subdomains and this machine are accepted, unless `SUPERSTABLES_ALLOW_SITE` names the origin |
| `SUPERSTABLES_ALLOW_SITE` | unset | The owner's opt-in for a site outside superstables.com: the exact `https` origin, or a comma-separated list. Set it yourself, in your own environment, only for a site you have checked; an agent never sets it |
| `SUPERSTABLES_DOCTOR_OFFLINE` | unset | `1` makes `doctor` skip every check that needs network access |

`SUPERSTABLES_HOME` is read when state is first touched, so set it before starting a process
rather than during one. The CLI's `--home <dir>` sets it for you, and `--wallet <mode>` sets
`SUPERSTABLES_WALLET` the same way.

## Ports

| Port | What binds it | When | Bound to |
| --- | --- | --- | --- |
| 4412, or a free port when it is busy | the approval page, inside the agent's own process | browser mode, from the first payment | `127.0.0.1` |
| 4411 | the local wallet | `--wallet local` only | `127.0.0.1` |
| 4402 | the demo service | only if you run the seller yourself; the one on superstables.com needs no port | `127.0.0.1` |

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

Before deleting files, resolve uncertain outcomes using [Records](records.md#check-an-unresolved-outcome).
Keep the journals and keys needed for those checks. For stranded EVM USDC, see
[recovery](budget.md#recovery-and-ending-use); revoke alone does not return it.

Then delete the skill folder if you installed it, and delete `~/.superstables`
(or your `SUPERSTABLES_HOME`). If you installed from npm, run
`npm uninstall -g @superstables/client`. If you linked a checkout with `npm link`, remove the
global link with `npm unlink --global @superstables/client`; this removes the linked command,
without downloading a package. If you installed from git in a separate installation folder, remove
that installation after preserving any records you still need.

With `pay` in the default browser mode, that directory holds no key, and your funds in your wallet are
not affected. It can hold keys in two cases, and deleting it makes any funds those keys hold
unreachable. They are testnet funds, but check before you delete:

- `wallet/key`, with `--wallet local`;
- `keys/budget/`, the agent keys of `superstables budget`, which can hold gas the owner sent with
  `fund-agent`.
