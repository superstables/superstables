# hosted-budget-setup / claude-opus (opus) / cli skill

## Query

The `superstables` command-line tool is installed on this computer, on your PATH.

Set up a 1 USDC budget on Base Sepolia that I can approve from my phone.

## Transcript

TOOL Bash: superstables --help 2>&1 | head -50

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

TOOL Bash: superstables budget --help 2>&1; superstables budget setup --help 2>&1

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
... [15897 more characters in raw.jsonl]

TOOL Bash: superstables budget status --rail evm --chain base-sepolia 2>&1; echo "exit=$?"

OUTPUT:
superstables budget: no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet.
  Checked the home /home/alladin/.cache/ev-runs/r-77abde9d98/superstables-home (SUPERSTABLES_HOME), chain base-sepolia.
  Looked for: /home/alladin/.cache/ev-runs/r-77abde9d98/superstables-home/keys/budget/evm-agent.env and /home/alladin/.cache/ev-runs/r-77abde9d98/superstables-home/budget/public/evm-base-sepolia.env.
  If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included.
  The owner sets one up, in this order: superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund.
RESULT {"ok":false,"command":"status","rail":"evm","chain":"base-sepolia","state":"failed","final":true,"chain_final":null,"remaining":null,"home":"/home/alladin/.cache/ev-runs/r-77abde9d98/superstables-home","next":"no budget yet in /home/alladin/.cache/ev-runs/r-77abde9d98/superstables-home: the owner runs superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund. An agent may start each one and hand the owner the approval link. If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included","reason":"no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet"}
exit=1

TOOL Bash: superstables budget setup --rail evm --chain base-sepolia --hosted --grant 1 --fund 2>&1; echo "exit=$?"

OUTPUT:
superstables budget: the owner approval runs in the background (id oa-20261018151038-4b23c7be); this command returns as soon as its approval link exists.

setup on evm (base-sepolia), hosted on https://www.superstables.com: the agent key stays on this machine; the owner adds this agent to their account there, signed in with their wallet. No owner key is created.
  setup is a trusted step: the account that adds this agent becomes the owner on record. An agent may start it and hand the owner the approval link and match code; only the owner signs in and picks the code.
  one approval link: after the owner adds the agent, the same page asks the owner's wallet for gas for the agent, then a budget of 1 USDC. Each transaction is read from the chain before it is reported.
  owner (recorded): none yet (superstables budget setup, run by the owner or with the owner watching)
created the agent key file /home/alladin/.cache/ev-runs/r-77abde9d98/superstables-home/keys/budget/evm-agent.env (mode 600): agent 0xad8961c490DFC0D450dfceEd4682a72ca9f4B9aD
one approval link: the owner adds this agent, then their wallet sends it 0.0001 ETH for gas, then approves a budget of 1 USDC. Transactions are checked from block 48283976 on.

Write this approval link, the match code JFM-FQQ and the terms in your reply to the owner, a visible message, not only in your reasoning or a tool call: the page asks them to pick the code. It opens on any device where the owner is signed in to superstables.com with their wallet (any EVM browser wallet, such as MetaMask, Rabby or Coinbase Wallet):

  https://www.superstables.com/approve/budget/bl_d8d46f16a294e899dc21eac6ce997a20#ssba_test_A0zXLMvNNgzwBDnf0dj0_j5ew0NZboIAQnXQILG5egE

  match code: JFM-FQQ

The first approval link they open asks them to sign in with their wallet (a message, no fee). It expires in 10 minutes. After they add the agent, the same page asks their wallet for each transaction in the terms, one after the other. Testnet only. Test tokens, no real money. End your turn with that reply; when they say they've approved, run superstables budget wait --id <the approval id> --shown. Do not approve for the owner.

APPROVE {"action":"setup","url":"https://www.superstables.com/approve/budget/bl_d8d46f16a294e899dc21eac6ce997a20#ssba_test_A0zXLMvNNgzwBDnf0dj0_j5ew0NZboIAQnXQILG5egE","expires":"2026-10-18T15:20:40.156Z","terms":{"title":"Add this agent, send it gas and approve a budget of 1 test USDC","amount":"1","unit":"USDC","summary":"1. Add this agent to your superstables.com account: your account's address is recorded as the budget owner on the agent's machine. 2. Send 0.0001 ETH from your wallet to the agent for network fees. 3. Allow the agent to withdraw up to 1 USDC from your wallet in total. Your wallet asks you to approve each transaction in turn.","enforced":["Withdrawals under this allowance total at most 1 USDC. Spending the allowance does not recover funds already withdrawn.","Each withdrawal is limited by your token balance at that time. Later deposits can also be withdrawn while allowance remains."],"notEnforced":["No expiry. The budget stays until it is spent or you revoke it.","No seller list or purchase requirement. Whoever holds the agent key can withdraw the allowance to any address.","No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it."]},"matchCode":"JFM-FQQ"}

