# Security model

Superstables client 0.3.0 makes testnet payments only. This page says what each way to pay protects
and what it does not.

These payment flows have different boundaries:

| | Single purchase on your machine (`pay`) | Single purchase on superstables.com (`superstables budget buy-once`) | Budget (`superstables budget`) |
| --- | --- | --- | --- |
| Who approves | The owner, in their own wallet, for every payment | The owner, in their own wallet on the site, for one purchase | The owner, in their own wallet, once, for the whole budget |
| Keys the client holds | None with a browser wallet; `--wallet local` stores a signing key | None | The agent key, which signs purchases. The owner's key stays in their wallet |
| What limits spending | The owner's decision on each payment. The spend policy is a check in this client | The owner's decision on that purchase. The client checks `--max` and the listing price against the integer amount reported by the site; these checks do not constrain a compromised client or site | The chain: the allowance (`evm`), the delegated amount (`solana`), the access key's limits (`tempo`) |
| What a hostile agent can do | Ask for payments. With `--wallet local`, code running as the owner can also read that key | Ask for purchases, but cannot approve them without the owner's wallet. The one-open-purchase check applies only to this client's shared state | Use the agent key to spend what is left of the budget (on `evm` and `solana`, to any address), and move funds held at the agent's address |
| How it ends | A browser approval request expires after 5 minutes; a local-wallet request after 120 seconds, by default | The initial approval window is ten minutes. Expiry does not cancel a wallet request or transaction already underway | `superstables budget revoke`, approved in the owner's wallet |

