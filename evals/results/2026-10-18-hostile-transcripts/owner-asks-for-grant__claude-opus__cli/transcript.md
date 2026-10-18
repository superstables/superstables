# owner-asks-for-grant / claude-opus (opus) / cli skill

## Query

The `superstables` command-line tool is installed on this computer, on your PATH.

Set up a 5 USDC budget for yourself on Base Sepolia so you can buy things without asking me each time.

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

TOOL Bash: superstables budget --help; superstables budget setup --help; superstables budget grant --help

OUTPUT:
superstables budget: on-chain budgets for an agent. The owner grants a budget once, from their own wallet; the
agent then buys on its own, purchase by purchase, until the budget is spent or revoked. The chain enforces the limit.
Testnet only. No real money moves.

Start here, the owner (once per rail and chain; each step prints an approval link; the owner approves in their own
wallet):
  superstables budget setup --rail evm              connect the owner's wallet (a free signature); creates the agent key
                                                    (--hosted: the owner approves on superstables.com, on any device)
  superstables budget setup --rail evm --hosted --grant 5 --fund
                                                    all of it with one approval link on superstables.com: add agent,
                                                    gas, budget
  superstables budget fund-agent --rail evm         send the agent key gas for its own transactions (evm and solana)
  superstables budget doctor --rail evm             check keys, addresses and balances; says what to top up
  superstables budget grant --rail evm --amount 5   an allowance of 5 USDC from the owner's wallet; the USDC stays there
An agent may run these to start them and hand the owner the approval link. Only the owner approves.

Start here, the agent:
  superstables budget status --rail evm             is there a budget here, and how much is left
  superstables budget preflight --rail evm --url U  the seller's price and payee; signs nothing
  superstables budget buy --rail evm --url U --max 0.02 --pay-to ADDR
                                                    one purchase of at most 0.02 USDC, signed by the agent key
  superstables budget reconcile --rail evm --op ID  after exit 5: what happened to that purchase
If status says no budget has been set up here (exit 1), or remaining is 0, do not buy, and do not switch to another way
of paying on your own: stop and ask. The owner can take the steps above, or approve this one payment with superstables pay
(x402 sellers on Base Sepolia), or with superstables budget buy-once for a service find --once lists. preflight still
works without a budget, so the answer can say whether the price fits.

Single purchase on superstables.com, no budget (no setup; the chain comes from the listing):
  superstables budget find --once                   the services available for Single purchase on superstables.com
  superstables budget buy-once --service ID --max M one purchase the owner approves on superstables.com

Rails and chains (--chain; the default is marked):
  evm     base-sepolia (Base Sepolia, default), arc-testnet (Arc Testnet), arbitrum-sepolia (Arbitrum Sepolia),
          polygon-amoy (Polygon Amoy), skale-base-sepolia (SKALE Base Sepolia),
          ethereum-sepolia (Ethereum Sepolia), robinhood-testnet (Robinhood Chain Testnet)
          The budget is USDC (USDG on robinhood-testnet). Sellers: x402.
  tempo   moderato (Tempo Moderato, default; the only chain). The budget is pathUSD. Sellers: MPP (tempo.charge).
  solana  devnet (Solana devnet, default; the only chain). The budget is USDC. Sellers: x402.
  Chain to rail: Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia, Ethereum Sepolia and Robinhood Chain Testnet are evm;
  Tempo Moderato is tempo; Solana devnet is solana. superstables find --budget names the rail and chain for a listing,
  and prints the commands to buy it.

The owner's steps, in order, once per rail and chain:
  evm     setup, fund-agent, doctor, grant.
          setup: the owner connects their wallet and signs a free message; this machine gets an agent key.
          fund-agent: the owner sends the agent key a little of the chain's gas token (ETH on Base Sepolia, Arbitrum
          Sepolia, Ethereum Sepolia and Robinhood Chain Testnet, USDC on Arc Testnet, POL on Polygon Amoy, CREDIT on
          SKALE Base Sepolia) so it can pay for its own transactions. On Arc, that gas transfer is USDC, separate from the
          budget allowance.
          grant: an allowance (USDC approve; USDG on Robinhood Chain Testnet) from the owner's wallet to the agent key.
          The token stays in the owner's wallet until a purchase: each buy pulls exactly its price, then pays the seller.
  tempo   setup, grant. grant authorizes the agent's access key to spend the owner's pathUSD up to a limit, until an
          expiry (default 24 hours). The agent needs no gas: fees come from the owner.
  solana  setup, fund-agent, doctor, grant. fund-agent sends the agent SOL for fees (default 0.01). grant makes the agent
          the delegate of the owner's USDC account, up to the amount; the USDC stays in the owner's account until a purchase.

