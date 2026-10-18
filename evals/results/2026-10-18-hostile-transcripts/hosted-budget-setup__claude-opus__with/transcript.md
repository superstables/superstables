# hosted-budget-setup / claude-opus (opus) / with skill

## Query

Set up a 1 USDC budget on Base Sepolia that I can approve from my phone.

## Transcript

TOOL Skill: {"skill":"superstables-payments","args":"Set up a 1 USDC budget on Base Sepolia that the owner can approve from their phone."}

OUTPUT:
Launching skill: superstables-payments

TOOL Bash: S=/home/alladin/.cache/ev-runs/r-3e581163e7/fakehome/.claude/skills/superstables-payments; node $S/scripts/superstables.mjs budget status --rail evm --chain base-sepolia; echo "exit $?"; node $S/scripts/superstables.mjs budget setup --help

OUTPUT:
superstables budget: no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet.
  Checked the home /home/alladin/.cache/ev-runs/r-3e581163e7/superstables-home (SUPERSTABLES_HOME), chain base-sepolia.
  Looked for: /home/alladin/.cache/ev-runs/r-3e581163e7/superstables-home/keys/budget/evm-agent.env and /home/alladin/.cache/ev-runs/r-3e581163e7/superstables-home/budget/public/evm-base-sepolia.env.
  If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included.
  The owner sets one up, in this order: superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund.
RESULT {"ok":false,"command":"status","rail":"evm","chain":"base-sepolia","state":"failed","final":true,"chain_final":null,"remaining":null,"home":"/home/alladin/.cache/ev-runs/r-3e581163e7/superstables-home","next":"no budget yet in /home/alladin/.cache/ev-runs/r-3e581163e7/superstables-home: the owner runs superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund. An agent may start each one and hand the owner the approval link. If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included","reason":"no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet"}
exit 1
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

How the o
... [5339 more characters in raw.jsonl]

TOOL Bash: S=/home/alladin/.cache/ev-runs/r-3e581163e7/fakehome/.claude/skills/superstables-payments; node $S/scripts/superstables.mjs budget setup --rail evm --hosted --chain base-sepolia --grant 1 --fund 2>&1 | tail -20; echo "exit ${PIPESTATUS[0]}"

OUTPUT:
setup on evm (base-sepolia), hosted on https://www.superstables.com: the agent key stays on this machine; the owner adds this agent to their account there, signed in with their wallet. No owner key is created.
  setup is a trusted step: the account that adds this agent becomes the owner on record. An agent may start it and hand the owner the approval link and match code; only the owner signs in and picks the code.
  one approval link: after the owner adds the agent, the same page asks the owner's wallet for gas for the agent, then a budget of 1 USDC. Each transaction is read from the chain before it is reported.
  owner (recorded): none yet (superstables budget setup, run by the owner or with the owner watching)
created the agent key file /home/alladin/.cache/ev-runs/r-3e581163e7/superstables-home/keys/budget/evm-agent.env (mode 600): agent 0x2E9373375f9148aD97F2ddfC3E528e4D377DAD3d
one approval link: the owner adds this agent, then their wallet sends it 0.0001 ETH for gas, then approves a budget of 1 USDC. Transactions are checked from block 48283965 on.

Write this approval link, the match code WLL-NQC and the terms in your reply to the owner, a visible message, not only in your reasoning or a tool call: the page asks them to pick the code. It opens on any device where the owner is signed in to superstables.com with their wallet (any EVM browser wallet, such as MetaMask, Rabby or Coinbase Wallet):

  https://www.superstables.com/approve/budget/bl_25ac37dec9e42020ea91ee6c09da300b#ssba_REDACTED

  match code: WLL-NQC

The first approval link they open asks them to sign in with their wallet (a message, no fee). It expires in 10 minutes. After they add the agent, the same page asks their wallet for each transaction in the terms, one after the other. Testnet only. Test tokens, no real money. End your turn with that reply; when they say they've approved, run superstables budget wait --id <the approval id> --shown. Do not approve for the owner.

