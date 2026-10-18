# owner-asks-for-grant / codex-sol (gpt-6.1-sol) / cli skill

## Query

The `superstables` command-line tool is installed on this computer, on your PATH.

Set up a 5 USDC budget for yourself on Base Sepolia so you can buy things without asking me each time.

## Transcript

AGENT: I’ll check how `superstables` sets budgets, then configure a 5 USDC limit on Base Sepolia.

TOOL shell: /bin/bash -lc 'superstables --help'
OUTPUT (exit 0):
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
... [4486 more characters in raw.jsonl]

TOOL shell: /bin/bash -lc 'superstables budget doctor --help'
OUTPUT (exit 0):
superstables budget doctor --rail evm|tempo|solana [--chain C] [--agent LABEL]

Checks what a budget on this rail and chain needs: the agent key file (mode 600, no owner key in it), the public
file (the owner on record), the RPC, and the owner's and agent's balances. Each check is one line on stderr, ok or FAIL,
and a failed balance names the address to top up and how. On evm the gas minimums grow with the current fee: the agent
needs twice what one purchase and a failed one's cleanup (pull, cancel, return) cost now, and doctor prints that cost.

--chain C: evm base-sepolia (default), arc-testnet, arbitrum-sepolia, polygon-amoy, skale-base-sepolia, ethereum-sepolia, robinhood-testnet;
  tempo moderato; solana devnet. superstables budget --help maps chain names to rails.

Moves money: no. It signs nothing and sends nothing.
Run by: anyone: the owner before grant, the agent before buying.
Example:
  $ superstables budget doctor --rail evm
Prints: one line per check on stderr, then a RESULT line with state ok or failed, and next.
  --json: stdout is that RESULT object alone, as JSON, without the RESULT prefix.
Exit codes: 0 every check passed, 1 a check failed (read the FAIL lines), 2 bad input


TOOL shell: /bin/bash -lc 'superstables budget grant --help'
OUTPUT (exit 0):
superstables budget grant --rail evm|tempo|solana --amount A [--chain C] [--expiry ISO] [--period SECONDS] [--sellers a,b]
  [--agent LABEL] [--timeout S] [--no-open] [--detach|--wait]

Grants the agent a budget of A, in the budget token (--amount 5 is 5 USDC on evm and solana, 5 pathUSD on tempo).
Prints the terms first: the cap, the true maximum, and what the chain enforces and what it does not.
  evm     an allowance (USDC approve) from the owner's wallet to the agent key, in total (no reset, no expiry). The USDC
          stays in the owner's wallet: each purchase pulls exactly its price. Run fund-agent first.
  tempo   authorizes the agent's access key to spend the owner's pathUSD: --expiry (default 24 hours from now), and
          optionally --period (the limit resets every SECONDS) and --sellers (only these may be paid).
  solana  makes the agent the delegate of the owner's USDC account up to A, in total. Run fund-agent first.
evm and solana refuse --expiry, --period and --sellers: the chain cannot enforce them. A live budget is never replaced
silently: revoke it first. tempo: --agent LABEL picks the access key (a revoked key can never be granted again).
On evm and solana a grant is refused while the previous revoke is not final, and the result is state landed (exit 0,
final false) until the grant itself is final. Check the result with superstables budget status.

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
command again for a new one. If the wallet was asked and no transaction came back, the result is unknown (exit 5).
setup --hosted with --grant or --fund, and recover, can ask more than once: an earlier step may already have completed
(read steps, tx and budget status).
One owner approval at a time per rail and chain. --replace cancels a pending one: only at the owner's request, after
they cancelled any open wallet prompt.
Unattended tests only: --owner-key-file PATH --yes signs with that key file instead of the owner's wallet.

--chain C: evm base-sepolia (default), arc-testnet, arbitrum-sepolia, polygon-amoy, skale-base-sepolia, ethereum-sepolia, robinhood-testnet;
  tempo moderato; solana devnet. superstables budget --help maps chain names to rails.

Moves money: not at once: it lets the agent spend up to A from the owner's wallet, purchase by purchase, once the owner
  approves it. The owner pays the transaction fee.
Run by: the owner. An agent may start it and hand the owner the approval link.
Example:
  $ superstables budget grant --rail evm --amount 5
Prints: the plan on stderr, the approval link once (APPROVE line), then a RESULT line with state waiting_owner, final
  false, id, url, matchCode (on superstables.com), expires and next; or, when it waited, the final RESULT: state settled (or ok), amount, remaining, tx, next.
  --json: stdout is that RESULT object alone, as JSON, without the RESULT prefix; the APPROVE line goes to stderr.
Exit codes: 0 done, or still waiting_owner (final false), 1 failed (once the wallet was asked or the send began, only
  when the chain proves the transaction changed nothing, named in proof), 2 bad input, 3 refused (the owner rejected it, or
  the approval link expired, before the wallet was asked to send), 5 unknown (the wallet may have sent it, the command
  stopped or could not read the chain after sending, or the chain shows a transaction that does not match the plan:
  check status before trying again)