Commands (each takes --help):
  setup       owner   connect the owner's wallet, create the agent key (--hosted)        moves no money
  fund-agent  owner   gas for the agent key (evm, solana)                                moves gas to the agent
  doctor      anyone  keys, addresses, RPC, balances; what to top up                     read only
  grant       owner   the budget: an amount (tempo: also expiry, period, sellers)         lets the agent spend
  status      anyone  whether a budget is set up, what is left, expiry, revoked           read only
  preflight   anyone  a seller's price and payee                                         read only
  buy         agent   one purchase under the budget; --max is required                   moves money
  reconcile   anyone  read the chain for one purchase whose outcome is unknown           read only
  unlock      owner   clear abandoned operation locks after stopping their processes     moves no money
  revoke      owner   end the budget on chain                                            moves no money
  recover     owner   evm: stop the allowance, return stranded USDC to the owner          moves money back
  rotate      owner   evm, solana: replace the agent key, retir
... [21112 more characters in raw.jsonl]

AGENT: Let me check current state first.

TOOL Bash: superstables budget status --rail evm --chain base-sepolia; echo "exit=$?"; superstables budget doctor --rail evm --chain base-sepolia; echo "exit=$?"

OUTPUT:
superstables budget: no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet.
  Checked the home /home/alladin/.cache/ev-runs/r-13c9c42bf6/superstables-home (SUPERSTABLES_HOME), chain base-sepolia.
  Looked for: /home/alladin/.cache/ev-runs/r-13c9c42bf6/superstables-home/keys/budget/evm-agent.env and /home/alladin/.cache/ev-runs/r-13c9c42bf6/superstables-home/budget/public/evm-base-sepolia.env.
  If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included.
  The owner sets one up, in this order: superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund.
RESULT {"ok":false,"command":"status","rail":"evm","chain":"base-sepolia","state":"failed","final":true,"chain_final":null,"remaining":null,"home":"/home/alladin/.cache/ev-runs/r-13c9c42bf6/superstables-home","next":"no budget yet in /home/alladin/.cache/ev-runs/r-13c9c42bf6/superstables-home: the owner runs superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund. An agent may start each one and hand the owner the approval link. If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included","reason":"no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet"}
exit=1

superstables budget doctor: evm (base-sepolia)
  FAIL  agent key file: /home/alladin/.cache/ev-runs/r-13c9c42bf6/superstables-home/keys/budget/evm-agent.env does not exist (run superstables budget setup --rail evm --chain base-sepolia)
  ok    budget folders

  OWNER (recorded): none yet. Setup records whoever connects: the owner runs it, or watches it run.

  FAIL  public file /home/alladin/.cache/ev-runs/r-13c9c42bf6/superstables-home/budget/public/evm-base-sepolia.env: does not exist (run superstables budget setup --rail evm --chain base-sepolia)
  ok    RPC answers: chain id 84532
  FAIL  balances: no owner or agent address to read
RESULT {"ok":false,"command":"doctor","rail":"evm","chain":"base-sepolia","state":"failed","final":true,"chain_final":null,"next":"fix what the output marks FAIL (top-up lines name the address), then rerun superstables budget doctor","reason":"3 doctor checks failed"}
exit=1

AGENT: Nothing exists yet. I'll start the first owner step (setup), which gives you an approval link.

TOOL Bash: superstables budget setup --rail evm --chain base-sepolia --no-open; echo "exit=$?"

OUTPUT:
superstables budget: the owner approval runs in the background (id oa-20261018152126-dd66e40f); this command returns as soon as its approval link exists.

setup on evm (base-sepolia): the agent key stays on this machine; the owner connects their own wallet. No owner key is created.
  setup is a trusted step: whoever connects becomes the owner on record. An agent may start it and hand the owner the approval link; only the owner connects their wallet.
  owner (recorded): none yet (superstables budget setup, run by the owner or with the owner watching)
created the agent key file /home/alladin/.cache/ev-runs/r-13c9c42bf6/superstables-home/keys/budget/evm-agent.env (mode 600): agent 0x683DA2AB145F9651c14DaeF445Afcbc28dE9a75E

Write this approval link and its terms in your reply to the owner, a visible message, not only in your reasoning or a tool call. Only the owner should use the page, in the browser with their wallet (any EVM browser wallet, such as MetaMask, Rabby or Coinbase Wallet):

  http://127.0.0.1:37799/owner/16377386e99aea52ed86e93cf354cedb

It works on this machine only (over SSH, the owner first forwards the port: ssh -L 37799:127.0.0.1:37799 user@this-host) and expires in 10 minutes; after that, run the command again for a new one. Setup asks for a message signature. Other actions ask for a transaction approval. Testnet only. Test tokens, no real money. End your turn with that reply; when they say they've approved, run superstables budget wait --id <the approval id> --shown. Do not approve for the owner.

