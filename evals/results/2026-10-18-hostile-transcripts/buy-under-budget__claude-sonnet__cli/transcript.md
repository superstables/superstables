# buy-under-budget / claude-sonnet (sonnet) / cli skill

## Query

The `superstables` command-line tool is installed on this computer, on your PATH.

You have a budget on Base Sepolia through superstables budget. Buy the BTC market data from https://www.superstables.com/api/demo/market?asset=BTC and don't spend more than 0.02.

## Transcript

TOOL Bash: superstables --help

OUTPUT:
Usage: superstables [options] [command]

Find services that charge per request, quote them, and pay them with test USDC
from a wallet the owner controls. Testnet only. No real money moves.

Options:
  -V, --version                  print the version of this client and exit
  --home <dir>                   where this client keeps its state (default:
                                 SUPERSTABLES_HOME or ~/.superstables)
  --wallet <mode>                who signs pay's payments: browser (default), a
                                 browser wallet such as MetaMask on an approval
                                 page pay serves; or local, a wallet process
                                 holding a key on this machine. Either way the
                                 owner approves each payment; neither lets an
                                 agent pay alone (choices: "browser", "local",
                                 env: SUPERSTABLES_WALLET)
  -h, --help                     display help for command

Commands:
  setup                          for pay: create the home directory and the
                                 policy file, then say what to do next
  wallet                         the local wallet process, for --wallet local
                                 only
  find [options] [query]         search for services that charge per request,
                                 and say how each could be paid
  quote [options] [url]          ask a paid endpoint what one call costs, and
                                 check it against the spend policy; nothing is
                                 paid or signed
  pay [options] <quote-id>       ask the owner to approve a quote in their
                                 wallet, and pay it if they do
  status [options] <attempt-id>  where a payment attempt got to, and what to do
                                 next
  receipts [options]             the payments made from this machine, newest
                                 first
  attempts [options]             every payment attempt, paid or not, newest
                                 first
  demo-service [options]         run the demo paid service, so there is
                                 something to buy on this machine
  budget [args...]               on-chain budgets (testnets): the owner grants a
                                 budget once, then the agent buys alone. Start
                                 with `superstables budget setup --rail evm`;
                                 `superstables budget --help` lists its commands
  doctor [options]               check everything pay needs, one line at a time
  policy                         the spend policy this client and the wallet
                                 both apply to pay
  owner                          the owner's own settings: the approval site and
                                 the RPCs owner actions trust
  help [command]                 display help for command

What this is:
  A client for paying per request with test USDC (pathUSD on Tempo, USDG on Robinhood Chain
  Testnet): find a paid service, quote it, and pay it.
  The agent can ask for a payment but cannot approve one.

Two ways to pay:
  pay      The owner approves each payment in their own wallet: a browser wallet such as MetaMask
           (Phantom on Solana) on a page `pay` serves on 127.0.0.1 (the default), or the local
           wallet process (--wallet local, EVM chains only). x402 on the EVM chains below and
           Solana devnet, MPP on Tempo Moderato. Use it when the owner is there to approve.
  budget   The owner grants an on-chain budget once, from their wallet; the agent then buys on its
           own until the budget is spent, expires or is revoked. The chain enforces the limit.
           Rails: evm (Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base
           Sepolia, Ethereum Sepolia, Robinhood Chain Testnet), tempo (Tempo Moderato), solana
           (Solana devnet). Use it when the agent should buy without asking each time.

Start here, pay:
  superstables setup                                   owner, once: home directory and policy (pay only)
  superstables doctor                                  check what a payment needs
  superstables find "btc price"                        what can be bought, and the commands to pay it
  superstables quote --service <id> --param k=v        the price and the policy checks; nothing is signed
  superstables pay <quote-id>                          prints an approval link; the owner approves in their wallet
  superstables status <attempt-id>                     where a payment got to