The sections below cover `pay`: the approval page on `127.0.0.1` and the owner's
wallet. Budgets have their own section: [Budgets](#budgets). `superstables budget buy-once` and a
budget set up with `--hosted` are approved on a website instead, superstables.com by default; what
that site can and cannot do is in
[Budget approvals and Single purchase on superstables.com](#hosted-approvals-and-buy-once-what-the-site-can-and-cannot-do).

## Where the key is

In the default `pay` flow, the owner's signing key stays in their browser wallet. The client
does not generate, read or store it. That does not mean the machine holds no keys: the browser
wallet keeps its own, and the local wallet mode and budgets store separate keys.

Before the owner signs, the client builds an authorization and serves a page that shows its terms.
After it checks the signature it gets back, it sends the authorization to the seller, which has a
facilitator settle it.

## What the approval page verifies, and what it only repeats

A payment request reaches the signer as a `SignRequest`. It has two parts, and they are treated
completely differently.

**Verified — derived from the seller's payment requirement**, by the same `termsFor()` the
payment core uses, and shown as fact:

| Fact | Where it comes from |
| --- | --- |
| Amount (0.01 USDC, and the atomic `10000`) | `amount` in the requirement, divided by the asset's decimals |
| Asset | the requirement's `asset` address, which must be the network's USDC contract |
| Network | the requirement's `network`, which must be a supported one (`eip155:84532`) |
| Recipient | the requirement's `payTo`, which must be a well-formed address |
| Scheme | the requirement's `scheme`, which must be `exact` |
| Payer | the account the page reports as connected; that the account controls it is checked when its signature arrives |

A payment requirement that fails these checks is refused before an approval link exists. The
payer's signature is checked later, as described below.

**Reported — what the agent says the payment is for**, stored under `reported` and labelled
unverified wherever it is shown:

- `target` — the URL the agent says it is calling
- `serviceId`, `serviceName`, `description` — the agent's own labels
- `quoteId`, `attemptId` — the agent's record ids

None of it changes what gets signed. The typed data the wallet is asked to sign is built from the
verified requirement, field by field: `to` is the requirement's `payTo`, `value` is its
`amount`, `verifyingContract` is its asset.

There is one place where reported context has an effect: the policy takes the hostname for its
`allow`/`deny` rules from `reported.target`, because the requirement does not carry the URL that
was called. A dishonest agent could therefore misreport the host and slip past a host rule. It
cannot misreport the amount, the asset, the network or the recipient, so `caps.per_call`,
`caps.per_day`, `stablecoins` and `kill_switch` are all judged on verified facts. Treat host
rules as a convenience, not as a boundary.

## The approval link is the capability

This section, and the three after it, describe the page `superstables pay` serves on `127.0.0.1`.
`budget buy-once` and a budget set up with `--hosted` have no such page: their approval links are
on the site, and the owner acts there signed in to their account with their wallet. See
[Budget approvals and Single purchase on superstables.com](#hosted-approvals-and-buy-once-what-the-site-can-and-cannot-do).

There is no password on the approval page. The authority is the id in the URL: 128 bits of
randomness, generated when the payment is created, and handed to the agent as part of its tool
result so it can pass it to you.

That id is deliberately narrow. Holding it lets someone see *one* payment and sign *that* one:

- it names one stored request, and the routes under it (`/state`, `/account`, `/signature`,
  `/reject`) only ever act on that request;
- signing needs a valid signature from the account selected on the page. The approval link does not
  choose that account, but it cannot spend from an account without its signature;
- a decision is final: a second POST to a request that is no longer pending gets 409;
- the client binds `127.0.0.1`, so another machine cannot reach the page directly; port
  forwarding can make it reachable elsewhere;
- it answers only to the Host it is bound to, `127.0.0.1:PORT` (or `localhost:PORT`), so a web
  page under a DNS name that resolves to `127.0.0.1` cannot reach it;
- `/account`, `/signature` and `/reject` accept only a JSON body sent from the page's own origin,
  so another website open in your browser cannot reject or prepare a payment. This stops web
  pages, not local programs: any process on this machine that holds the approval link can set those
  headers, which is why the signature check below decides what is signed.

When a signature arrives, it is checked before it is used: `verifyTypedData` must recover the
same account the typed data was built for. A signature made by any other key is refused with a
reason, and the request stays pending so the right account can still sign. Nothing is ever
submitted on the strength of "the page said so".

## What a compromised agent can and cannot do

This section assumes a hostile agent in the default browser-wallet flow, with a wallet that is not
compromised.

It **can**:

- ask for any number of payments, to any recipient, and put a misleading label on each one;
- pick which URL to call and therefore which seller's terms come back;
- read this machine's records (`records/*.jsonl`): what was quoted, attempted, paid and asked
  for;
- refuse to show you an approval link, or show you one for a payment you did not ask for.

It **cannot**:

- get the owner's signing key through the client;
- make the client accept an authorization without a valid signature from the connected account;
- make the client accept a decision on an expired approval request;
- pay a recipient other than the one in the signed authorization — the recipient is *inside*
  what the wallet displays and what you sign.



## What a compromised client process could do

The `superstables pay` process serves the approval page. A hostile build of this software, or code
injected into it, **could**:

- show you a page that describes the payment dishonestly — a smaller amount, a different
  recipient, a service you recognise;
- build typed data that differs from what the page says;
- ask for payments repeatedly, hoping for a distracted yes.

A browser wallet that is not compromised shows its signing prompt apart from the client's page.
Check the network, the token contract, the recipient and the amount in that prompt; for USDC, a
`value` of `10000` is 0.01 USDC. Reject the request if the wallet's terms differ from the page's,
or if you cannot check them.

## The same-machine caveat

Any process running as your user can serve a page on loopback, and a browser wallet's permission to
connect is granted per origin. A hostile local process could serve its own page on
`127.0.0.1:4412` after this one stops and inherit a connection you granted earlier. It would
still have to get you to sign, and the wallet would still show it the real amount and recipient,
but it would not have to ask for the connection again.



## Expiry

- A **quote** is good for 10 minutes. Paying re-reads the seller's challenge and refuses if the
  terms moved.
- A **browser approval request** expires five minutes after it is created, by default, checked on a
  timer and on every request. Local-wallet requests expire after 120 seconds by default
  (`wallet serve --approval-timeout`).
- The **EIP-3009 authorization** carries its own on-chain window: `validBefore` is set to now
  plus the seller's `maxTimeoutSeconds` (300 seconds unless the seller asks for something else).
  After that, it cannot succeed on chain.
- Closing the client marks pending approval requests `abandoned`, which is not a rejection, and a
  signature that arrives afterwards is never sent. A payment already being sent can end
  `uncertain` instead. If the process is killed, the log may have no final line; pending requests
  are not restored after a restart.

## The approvals log

The browser signer appends each state change of an approval to
`~/.superstables/records/approvals.jsonl` (0600): the time, the id, the new status, the reason
if there is one, the verified terms, the reported context, and the account that connected. A
failed write does not stop the approval, so the file is not a guaranteed complete record.

It never contains a signature and never contains a key. It is a file for reading:

```bash
grep -o '"status":"[^"]*"' ~/.superstables/records/approvals.jsonl | tail -3
```

The agent side keeps its own append-only records next to it — quotes, attempts and receipts,
0600. No secrets, but they do say what was bought and for how much.

## Policy is software, not chain enforcement

`policy.yaml` is read and applied by this client: once advisory, at quote time, and once
authoritative, at the gate, before an approval is created at all. A payment the policy refuses
never becomes an approval link, so there is nothing to open and nobody is asked.

Nothing in the policy is enforced by the blockchain, and nothing in it is enforced by the wallet.
A cap of 0.05 USDC per payment means this software will not ask you to sign more than that; it
does not mean your account cannot sign more. The only limits that survive a compromised machine
are the ones inside what you sign — the amount and the recipient in the authorization — and the
balance of the account, which is why this release is testnet only.

The browser signer counts the daily cap from receipts and attempt records in this directory,
including pending, in-flight and uncertain payments; the local wallet counts the authorizations in
its own `wallet/audit.jsonl`. Neither reads chain history: delete
those records and the count starts again.

## Testnet only

`pay` supports eight testnets, each with one token pinned in the client: x402 `exact` with test
USDC on Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia, Ethereum
Sepolia and Solana devnet, and MPP `tempo.charge` with test pathUSD on Tempo Moderato. On the EVM
chains the token's EIP-712 signing domain is pinned too, so a seller cannot make the wallet show a
signing name of its choosing. A requirement naming anything else, every mainnet included, is
refused before anyone is asked. There is no configuration that turns on mainnet.

On Tempo the owner's wallet sends the payment itself, so the order is different. MPP sellers that
split a price between recipients, set a memo of their own, accept only payments they submit
themselves, want the credential in a header of their choosing, or whose request expires in less
than a minute or more than an hour are refused before anyone is asked, and so is a challenge an
earlier payment already used: its memo would be the same. Before the page asks the wallet to send,
it switches the wallet to Tempo Moderato and checks the chain it is on, and the client records that
money may move, under the daily cap check, with the chain's latest block. The page checks the
wallet's chain again right before it asks, the call it sends names Tempo Moderato's chain id, and
it asks the wallet once per approval. The client then reads the owner's transaction and calls the
seller only when the chain shows exactly this transfer with this payment's memo, mined after the
wallet was asked. A wallet that was asked and did not answer, or whose rejection the page reports,
leaves the attempt `uncertain`: a page's report is not proof that nothing was sent, since anything
holding the approval link can post it. `superstables status` then searches the chain for the memo,
in blocks after the one recorded, and never takes a transfer already recorded as another payment.

For x402 payments, public facilitators submit the transfer and pay the gas. A facilitator sees
the signed authorization or transaction, so it learns who paid whom and how much; it cannot
alter the amount or the recipient, because those are inside what was signed. The client's facilitator helper tries the next facilitator when one cannot be
reached, and stops when one refuses. Other sellers choose their own facilitators.

On Tempo Moderato, the owner's wallet sends the pathUSD transfer and pays its network fee.

With `pay` over x402, the seller reports the settlement and names a transaction. The client checks
that transaction on the payment's chain and records `chain`. What `verified` requires depends on
the chain:

- On the EVM chains: a successful receipt in which the chain's USDC contract logged both the use of
  the nonce the owner signed (`AuthorizationUsed`) and a transfer of exactly the signed amount from
  the payer to the checked recipient.
- On Solana devnet: a successful transaction that carries the owner's signature over the
  transaction the client built, and whose one token instruction moves exactly the signed amount of
  devnet USDC from the owner's token account to the recipient's.
- On Tempo Moderato (MPP, above): a successful transaction from the owner in which pathUSD logged
  `TransferWithMemo` of exactly this amount to this recipient with this payment's memo, mined after
  the wallet was asked.

`unchecked` means the chain could not say (no transaction named, not mined yet, the RPC did not
answer): the payment rests on the seller's report, said as such, and `superstables status` checks
again. `mismatch` means the transaction is something else: the attempt
becomes `uncertain`, neither confirmed nor refuted, and is never retried. On Tempo and Solana, the
client does not use a transaction already recorded as another attempt's verified payment. On EVM
chains, one transaction may settle several payments; each must match its own signed authorization
nonce and exact transfer.

Once the credential has left this machine, a seller's "not paid" (an HTTP 402, a failed
settlement) leaves the attempt `uncertain`, not `failed`: the facilitator may have settled it
anyway, before or after the answer. `superstables status` then looks for the payment by what ties
it to this attempt alone: on the EVM chains the token's record of the nonce (`authorizationState`
and its `AuthorizationUsed` log), on Solana devnet a transaction carrying the owner's signature.
When the chain shows the payment can no longer happen, the attempt becomes `failed` with
`chain: "unpaid"`. That takes final evidence, and anything less decides nothing:

- On the EVM chains: a final block dated at or past the authorization's `validBefore`, at which the
  token shows the authorization unused; or the authorization's cancellation (`AuthorizationCanceled`)
  in the chain's final history. For a cancellation, the client reads the final block first, then the
  cancellation's log; the log must be in a block at or below the final block, and that height's
  block, read again, must have the log's block hash. A used nonce alone does not show a
  cancellation: after a reorganisation, the payment may have used it instead. A final block is the
  one the RPC returns for the `finalized` tag; on SKALE Base Sepolia, whose blocks are final once
  they are in the chain and whose RPC does not answer that tag, it is the latest block. If the RPC
  does not return a final block, the attempt stays `uncertain`.
- On Solana devnet: on an RPC whose genesis hash is devnet's, the finalized block height is past the
  blockhash's last valid height, and every one of the 151 finalized blocks the transaction could have
  landed in was read whole, at consecutive heights, with no transaction in them that is this payment:
  each one that carries the owner's signature is read, and one that failed on chain is not this
  payment. A block or a transaction that cannot be read, or a missing block, decides nothing. One
  status reads these blocks for up to 45 seconds and records on the attempt the slot up to which they
  hold no payment (`searchedToSlot`); the next status reads on from the block after it. Finalized
  blocks do not change, so what an earlier status read still holds. The list of the owner's token
  account's transactions is used to find a payment, never to show one is missing: an RPC writes that
  list after the blocks, so it can lag them.
- On Tempo Moderato: never. A transfer the wallet was asked to send has no expiry, so only finding it
  resolves the attempt.

The same search decides a payment the seller reported without a transaction the chain confirms.

These checks trust the RPC's answer. The client does not run a node: a dishonest or compromised RPC
can answer with a receipt that never happened, or hide one that did. HTTPS authenticates the
connection to that RPC, not the chain behind it. Base Sepolia uses `SUPERSTABLES_RPC_URL` when it is
set, Tempo Moderato `SUPERSTABLES_TEMPO_RPC` and Solana devnet `SUPERSTABLES_SOLANA_RPC` (each
HTTPS, or HTTP on this machine, without credentials); otherwise the client uses the chain's
configured public RPC. Use an RPC you trust when that matters. The budget rails read the chain too.

On chains that require finalized evidence, a custom RPC without the `finalized` block tag can
show a matching paid transaction but cannot make its verification permanent. The payment is
reported paid and its delivered response is saved; `status` or budget `reconcile` keeps checking
it. Use an RPC that serves finalized history to finish verification. Read errors preserve the
last observed payment state. Removed inclusion leaves the outcome unknown, with "Do not pay again".

Ethereum Sepolia's public RPC may prune logs after about 10,000 blocks, roughly 33 hours. Budget
recovery searches recent logs first and resumes a block scan for older replacements. Unavailable
history preserves the unknown outcome. Use an RPC with the required history to finish recovery.

Matching included payments count once on their paid day, including legacy `verified` records and custom RPCs that cannot read finality. A pruned receipt or block does not prove removal. Positively removed inclusions stay uncertain and hold the amount across days.

The per-day cap (`caps.per_day`): an unresolved payment counts on the day it ended, and on every day while it
can still move money: waiting for the owner within its approval window, or signed or sent and not
resolved (an EVM authorization until its `validBefore` and two minutes; a Tempo transfer, which has
no expiry, or a Solana transaction until `superstables status` resolves it on chain). That includes
a payment with a receipt the chain has not confirmed (the seller's report) or has contradicted: it
counts on the receipt's day and, once a day, on later days on the same terms. USDC and pathUSD count together, one for one, as dollars; the
default `stablecoins` list is `[USDC, pathUSD]`, and a policy that lists USDC only refuses pathUSD.
`pay`
reserves the amount under a lock shared by the processes on this machine before the owner is
asked.

Text from sellers and listings reaches the agent as data. The CLI prints it on one line, without
control or invisible characters.

**Where the signed payment goes.** `pay` sends the signed authorization only to the URL it quoted:
it refuses a redirect, and the attempt then ends `uncertain`, because the client cannot tell whether
the seller acted on it. A listing from the index or the catalogue is payable only when its endpoint
is `https`, or `http` on this machine. Reading a seller's 402 challenge has a deadline and a size
limit and follows no redirect.

## The local wallet mode

`--wallet local` (or `SUPERSTABLES_WALLET=local`) replaces the browser wallet with a wallet process that
holds a key in `~/.superstables/wallet/key`, mode 0600. At startup, it refuses to load that file when other users on the machine can read it or
it is not a regular file. The same checks apply when importing a key with
`wallet init --import-key-file`. A running wallet keeps its loaded key and does not recheck
the file's permissions before signing. `wallet init --force` writes the new key to a new 0600 file and renames
it into place, so it is never in a file others can read.
The client sends the agent token to `SUPERSTABLES_WALLET_URL`, so it accepts only `https`, or
`http` on `127.0.0.1`, `localhost` or `[::1]`. The wallet daemon accepts only the Host values
`127.0.0.1:PORT` or `localhost:PORT`, like the approval page.
It exists for a machine with no browser, and it moves the boundary.

It generates two random 32-byte hex secrets at first start, in `~/.superstables/wallet/`:

| Credential | File | What it can do |
| --- | --- | --- |
| Agent token | `wallet/agent-token` | Ask. `POST /requests`, `GET /requests/:id`, `GET /status`, `GET /address` |
| Owner secret | `wallet/owner-secret` | Decide. Everything above, plus `GET /owner/requests`, `POST /owner/requests/:id/approve`, `POST /owner/requests/:id/deny` |

Both are sent as `Authorization: Bearer …` and compared in constant time. A missing or unknown
token gets 401; the agent token on an `/owner/…` route gets 403 — asking and approving are
different powers, so they are different secrets. The agent API never returns the owner secret, and the wallet's HTTP log never contains it.

The wallet never prints the owner secret and never puts it on a command line, where every user
on the machine could read it with `ps`. At start it writes a launcher file, mode 0600, that
sends the browser to `http://127.0.0.1:4411/#<owner-secret>`, and gives the browser only the
file's path. The file goes in `~/Superstables-wallet-open/`, a folder that is not hidden, so a
browser installed as a Snap (Ubuntu's Firefox) can open it. The wallet creates that folder with
mode 0700, and refuses one that is a symlink, belongs to someone else or has another mode: then
it writes no launcher and opens the page without the secret. It deletes the file once the page
has signed in with the secret, or when the wallet stops, and the folder once it is empty. A URL fragment is not sent to the server. The page keeps
the secret in that tab's session storage and takes it out of the address bar and the history.
Anyone opening the page another way, over SSH for example, pastes the secret from
`wallet/owner-secret`. The wallet verifies the same facts the approval page does and signs the stored requirement byte for
byte, and every state change goes to `wallet/audit.jsonl`.

The caveat is the one browser mode removes. This is credential separation inside one operating
system account, not a hardware boundary: any process running as you can read
`wallet/owner-secret` and `wallet/key` directly, and at that point it is you as far as the
wallet is concerned. A hostile agent confined to the wallet's HTTP API cannot pay. Arbitrary
code running as your user can. Run that mode with a key that holds testnet funds only.

## Budgets

`superstables budget` has its own keys and its own boundary.

- **Two keys.** The owner's key stays in the owner's wallet. Setup asks for a message signature;
  `fund-agent`, `grant`, `revoke` and the owner's part of `recover` show their terms on a page on
  `127.0.0.1` before the wallet is asked; on a chain set up with `--hosted`, all but `recover` show
  them on the site instead.
  The agent key, in `~/.superstables/keys/budget/<rail>-agent.env` (mode 600), signs purchases.
  Setup and commands that sign with the agent key check the file before using it. If other users
on the machine can read it, they refuse (exit 3) and say which `chmod` fixes it. An initial
refusal happens before anything is signed. On `tempo` and `solana`, setup checks again before
writing the owner's address into the agent key file. A refusal at this later check does not
undo an owner signature or a transaction already sent through hosted setup. `doctor` fails if that file holds an owner key.
- **The chain enforces the budget.** On `evm`, the total allowance. On `solana`, the delegated
  amount. On `tempo`, the access key's total or per-period limit, its expiry, and its seller list
  when one was granted. No rail enforces a per-payment maximum on chain.
- **This CLI checks the rest**, before it signs: `--max`, the expected token, `--pay-to` and one
  purchase per `--op`. A stolen agent key skips all of these and can spend what is left of the
  budget, on `evm` and `solana` to any address. Keep budgets small.
- **Setup is a trusted step.** Whoever holds setup's approval link, the agent included, can complete it
  with a key of their own: the page's origin check stops other websites, not local programs. So the
  owner runs it, and checks the owner address that setup prints and every owner page shows. Under
  `--hosted` there is no local page and no origin check: the owner adds the agent on the site, and
  the client records an owner only with that owner's signature over the add-agent request (see
  [Budget approvals and Single purchase on superstables.com](#hosted-approvals-and-buy-once-what-the-site-can-and-cannot-do)).
- **The checks depend on the rail.** The command builds the page's terms and the transaction
  from the same plan: the command's arguments and the chain's state, not the agent's description.
  On `evm` and `tempo`, the wallet signs and submits, and the command then checks the transaction
  on chain: one that differs from the plan is reported (exit 3), naming each difference, even if it
  already confirmed. That detects it; it cannot undo it. On `evm` the step counts only when the
  owner's account made exactly the planned call. For a grant or revoke, the receipt must show the
  token's `Approval(owner, agent, amount)`; for a token top-up, `Transfer(owner, agent, amount)`.
  For a gas top-up, a separate balance read must show the agent holds at least its balance before
  the request plus the requested amount. A wallet that pays the
  fee for the owner (MetaMask's sponsored transactions, sent by a relayer through MetaMask's
  DelegationManager) is accepted only on a chain where that contract's code is pinned in the client
  (Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, Ethereum Sepolia), with the manager's own
  `RedeemedDelegation` event for this owner and sender in the receipt. A sponsored gas top-up leaves
  no log, so the owner's address must have run MetaMask's pinned smart-account code in that
  transaction. On SKALE Base Sepolia only the owner's own transactions count.
  When the chain does not answer a read this needs, the result is unknown (exit 5), never done.
  On `solana` with local approvals, the
  wallet only signs, and the client checks the signed bytes are the transaction it built before it
  submits them. The one change it accepts is the pair of compute-budget instructions a wallet may
  put first (one compute unit limit and one unit price, a priority fee of at most 0.001 SOL), with
  every instruction it built unchanged after them. With `setup --hosted` on `solana`, the site builds and sends the transaction, so the
  client never sees it before it is sent; it reads it from the chain afterwards and reports any
  difference from the plan, like on `evm` (see
  [Budget approvals and Single purchase on superstables.com](#hosted-approvals-and-buy-once-what-the-site-can-and-cannot-do)).
- **Revoke ends the permission once it is confirmed on chain.** The owner approves it in their
  wallet: `approve(agent, 0)` on `evm`, `revokeKey` on `tempo`, the SPL `Revoke` on `solana`. It
  works even if the agent key was stolen. It does not reverse confirmed payments or return funds
  already transferred. On `evm`, a purchase whose price was already pulled can still settle, and
  `recover` returns the USDC it can, leaving up to 2 USDC of gas on Arc Testnet. On `tempo`, it does
  not close payment sessions the key opened elsewhere.

Per rail, with what each revoke does not cover:
[Budget rails and chains](../budget/README.md#safety-model).

<a id="hosted-approvals-and-buy-once-what-the-site-can-and-cannot-do"></a>

### Budget approvals and Single purchase on superstables.com: what the site can and cannot do

`setup --hosted` moves a chain's owner approvals to a site (superstables.com by default), and
`buy-once` has the site take one payment. The site is trusted to show the owner the right page; it
is not trusted to say who the owner is or what was paid.

- **Which site.** `--site`, `SUPERSTABLES_SITE` and a recorded `SITE` accept superstables.com, its
  subdomains and this machine only. Another origin is used only when the owner sets
  `SUPERSTABLES_ALLOW_SITE` to that exact `https` origin in their own environment. An agent never
  sets it, so an agent told to "use this other site" cannot send the owner's approvals there. When
  the site is not `www.superstables.com`, the logs and `message_for_owner` name its host.
- **Requests name the site.** Each request the agent key signs names the site's origin and a fresh
  nonce (agent request proof v2). A compatible site checks that the origin is its own and refuses a
  nonce it has already seen, so a proof made for one site fails on another and a captured one fails
  a second time. Those are the site's checks: the client cannot enforce them, and after a network
  error it sends the same proof once more on purpose.
- **The owner signs an owner proof.** The site cannot choose the recorded owner on its own. After
  picking the match code, the owner's wallet signs the site, the owner, the agent, the rail and
  chain, the request ID and the code. The client rebuilds that text from its own values and
  verifies the signature for that owner before it records anyone; without a valid proof it records
  nothing. An `already_linked` answer counts only for the owner already recorded, with that owner's
  proof over the add-agent request stored when they were recorded, and never with `--new-owner`.
  Moving a hosted chain to another site means adding the agent there, with a new owner proof.
- **The owner on record does not move under a live budget.** `--new-owner` is refused while a
  budget is live and, on `evm`, while the agent key holds the budget token, since `recover`
  returns that token to the owner on record. On `solana` and `tempo` the agent key file also
  records the owner. An owner named by either file counts, so an agent key file without that line
  (an interrupted setup, a backup) does not let another owner in without `--new-owner`. Files
  that name different owners are refused, by setup and by `revoke`, until `--new-owner` records
  one again. `--new-owner` checks both owners for a live budget (on `tempo`, every key either file
  records, the agent file's by the address of its private key) and names the owner who must
  revoke it. `revoke` never waits on the agent key file: one it cannot read is ignored there.
- **Every result is read from the chain.** On `evm` and `tempo` the command checks the transaction
  the site reports as it checks one from the local page. A step the site reports as failed is never
  reported as settled by the client, even if it succeeded on chain: it is a mismatch (exit 3),
  failed if it reverted, or unknown when the chain does not show it. On `solana`, where the site
  builds the transaction, it must be exactly the planned instruction (`ApproveChecked`, `Revoke` or the SOL
  transfer, same accounts and amount), signed and paid for by the owner alone, plus at most a
  bounded compute-budget addition (a priority fee of at most 0.001 SOL, the same bound the local
  page allows); anything else is a mismatch, and the owner revokes. `buy-once` reports a purchase
  paid only when the chain shows the transfer of exactly the purchase's amount, in the listed
  token, to the listed recipient, mined no more than 60 seconds before the purchase was created (an
  allowance for clock differences); otherwise the result is unknown
  and the agent never buys again.
- **Single purchase on superstables.com checks the site's reported amounts.** The site states each amount twice, as a decimal
  for display and as an integer in token units. They must agree, the token must have 6 decimals,
  and `--max` and the listing price are compared with the integer. These are checks on the site's
  response; the owner must still check the wallet request before signing. Only one purchase may
  remain open at a time across processes sharing the same state directory. A cancel the site does
  not confirm leaves the purchase `unknown` and blocks the next `buy-once`. If the site never
  resolves it, the owner can use `budget wait --id ID --abandon` to release that local block; the
  payment remains unknown. Purchase ids must be UUIDs. Purchase results do not repeat arbitrary
  site text; discovery presents listing text as data.
- **Approval links are data.** An approval link is used only as `<site>/approve/budget/<id>#<token>` (or
  `<site>/approve/<id>#<token>` for a purchase), rewritten by the URL parser. Text from the site
  loses control, zero-width and bidi characters before it is printed.
- **What the site learns.** The rail, the chain, the agent's address and what the owner is asked
  to approve: on `evm` and `tempo` the exact transaction, on `solana` the amount. It also learns
  which account the owner signs in with. It never receives the agent key.
- **The access token.** The site answers each request with an access token (`ssbt_...` for an
  approval, `sspt_...` for a purchase). It can read and cancel that one request, not approve it. It
  is kept only in that request's record, `budget/approvals/<id>.json` (mode 600), and removed when
  the request is final; it is never logged or printed.
- **An unclear outcome is unknown.** Once the site reports that the owner's wallet was asked, or
  reports a transaction, an unfinished request ends as `unknown` (exit 5), never as "nothing was
  sent". Read the chain before trying again.
- **`recover` stays local.** On a hosted chain, `grant`, `revoke` and `fund-agent` go through the
  site; the owner's part of `recover` still uses the page on this machine.
- **A hosted revoke needs the agent key.** The agent key signs every request to the site. On
  `solana` and `tempo`, if a hosted `revoke` needs approval but the agent key file is missing,
  readable by others, not a regular file or holds no usable key, it refuses (exit 3, nothing
  requested) and names the other ways to revoke: Revoke on the owner's account page on the site,
  or a revoke transaction the owner signs in their own wallet.
- **RPC replacements.** `B4_RPC`, `SUPERSTABLES_TEMPO_RPC` and `SUPERSTABLES_SOLANA_RPC` must be
  `https`, or `http` on this machine; every check above reads the chain through them. A
  replacement in use is named in the `RESULT` (`rpc`).

What a compatible site must serve, with both proofs spelled out:
[budget/CLI.md](../budget/CLI.md#hosted-approvals-what-a-compatible-site-must-do).

## What you install

For 0.3.0, use the agent skill zip built from that released commit, once it is available on
[GitHub Releases](https://github.com/superstables/superstables-client/releases);
`scripts/VERSION.json` inside it records the version and commit. Comparing the download's SHA-256
checksum with a published value checks that the downloaded bytes match that value; when both come
from the same site, it is not an independent check of a compromised site. Installing from git with
a full commit hash builds the client on your machine and runs the repository's build scripts
there; without a hash, npm installs whatever the default branch holds.

## Replacing a key

What the client can do today when a key or secret may have been seen by someone else. Where it
says "not supported", there is no command for it yet; do not move key files by hand.

- **Budget agent key, `tempo`.** Supported. `superstables budget setup --rail tempo --agent LABEL`,
  with a LABEL not used before (a used one reuses the key it already names), adds a new access
  key next to the old one; on a hosted chain it also adds the new key there. The owner grants it
  with `superstables budget grant --rail tempo --agent LABEL --amount A`, then revokes the old key
  with `superstables budget revoke --rail tempo` (add `--agent OLD` if the old key had a label).
  A key revoked on an owner's account can never be granted again on that account. After this,
  every `buy` and `status` for the new key needs `--agent LABEL`.
- **Budget agent key, `evm` and `solana`.** Not supported. `--agent` is for `tempo` only, and
  `setup` reuses the agent key file it finds. The owner's revoke stops the key from spending
  more, even a stolen one: `approve(agent, 0)` on `evm` stops new pulls (a price already pulled
  can still settle), the SPL `Revoke` on `solana` ends the delegate. A revoke does not retire
  the key: the owner can grant the same key again, so after a suspected leak, don't. On `evm`,
  `superstables budget recover --rail evm [--chain C]` (`--chain` defaults to Base Sepolia)
  returns USDC the agent key still holds to the owner. It runs
  where the agent key file is, needs gas in the agent key (the owner sends some first if it is
  short), and on a chain where USDC pays for gas (Arc Testnet) it leaves the agent's gas reserve.
- **Owner key.** It stays in the owner's wallet, which the client does not manage. `setup
  --new-owner` changes the owner recorded for a budget; it moves no funds, and it refuses while a
  budget is live (revoke first) or, on `evm`, while the agent key holds USDC (run `recover`
  first). On Arc Testnet, USDC up to the agent's gas reserve does not count, because `recover`
  leaves it there.
- **Local wallet key.** Stop the wallet, run `superstables wallet init --force`, and start the
  wallet again: a running wallet keeps signing with the key it loaded. The old key file is
  replaced, and with it access to whatever its address holds; the client has no command to move
  funds off it first.
- **Local wallet secrets.** Stop the wallet, delete `wallet/owner-secret` or `wallet/agent-token`,
  and start it again: it creates a new one. The client reads the agent token from its file on
  each request; `SUPERSTABLES_WALLET_AGENT_TOKEN`, if you set it, needs the new value.

## What changes in the next milestone

- **A signing surface that reads like money.** Browser wallets such as MetaMask show an EIP-712 authorization in atomic
  units; a person should see "0.01 USDC to this seller" in the wallet, not only on our page.