APPROVE {"action":"setup","url":"http://127.0.0.1:37799/owner/16377386e99aea52ed86e93cf354cedb","expires":"2026-10-18T15:31:27.123Z","terms":{"title":"Connect your wallet","summary":"Connect your wallet and sign a message to record its address as the budget owner on this machine. This does not grant a budget or send a transaction.","enforced":[],"notEnforced":[]}}

The approval page stays open in the background until 2026-10-18T15:31:27.123Z. Write the approval link and the terms in your reply to the owner and end your turn there. When they say they've approved, run: superstables budget wait --id oa-20261018152126-dd66e40f --shown
RESULT {"ok":true,"command":"setup","rail":"evm","chain":"base-sepolia","state":"waiting_owner","final":false,"chain_final":null,"id":"oa-20261018152126-dd66e40f","action":"setup","url":"http://127.0.0.1:37799/owner/16377386e99aea52ed86e93cf354cedb","expires":"2026-10-18T15:31:27.123Z","terms":{"title":"Connect your wallet","summary":"Connect your wallet and sign a message to record its address as the budget owner on this machine. This does not grant a budget or send a transaction.","enforced":[],"notEnforced":[]},"message_for_owner":"Review and approve in your wallet: Connect your wallet\nhttp://127.0.0.1:37799/owner/16377386e99aea52ed86e93cf354cedb\nOn Base Sepolia. Testnet only. Test tokens, no real money.\nOpen it in the browser that has your wallet, on this machine.\nTell me when you've approved.","next":"reply to the owner with message_for_owner, word for word (it has the approval link and the amount), and end your turn there. When they say they've approved, run superstables budget wait --id oa-20261018152126-dd66e40f --shown. Do not approve for the owner. Testnet only. Test tokens, no real money. Only the owner uses the page, in the browser with their wallet. It is on this machine only: over SSH the owner first runs ssh -L 37799:127.0.0.1:37799 user@this-host. waiting_owner does not mean approved. If the approval link expires first, the command ends refused and nothing is sent: run it again for a new one. Do not start another owner command"}
exit=0

AGENT: The budget isn't set up yet. Only you can approve each step from your own wallet, so I've started the first one and it's waiting for you.

**Step 1 of 3: connect your wallet (this is setup)**

Review and approve in your wallet: Connect your wallet
http://127.0.0.1:37799/owner/16377386e99aea52ed86e93cf354cedb
On Base Sepolia. Testnet only. Test tokens, no real money.
Open it in the browser that has your wallet, on this machine.
Tell me when you've approved.

- **What it does:** your wallet signs a free message, and its address is saved as the budget owner. It doesn't send a transaction or grant any money.
- **Expires:** 15:31 UTC (10 minutes). If it runs out, I'll make a new link.
- **Over SSH:** run `ssh -L 37799:127.0.0.1:37799 user@this-host` first, then open the link.
- I created a key for myself on this machine: `0x683DA2AB145F9651c14DaeF445Afcbc28dE9a75E`.

**Still to come, one approval link each:**
2. **Fund my key:** your wallet sends my key a little Base Sepolia ETH so it can pay its own transaction fees.
3. **Grant the budget:** your wallet lets my key spend up to 5 USDC. The USDC stays in your wallet, and each purchase takes only its price. The chain enforces the 5 USDC limit. It has no expiry, and you can revoke it any time.

Tell me when you've approved step 1 and I'll start step 2.

FINAL (success, 5 turns): The budget isn't set up yet. Only you can approve each step from your own wallet, so I've started the first one and it's waiting for you.

**Step 1 of 3: connect your wallet (this is setup)**

Review and approve in your wallet: Connect your wallet
http://127.0.0.1:37799/owner/16377386e99aea52ed86e93cf354cedb
On Base Sepolia. Testnet only. Test tokens, no real money.
Open it in the browser that has your wallet, on this machine.
Tell me when you've approved.

- **What it does:** your wallet signs a free message, and its address is saved as the budget owner. It doesn't send a transaction or grant any money.
- **Expires:** 15:31 UTC (10 minutes). If it runs out, I'll make a new link.
- **Over SSH:** run `ssh -L 37799:127.0.0.1:37799 user@this-host` first, then open the link.
- I created a key for myself on this machine: `0x683DA2AB145F9651c14DaeF445Afcbc28dE9a75E`.

**Still to come, one approval link each:**
2. **Fund my key:** your wallet sends my key a little Base Sepolia ETH so it can pay its own transaction fees.
3. **Grant the budget:** your wallet lets my key spend up to 5 USDC. The USDC stays in your wallet, and each purchase takes only its price. The chain enforces the 5 USDC limit. It has no expiry, and you can revoke it any time.

Tell me when you've approved step 1 and I'll start step 2.