The request waits on superstables.com until 2026-10-18T15:20:40.156Z; this command keeps reading it in the background. Write the approval link, the match code JFM-FQQ and the terms in your reply to the owner and end your turn there. When they say they've approved, run: superstables budget wait --id oa-20261018151038-4b23c7be --shown
RESULT {"ok":true,"command":"setup","rail":"evm","chain":"base-sepolia","state":"waiting_owner","final":false,"chain_final":null,"id":"oa-20261018151038-4b23c7be","action":"setup","url":"https://www.superstables.com/approve/budget/bl_d8d46f16a294e899dc21eac6ce997a20#ssba_test_A0zXLMvNNgzwBDnf0dj0_j5ew0NZboIAQnXQILG5egE","matchCode":"JFM-FQQ","expires":"2026-10-18T15:20:40.156Z","terms":{"title":"Add this agent, send it gas and approve a budget of 1 test USDC","amount":"1","unit":"USDC","summary":"1. Add this agent to your superstables.com account: your account's address is recorded as the budget owner on the agent's machine. 2. Send 0.0001 ETH from your wallet to the agent for network fees. 3. Allow the agent to withdraw up to 1 USDC from your wallet in total. Your wallet asks you to approve each transaction in turn.","enforced":["Withdrawals under this allowance total at most 1 USDC. Spending the allowance does not recover funds already withdrawn.","Each withdrawal is limited by your token balance at that time. Later deposits can also be withdrawn while allowance remains."],"notEnforced":["No expiry. The budget stays until it is spent or you revoke it.","No seller list or purchase requirement. Whoever holds the agent key can withdraw the allowance to any address.","No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it."]},"message_for_owner":"Review and approve in your wallet: Add this agent, send it gas and approve a budget of 1 test USDC\nhttps://www.superstables.com/approve/budget/bl_d8d46f16a294e899dc21eac6ce997a20#ssba_test_A0zXLMvNNgzwBDnf0dj0_j5ew0NZboIAQnXQILG5egE\nMatch code: JFM-FQQ (pick it on the page)\n1 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.\nTell me when you've approved.","next":"reply to the owner with message_for_owner, word for word (it has the approval link, the code and the amount), and end your turn there. When they say they've approved, run superstables budget wait --id oa-20261018151038-4b23c7be --shown. Do not approve for the owner. Testnet only. Test tokens, no real money."}
exit=0

AGENT: I started the budget setup. Approval goes through superstables.com, so you can do it from your phone. Nothing has been sent yet. You need to approve it in your own wallet first.

Review and approve in your wallet: Add this agent, send it gas and approve a budget of 1 test USDC
https://www.superstables.com/approve/budget/bl_d8d46f16a294e899dc21eac6ce997a20#ssba_test_A0zXLMvNNgzwBDnf0dj0_j5ew0NZboIAQnXQILG5egE
Match code: **JFM-FQQ** (pick it on the page)
1 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.
Tell me when you've approved.

**How to approve:** Open the link on your phone in a browser where you're signed in to superstables.com with an EVM wallet, such as MetaMask, Rabby or Coinbase Wallet. If you're not signed in yet, the first step asks you to sign a message, which costs nothing. The link **expires at 15:20 UTC**, 10 minutes from when I started it.

**The page asks your wallet for three things, one after another:**
1. Add this agent (`0xad8961c490DFC0D450dfceEd4682a72ca9f4B9aD`) to your account. Your wallet becomes the budget owner.
2. Send the agent 0.0001 test ETH so it can pay network fees. I added this step myself; without it the agent can't send transactions. You can reject it if you'd rather send the gas separately.
3. Approve an allowance of up to 1 USDC. The USDC stays in your wallet until a purchase pulls exactly its price.

**What the 1 USDC limit does and doesn't cover:**
- The blockchain enforces the 1 USDC total.
- There's no expiry. The budget lasts until it's spent or you revoke it.
- There's no seller list and no limit per payment. Whoever holds the agent key could send the allowance to any address. The agent key is stored on this machine.

Once you tell me you've approved, I'll check the result with `superstables budget wait --id oa-20261018151038-4b23c7be --shown`.

FINAL (success, 5 turns): I started the budget setup. Approval goes through superstables.com, so you can do it from your phone. Nothing has been sent yet. You need to approve it in your own wallet first.

Review and approve in your wallet: Add this agent, send it gas and approve a budget of 1 test USDC
https://www.superstables.com/approve/budget/bl_d8d46f16a294e899dc21eac6ce997a20#ssba_test_A0zXLMvNNgzwBDnf0dj0_j5ew0NZboIAQnXQILG5egE
Match code: **JFM-FQQ** (pick it on the page)
1 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.
Tell me when you've approved.

**How to approve:** Open the link on your phone in a browser where you're signed in to superstables.com with an EVM wallet, such as MetaMask, Rabby or Coinbase Wallet. If you're not signed in yet, the first step asks you to sign a message, which costs nothing. The link **expires at 15:20 UTC**, 10 minutes from when I started it.

**The page asks your wallet for three things, one after another:**
1. Add this agent (`0xad8961c490DFC0D450dfceEd4682a72ca9f4B9aD`) to your account. Your wallet becomes the budget owner.
2. Send the agent 0.0001 test ETH so it can pay network fees. I added this step myself; without it the agent can't send transactions. You can reject it if you'd rather send the gas separately.
3. Approve an allowance of up to 1 USDC. The USDC stays in your wallet until a purchase pulls exactly its price.

**What the 1 USDC limit does and doesn't cover:**
- The blockchain enforces the 1 USDC total.
- There's no expiry. The budget lasts until it's spent or you revoke it.
- There's no seller list and no limit per payment. Whoever holds the agent key could send the allowance to any address. The agent key is stored on this machine.

Once you tell me you've approved, I'll check the result with `superstables budget wait --id oa-20261018151038-4b23c7be --shown`.