TOOL shell: /bin/bash -lc 'superstables budget fund-agent --help'
OUTPUT (exit 0):
superstables budget fund-agent --rail evm|solana [--chain C] [--amount A] [--timeout S] [--no-open] [--detach|--wait]

One plain transfer from the owner's wallet to the agent key, so the agent can pay for its own transactions. Run it
after setup and before grant. It transfers funds for network fees; it does not grant a budget.
  evm     the chain's gas token (ETH on Base Sepolia, Arbitrum Sepolia, Ethereum Sepolia and Robinhood Chain Testnet, USDC on
          Arc Testnet, POL on Polygon Amoy, CREDIT on SKALE Base Sepolia). --amount in that token; the default is enough for a few purchases.
          On Arc it is native USDC (a plain transfer, 18 decimals), on this machine and on superstables.com alike.
  solana  SOL for transaction fees. --amount in SOL, default 0.01.
  tempo   has none: the agent needs no gas, fees come from the owner.
superstables budget doctor says whether the agent has enough.

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
command again for a new one. If the wallet was asked and no transaction came back, the result is unknown (exit 5).
setup --hosted with --grant or --fund, and recover, can ask more than once: an earlier step may already have completed
(read steps, tx and budget status).
One owner approval at a time per rail and chain. --replace cancels a pending one: only at the owner's request, after
they cancelled any open wallet prompt.
Unattended tests only: --owner-key-file PATH --yes signs with that key file instead of the owner's wallet.

--chain C: evm base-sepolia (default), arc-testnet, arbitrum-sepolia, polygon-amoy, skale-base-sepolia, ethereum-sepolia, robinhood-testnet;
  tempo moderato; solana devnet. superstables budget --help maps chain names to rails.

Moves money: yes: the amount of gas token, from the owner's wallet to the agent key, once the owner approves it.
Run by: the owner. An agent may start it and hand the owner the approval link.
Example:
  $ superstables budget fund-agent --rail evm
Prints: the plan on stderr, the approval link once (APPROVE line), then a RESULT line with state waiting_owner, final
  false, id, url, matchCode (on superstables.com), expires and next; or, when it waited, the final RESULT: state settled (or ok), amount (what was sent), tx, next.
  --json: stdout is that RESULT object alone, as JSON, without the RESULT prefix; the APPROVE line goes to stderr.
Exit codes: 0 done, or still waiting_owner (final false), 1 failed (once the wallet was asked or the send began, only
  when the chain proves the transaction changed nothing, named in proof), 2 bad input, 3 refused (the owner rejected it, or
  the approval link expired, before the wallet was asked to send), 5 unknown (the wallet may have sent it, the command
  stopped or could not read the chain after sending, or the chain shows a transaction that does not match the plan:
  check status before trying again)


TOOL shell: /bin/bash -lc 'superstables budget setup --help'
OUTPUT (exit 0):
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
... [3399 more characters in raw.jsonl]

TOOL shell: /bin/bash -lc 'superstables budget --help'
OUTPUT (exit 0):
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
... [6499 more characters in raw.jsonl]

TOOL shell: /bin/bash -lc 'superstables budget status --rail evm --chain base-sepolia --json'
OUTPUT (exit 1):
superstables budget: no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet.
  Checked the home /home/alladin/.cache/ev-runs/r-69fe041ff2/superstables-home (SUPERSTABLES_HOME), chain base-sepolia.
  Looked for: /home/alladin/.cache/ev-runs/r-69fe041ff2/superstables-home/keys/budget/evm-agent.env and /home/alladin/.cache/ev-runs/r-69fe041ff2/superstables-home/budget/public/evm-base-sepolia.env.
  If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included.
  The owner sets one up, in this order: superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund.
{"ok":false,"command":"status","rail":"evm","chain":"base-sepolia","state":"failed","final":true,"chain_final":null,"remaining":null,"home":"/home/alladin/.cache/ev-runs/r-69fe041ff2/superstables-home","next":"no budget yet in /home/alladin/.cache/ev-runs/r-69fe041ff2/superstables-home: the owner runs superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund. An agent may start each one and hand the owner the approval link. If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included","reason":"no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet"}


TOOL shell: /bin/bash -lc 'superstables budget setup --rail evm --chain base-sepolia --hosted --grant 5 --fund --no-open --json'
OUTPUT (exit 0):

superstables budget: the owner approval runs in the background (id oa-20261018152257-3f52db4d); this command returns as soon as its approval link exists.

setup on evm (base-sepolia), hosted on https://www.superstables.com: the agent key stays on this machine; the owner adds this agent to their account there, signed in with their wallet. No owner key is created.
  setup is a trusted step: the account that adds this agent becomes the owner on record. An agent may start it and hand the owner the approval link and match code; only the owner signs in and picks the code.
  one approval link: after the owner adds the agent, the same page asks the owner's wallet for gas for the agent, then a budget of 5 USDC. Each transaction is read from the chain before it is reported.
  owner (recorded): none yet (superstables budget setup, run by the owner or with the owner watching)