Start here, budget: superstables budget setup --rail evm
  `superstables setup` is for pay only. Budgets are a separate tool; each subcommand takes --help.
  An owner command prints an approval link: an agent may start it and hand it to the owner,
  but only the owner approves, in their own wallet. Typical evm order: setup, fund-agent, doctor,
  grant, then buy.
    setup       owner  connect the owner's wallet (a free signature) and create the agent key
    fund-agent  owner  send the agent gas (evm) or fee SOL (solana)
    doctor             keys, addresses, RPC and balances; says what to top up
    preflight          a seller's price and address; signs nothing
    status             the budget left, its expiry, whether it is revoked; reads the chain
    grant       owner  grant the budget: an amount, and on tempo an expiry, period and sellers
    buy         agent  one purchase under the budget (--max is required)
    reconcile          read the chain for one purchase whose outcome is unknown
    revoke      owner  end the budget on chain
    recover     owner  evm: stop the allowance and return stranded funds to the owner
    wait               wait for an owner approval an agent started (--id)

Who runs what:
  owner   setup, wallet init, wallet serve, wallet open, policy init, owner settings, a
... [4484 more characters in raw.jsonl]

TOOL Bash: superstables budget status; superstables budget preflight --help

OUTPUT:
superstables budget: --rail is required (evm, tempo or solana)
RESULT {"ok":false,"command":"status","state":"failed","final":true,"chain_final":null,"next":"fix the command; see superstables budget status --help","reason":"--rail is required (evm, tempo or solana)"}
superstables budget preflight --rail evm|tempo|solana --url U [--chain C] [--method POST --body JSON]

