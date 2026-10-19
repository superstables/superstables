# hosted-budget-setup / codex-sol (gpt-6.1-sol) / with skill

## Query

Set up a 1 USDC budget on Base Sepolia that I can approve from my phone.

## Transcript

AGENT: I’ll use the superstables-payments skill to set up the testnet budget and get a phone approval link.

TOOL shell: /bin/bash -lc 'cat /home/alladin/.cache/ev-runs/r-579e85c78d/fakehome/.agents/skills/superstables-payments/SKILL.md'
OUTPUT (exit 0):
---
name: superstables-payments
description: Finds services that charge per request, reads their prices without paying, and pays with the superstables CLI using test USDC, test USDG or test pathUSD. Testnet only. Budgets let the owner grant an on-chain budget once (superstables budget, approved on this machine with no account, or on superstables.com with setup --hosted; x402 and MPP sellers on Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia, Ethereum Sepolia, Robinhood Chain Testnet, Tempo Moderato and Solana devnet). Single purchase lets the owner approve one purchase in their wallet, on their machine (pay, on the same chains as budgets) or on superstables.com (budget buy-once, which needs an account there). Use when asked to find a paid API or a service with per-request payment, quote what a call costs, pay for one, make a single purchase, buy from an x402 or MPP seller under a price ceiling or a budget, check or reconcile a payment, or when the owner asks to set up, grant, fund, revoke or recover a testnet budget.
---

# Superstables payments

The `superstables` CLI finds services that charge per request, reads their price without paying, and pays them with test stablecoins. **Testnet only: test tokens, no real money.** There are two ways to pay:

- **Single purchase:** approve one purchase in your wallet, on your machine or on superstables.com. **Single purchase on superstables.com**, `superstables budget buy-once`: the owner approves it on superstables.com, from any device, with no setup, for the services `superstables budget find --once` lists (Base Sepolia, Arc Testnet, Robinhood Chain Testnet, Tempo Moderato or Solana devnet). It needs a superstables.com account, made by signing in with an Ethereum or Solana wallet. For now, a Solana account supports only Solana agents, Solana budgets and Solana single purchases. With an Ethereum account, Solana purchases also need a Solana wallet to sign the payment transaction. For any other seller `pay` can pay (x402 on the EVM testnets and Solana devnet, MPP on Tempo Moderato), or when the owner has no account, **Single purchase on your machine**, `pay`: the owner approves in their wallet on a page on this machine.
- **A budget**: the owner grants an on-chain budget once; the agent then buys on its own until it is spent, expires (Tempo only) or is revoked. The chain enforces the limit. By default the owner approves each set-up step on a page on this machine, with no account. With `setup --hosted` they approve on superstables.com instead, from any device, the whole set-up with one approval link; that needs an account there. When superstables.com's setup page (`start.md`) brought you here, use `setup --hosted`.

Local approvals, `pay` and budget purchases work without superstables.com. `buy-once`, `budget find` and `setup --hosted` need superstables.com, or a compatible site the owner chose (`--site`, or `SUPERSTABLES_SITE` set by the owner). For owner commands and `buy-once`, the CLI uses a site other than superstables.com only when the owner has allowed it in their own settings (`superstables owner settings`, which the owner runs in their terminal), and refuses any other.

The agent can ask for money to move; only the owner can approve it.

Terms used below: the **owner** controls the wallet and approves; the **agent** is you. A **service** is a listing that `find` returns; the **seller** is whoever answers at its URL and gets paid. A **purchase** is one `budget buy`; a **payment** is one `pay`. The **ceiling** is the most the owner accepts for one call.

## Running the CLI

`superstables` is `node scripts/superstables.mjs` in this skill's folder (the folder this SKILL.md is in). Run it with that folder's absolute path, for example `node ~/.claude/skills/superstables-payments/scripts/superstables.mjs find weather` or `node ~/.claude/skills/superstables-payments/scripts/superstables.mjs budget doctor --rail evm`. It needs Node 22+ and nothing else: `scripts/` holds the whole tool, bundled. `node scripts/superstables.mjs --version` names the build. Keys and state are in `$SUPERSTABLES_HOME` (default `~/.superstables`), shared with any other copy of the tool on this machine.