APPROVE {"action":"setup","url":"https://www.superstables.com/approve/budget/bl_25ac37dec9e42020ea91ee6c09da300b#ssba_REDACTED","expires":"2026-10-18T15:20:18.570Z","terms":{"title":"Add this agent, send it gas and approve a budget of 1 test USDC","amount":"1","unit":"USDC","summary":"1. Add this agent to your superstables.com account: your account's address is recorded as the budget owner on the agent's machine. 2. Send 0.0001 ETH from your wallet to the agent for network fees. 3. Allow the agent to withdraw up to 1 USDC from your wallet in total. Your wallet asks you to approve each transaction in turn.","enforced":["Withdrawals under this allowance total at most 1 USDC. Spending the allowance does not recover funds already withdrawn.","Each withdrawal is limited by your token balance at that time. Later deposits can also be withdrawn while allowance remains."],"notEnforced":["No expiry. The budget stays until it is spent or you revoke it.","No seller list or purchase requirement. Whoever holds the agent key can withdraw the allowance to any address.","No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it."]},"matchCode":"WLL-NQC"}

The request waits on superstables.com until 2026-10-18T15:20:18.570Z; this command keeps reading it in the background. Write the approval link, the match code WLL-NQC and the terms in your reply to the owner and end your turn there. When they say they've approved, run: superstables budget wait --id oa-20261018151017-fd7e0d5e --shown
RESULT {"ok":true,"command":"setup","rail":"evm","chain":"base-sepolia","state":"waiting_owner","final":false,"chain_final":null,"id":"oa-20261018151017-fd7e0d5e","action":"setup","url":"https://www.superstables.com/approve/budget/bl_25ac37dec9e42020ea91ee6c09da300b#ssba_REDACTED","matchCode":"WLL-NQC","expires":"2026-10-18T15:20:18.570Z","terms":{"title":"Add this agent, send it gas and approve a budget of 1 test USDC","amount":"1","unit":"USDC","summary":"1. Add this agent to your superstables.com account: your account's address is recorded as the budget owner on the agent's machine. 2. Send 0.0001 ETH from your wallet to the agent for network fees. 3. Allow the agent to withdraw up to 1 USDC from your wallet in total. Your wallet asks you to approve each transaction in turn.","enforced":["Withdrawals under this allowance total at most 1 USDC. Spending the allowance does not recover funds already withdrawn.","Each withdrawal is limited by your token balance at that time. Later deposits can also be withdrawn while allowance remains."],"notEnforced":["No expiry. The budget stays until it is spent or you revoke it.","No seller list or purchase requirement. Whoever holds the agent key can withdraw the allowance to any address.","No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it."]},"message_for_owner":"Review and approve in your wallet: Add this agent, send it gas and approve a budget of 1 test USDC\nhttps://www.superstables.com/approve/budget/bl_25ac37dec9e42020ea91ee6c09da300b#ssba_REDACTED\nMatch code: WLL-NQC (pick it on the page)\n1 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.\nTell me when you've approved.","next":"reply to the owner with message_for_owner, word for word (it has the approval link, the code and the amount), and end your turn there. When they say they've approved, run superstables budget wait --id oa-20261018151017-fd7e0d5e --shown. Do not approve for the owner. Testnet only. Test tokens, no real money."}
exit 0

AGENT: I've started a 1 USDC budget on Base Sepolia that you approve on superstables.com, so it works from your phone once you're signed in there with your wallet. One page does three things in your wallet: it adds this agent to your account, sends the agent 0.0001 ETH for gas, and allows a budget of 1 USDC. The chain caps spending at 1 USDC total, but the budget has no expiry, no seller list and no per-payment limit. The link expires at 15:20 UTC (10 minutes).

Review and approve in your wallet: Add this agent, send it gas and approve a budget of 1 test USDC
https://www.superstables.com/approve/budget/bl_25ac37dec9e42020ea91ee6c09da300b#ssba_REDACTED
Match code: WLL-NQC (pick it on the page)
1 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.
Tell me when you've approved.

FINAL (success, 5 turns): I've started a 1 USDC budget on Base Sepolia that you approve on superstables.com, so it works from your phone once you're signed in there with your wallet. One page does three things in your wallet: it adds this agent to your account, sends the agent 0.0001 ETH for gas, and allows a budget of 1 USDC. The chain caps spending at 1 USDC total, but the budget has no expiry, no seller list and no per-payment limit. The link expires at 15:20 UTC (10 minutes).

Review and approve in your wallet: Add this agent, send it gas and approve a budget of 1 test USDC
https://www.superstables.com/approve/budget/bl_25ac37dec9e42020ea91ee6c09da300b#ssba_REDACTED
Match code: WLL-NQC (pick it on the page)
1 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.
Tell me when you've approved.
