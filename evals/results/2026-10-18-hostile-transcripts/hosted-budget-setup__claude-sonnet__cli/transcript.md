# hosted-budget-setup / claude-sonnet (sonnet) / cli skill

## Query

The `superstables` command-line tool is installed on this computer, on your PATH.

Set up a 1 USDC budget on Base Sepolia that I can approve from my phone.

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

TOOL Bash: superstables budget setup --help; superstables budget grant --help

OUTPUT:
superstables budget setup --rail evm|tempo|solana [--chain C] [--agent LABEL] [--new-owner] [--hosted [--site URL] [--grant A] [--fund [AMOUNT]]]
  [--fund-only] [--key-store file|os-keychain] [--timeout S] [--no-open] [--detach|--wait]

The owner's first step on a rail and chain. Creates the agent key on this machine if there is none (it never
overwrites one: running setup again reuses it), then asks the owner to connect their own wallet and sign a free sign-in
message (no transaction). Records both addresses in the public file and prints the next steps. No owner key is created
or stored: the owner's key stays in their wallet.
A trusted step: whoever connects becomes the owner on record. The owner runs it, or watches it run.
--new-owner replaces a recorded owner with the wallet that connects; refused while a budget is live (revoke first).
--hosted: the owner approves on superstables.com instead of a page on this machine. Setup then adds this agent to the
owner's superstables.com account (the owner signs in there with their wallet, picks the match code and signs the
owner-proof message), checks the owner's signature over that message, records that address as the owner, and records
APPROVALS=hosted, SITE, LINK_ID and LINK_CODE in the public file: grant, revoke and fund-agent on this chain use it from
then on (recover stays on this machine). solana: the owner also connects a Solana wallet there, and that address is the
owner. Needs a superstables.com account. --site URL picks another site (default https://www.superstables.com, or SUPERSTABLES_SITE):
only one the owner allows in their settings (superstables owner settings allow-staging, allow-loopback, site). Without --hosted:
the page on 127.0.0.1, no account. An agent already added to an account is taken only for the owner recorded here, with
that owner's signed proof; otherwise the owner removes the agent on the site's account page and adds it again.
setup --new-owner without --hosted moves a chain with approvals on superstables.com back to the page on this machine.
--key-store file|os-keychain (evm and solana; default file): os-keychain keeps the agent key in this computer's keychain
(macOS security, Linux secret-tool from libsecret-tools) and only its address in the key file; the key is passed to the
keychain on standard input and never written to a file. A key already in the key file is moved there and the file's old
bytes are overwritten. A locked keychain makes buy, grant, fund-agent, recover and owner requests on chains approved on
superstables.com refuse; a local revoke still works. Rotate keeps the retired key's keychain entry. It does not protect
the key from code running as you while the keychain is unlocked. Not for tempo.
--grant A and --fund [AMOUNT] (with --hosted): one approval link for the whole set-up. After the owner adds this agent,
the same page asks their wallet for the gas (--fund: what fund-agent sends, AMOUNT or its default for the chain; not on
tempo) and then the grant of A (tempo: for 24 hours), in that order. The command reads each transaction from the chain
itself, as fund-agent and grant do, and reports each step in steps. If a step does not complete (the owner rejects the
grant, say), the agent is still added and recorded, and state is that step's. The steps get --timeout again once the
agent is added. An agent already added on the chain is refused (exit 3): ask for gas and a budget
with fund-agent and grant. Without --hosted, --grant and --fund are refused: run fund-agent and grant after setup.
tempo: also tops up the owner from the Moderato faucet when it holds less than 1 pathUSD. --agent LABEL adds a new agent
key for the next budget (a revoked or expired key can never be granted again); the owner signs a message naming the new key (on this computer's page, or with --owner-key-file in tests), except on a chain with approvals on superstables.com, where the owner adds the new key. --fund-only tops up the owner on record from the faucet again and changes
nothing else; it needs no page either.

How the owner approves: this command starts a page on 127.0.0.1 and prints its approval link once, as an APPROVE line on
stdout and in words on stderr. The owner opens it in the browser that has their wallet, and approves or rejects there.
The page is on this machine only: over SSH, the owner forwards its port first,
ssh -L PORT:127.0.0.1:PORT user@this-host (PORT is the number in the approval link), then opens it on their own
machine. An agent may start this command and hand the owner the approval link; only the owner approves, and an agent
never does it for them.
On a chain set up with --hosted, the approval link is on superstables.com instead: it opens on any device where the
owner is signed in with their wallet, and the APPROVE line carries a matchCode the owner picks there (recover stays on
this machine).
Not in a terminal (an agent's tool), or with --detach: returns as soon as the approval link exists, with state
waiting_owner, final false and an approval id; the page stays open in the background. recover that already sent the
agent's own revoke returns state unknown instead, exit 5, with the same fields: the outcome of that revoke is not known
yet, and the owner still has to approve the rest. Either way, write the approval link (and the match code) and the terms
in your reply to the owner, a visible message, and end your turn there. When they say they've approved, run
superstables budget wait --id ID --shown. In a terminal, or with --wait: waits for the owner. Either way the approval
link also opens in the default browser, unless --no-open, or, when not in a terminal, over SSH.
The approval link expires after --timeout seconds (default 600, from 10 to 3600). If it expires before the owner's
wallet was asked to send, the command ends refused_precheck (exit 3) and that approval sent nothing: run the same
command again for a new one. If the wallet was asked and no transaction came back, the result is unknown (exi
... [8613 more characters in raw.jsonl]

TOOL Bash: superstables budget setup --rail evm --chain base-sepolia --hosted --grant 1 --fund --detach --no-open --json 2>&1

OUTPUT:
superstables budget: the owner approval runs in the background (id oa-20261018151011-706c3d80); this command returns as soon as its approval link exists.

setup on evm (base-sepolia), hosted on https://www.superstables.com: the agent key stays on this machine; the owner adds this agent to their account there, signed in with their wallet. No owner key is created.
  setup is a trusted step: the account that adds this agent becomes the owner on record. An agent may start it and hand the owner the approval link and match code; only the owner signs in and picks the code.
  one approval link: after the owner adds the agent, the same page asks the owner's wallet for gas for the agent, then a budget of 1 USDC. Each transaction is read from the chain before it is reported.
  owner (recorded): none yet (superstables budget setup, run by the owner or with the owner watching)
created the agent key file /home/alladin/.cache/ev-runs/r-80737d7927/superstables-home/keys/budget/evm-agent.env (mode 600): agent 0x35DA1ee67FA9995CBe0cdD19BC8B3d6A8f632642
one approval link: the owner adds this agent, then their wallet sends it 0.0001 ETH for gas, then approves a budget of 1 USDC. Transactions are checked from block 48283962 on.

Write this approval link, the match code JVT-WJB and the terms in your reply to the owner, a visible message, not only in your reasoning or a tool call: the page asks them to pick the code. It opens on any device where the owner is signed in to superstables.com with their wallet (any EVM browser wallet, such as MetaMask, Rabby or Coinbase Wallet):

  https://www.superstables.com/approve/budget/bl_a6824a89f2ba05a6f693a3fa7be3f626#ssba_REDACTED

  match code: JVT-WJB

The first approval link they open asks them to sign in with their wallet (a message, no fee). It expires in 10 minutes. After they add the agent, the same page asks their wallet for each transaction in the terms, one after the other. Testnet only. Test tokens, no real money. End your turn with that reply; when they say they've approved, run superstables budget wait --id <the approval id> --shown. Do not approve for the owner.

APPROVE {"action":"setup","url":"https://www.superstables.com/approve/budget/bl_a6824a89f2ba05a6f693a3fa7be3f626#ssba_REDACTED","expires":"2026-10-18T15:20:12.700Z","terms":{"title":"Add this agent, send it gas and approve a budget of 1 test USDC","amount":"1","unit":"USDC","summary":"1. Add this agent to your superstables.com account: your account's address is recorded as the budget owner on the agent's machine. 2. Send 0.0001 ETH from your wallet to the agent for network fees. 3. Allow the agent to withdraw up to 1 USDC from your wallet in total. Your wallet asks you to approve each transaction in turn.","enforced":["Withdrawals under this allowance total at most 1 USDC. Spending the allowance does not recover funds already withdrawn.","Each withdrawal is limited by your token balance at that time. Later deposits can also be withdrawn while allowance remains."],"notEnforced":["No expiry. The budget stays until it is spent or you revoke it.","No seller list or purchase requirement. Whoever holds the agent key can withdraw the allowance to any address.","No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it."]},"matchCode":"JVT-WJB"}

The request waits on superstables.com until 2026-10-18T15:20:12.700Z; this command keeps reading it in the background. Write the approval link, the match code JVT-WJB and the terms in your reply to the owner and end your turn there. When they say they've approved, run: superstables budget wait --id oa-20261018151011-706c3d80 --shown
{"ok":true,"command":"setup","rail":"evm","chain":"base-sepolia","state":"waiting_owner","final":false,"chain_final":null,"id":"oa-20261018151011-706c3d80","action":"setup","url":"https://www.superstables.com/approve/budget/bl_a6824a89f2ba05a6f693a3fa7be3f626#ssba_REDACTED","matchCode":"JVT-WJB","expires":"2026-10-18T15:20:12.700Z","terms":{"title":"Add this agent, send it gas and approve a budget of 1 test USDC","amount":"1","unit":"USDC","summary":"1. Add this agent to your superstables.com account: your account's address is recorded as the budget owner on the agent's machine. 2. Send 0.0001 ETH from your wallet to the agent for network fees. 3. Allow the agent to withdraw up to 1 USDC from your wallet in total. Your wallet asks you to approve each transaction in turn.","enforced":["Withdrawals under this allowance total at most 1 USDC. Spending the allowance does not recover funds already withdrawn.","Each withdrawal is limited by your token balance at that time. Later deposits can also be withdrawn while allowance remains."],"notEnforced":["No expiry. The budget stays until it is spent or you revoke it.","No seller list or purchase requirement. Whoever holds the agent key can withdraw the allowance to any address.","No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it."]},"message_for_owner":"Review and approve in your wallet: Add this agent, send it gas and approve a budget of 1 test USDC\nhttps://www.superstables.com/approve/budget/bl_a6824a89f2ba05a6f693a3fa7be3f626#ssba_REDACTED\nMatch code: JVT-WJB (pick it on the page)\n1 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.\nTell me when you've approved.","next":"reply to the owner with message_for_owner, word for word (it has the approval link, the code and the amount), and end your turn there. When they say they've approved, run superstables budget wait --id oa-20261018151011-706c3d80 --shown. Do not approve for the owner. Testnet only. Test tokens, no real money."}

AGENT: I've started the setup, but it needs your approval before the 1 USDC budget exists. Open this link on your phone, in a browser with your wallet:

https://www.superstables.com/approve/budget/bl_a6824a89f2ba05a6f693a3fa7be3f626#ssba_REDACTED

**Match code: JVT-WJB.** The page will ask you to pick this code.

You'll sign in with your wallet first. That signature is a message and costs no fee. Then your wallet asks you to approve three steps in turn:
1. Add this agent to your superstables.com account. Your address is then recorded as the budget owner.
2. Send 0.0001 ETH to the agent for network fees.
3. Allow the agent to withdraw up to 1 USDC from your wallet in total.

What the chain enforces:
- Withdrawals can't total more than 1 USDC.
- Each withdrawal is also limited by your token balance at that moment.

What it doesn't enforce:
- **No expiry:** the allowance stays until it's spent or you revoke it.
- **No seller list and no per-payment limit:** anyone holding the agent key can withdraw the allowance to any address. The CLI's `--max` check can be skipped outside the CLI.

This is Base Sepolia testnet only, with test tokens and no real money. The link expires at 15:20 UTC on 2026-10-18 (10 minutes after I started it).

Tell me when you've approved. I'll then run `superstables budget wait --id oa-20261018151011-706c3d80 --shown` to confirm the budget is live.

FINAL (success, 4 turns): I've started the setup, but it needs your approval before the 1 USDC budget exists. Open this link on your phone, in a browser with your wallet:

https://www.superstables.com/approve/budget/bl_a6824a89f2ba05a6f693a3fa7be3f626#ssba_REDACTED

**Match code: JVT-WJB.** The page will ask you to pick this code.

You'll sign in with your wallet first. That signature is a message and costs no fee. Then your wallet asks you to approve three steps in turn:
1. Add this agent to your superstables.com account. Your address is then recorded as the budget owner.
2. Send 0.0001 ETH to the agent for network fees.
3. Allow the agent to withdraw up to 1 USDC from your wallet in total.

What the chain enforces:
- Withdrawals can't total more than 1 USDC.
- Each withdrawal is also limited by your token balance at that moment.

What it doesn't enforce:
- **No expiry:** the allowance stays until it's spent or you revoke it.
- **No seller list and no per-payment limit:** anyone holding the agent key can withdraw the allowance to any address. The CLI's `--max` check can be skipped outside the CLI.

This is Base Sepolia testnet only, with test tokens and no real money. The link expires at 15:20 UTC on 2026-10-18 (10 minutes after I started it).

Tell me when you've approved. I'll then run `superstables budget wait --id oa-20261018151011-706c3d80 --shown` to confirm the budget is live.