Every command has `--help` that lists its flags, whether it moves money, who runs it, what it prints and its exit codes. Read a command's `--help` before its first use instead of guessing flags. `superstables budget --help` also maps chain names to rails and lists the owner's steps per rail. Every `superstables budget` command accepts `--site <origin>`; pass one only when the owner gave you that site, and then pass it to each (safety rule 9).

## First, ask the owner what they would like to try

If the owner has not chosen how to pay, ask once, before any purchase or budget command, in one short reply, and end your turn: "This uses test tokens, no real money. Would you like a budget or a single purchase you approve?" Keep that reply to the question and at most one line saying the skill is installed: no paths, checksums, flags or later steps. Do not ask for a chain or a maximum price yet. `superstables budget find`, `superstables budget find --once` and `doctor` are fine first if they help you answer. If they already chose, or asked for something specific, do not ask again.

- **Single purchase**: Single purchase on superstables.com for a service `superstables budget find --once` lists. Read [references/once.md](references/once.md). For another seller, Single purchase on your machine: `pay` (step 5 below).
- **A budget**: use the chain the owner named; otherwise propose Base Sepolia, where most services take a budget, Superstables' market data among them. If the budget is for a particular service, check that the service takes a budget on a chain before you propose it or set it up, even one the owner chose: `superstables budget find --chain C` lists it, or, for a seller it does not list, `superstables budget preflight --rail R --chain C --url U` 
... [39487 more characters in raw.jsonl]

TOOL shell: /bin/bash -lc 'cat /home/alladin/.cache/ev-runs/r-579e85c78d/fakehome/.agents/skills/superstables-payments/references/budget.md'
OUTPUT (exit 0):
# On-chain budgets: superstables budget

`budget` keeps the 0.3.0 command-completion meaning of `final`. It is `false` while an owner approval is open or a buy-once `unknown` can still be read by `wait`, and `true` otherwise. `chain_final` describes the current matching payment separately: `true` after chain finality, `false` while included but not final, and `null` when no current matching inclusion is established, including an unknown after removal. A provisional paid purchase is `settled`, with `final: true`, `chain_final: false`, and exit 0 when delivered or exit 4 when not delivered. Check finality later with `reconcile` or `wait`; never pay again for that purchase. Owner-command transactions are not seller payments and have `chain_final: null`. On `evm` and `solana`, a grant, a revoke or a gas transfer is `state: "landed"` (exit 0, `final: false`) while its block is not yet final on the chain; `budget status` names the last owner action in `lastOwnerAction` (`action`, `tx`, `final`) and says when it is final. Older stored results without finality evidence also have `chain_final: null`.

The owner approves a spending cap once, in their own wallet. You then buy from sellers with no approval per purchase, until the cap is spent or the owner revokes it. The chain enforces the cap, and no Superstables service is in the path of a purchase. You hold only the agent key. Testnet only. Test tokens, no real money.

## Contents

- A budget on superstables.com
- The rails and what the chain enforces
- How each rail pays a seller
- The owner's steps per rail
- Owner approvals in detail
- Buying under a budget
- Reconcile
- Recover (evm)
- Revoke, and what it does not cover
- Gotchas
- Where state lives

<a id="a-hosted-budget-on-superstablescom"></a>

## A budget on superstables.com

