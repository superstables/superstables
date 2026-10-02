# Installing

Node 20 or newer, and MetaMask in your browser. Everything runs on your machine except the paid
service, the public facilitators, the Base Sepolia RPC and the Superstables index.

```bash
npm install -g @superstables/client
superstables setup
```

This puts the `superstables` command on your PATH. `npm install -g @superstables/client@latest`
updates it; [Which build is running](#which-build-is-running) says how to check that an agent
picked up the update.

`setup` is idempotent. It creates `~/.superstables`, writes `policy.yaml` from the example if
there is none, and prints the MetaMask steps and the exact command for your agent. It creates no
key: in the default mode there is no key on this machine.

### From a checkout

To run the client from its sources, for example to work on it:

```bash
git clone https://github.com/superstables/superstables-client.git
cd superstables-client
npm install
npm run build
npm link
superstables setup
```

`npm link` puts the checkout's `superstables` command on your PATH, so every command in these
docs works as written. Without it, run `node <checkout>/dist/cli/main.js …`, or
`npx --no superstables …` at the repository root. Keep the `--no`: when npx doesn't find this
checkout's command, it downloads whatever package the npm registry has under that name, and
`--no` makes it stop instead.

## There is no process to start

The client signs with MetaMask. The agent starts the MCP server, that server binds
`127.0.0.1:4412` the first time a payment needs approval, and it hands the agent a link of the
form `http://127.0.0.1:4412/approve/<id>`. You open the link, connect MetaMask, and sign. The
port is released when the server stops. If another payment is already waiting on 4412 (a second
agent, or a `superstables pay` in another terminal), the page takes a free port instead, and the
link names it.

So the only preparation is in the browser:

1. Install MetaMask: <https://metamask.io/download>.
2. Add the Base Sepolia network. The approval page offers to add or switch to it the first time
   you connect, so you can also skip this and say yes when asked.
3. Fund your MetaMask account with test USDC on Base Sepolia at <https://faucet.circle.com>.
   Copy the address out of MetaMask; that is the account that pays. You do not need ETH:
   facilitators submit the transfer and pay the gas.

Check the machine with `superstables doctor`. In this mode it checks that the home
directory and policy are in place, which account last connected, and that the approval port is
free:

```
  client version           0.1.0
  home                     ~/.superstables

✓ home directory           ~/.superstables (writable)
✓ spend policy             ~/.superstables/policy.yaml: up to 0.05 USDC per payment, 1 USDC per day
✓ browser wallet           no account connected yet: MetaMask connects when the first approval link opens
✓ approval page            http://127.0.0.1:4412 is free; the agent serves the page itself
```

Not having connected an account yet is fine and is not a failure.

## Claude Code

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

To keep the server's state somewhere else, or to use the local wallet, pass the environment
through:

```bash
claude mcp add superstables --env SUPERSTABLES_HOME=/path/to/home -- superstables mcp
```

Claude Code has been tested end to end with the MetaMask flow: find, quote, approve, pay,
receipt, and a rejected payment that signs nothing.

## Any other MCP client

The MCP server is part of the CLI: `superstables mcp` runs it on stdio. Any MCP client that can
start a local stdio server can use it. Most take a JSON entry like this one; where the file lives
and what the top-level key is called depend on the client, so check its documentation.

With `superstables` on your PATH (after `npm install -g @superstables/client`, or `npm link` in
a checkout):

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

Leave out `SUPERSTABLES_DEMO_SERVICES` to list only real sellers, and add `SUPERSTABLES_HOME` or
`SUPERSTABLES_WALLET` to `env` to change where state lives or which signer is used (see
[Environment](#environment-variables)).

The server logs to stderr only, because stdout is the protocol. Its first line says which build
is running, where its state lives and which signer it is using:

```
superstables client 0.1.0 · home /Users/you/.superstables · wallet browser
```

### Which build is running

After an update, restart the client so it starts the server again: a client that keeps the old
server process running keeps answering with the old build. Then ask the agent for the wallet
status. The answer carries `client_version` and `home`: the first must be the version you just
built or installed, the second the directory you expect (`~/.superstables` unless you changed it).
`superstables --version` and `superstables doctor` answer the same question from a terminal.

Releases are tagged `v<version>` on GitHub, with the release notes taken from
[../CHANGELOG.md](../CHANGELOG.md).

## The paid service

The demo buys from a small x402 service Superstables hosts at
`https://www.superstables.com/api/demo/market` (`HOSTED_DEMO_SERVICE_URL` in
`src/core/discovery.ts`), so there is something to buy without anyone running a seller. Nothing
has to be started for the quick start to work.

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

The second signer keeps a key in a file and serves its own approval page, protected by a secret
carried in the URL fragment. It is the fallback, not the default.

```bash
superstables --wallet local setup          # creates ~/.superstables/wallet/key, prints the address
superstables --wallet local wallet serve   # leave it running
```

It binds `127.0.0.1:4411`, prints an approval URL of the form
`http://127.0.0.1:4411/#<owner-secret>`, and opens it in your browser. The secret is in the URL
fragment, so it never reaches the server; keep that link to yourself.

| Option | Meaning |
| --- | --- |
| `--port <n>` | Listen somewhere other than 4411. Set `SUPERSTABLES_WALLET_URL` to match |
| `--approval-timeout <seconds>` | How long a request waits for you. Default 120 |
| `--no-open` | Do not open a browser; print the link only |

Every other command needs `--wallet local` too, or `SUPERSTABLES_WALLET=local` in the
environment — including the one that starts the MCP server, which is how an agent gets it.
Fund the address it prints from the same faucet. Stopping the wallet is the off switch: with no
wallet, `pay` fails with "the wallet is not running", and nothing can be signed.

## Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `SUPERSTABLES_HOME` | `~/.superstables` | Where the policy, the records and the remembered account live |
| `SUPERSTABLES_WALLET` | `browser` | Who signs: `browser` (MetaMask) or `local` (the wallet process) |
| `SUPERSTABLES_APPROVE_PORT` | unset: `4412`, or a free port when 4412 is busy | Fixes the approval page's port, browser mode. A fixed port that is busy fails at once, without asking the owner or using up the quote. `0` picks a free port |
| `SUPERSTABLES_POLICY` | `$SUPERSTABLES_HOME/policy.yaml` | Read the policy from somewhere else |
| `SUPERSTABLES_WALLET_URL` | `http://127.0.0.1:4411` | Where the client looks for the local wallet |
| `SUPERSTABLES_WALLET_AGENT_TOKEN` | read from `wallet/agent-token` | The agent's bearer token for the local wallet, when it is not on this filesystem |
| `SUPERSTABLES_DEMO_SERVICE_URL` | `https://www.superstables.com/api/demo/market` | Where the built-in catalogue says the paid service is |
| `SUPERSTABLES_DEMO_PAY_TO` | none | Default recipient for `demo-service` |
| `SUPERSTABLES_DEMO_HOST` | `127.0.0.1` | Which interface `demo-service` binds |
| `SUPERSTABLES_MCP_WAIT_MS` | `20000` | How long the MCP tools wait for a payment before answering "still waiting" |
| `SUPERSTABLES_RPC_URL` | `https://sepolia.base.org` | Base Sepolia RPC, used to read the USDC balance |
| `SUPERSTABLES_INDEX_URL` | `https://www.superstables.com/api/v1/services` | The service index `find` reads. Point it at another index that answers the same API, or set it to `off` to list the built-in catalogue only |
| `SUPERSTABLES_DEMO_SERVICES` | unset (off) | `on` includes Superstables' prepared demo services (simulated answers, marked `mock`) in discovery, after the real sellers. The demo setup snippets set it; leave it off to see only real sellers |
| `SUPERSTABLES_CATALOGUE_URL` | `https://www.superstables.com/api/demo/catalogue` | Where the prepared demo services are published, read only when `SUPERSTABLES_DEMO_SERVICES` is on. Point it at another deployment, or set it to `off` |
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

None of them is reachable from another machine. If a port is busy, move it with the matching
variable or `--port`. The approval page moves by itself: a busy 4412 usually means another
payment is waiting there for its owner, so leave that process running.

## Uninstalling

Remove the MCP server (`claude mcp remove superstables`, or delete its entry from your MCP
client's configuration) and delete `~/.superstables`. In the default mode that directory holds no key — your
funds are in MetaMask and are not affected. With `--wallet local` it holds
`wallet/key`, so deleting it makes any funds that key holds unreachable; they are testnet
funds, but check before you delete.