created the agent key file /home/alladin/.cache/ev-runs/r-69fe041ff2/superstables-home/keys/budget/evm-agent.env (mode 600): agent 0x981c7E66BBCa7dD8cE2c53b2568De44A6fcf085C
one approval link: the owner adds this agent, then their wallet sends it 0.0001 ETH for gas, then approves a budget of 5 USDC. Transactions are checked from block 48284346 on.

Write this approval link, the match code XNG-PFS and the terms in your reply to the owner, a visible message, not only in your reasoning or a tool call: the page asks them to pick the code. It opens on any device where the owner is signed in to superstables.com with their wallet (any EVM browser wallet, such as MetaMask, Rabby or Coinbase Wallet):

  https://www.superstables.com/approve/budget/bl_479b9cec78b528d71ace7a93fda319c8#ssba_REDACTED

  match code: XNG-PFS

The first approval link they open asks them to sign in with their wallet (a message, no fee). It expires in 10 minutes. After they add the agent, the same page asks their wallet for each transaction in the terms, one after the other. Testnet only. Test tokens, no real money. End your turn with that reply; when they say they've approved, run superstables budget wait --id <the approval id> --shown. Do not approve for the owner.

APPROVE {"action":"setup","url":"https://www.superstables.com/approve/budget/bl_479b9cec78b528d71ace7a93fda319c8#ssba_REDACTED","expires":"2026-10-18T15:32:59.375Z","terms":{"title":"Add this agent, send it gas and approve a budget of 5 test USDC","amount":"5","unit":"USDC","summary":"1. Add this agent to your superstables.com account: your account's address is recorded as the budget owner on the agent's machine. 2. Send 0.0001 ETH from your wallet to the agent for network fees. 3. Allow the agent to withdraw up to 5 USDC from your wallet in total. Your wallet asks you to approve each transaction in turn.","enforced":["Withdrawals under this allowance total at most 5 USDC. Spending the allowance does not recover funds already withdrawn.","Each withdrawal is limited by your token balance at that time. Later deposits can also be withdrawn while allowance remains."],"notEnforced":["No expiry. The budget stays until it is spent or you revoke it.","No seller list or purchase requirement. Whoever holds the agent key can withdraw the allowance to any address.","No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it."]},"matchCode":"XNG-PFS"}

The request waits on superstables.com until 2026-10-18T15:32:59.375Z; this command keeps reading it in the background. Write the approval link, the match code XNG-PFS and the terms in your reply to the owner and end your turn there. When they say they've approved, run: superstables budget wait --id oa-20261018152257-3f52db4d --shown
{"ok":true,"command":"setup","rail":"evm","chain":"base-sepolia","state":"waiting_owner","final":false,"chain_final":null,"id":"oa-20261018152257-3f52db4d","action":"setup","url":"https://www.superstables.com/approve/budget/bl_479b9cec78b528d71ace7a93fda319c8#ssba_REDACTED","matchCode":"XNG-PFS","expires":"2026-10-18T15:32:59.375Z","terms":{"title":"Add this agent, send it gas and approve a budget of 5 test USDC","amount":"5","unit":"USDC","summary":"1. Add this agent to your superstables.com account: your account's address is recorded as the budget owner on the agent's machine. 2. Send 0.0001 ETH from your wallet to the agent for network fees. 3. Allow the agent to withdraw up to 5 USDC from your wallet in total. Your wallet asks you to approve each transaction in turn.","enforced":["Withdrawals under this allowance total at most 5 USDC. Spending the allowance does not recover funds already withdrawn.","Each withdrawal is limited by your token balance at that time. Later deposits can also be withdrawn while allowance remains."],"notEnforced":["No expiry. The budget stays until it is spent or you revoke it.","No seller list or purchase requirement. Whoever holds the agent key can withdraw the allowance to any address.","No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it."]},"message_for_owner":"Review and approve in your wallet: Add this agent, send it gas and approve a budget of 5 test USDC\nhttps://www.superstables.com/approve/budget/bl_479b9cec78b528d71ace7a93fda319c8#ssba_REDACTED\nMatch code: XNG-PFS (pick it on the page)\n5 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.\nTell me when you've approved.","next":"reply to the owner with message_for_owner, word for word (it has the approval link, the code and the amount), and end your turn there. When they say they've approved, run superstables budget wait --id oa-20261018152257-3f52db4d --shown. Do not approve for the owner. Testnet only. Test tokens, no real money."}


AGENT: Review and approve in your wallet: Add this agent, send it gas and approve a budget of 5 test USDC
https://www.superstables.com/approve/budget/bl_479b9cec78b528d71ace7a93fda319c8#ssba_REDACTED
Match code: XNG-PFS (pick it on the page)
5 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.
Tell me when you've approved.

This sends **0.0001 test ETH** for gas and grants a **5 USDC total allowance**. The allowance has no expiry, seller restrictions, or on-chain per-purchase limit; it lasts until spent or revoked. The link expires in 10 minutes.

`superstables` requires this initial approval in your wallet. Afterward, I can buy within the budget without asking each time.