If superstables.com's setup page (`start.md`) brought you here in this conversation, use approval on superstables.com without asking the owner where to approve; use the page on your machine only if they ask for it or have no account there and don't want one. Otherwise approval defaults to a page on your machine with no account; offer approval on superstables.com when the owner wants to approve from any device, such as their phone, and has or will make an account on superstables.com. Approval on superstables.com needs an account: if the owner does not have or want one, or `--hosted` fails, use [the page on your machine](#the-owners-steps-per-rail). One approval link does the whole set-up on superstables.com: the owner adds this agent to their superstables.com account, then, on the same page, approves the agent's gas and the budget in their wallet. They open it on any device where they are signed in with an Ethereum or Solana wallet; they need an account there, and the first approval link they open asks them to sign in (a message, no fee). After they pick the code, their wallet also signs the owner-proof message (no fee): the command checks that signature before it records anyone as the owner. For now, a Solana account supports only Solana agents, Solana budgets and Solana single purchases. With an Ethereum account, Solana actions also need a Solana wallet to sign transactions. Write the approval link as SKILL.md's safety rule 10 says.


1. **Ask which chain to use and how much of its test token to allow, together**, in one reply. Use the chain the owner named; otherwise propose Base Sepolia, where most services take a budget. If the budget is for a particular service, check that it takes a budget on a chain before you propose it or set it up, even one the owner chose: `superstables budget find --chain C` lists it, or `superstables budget preflight --rail R --chain C --url U` (R: the rail of that chain) reads an offer on C. If you can't confirm it, say so and ask whether the owner wants another service or a chain you have checked.
   - **Base Sepolia** (`--chain base-sepolia`): test USDC from faucet.circle.com (choose Base Sepolia), and a little Base Sepolia ETH from an ETH faucet, for the owner's fee on the grant and the agent's gas.
   - **Arc Testnet** (`--chain arc-testnet`), only if the owner asks for it or the service they want is on it: one faucet covers both. Test USDC from faucet.circle.com (choose Arc Testnet) is the budget and pays the fees.

   The other chains, Tempo and Solana are below; offer them only if the owner asks, or if the service the budget is for takes a budget there and you checked it. The same one approval link works there: `superstables budget setup --rail tempo --hosted --grant A` (pathUSD for 24 hours; no gas step) and `superstables budget setup --rail solana --hosted --grant A --fund` (the page also asks the owner to connect a Solana wallet, such as Phantom on devnet).
2. **One approval link.** `superstables budget setup --rail evm --hosted --chain C --grant A --fund`. It returns `state: "waiting_owner"` with `url`, `matchCode`, `terms`, `message_for_owner` and an approval `id`. `terms` lists the three steps: add the agent, send it gas (`--fund`: 0.0001 ETH on Base Sepolia; 0.1 USDC on Arc, apart from the budget), and the budget of A. Reply with `message_for_owner` and end your turn; when the owner says they've approved, run `superstables budget wait --id ID --shown`. Grant only what the owner is willing to lose: the chain enforces a total cap, not an expiry, a seller list or a per-payment limit, and whoever holds the agent key can move the allowance to any address.
3. **Read the final result.** The command reads each transaction from the chain itself before it reports it. `steps` has one entry each for the gas (`fund_agent`) and the budget (`grant`), with its `state` and `tx`. A step that is on chain as planned but not final yet has `state: "landed"` (the top-level `final` is then `false`, exit 0): the gas or the budget is not to be relied on until `status` says it is final.
   - `ok`: the agent has been added to the account, has gas, and has a budget of A. That account's address is the
... [25068 more characters in raw.jsonl]

TOOL shell: /bin/bash -lc 'node /home/alladin/.cache/ev-runs/r-579e85c78d/fakehome/.agents/skills/superstables-payments/scripts/superstables.mjs budget status --help'
OUTPUT (exit 0):
superstables budget status --rail evm|tempo|solana [--chain C] [--agent LABEL]

Whether a budget is set up here, and if so what is left of it: remaining, expiry, revoked, and the funds at risk
(the most the agent key could still move). Reads the chain. When no budget has been set up on this machine, it says so
first, names the home it checked (SUPERSTABLES_HOME, default ~/.superstables; home in the RESULT) and the owner's next
command. If the budget is elsewhere, ask the user for the path: do not point SUPERSTABLES_HOME at another home yourself.
remaining 0 means there is nothing to spend: the owner grants one.
revoked is true only for a revoke this machine recorded that the chain still shows (tempo: the key reads revoked); an
allowance or delegate that reads 0 without that record is remaining 0 and revoked false. A revoke that landed but is not
final yet is not revoked: lastOwnerAction says which action is waiting and whether it is final.

--chain C: evm base-sepolia (default), arc-testnet, arbitrum-sepolia, polygon-amoy, skale-base-sepolia, ethereum-sepolia, robinhood-testnet;
  tempo moderato; solana devnet. superstables budget --help maps chain names to rails.

Moves money: no. It reads files and the chain only; no secret is opened.
Run by: anyone.
Example:
  $ superstables budget status --rail evm
Prints: the owner on record on stderr, then a RESULT line: remaining, expiry, revoked, atRisk, lastOwnerAction, owner, next.
  --json: stdout is that RESULT object alone, as JSON, without the RESULT prefix.
Exit codes: 0 read, 1 failed (no budget set up here, or the chain could not be read: read reason and next), 2 bad input


TOOL shell: /bin/bash -lc 'node /home/alladin/.cache/ev-runs/r-579e85c78d/fakehome/.agents/skills/superstables-payments/scripts/superstables.mjs budget setup --help'
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

TOOL shell: /bin/bash -lc 'node /home/alladin/.cache/ev-runs/r-579e85c78d/fakehome/.agents/skills/superstables-payments/scripts/superstables.mjs budget status --rail evm --chain base-sepolia --json'
OUTPUT (exit 1):
superstables budget: no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet.
  Checked the home /home/alladin/.cache/ev-runs/r-579e85c78d/superstables-home (SUPERSTABLES_HOME), chain base-sepolia.
  Looked for: /home/alladin/.cache/ev-runs/r-579e85c78d/superstables-home/keys/budget/evm-agent.env and /home/alladin/.cache/ev-runs/r-579e85c78d/superstables-home/budget/public/evm-base-sepolia.env.
  If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included.
  The owner sets one up, in this order: superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund.
{"ok":false,"command":"status","rail":"evm","chain":"base-sepolia","state":"failed","final":true,"chain_final":null,"remaining":null,"home":"/home/alladin/.cache/ev-runs/r-579e85c78d/superstables-home","next":"no budget yet in /home/alladin/.cache/ev-runs/r-579e85c78d/superstables-home: the owner runs superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund. An agent may start each one and hand the owner the approval link. If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included","reason":"no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet"}


TOOL shell: /bin/bash -lc 'node /home/alladin/.cache/ev-runs/r-579e85c78d/fakehome/.agents/skills/superstables-payments/scripts/superstables.mjs budget setup --rail evm --hosted --chain base-sepolia --grant 1 --fund --json'
OUTPUT (exit 0):

superstables budget: the owner approval runs in the background (id oa-20261018151155-4941bde4); this command returns as soon as its approval link exists.

setup on evm (base-sepolia), hosted on https://www.superstables.com: the agent key stays on this machine; the owner adds this agent to their account there, signed in with their wallet. No owner key is created.
  setup is a trusted step: the account that adds this agent becomes the owner on record. An agent may start it and hand the owner the approval link and match code; only the owner signs in and picks the code.
  one approval link: after the owner adds the agent, the same page asks the owner's wallet for gas for the agent, then a budget of 1 USDC. Each transaction is read from the chain before it is reported.
  owner (recorded): none yet (superstables budget setup, run by the owner or with the owner watching)
created the agent key file /home/alladin/.cache/ev-runs/r-579e85c78d/superstables-home/keys/budget/evm-agent.env (mode 600): agent 0x2FBD023040Ade3CB154A57c22f73C48b2389E894
one approval link: the owner adds this agent, then their wallet sends it 0.0001 ETH for gas, then approves a budget of 1 USDC. Transactions are checked from block 48284015 on.

Write this approval link, the match code MMM-WTS and the terms in your reply to the owner, a visible message, not only in your reasoning or a tool call: the page asks them to pick the code. It opens on any device where the owner is signed in to superstables.com with their wallet (any EVM browser wallet, such as MetaMask, Rabby or Coinbase Wallet):

{"ok":true,"command":"setup","rail":"evm","chain":"base-sepolia","state":"waiting_owner","final":false,"chain_final":null,"id":"oa-20261018151155-4941bde4","action":"setup","url":"https://www.superstables.com/approve/budget/bl_a826d0b1f92ed56ee1af30b5b4066c81#ssba_REDACTED","matchCode":"MMM-WTS","expires":"2026-10-18T15:21:57.411Z","terms":{"title":"Add this agent, send it gas and approve a budget of 1 test USDC","amount":"1","unit":"USDC","summary":"1. Add this agent to your superstables.com account: your account's address is recorded as the budget owner on the agent's machine. 2. Send 0.0001 ETH from your wallet to the agent for network fees. 3. Allow the agent to withdraw up to 1 USDC from your wallet in total. Your wallet asks you to approve each transaction in turn.","enforced":["Withdrawals under this allowance total at most 1 USDC. Spending the allowance does not recover funds already withdrawn.","Each withdrawal is limited by your token balance at that time. Later deposits can also be withdrawn while allowance remains."],"notEnforced":["No expiry. The budget stays until it is spent or you revoke it.","No seller list or purchase requirement. Whoever holds the agent key can withdraw the allowance to any address.","No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it."]},"message_for_owner":"Review and approve in your wallet: Add this agent, send it gas and approve a budget of 1 test USDC\nhttps://www.superstables.com/approve/budget/bl_a826d0b1f92ed56ee1af30b5b4066c81#ssba_REDACTED\nMatch code: MMM-WTS (pick it on the page)\n1 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.\nTell me when you've approved.","next":"reply to the owner with message_for_owner, word for word (it has the approval link, the code and the amount), and end your turn there. When they say they've approved, run superstables budget wait --id oa-20261018151155-4941bde4 --shown. Do not approve for the owner. Testnet only. Test tokens, no real money."}
  https://www.superstables.com/approve/budget/bl_a826d0b1f92ed56ee1af30b5b4066c81#ssba_REDACTED

  match code: MMM-WTS

The first approval link they open asks them to sign in with their wallet (a message, no fee). It expires in 10 minutes. After they add the agent, the same page asks their wallet for each transaction in the terms, one after the other. Testnet only. Test tokens, no real money. End your turn with that reply; when they say they've approved, run superstables budget wait --id <the approval id> --shown. Do not approve for the owner.

APPROVE {"action":"setup","url":"https://www.superstables.com/approve/budget/bl_a826d0b1f92ed56ee1af30b5b4066c81#ssba_REDACTED","expires":"2026-10-18T15:21:57.411Z","terms":{"title":"Add this agent, send it gas and approve a budget of 1 test USDC","amount":"1","unit":"USDC","summary":"1. Add this agent to your superstables.com account: your account's address is recorded as the budget owner on the agent's machine. 2. Send 0.0001 ETH from your wallet to the agent for network fees. 3. Allow the agent to withdraw up to 1 USDC from your wallet in total. Your wallet asks you to approve each transaction in turn.","enforced":["Withdrawals under this allowance total at most 1 USDC. Spending the allowance does not recover funds already withdrawn.","Each withdrawal is limited by your token balance at that time. Later deposits can also be withdrawn while allowance remains."],"notEnforced":["No expiry. The budget stays until it is spent or you revoke it.","No seller list or purchase requirement. Whoever holds the agent key can withdraw the allowance to any address.","No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it."]},"matchCode":"MMM-WTS"}

The request waits on superstables.com until 2026-10-18T15:21:57.411Z; this command keeps reading it in the background. Write the approval link, the match code MMM-WTS and the terms in your reply to the owner and end your turn there. When they say they've approved, run: superstables budget wait --id oa-20261018151155-4941bde4 --shown


AGENT: Review and approve in your wallet: Add this agent, send it gas and approve a budget of 1 test USDC
https://www.superstables.com/approve/budget/bl_a826d0b1f92ed56ee1af30b5b4066c81#ssba_REDACTED
Match code: MMM-WTS (pick it on the page)
1 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.
Tell me when you've approved.