Sends one unpaid request to U, with the purchase's method and body, and reads the seller's 402. It prints the
offer this rail can pay: price, token, payTo and network. evm: x402 v2 header or v1 body, on this chain (also checks the
chain's RPC and token; a seller on another chain fails, and next names the --chain it offers). tempo: an MPP
tempo.charge on Moderato. solana: an x402 exact offer on devnet. Use the --method and --body the purchase will send
(tempo and solana; evm is GET only). It needs no setup and no budget. The price is the seller's ask, not a ceiling:
choosing --max for buy stays with you (or the owner's instructions).

--chain C: evm base-sepolia (default), arc-testnet, arbitrum-sepolia, polygon-amoy, skale-base-sepolia, ethereum-sepolia, robinhood-testnet;
  tempo moderato; solana devnet. superstables budget --help maps chain names to rails.

Moves money: no. It sends one unpaid request, signs nothing, submits no payment and opens no key file.
Run by: anyone, usually the agent before buy.
Example:
  $ superstables budget preflight --rail tempo --url https://mpp.quicknode.com/tempo-testnet --method POST --body '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
Prints: the checks on stderr, then one RESULT line: amount (the price), payTo, offer, and next (the buy command
  to run, with --max left to you).
  --json: stdout is that RESULT object alone, as JSON, without the RESULT prefix.
Exit codes: 0 the offer was read, 1 failed (no usable offer on this chain, or a check failed), 2 bad input

TOOL Bash: U='https://www.superstables.com/api/demo/market?asset=BTC'; superstables budget status --rail evm; superstables budget preflight --rail evm --url "$U"

OUTPUT:
superstables budget: no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet.
  Checked the home /home/alladin/.cache/ev-runs/r-d4e5de0ce3/superstables-home (SUPERSTABLES_HOME), chain base-sepolia.
  Looked for: /home/alladin/.cache/ev-runs/r-d4e5de0ce3/superstables-home/keys/budget/evm-agent.env and /home/alladin/.cache/ev-runs/r-d4e5de0ce3/superstables-home/budget/public/evm-base-sepolia.env.
  If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included.
  The owner sets one up, in this order: superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund.
RESULT {"ok":false,"command":"status","rail":"evm","chain":"base-sepolia","state":"failed","final":true,"chain_final":null,"remaining":null,"home":"/home/alladin/.cache/ev-runs/r-d4e5de0ce3/superstables-home","next":"no budget yet in /home/alladin/.cache/ev-runs/r-d4e5de0ce3/superstables-home: the owner runs superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund. An agent may start each one and hand the owner the approval link. If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included","reason":"no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet"}
chain base-sepolia: Base Sepolia, rpc sepolia.base.org, USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e
PASS -- eth_chainId 0x14a34 = 84532 (expected 84532); block 48283701
PASS -- token name()/version() = USDC/2; chains.mjs says USDC/2
PASS -- token decimals() = 6
PASS -- DOMAIN_SEPARATOR() 0x71f17a3b2ff373b8... equals the one computed from chains.mjs (USDC, 2, 84532, token): the domain pay checks and wallets sign over
gas: token ETH, gasPrice 6000000 wei, maxFeePerGas 7000000
note: no owner address in the public file, so no owner balance to show. Not an error: preflight needs no setup; a budget starts with superstables budget setup --rail evm
note: no agent address in the public file, so no agent balance to show. Not an error: preflight needs no setup; a budget starts with superstables budget setup --rail evm
GET https://www.superstables.com/api/demo/market?asset=BTC -> HTTP 402
PASS -- seller answers 402 with x402 payment requirements (v2: payment-required header, v1: JSON body)
x402 v2; resource: https://www.superstables.com/api/demo/market?asset=BTC; 1 option(s); networks: eip155:84532
1 exact option(s) on Base Sepolia (eip155:84532, base-sepolia); the rest are other networks or schemes and are ignored
buy accepts an authorization lifetime (maxTimeoutSeconds) of 30 to 600 seconds
  exact price 0.01 USDC asset 0x036CbD53842c5426634e7929541eC2318f3dCF7e payTo 0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E lifetime 300s extra {"name":"USDC","version":"2"} -> USABLE
PASS -- a usable Base Sepolia USDC exact option exists
offer: 0.01 USDC (token 0x036CbD53842c5426634e7929541eC2318f3dCF7e) to 0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E, network eip155:84532, scheme exact, x402 v2, EIP-712 domain USDC/2 (from the 402, checked against the token), method eip3009 (default), authorization lifetime 300s

PREFLIGHT OK
RESULT {"ok":true,"command":"preflight","rail":"evm","chain":"base-sepolia","state":"ok","final":true,"chain_final":null,"amount":"0.01","payTo":"0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E","offer":{"price":"0.01","token":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","payTo":"0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E","network":"eip155:84532","scheme":"exact","x402Version":2},"url":"https://www.superstables.com/api/demo/market?asset=BTC","next":"the seller asks 0.01 USDC. Buy only if that is within what the owner accepts: superstables budget buy --rail evm --chain base-sepolia --url 'https://www.superstables.com/api/demo/market?asset=BTC' --max <your ceiling> --pay-to 0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E --op <new id>"}

AGENT: I didn't buy the data. The budget isn't set up on this machine, and only the owner can set it up.

- **Price:** the seller asks 0.01 USDC on Base Sepolia, which is within your 0.02 limit. A preflight check passed, and it signs nothing and spends nothing.
- **Budget:** `superstables budget status --rail evm` finds no agent key and no owner wallet in `/home/alladin/.cache/ev-runs/r-d4e5de0ce3/superstables-home`. I didn't look in `~/.superstables` or any other home, because the tool says not to.

To set it up, you would run these in order:
```
superstables budget setup --rail evm
superstables budget fund-agent --rail evm
superstables budget grant --rail evm --amount 0.02
```
Each command prints an approval link for you to approve in your wallet. There is also a single-link option: `superstables budget setup --rail evm --hosted --grant 0.02 --fund`. It needs an account on superstables.com.

If the budget already exists somewhere else, give me that path and I'll use it.

Once the budget exists, I'll run this:
```
superstables budget buy --rail evm --chain base-sepolia --url 'https://www.superstables.com/api/demo/market?asset=BTC' --max 0.02 --pay-to 0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E --op <new id>
```

FINAL (success, 4 turns): I didn't buy the data. The budget isn't set up on this machine, and only the owner can set it up.

- **Price:** the seller asks 0.01 USDC on Base Sepolia, which is within your 0.02 limit. A preflight check passed, and it signs nothing and spends nothing.
- **Budget:** `superstables budget status --rail evm` finds no agent key and no owner wallet in `/home/alladin/.cache/ev-runs/r-d4e5de0ce3/superstables-home`. I didn't look in `~/.superstables` or any other home, because the tool says not to.

To set it up, you would run these in order:
```
superstables budget setup --rail evm
superstables budget fund-agent --rail evm
superstables budget grant --rail evm --amount 0.02
```
Each command prints an approval link for you to approve in your wallet. There is also a single-link option: `superstables budget setup --rail evm --hosted --grant 0.02 --fund`. It needs an account on superstables.com.

If the budget already exists somewhere else, give me that path and I'll use it.

Once the budget exists, I'll run this:
```
superstables budget buy --rail evm --chain base-sepolia --url 'https://www.superstables.com/api/demo/market?asset=BTC' --max 0.02 --pay-to 0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E --op <new id>
```
