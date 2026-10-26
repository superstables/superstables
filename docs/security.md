# Security model

Superstables client 0.5.0 makes testnet payments only. This page says what each way to pay protects
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

The client's own folders are private. Before it writes to its home folder (`~/.superstables`, or
`SUPERSTABLES_HOME`), its payment records (`records/`) or the local wallet's folder (`wallet/`), it
checks that each is a folder you own that no other user can write to, and creates a missing one with
mode 0700. A folder under the home that is a symbolic link, belongs to someone else or that others
can write to is refused with the reason, and a folder others can only read is set back to 0700. The
home folder itself may be a link to such a folder. Budget folders (`keys/budget/`,
`budget/public/`, `budget/ops/`, `budget/approvals/`) are checked the same way before anything is
written to them. The client reads the local wallet's agent token
only from a regular file that only you can read.

When a budget command or `superstables owner settings sign` opens its approval link in your browser, it does not put the link on a command line, where every user on the machine could read it with `ps`. It writes a launcher file, mode 0600, in `~/Superstables-budget-open/` (mode 0700), which sends the browser to the link, and gives the browser only the file's path. The file is deleted when the approval ends or the command exits, and the folder once it is empty; one left by a command stopped by a signal, Ctrl-C included, is removed the next time a link is opened. The folder check looks at that folder only, so it assumes your home folder is not writable by other users: in a home folder others can write to, they could swap the launcher folder between the check and the file's creation. The file itself is still created exclusively, with mode 0600. The local wallet's launcher, below, has the same limit.

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
| Asset | the requirement's `asset` address, which must be the chain's USDC contract |
| Chain | the requirement's `network`, which must be a supported one (`eip155:84532`) |
| Recipient | the requirement's `payTo`, which must be a well-formed address, and not the zero address or the token contract (on Solana, the all-zero key or the mint) |
| Scheme | the requirement's `scheme`, which must be `exact` |
| Payer | the account the page reports as connected, which must not be the recipient; that the account controls it is checked when its signature arrives |

A payment requirement that fails these checks is refused before an approval link exists. So is an
EVM offer that asks for a transfer method other than EIP-3009 (`extra.assetTransferMethod`), or
whose `extra` holds anything but the token's signing domain, its decimals, that method and the
display-only fields `tokenSymbol`, `displayPrice` and `routeKey` (short strings; `routeKey` without
control characters) and `chainId`, `paymentChainId` and `operationChainId` (each must be the offer's chain);
or a Tempo challenge that enables the machine-token route (`methodDetails.machineTokenEnabled`). The
display fields are not shown on approval pages, included in the signature or used for the amount
(`quote --json` prints the stored offer, cleaned). The payer's signature is checked later, as described below.

The page also shows the seller's scheme and host (the URL this client asked for the price and will call to pay), the
policy file whose caps applied, with a flag when it is not your account's own, how long what your wallet signs stays valid,
and what your wallet's prompt will show, raw values next to readable ones.

**Reported — what the agent says the payment is for**, stored under `reported` and labelled
unverified wherever it is shown:

- `serviceId`, `serviceName` — the agent's own labels
- `quoteId`, `attemptId` — the agent's record ids
- the seller's own description, cleaned and cut to 200 characters, under "The seller says (not verified)"

None of it changes what gets signed. The typed data the wallet is asked to sign is built from the
verified requirement, field by field: `to` is the requirement's `payTo`, `value` is its
`amount`, `verifyingContract` is its asset, and `validBefore` is now plus the seller's
`maxTimeoutSeconds`, at most 600 seconds.

There is one place where reported context has an effect: the policy takes the hostname for its
`allow`/`deny` rules from the same URL the page shows as the seller, because the requirement does not carry the URL that
was called. A dishonest agent could therefore misreport the host and slip past a host rule. It
cannot misreport the amount, the asset, the chain or the recipient, so `caps.per_call`,
`caps.per_day`, `stablecoins` and `kill_switch` are all judged on verified facts. Treat host
rules as a convenience, not as a boundary.

The facts are verified; the policy file is not. The process that runs `quote` and `pay` is the agent's, and its
environment chooses which `policy.yaml` is read: `SUPERSTABLES_POLICY`, `SUPERSTABLES_HOME` or `--home`. Your
own `~/.superstables/policy.yaml`, in the home directory your system account records, applies as well whenever it
exists, so no such setting can lift a rule written there. An agent that can edit files as you can still change
that file, and a different home starts its own daily count. Treat the policy as a guard against mistakes, not as a
boundary against a hostile agent. The amount in your wallet's prompt is the boundary.

## The approval link is the capability

This section, and the three after it, describe the page `superstables pay` serves on `127.0.0.1`.
`budget buy-once` and a budget set up with `--hosted` have no such page: their approval links are
on the site, and the owner acts there signed in to their account with their wallet. See
[Budget approvals and Single purchase on superstables.com](#hosted-approvals-and-buy-once-what-the-site-can-and-cannot-do).

There is no password on the approval page. The authority is the id in the URL: 128 bits of
randomness, generated when the payment is created, and handed to the agent as part of its tool
result so it can pass it to you.

`superstables pay` prints the link once, in its own output (on stderr with `--json`). No record holds it: the attempt
record and the approvals log never contain the id, `status` never repeats it, and the link works only while that `pay`
process runs. The one place it can end up on disk is wherever the person or agent who ran `pay` sends that output, a log
file for example. Whoever can read that file can open the payment's approval page while `pay` runs, though signing still
needs the owner's wallet, so such a file should be private (`umask 077` before the command) and deleted when `pay` ends.

That id is deliberately narrow. Holding it lets someone see *one* payment and sign *that* one:

- it names one stored request, and the routes under it (`/state`, `/account`, `/signature`,
  `/reject`) only ever act on that request;
- signing needs a valid signature from the account selected on the page. The approval link does not
  choose that account, but it cannot spend from an account without its signature;
- a decision is final: a second POST to a request that is no longer pending gets 409;
- the client binds `127.0.0.1`, so another machine cannot reach the page directly; port
  forwarding can make it reachable elsewhere;
- the page cannot be framed by another site (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), sends
  no `Referer` (its link is the capability), and is served with `nosniff`; only the page's own scripts run: each
  response carries a fresh nonce, and the content security policy allows scripts with that nonce only;
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
Check the chain, the token contract, the recipient and the amount in that prompt; for USDC, a
`value` of `10000` is 0.01 USDC. Reject the request if the wallet's terms differ from the page's,
or if you cannot check them.

## The same-machine caveat

Any process on this machine can serve a page on loopback, and a browser wallet's permission to
connect is granted per origin. A hostile local process could serve its own page on the approval
page's port after this one stops and inherit a connection you granted earlier. It would still have
to get you to sign, and the wallet would still show it the real amount and recipient, but it would
not have to ask for the connection again.

So that port is not a well-known one. Each install picks its own at random in 20000-29999 the first
time `pay` runs, and keeps it in `approve-port` in the home folder (mode 0600); when another payment
is waiting on it, the page takes a free port instead. Another account cannot know the port in
advance, but one that watches the machine's open ports while a payment page is open can learn it,
and bind it between payments. `SUPERSTABLES_APPROVE_PORT=0` asks the operating system to choose a free
port for each payment. This avoids a fixed approval port, but ports can be reused and another local
process can bind one after the page closes. Your wallet may ask you to connect again when the origin
changes.



## Expiry

- A **quote** is good for 10 minutes. Paying re-reads the seller's challenge and refuses if the
  terms moved, the seller's authorization window included.
- A **browser approval request** expires five minutes after it is created, by default, checked on a
  timer and on every request. Local-wallet requests expire after 120 seconds by default
  (`wallet serve --approval-timeout`).
- The **EIP-3009 authorization** carries its own on-chain window: `validBefore` is set to now
  plus the seller's `maxTimeoutSeconds` (300 seconds unless the seller asks for something else), and
  never more than 600 seconds: a seller may allow up to an hour, and its requirement is sent back
  as offered, but what `pay` signs lasts ten minutes at most. After that, it cannot succeed on
  chain. The local wallet signs the same ten-minute authorization for a request sent to it directly.
- Closing the client marks pending approval requests `abandoned`, which is not a rejection, and a
  signature that arrives afterwards is never sent. A payment already being sent can end
  `uncertain` instead. If the process is killed, the log may have no final line; pending requests
  are not restored after a restart.
- A payment left waiting by a `pay` process that is gone is ended as `abandoned` only when the client can prove the process is gone: the same machine, shown by its boot id and `/etc/machine-id`. Virtual machines cloned without a new `/etc/machine-id` share that id, so a record from a clone is not taken as proven; give each clone its own.

## The approvals log

The browser signer appends each state change of an approval to
`~/.superstables/records/approvals.jsonl` (0600): the time, a hash of the id (`sha256:…`, which also
appears as `walletRequestId` on the attempt; the id itself, which opens the page, is never written), the new
status, the reason if there is one, the verified terms, the reported context, and the account that connected.
Each line is flushed to disk. A failed write does not stop the approval, so the file is not a guaranteed
complete record.

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
A cap of 0.05 USDC per payment means this software will not ask you to sign more than that while it
runs with your policy. An agent that runs as you can edit or delete your policy file, or run its own
code, so it is not a promise against a hostile agent, and it never means your account cannot sign
more. Your own `~/.superstables/policy.yaml` applies whichever policy file or home the environment
names, but its daily count and the file itself are only as safe as your account's files. An empty
policy file means the defaults. A file with a misspelled key, a `kill_switch` that is not `true` or
`false`, a scalar where a list belongs or an unreadable amount stops every payment until it is
fixed. Amounts are read as you wrote them, in plain decimal with at most six decimals: `0.05`,
`1` or `0.05 USDC`. YAML would read `0x10` as 16 and `1e3` as 1000, so those spellings, and `.5`,
`+1` or `-1`, stop payments in the same way, with the key named. The only limits that survive a
compromised machine are the ones inside what you sign — the amount and the recipient in the
authorization — and the balance of the account, which is why this release is testnet only.

The browser signer counts the daily cap from receipts and attempt records in this directory,
including pending, in-flight and uncertain payments; the local wallet counts the authorizations in
its own `wallet/audit.jsonl`. Both add up whole token units (millionths of a dollar for the dollar
stablecoins), never floating-point decimals. On the browser signer's path, from the payment records
to the policy check, totals and comparisons with the cap are exact, so a cap is reached exactly.
The local wallet daemon passes its whole-unit total and the payment's amount to the same check as
whole units, so the cap is reached exactly there too. It reads both policy files again when a
request arrives and again when you approve it, counts requests still waiting for you, and refuses
to sign while its audit log cannot be written or read. For the browser signer, a record whose
amount cannot be read makes today's total unknown, and the daily cap then refuses every payment
until the record is fixed. Neither reads chain history: delete those records and the count starts
again.

`superstables owner settings sign` has your own wallet sign one payload: the hash of your owner
settings (which covers your approval site, RPC endpoints and development switches), the hash of your
account's `~/.superstables/policy.yaml`, the hash of the list of retired agent keys, the chains
enabled for signing and the approval site. An EVM wallet signs it as EIP-712 typed data with no
chain id, so it holds on every chain; a Solana wallet signs a fixed seven-line text with
`signMessage`. The local wallet has a card on its page that does the same with its own key. The
signature sits in the settings file and every hash is read again from disk each time it is used.
Signed settings count only for approvals made with the wallet that signed them: `pay` and the local
wallet refuse a payment when the policy file differs from the signed one, until you sign again. A
browser wallet is checked when it connects on the approval page, because only then is it known which
wallet pays; the page refuses before anything is signed and shows "Signed by" only when the policy
is the signed one. Signing needs a policy file at `~/.superstables/policy.yaml`
(`superstables policy init` writes one); a signature over no file would pin nothing. For any other
wallet the settings are ignored and the approval page says so ("Signed settings: signed by ... they
do not apply to this wallet"). A signature that does not verify, or that no longer covers your
settings or retired keys, counts as no signature; `pay` warns on stderr, and `owner settings`
commands that change a signed setting say so. The chain gate reads its list of enabled chains only
from a valid signature; this build signs on testnets only, so the list is empty. This is evidence,
not enforcement: an agent that runs as you can still edit the files, and in the local wallet it can
read the key that signs, so there the signature only makes an edit evident. The signature that
matters is the one a wallet you keep apart from the agent makes.

## Testnet only

`pay` supports nine testnets, each with one token pinned in the client: x402 `exact` with test
USDC on Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia, Ethereum
Sepolia and Solana devnet, x402 `exact` with test USDG on Robinhood Chain Testnet, and MPP
`tempo.charge` with test pathUSD on Tempo Moderato. Each chain's token is one entry in the
client's chain table: its address and decimals, and on the EVM chains its EIP-712 signing domain
and whether a new allowance must start from 0. Nothing assumes six decimals. On the EVM chains the
signing domain is pinned, so a seller cannot make the wallet show a signing name of its choosing,
and before the first signature on a chain `pay` reads the token's `DOMAIN_SEPARATOR()` from the
chain and refuses, before anyone is asked, when it is not the one the table states or the RPC
answers for another chain. When a testnet's RPC cannot be read, `pay` goes on without that check (a
wrong domain only makes a signature that does not verify) and reads again on the next payment. A
budget grant never approves over a live allowance on any token, and a token that needs its
allowance set to 0 first is never granted through an approval site such as superstables.com. A
requirement naming anything else, every mainnet included, is refused before anyone is asked. There is no configuration that turns on mainnet. A mainnet added
to the chain tables would still be refused by a separate check: before anything is signed, offered
to a wallet or sent, `quote`, `pay`, the approval page, the local wallet and every
`superstables budget` command ask it, and it refuses any chain whose table entry is not marked as
a testnet, because mainnet signing is off in this build. `quote` and `pay` then refuse the offer;
a budget command exits 3 before it reads a key file or the chain.

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

Budget purchases on Tempo (`superstables budget buy --rail tempo`) are signed by the agent's access key through mppx, and the client checks the seller's challenge first. It refuses a challenge that turns on mppx's machine-token route (`machineTokenEnabled`), which would pay through a swap contract instead of a plain pathUSD transfer; one that names no realm, since its payment could then not be found on chain as this purchase's; one that stays open for more than ten minutes; and one whose payment split names a memo in the format this client uses to find its purchases, which could be counted as another purchase's payment. Before anything is signed, the purchase claims the challenge on this machine, in a file named by its payment memo, so a seller that hands the same challenge to two purchases cannot settle both against one payment. The signed payment is read back before it leaves the process, to the seller or to the RPC: it must make exactly the quoted pathUSD transfers and stay valid for at most ten minutes. mppx signs it for 25 seconds.

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
  list after the blocks, so it can lag them. A second endpoint of the verdict set (below) reads the
  same blocks itself, with its own progress (`confirmSearchedTo`), and a payment it finds is the answer.
- On Tempo Moderato: never. A transfer the wallet was asked to send has no expiry, so only finding it
  resolves the attempt.

The same search decides a payment the seller reported without a transaction the chain confirms.

### Which RPC is believed

Before calling a payment unpaid, the client checks the configured RPC agreement rule. This normally
requires independent operators, but the single-endpoint exceptions below also apply. An unpaid result
frees the daily cap and lets an agent pay again. Every endpoint is first asked which chain it is on
(`eth_chainId`, or the genesis hash on Solana) before anything is read from it, once per process, and an
endpoint on another chain is not read at all. Then `unpaid` is decided only when the verdict set agrees:

- two endpoints run by different operators show the same final block (number, hash and time) and the same
  answer there (`chain_agreement: "quorum"`); or
- the owner's own node, set with `superstables owner settings rpc` and `ownNode` (`owner-node`); or
- on a testnet whose table lists one public RPC, that RPC (`single`); or
- an RPC the calling code pinned (the SDK's `rpcUrl`, `rpcUrlFor`; `caller`). The CLI pins none.

The attempt and its receipt record how, and where: `chainAgreement` and `chainAgreedAt` (the operators and
the final block and its hash, or the Solana slot); `status --json` prints `chain_agreement` and
`chain_agreed_at`. The endpoints come from the table in `src/core/rpc-endpoints.mjs`, or from the owner's
settings when they set their own.

`SUPERSTABLES_RPC_URL`, `SUPERSTABLES_TEMPO_RPC` and `SUPERSTABLES_SOLANA_RPC` (each HTTPS, or HTTP on this
machine, without credentials) still choose where reads go, but an endpoint named only there never decides
`unpaid`: unless it is a table URL or one the owner set, the attempt stays `uncertain` and counted, with the
way out in words (unset the variable, or stop and ask the owner to add this RPC in the settings). When endpoints
disagree, one is missing or unreadable, or a confirmer is still reading, the attempt also stays
`uncertain`, and the agent is told not to pay again. Records written before this check are not re-opened,
and a purchase on the hosted site (`buy-once`) is not covered by it. The client does not run a node: HTTPS
authenticates the connection to an RPC, not the chain behind it. The budget rails use the same endpoints.

- **Solana and Tempo budget verdicts.** A verdict that lets an agent pay again or ends a budget (a delegate,
  a token account or an access key gone, a purchase that never happened or failed) is believed only when
  the confirming endpoints agree. Each endpoint's genesis hash or chain id is checked first. On Solana they
  read at `finalized` commitment from one common slot on; on Tempo, at one block they all name. Tempo has a
  single public RPC, so its verdicts rest on that one, labelled `single`, until the owner pins more. Owner
  commands on Solana read and send through the endpoints the owner set; an RPC that only
  `SUPERSTABLES_SOLANA_RPC` names is refused there (exit 3), and a verdict that would rest on it stays
  unknown, with that reason and the fix (unset it, or stop and ask the owner to add this RPC in the settings). When
  the endpoints disagree or one is missing, the answer is unknown and nothing is treated as revoked or as
  never paid.

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
counts on the receipt's day and, once a day, on later days on the same terms. USDC, pathUSD and USDG count together, one for one, as dollars; the
default `stablecoins` list is `[USDC, pathUSD, USDG]`, and a policy that lists USDC only refuses the others.
`pay`
reserves the amount under a lock shared by the processes on this machine before the owner is
asked.

Text from sellers, listings and RPCs reaches the agent as data. The CLI prints it, on the terminal and
in `--json` output, on one line and without control characters or invisible formatting characters
(zero-width, bidi and Unicode tag characters). A command the CLI suggests carries a seller's payee
only when it is a valid address for that rail.

**Where the signed payment goes.** `pay` sends the signed authorization only to the URL it quoted:
it refuses a redirect, and the attempt then ends `uncertain`, because the client cannot tell whether
the seller acted on it. Every seller URL must be `https`, or `http` on this machine (127.0.0.1,
localhost, [::1]). That covers a URL given to `quote`, a listing's endpoint, and every `budget buy`
and `preflight` URL. Anything else is refused before the first request, because on plain http
anyone on the way can change the recipient and read the signed payment. Reading a seller's 402
challenge has a deadline and a size limit and follows no redirect, and `budget preflight` follows
none either. Discovery reads of the index and the catalogue follow no redirect and are cut at 2 MB.
`SUPERSTABLES_INDEX_URL`, `SUPERSTABLES_CATALOGUE_URL` and `SUPERSTABLES_DEMO_SERVICE_URL` follow the
same https rule.

## The local wallet mode

`--wallet local` (or `SUPERSTABLES_WALLET=local`) replaces the browser wallet with a wallet process that
holds a key in `~/.superstables/wallet/key`, mode 0600, encrypted with a passphrase the owner chose
(scrypt, then AES-256-GCM). The address is stored in clear next to it, so `wallet address`, `setup` and
`doctor` need no passphrase, and editing it breaks decryption. The key is decrypted only in
`wallet serve`, after the owner types the passphrase at a terminal. `wallet init --no-passphrase` keeps the
key unencrypted, for testnets, and `wallet serve` then says so; `wallet encrypt` converts an existing key.
At startup, it refuses to load that file when other users on the machine can read it or
it is not a regular file. The same checks apply when importing a key with
`wallet init --import-key-file`, and to the agent token and the owner secret below. A running wallet keeps its loaded key and does not recheck
the file's permissions before signing. `wallet init --force` writes the new key to a new 0600 file and renames
it into place, so it is never in a file others can read. `wallet init --force` and `wallet encrypt` first
overwrite the old file's bytes in place, never through a symlink. Copies a file system or a disk keeps
elsewhere (copy-on-write and journalling file systems, flash storage, backups) are not erased. When the
old key could not be overwritten (it was a symbolic link, say), the command says so on stderr and names the file.
Client 0.4.0 cannot read an encrypted key file and stops with "that is not a private key"; if you may go back to it,
keep the key somewhere safe before you encrypt it.
The agent reaches the wallet over a socket, `wallet/agent.sock` (mode 0600, in the 0700 wallet
folder). Before it sends the agent token, the client checks that the socket and its folder belong
to this user and that no other user can write to the folder, so another account cannot pose as the
wallet by taking its port. On TCP, `127.0.0.1:4411`, the wallet serves only the owner's page and
the `/owner/…` routes; the agent token there gets 403, unless the wallet was started with
`wallet serve --tcp`, for an agent that reaches it over SSH forwarding. Any process on this machine
that has the agent token can then use those routes. Such an agent sets `SUPERSTABLES_WALLET_URL`,
and the client sends the agent token there, so it accepts only `https`, or `http` on `127.0.0.1`,
`localhost` or `[::1]`. On TCP, the wallet daemon accepts only the Host values `127.0.0.1:PORT` or
`localhost:PORT`, like the approval page. On Windows there is no socket, and everything stays on TCP.
It exists for a machine with no browser, and it moves the boundary.

It generates two random 32-byte hex secrets at first start, in `~/.superstables/wallet/`:

| Credential | File | What it can do |
| --- | --- | --- |
| Agent token | `wallet/agent-token` | Ask, over the private socket only, unless `wallet serve --tcp`. `POST /requests`, `GET /requests/:id`, `POST /requests/:id/cancel`, `GET /status`, `GET /address` |
| Owner secret | `wallet/owner-secret` | Decide, on the TCP port only. Everything above, plus `GET /owner/requests`, `POST /owner/requests/:id/approve`, `POST /owner/requests/:id/deny` |

Both are sent as `Authorization: Bearer …` and compared in constant time. A missing or unknown
token gets 401; the agent token on an `/owner/…` route gets 403 — asking and approving are
different powers, so they are different secrets. The agent API never returns the owner secret, and the wallet's HTTP log never contains it.

The wallet never prints the owner secret and never puts it on a command line, where every user
on the machine could read it with `ps`. At start it writes a launcher file, mode 0600, that
sends the browser to `http://127.0.0.1:4411/#<owner-secret>`, and gives the browser only the
file's path. The file goes in `~/Superstables-wallet-open/`, a folder that is not hidden, so a
browser installed as a Snap (Ubuntu's Firefox) can open it. The wallet creates that folder with
mode 0700, and refuses one that is a symlink, belongs to someone else or has another mode: then
it writes no launcher and opens the page without the secret. It keeps the file until the wallet
stops, then deletes it, and the folder once it is empty: after a reload the page asks for the secret
again, and the file is how the owner opens it signed in again. It holds the same secret, at the same
mode in a folder of the same mode, as `wallet/owner-secret`, so keeping it adds no exposure.
`superstables --wallet local wallet open` writes a fresh one and opens it, for when the tab was closed or the folder
was cleaned. Before it writes the secret anywhere, it asks the process on the port the wallet recorded for its page to prove it knows
the owner secret (an HMAC of a fresh nonce), so a different process that has taken that port after a crash gets nothing. A URL fragment is not sent to the server. The page takes the secret out of the address
bar and the history and keeps it in the page's memory only: it is never put in session or local
storage, so closing or reloading the tab forgets it. Anyone opening the page another way, over SSH for
example, pastes the secret from `wallet/owner-secret`.

The page lists each request as a card that keeps its place while you read it: a new request goes
below, and one that ended stays greyed in its slot until the pointer leaves the list. "Approve and
sign" opens a confirmation in the card that names the amount, the recipient and the chain, and
shows the amount as the token's raw value. "Yes, sign" posts those three values with the approval,
and the wallet refuses with 409 when any of them differs from the request it holds, or when the call
has no confirmation. The page also names the policy file that applies and its caps. Only the page's
own script runs on it (a per-load nonce in its content security policy). The wallet verifies the same facts the approval page does and signs the same EIP-3009 authorization the
page builds, at most ten minutes long and never to its own address, and every state change goes to
`wallet/audit.jsonl`.

At most three requests wait for you at once. A request the client stops waiting for is cancelled,
and the wallet hands out a signature only until the client's wait ends (plus 15 seconds). A request
from a web page, with an `Origin` other than the wallet's own, is refused, and requests must be
JSON. Every state change is flushed to `wallet/audit.jsonl` before the next step, and a failed
write stops it.

The caveat is the one browser mode removes. This is credential separation inside one operating
system account, not a hardware boundary: any process running as you can read
`wallet/owner-secret`, and the key from the running wallet's memory, and at that point it is you as far as the
wallet is concerned. An encrypted key file protects the key at rest, not from code running as you while the wallet runs. A hostile agent confined to the wallet's HTTP API cannot pay. Arbitrary
code running as your user can. Run that mode with a key that holds testnet funds only.

## Budgets

`superstables budget` has its own keys and its own boundary.

- **Two keys.** The owner's key stays in the owner's wallet. Setup asks for a message signature;
  `fund-agent`, `grant`, `revoke` and the owner's part of `recover` show their terms on a page on
  `127.0.0.1` before the wallet is asked; on a chain set up with `--hosted`, all but `recover` show
  them on the site instead.
  The page on `127.0.0.1` names the chain by its chain id (Solana: the cluster's genesis hash), the RPC hosts the command reads and where they come from (hosts only, never a path or key), its own address, whether you signed the agent address at setup, and the exact values your wallet will show. Right before an EVM page asks the wallet to send, it switches the wallet to the chain, reads the chain id again and puts it in the transaction. If the wallet switches account or chain after connecting, the page asks you to connect again.
  The agent key, in `~/.superstables/keys/budget/<rail>-agent.env` (mode 600) or, with
  `setup --key-store os-keychain` on `evm` and `solana`, in the OS keychain with only its address in
  that file, signs purchases. A keychain does not protect the key from code running as you while the
  keychain is unlocked: it protects it from copies of the file and from backups.
  Setup and commands that sign with the agent key check the file before using it. If other users
on the machine can read it, they refuse (exit 3) and say which `chmod` fixes it. An initial
refusal happens before anything is signed. On `tempo` and `solana`, setup checks again before
writing the owner's address into the agent key file. A refusal at this later check does not
undo an owner signature or a transaction already sent through setup on superstables.com. `doctor` fails if that file holds an owner key.
- **The chain enforces the budget.** On `evm`, the total allowance. On `solana`, the delegated
  amount. On `tempo`, the access key's total or per-period limit, its expiry, and its seller list
  when one was granted. When the owner's account pays the network fee (a push payment, or a pull payment the seller does not
  sponsor), the fee counts against that limit, and in the runs measured on Tempo Moderato it was paid in pathUSD. A payment the
  chain refuses still costs its fee. When it can read the key and estimate the fee, `buy` refuses before signing if the price
  plus the largest fee the payment can have is more than what is left, and otherwise the chain checks the limit. No rail
  enforces a per-payment maximum on chain.
- **This CLI checks the rest**, before it signs: `--max`, the expected token, `--pay-to` and one
  purchase per `--op`. On `evm`, before the pull, it has the x402 client build the payment it would
  send and checks it against the option those checks passed, including the token's EIP-712 domain
  name and version; it then signs once, for at most ten minutes, and purchases that share an agent
  key take turns. That check of the built payment lets it expire up to five seconds (a clock
  tolerance) later than the seller's offered timeout allows. On Arc Testnet, a price an earlier
  purchase left in the agent key is not counted as gas reserve. A stolen agent key skips all of
  these and can spend what is left of the budget, on `evm` and `solana` to any address. Keep
  budgets small.
- **Setup is a trusted step.** Whoever holds setup's approval link, the agent included, can complete it
  with a key of their own: the page's origin check stops other websites, not local programs. So the
  owner runs it, and checks the owner address that setup prints and every owner page shows. Under
  `--hosted` there is no local page and no origin check: the owner adds the agent on the site, and
  the client records an owner only with that owner's signature over the add-agent request (see
  [Budget approvals and Single purchase on superstables.com](#hosted-approvals-and-buy-once-what-the-site-can-and-cannot-do)).
- **The agent address is the one the owner signed for.** Setup keeps the text the owner's wallet
  signed, which names the agent's address, and the signature, in the public file. Before `grant`,
  `fund-agent` or `recover` (and so `rotate`) builds anything, the command checks that signature
  against the owner on record, that the address matches the agent key on this machine when the key
  is here, and that the address was not retired. An edited public file is refused before any page
  opens. A public file from before this check has no signature: on testnet the command warns and
  goes on, and running `setup` again where the agent key is records one. Deleting the signature
  lines makes a file look that old. On a chain that is not a testnet the command refuses such a file;
  mainnet signing is off in this build, so that does not apply yet. The check proves
  who the owner on record signed for, not who that owner is. `revoke` is never blocked by it.
- **The checks depend on the rail.** The command builds the page's terms and the transaction
  from the same plan: the command's arguments and the chain's state, not the agent's description.
  On `evm` and `tempo`, the wallet signs and submits, and the command then checks the transaction
  on chain: one that differs from the plan is reported as unknown (exit 5), naming each difference, even if it
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
  transaction. On SKALE Base Sepolia and Robinhood Chain Testnet only the owner's own transactions count.
  When the chain does not answer a read this needs, the result is unknown (exit 5), never done.
  On `solana` with local approvals, the
  wallet only signs, and the client checks the signed bytes are the transaction it built before it
  submits them. The one change it accepts is the pair of compute-budget instructions a wallet may
  put first (one compute unit limit and one unit price, a priority fee of at most 0.001 SOL), with
  every instruction it built unchanged after them. With `setup --hosted` on `solana`, the site builds and sends the transaction, so the
  client never sees it before it is sent; it reads it from the chain afterwards and reports any
  difference from the plan, like on `evm` (see
  [Budget approvals and Single purchase on superstables.com](#hosted-approvals-and-buy-once-what-the-site-can-and-cannot-do)).
- **`recover` acts only on what is final.** On `evm`, a purchase's price goes back to the owner (after a
  failed `buy`, or from `recover`) only once its payment authorization can no longer settle at a final
  block: never signed, cancelled in a final block, or expired by a final block's time. A cancellation
  that is mined but not final leaves the price in the agent key and the outcome unknown (exit 5);
  `recover --op ID` returns it once the cancellation is final; until its return and the owner's revoke are final it answers unknown (exit 5) even if the price was already swept, and `reconcile` reports it returned after finality. `recover` asks the owner for
  `approve(agent, 0)` unless the agent's own revoke in that run brought the allowance to 0 and a later
  read shows 0. Without `--op` it sweeps the rest of the agent key only when every journal of that
  chain can be read and no operation of the agent can still move money; otherwise it names them,
  sweeps nothing and answers unknown (exit 5). Its amounts are exact token units, never floating point.
- **An owner action is final only at a final block.** A grant, revoke, gas transfer or recover revoke
  is reported `final: true` only once its block is final on that chain (the `finalized` tag on most
  EVM chains, `latest` on Tempo Moderato and SKALE Base Sepolia, `finalized` commitment on Solana)
  and the endpoints agree the effect reads the same at a final block. Until then it is `landed`
  (exit 0, `final: false`): `revoke` says the allowance or delegate reads 0 but does not call the
  budget revoked, and `status` names the last owner action and whether it is final. A new grant
  waits for the previous revoke to be final, and a setup that bundles a grant refuses unless it can
  read, at a final block, that no older allowance is live, or the agent key was created in that same
  setup. A reused agent key with no owner on record links first: setup refuses
  the grant, sending nothing, and says to set up (link), then grant.
- **Revoke ends the permission once it is confirmed on chain.** The owner approves it in their
  wallet: `approve(agent, 0)` on `evm`, `revokeKey` on `tempo`, the SPL `Revoke` on `solana`. It
  works even if the agent key was stolen. It does not reverse confirmed payments or return funds
  already transferred. On `evm`, a purchase whose price was already pulled can still settle, and
  `recover` returns the USDC it can, leaving up to 2 USDC of gas on Arc Testnet. On `tempo`, it does
  not close payment sessions the key opened elsewhere. An access key signs with the owner's account nonce, so while a stolen key keeps sending transactions the owner's wallet can refuse a revoke with "nonce too low"; the command answers unknown, and the owner reads `status` and retries the revoke. The key's limit still bounds what it can spend. `revoke` sends its transaction every time it
  is asked, even when the budget already reads empty or revoked: one RPC's read is not proof that
  nothing is live. On `solana` it sends nothing only when the owner has no USDC account, and on
  `tempo` only when the keychain refuses a simulated `revokeKey` from the owner as already done; a
  simulation it cannot read is unknown (exit 5). When it sends a transaction, it reports `revoked`
  only after its own transaction and a read that shows it. The exception is the `tempo` case just
  described: the key reads revoked, and the keychain refuses the owner's simulated `revokeKey` with
  `KeyAlreadyRevoked` or `KeyNotFound`, decoded from the revert data or, without it, named in the
  RPC's error text. The command then reports `state: "ok"`, `revoked: true` and `tx: {}`, with
  nothing sent. That is the command's own result. `budget status` says `revoked: true` only for a
  revoke this machine recorded that the chain still shows (on `tempo`, the keychain's revoked flag):
  an allowance or delegate that reads 0 is reported as `remaining: "0"`, because spent, never
  granted, revoked elsewhere and a wrong read all look the same.

Per rail, with what each revoke does not cover:
[Budget rails and chains](../budget/README.md#safety-model).

<a id="hosted-approvals-and-buy-once-what-the-site-can-and-cannot-do"></a>

### Budget approvals and Single purchase on superstables.com: what the site can and cannot do

`setup --hosted` moves a chain's owner approvals to a site (superstables.com by default), and
`buy-once` has the site take one payment. The site is trusted to show the owner the right page; it
is not trusted to say who the owner is or what was paid. Which site those links may be on is the
owner's setting, not the agent's (see "Which site" below).

- **Which site.** Approvals happen on `https://www.superstables.com` (the apex is the same site).
  Staging, other `*.superstables.com` hosts and a site on this machine are used only when the owner
  allows them in the owner settings: `superstables owner settings site <origin>`, `allow-staging on`
  or `allow-loopback site on`. The settings are a file in the account's own home,
  `~/.superstables/owner/settings.json`, that only a command in the owner's terminal writes.
  `--site`, `SUPERSTABLES_SITE` and a recorded `SITE` count only when they name an allowed site, so
  an agent told to "use this other site" cannot send the owner's approvals there.
  `SUPERSTABLES_ALLOW_SITE` is no longer read. An agent runs as the same user and could still edit the
  file itself; `superstables owner settings sign` has the owner's wallet sign them, which makes an edit
  evident (see "Policy is software"). A revoke on a chain whose
  recorded site is no longer allowed asks on the page on this machine instead. When the site is not
  `www.superstables.com`, the logs and `message_for_owner` name its host, including a site on this machine.
- **Requests name the site.** Each request the agent key signs names the site's origin and a fresh
  nonce (agent request proof v2). A compatible site checks that the origin is its own and refuses a
  nonce it has already seen, so a proof made for one site fails on another and a captured one fails
  a second time. Those are the site's checks: the client cannot enforce them, and after a network
  error it sends the same proof once more on purpose.
- **The owner signs an owner proof.** The site cannot choose the recorded owner on its own. After
  picking the match code, the owner's wallet signs the site, the owner, the agent, the rail and
  chain, the request ID and the code. On a site that offers it, the client asks for the text that
  also names the account the agent joins (version 2), and only that text is accepted for such a
  request. The client rebuilds that text from its own values and
  verifies the signature for that owner before it records anyone; without a valid proof it records
  nothing. When this machine already records an owner and the site says it supports it, the
  add-agent request also names that owner (`expected_owner`), and the site refuses any other
  account. The client checks that the site repeated it. On any site, a bundled setup that the site
  adds to another account is withdrawn before anything is recorded. An `already_linked` answer
  counts only for the owner already recorded, with that owner's
  proof over the add-agent request stored when they were recorded, and never with `--new-owner`.
  Moving a chain with approvals on superstables.com to another site means adding the agent there, with a new owner proof.
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
  reported as settled by the client, even if it succeeded on chain: it is failed only when it
  reverted and matches the plan, otherwise unknown (exit 5). On `solana`, where the site
  builds the transaction, it must be exactly the planned instruction (`ApproveChecked`, `Revoke` or the SOL
  transfer, same accounts and amount), signed and paid for by the owner alone, plus at most a
  bounded compute-budget addition (a priority fee of at most 0.001 SOL, the same bound the local
  page allows); anything else is a mismatch, and the owner revokes. `buy-once` reports a purchase
  paid only when the chain shows the transfer of exactly the purchase's amount, in the listed
  token, to the listed recipient, mined no more than 60 seconds before the purchase was created (an
  allowance for clock differences), and only for the payment the site first showed for this purchase.
  The payer and authorization it named are fixed from that answer on, and on EVM chains the
  authorization's nonce must be the hash of an order naming this purchase and its terms; otherwise
  the result is unknown and the agent never buys again.
- **A single purchase names its payer where the site supports it.** The wallet is the hosted owner
  this machine records for that chain on the same site. The site refuses any other wallet before it
  signs, the client checks that the site repeated the name, and a payment by another wallet is
  `unknown`, never paid.
- **Single purchase on superstables.com checks the site's reported amounts.** The site states each amount twice, as a decimal
  for display and as an integer in token units. They must agree, the token must have 6 decimals,
  and `--max` and the listing price are compared with the integer. These are checks on the site's
  response; the owner must still check the wallet request before signing. Only one purchase may
  remain open at a time across processes sharing the same state directory. A cancel the site does
  not confirm leaves the purchase `unknown` and blocks the next `buy-once`. If the site never
  resolves it, the owner can use `budget wait --id ID --abandon` to release that local block; the
  payment remains unknown. Purchase ids must be UUIDs. Purchase results do not repeat arbitrary
  site text; discovery presents listing text as data. A paid purchase holds the next `buy-once` until the chain shows its payment final; the owner can stop waiting for finality with `wait --id ID --abandon`. Once the owner's wallet has signed, the site's word alone
  never makes a purchase "not paid". Creation sends a random `Superstables-Replay-Secret`, so only
  this client's own retry can return its purchase.
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
  sent". Read the chain before trying again. A cancel counts as "nothing was sent" only when the
  site answers `200` with that request, `cancelled` and final, or, to a second cancel, `409
  not_open` with state `cancelled`, no wallet request and no transaction (that answer has no id
  and is not marked final; it is never accepted with another request's id). Either way the
  answer, its `error` and their steps must show no wallet request, transaction, send-implying
  state or money that may have moved, and no earlier answer, from the creation on, may have shown
  one (an error answer to a read counts too: `error.money_moved` on a 429 says the wallet was
  asked): what an answer showed is never taken back by a later, cleaner one. For a link with steps, a step
  is "nothing was sent" only when an answer about this request shows it ended without being asked,
  or the site confirmed an unapproved link withdrawn, and no answer showed evidence no step
  accounts for; otherwise it is unknown and the link's result says to read the chain. An empty, unreadable or
  contradictory answer, or none at all, is unknown (exit 5) for anything that can move funds.
- **`recover` stays local.** On a chain with approvals on superstables.com, `grant`, `revoke` and `fund-agent` go through the
  site; the owner's part of `recover` still uses the page on this machine.
- **A revoke on superstables.com needs the agent key.** The agent key signs every request to the site. On
  `solana` and `tempo`, if a `revoke` on superstables.com needs approval but the agent key file is missing,
  readable by others, not a regular file or holds no usable key, it refuses (exit 3, nothing
  requested) and names the other ways to revoke: Revoke on the owner's account page on the site,
  or a revoke transaction the owner signs in their own wallet.
- **RPC replacements.** `B4_RPC`, `SUPERSTABLES_TEMPO_RPC` and `SUPERSTABLES_SOLANA_RPC` must be
  `https`, or `http` on this machine; every check above reads the chain through them. For owner
  actions (setup, grant, revoke, fund-agent, recover) a replacement counts only when it is one of the
  owner's RPCs for that chain (`superstables owner settings rpc <chain> <url...>`) or the chain's
  built-in one; any other value stops the command (exit 3) before anything is asked or sent. With no
  replacement set, every command reads through the owner's RPC when there is one. A
  replacement in use is named in the `RESULT` (`rpc`). Approval pages on your machine do not
  pass replacement RPC URLs to the owner's wallet, including URLs that carry access keys.
  When asking the wallet to add a chain, they offer the chain's public RPC.
  On `solana`, `fund-agent`, `grant`, `revoke`, `buy`, and `setup` when it replaces a recorded owner
  or asks for `--fund` or `--grant`, first check that the RPC answers Solana devnet's genesis hash. On
  another cluster, or when the hash can't be read, they refuse (exit 3) before a blockhash is fetched
  or anything is signed or sent. `status` then says the budget could not be read (exit 1).
- **Budget EVM commands check the chain, and decide on agreement.** Every `evm` command that reads
  checks the chain id its RPC answers before it reads anything (`read` and `reconcile` included), and
  `B4_RPC_<CHAIN>` sets one chain's RPC without touching the others. An allowance of 0 shown as a
  revoke, a pull that reverted, a purchase that never happened (another transaction took the pull's
  nonce) and an authorization that can no longer settle are checked at a final block using the
  configured RPC agreement rule. This requires independent operators, except when the owner's own
  node is sufficient or the testnet's configured verdict set has one operator. If the required
  agreement cannot be reached, the answer stays unknown, with the reason in words: do not pay again.

What a compatible site must serve, with both proofs spelled out:
[budget/CLI.md](../budget/CLI.md#hosted-approvals-what-a-compatible-site-must-do).

## What you install

For 0.5.0, use the agent skill zip attached to the 0.5.0 release on
[GitHub Releases](https://github.com/superstables/superstables/releases), `superstables-payments-skill-0.5.0.zip`;
`scripts/VERSION.json` inside it records the version and commit. Comparing the download's SHA-256
checksum with a published value checks that the downloaded bytes match that value; when both come
from the same site, it is not an independent check of a compromised site. Installing from git with
a full commit hash builds the client on your machine and runs the repository's build scripts
there; without a hash, npm installs whatever the default branch holds.

The npm package pins its runtime dependencies to the exact versions its tests ran on, and viem pins
the packages that sign and hash. Four packages further down (`@noble/ciphers`, `@scure/base`,
`@adraffy/ens-normalize`, and zod 3 under `@x402/core` and `@x402/evm`) may still resolve to a
newer compatible version; the project's nightly install check fails when an install no longer
matches the tested set. `dist/sbom.cdx.json` in the package and `scripts/sbom.cdx.json` in the skill
zip list every package the client installs or bundles, including the bundled Solana and Tempo
libraries that `npm audit` on your machine cannot see. Two builds of one commit are identical
([checking a build](install.md#checking-a-build-against-its-commit)). The package is not published
with npm provenance, so nothing on the registry ties it to a commit: rebuilding it is the check.

## Replacing a key

What the client can do today when a key or secret may have been seen by someone else. Where it
says "not supported", there is no command for it yet; do not move key files by hand.

- **Budget agent key, `tempo`.** Supported. `superstables budget setup --rail tempo --agent LABEL`,
  with a LABEL not used before (a used one reuses the key it already names), adds a new access
  key next to the old one; on a chain with approvals on superstables.com it also adds the new key there. The owner grants it
  with `superstables budget grant --rail tempo --agent LABEL --amount A`, then revokes the old key
  with `superstables budget revoke --rail tempo` (add `--agent OLD` if the old key had a label).
  A key revoked on an owner's account can never be granted again on that account. After this,
  every `buy` and `status` for the new key needs `--agent LABEL`.
- **Budget agent key in the OS keychain, `evm` and `solana`.** `superstables budget setup --rail
  evm|solana --key-store os-keychain` creates the key in the keychain (macOS `security`, Linux
  `secret-tool`) and writes only its address to the key file. Moving an existing agent key there with
  the same command overwrites the file's copy in place with zeros first, then replaces the file. That
  clears the file's own bytes and any hard link to it; it cannot clear copies a copy-on-write or
  journalling file system, a snapshot or a backup already holds. `rotate` of such a key puts the
  new one in the keychain too and keeps the old entry: the retired key file names it, and it stays under
  service `superstables-budget-agent`, account `<rail>:<old address>` (`secret-tool lookup service
  superstables-budget-agent account evm:0x...` on Linux; `security find-generic-password -s
  superstables-budget-agent -a evm:0x... -w` on macOS), so funds left at the retired address can
  still be moved by hand. The account is case-sensitive and EVM entries use the checksummed address,
  while the retired file's name is lowercase: copy the address from the retired file's
  `B4_AGENT_ADDRESS` line. Moving a key in is ordered so that no step loses it: the keychain takes the
  key and is read back, the replacement file is written beside the old one, the old file's bytes are
  overwritten, and only then is the replacement renamed over it; if the replacement cannot be written,
  setup refuses and the old file is untouched. If the process is killed in the moment between the overwrite and the rename, the key
  file holds zeros, the key is in the keychain under the account above, and a hidden file named `.<name>.<pid>.<random>.tmp`
  (mode 0600) beside it holds the address lines. Running the same `setup` again finishes the move: it checks that the keychain
  gives back the key of the address the hidden file names, then puts that file in place. If the keychain cannot be read or the
  hidden file is gone, setup refuses, changes nothing and says which keychain entry holds the key. If the hidden file names a
  different agent than the public file does, it refuses and names both. If another setup is still moving the key, it refuses and
  asks you to wait for that one to finish. Do not start a new agent because of it: the old one may still hold a live budget. A locked keychain makes `buy`, `grant`,
  `fund-agent`, `recover` and owner requests on chains approved on superstables.com refuse, because the agent key signs
  them; the local `revoke` still works. `tempo` agent keys stay in files in this release.
- **Budget agent key, `evm` and `solana`.** Supported: `superstables budget rotate --rail evm|solana`
  (`--plan` first shows what it would do and sends nothing). It runs where the agent key file is,
  in the owner's terminal, and goes in this order:
  1. The old address is retired first, in `keys/budget/retired.json`. From then on this machine
     never grants, funds, sets up or buys with it again.
  2. On every chain where the old key is set up, the owner ends its authority in their wallet:
     `approve(agent, 0)` on `evm` (a price already pulled can still settle, and `rotate` waits for
     it), the SPL `Revoke` on `solana`. Open purchases are settled or returned. The old key's funds
     go back to the owner: USDC above the gas reserve on `evm`, USDC and SOL on `solana`.
  3. Only then is the old key file moved to `keys/budget/retired/`, and a new key is created and
     connected on the same chains, with the same owner. Run `grant` for it as for any new agent.

  A rotation that stops (the owner's link expired, a chain read failed) can be run again; it
  continues where it stopped and never repeats an approval it recorded in `budget/rotations/`. On
  chains approved on superstables.com the old agent also stays on the owner's account page until
  the owner removes it there; `rotate` says so. What it does not do: the retired key (the file, or for a key
  in the keychain the keychain entry the file names) is kept and no command uses it, so funds that reach a
  retired address later stay there until you move them by hand; and the retired list is a file on this machine, as editable by whoever can edit the
  public files as they are. It stops this client from arming the old key again. What stops a stolen
  key is the owner's revoke on chain, which `rotate` makes before it moves the key. A plain revoke, without `rotate`,
  does not retire the key: the owner can grant it again. `superstables budget recover --rail evm
  [--chain C]` (`--chain` defaults to Base Sepolia) alone returns USDC the agent key still holds to
  the owner. It needs gas in the agent key (the owner sends some first if it is short), and on a
  chain where USDC pays for gas (Arc Testnet) it leaves the agent's gas reserve.
- **Owner key.** It stays in the owner's wallet, which the client does not manage. `setup
  --new-owner` changes the owner recorded for a budget; it moves no funds, and it refuses while a
  budget is live (revoke first) or, on `evm`, while the agent key holds USDC (run `recover`
  first). On Arc Testnet, USDC up to the agent's gas reserve does not count, because `recover`
  leaves it there.
- **Local wallet key.** Stop the wallet, run `superstables wallet init --force` (it asks for a
  passphrase for the new key), and start the wallet again: a running wallet keeps signing with the key it loaded. The old key file is
  replaced, and with it access to whatever its address holds; the client has no command to move
  funds off it first.
- **Local wallet secrets.** Stop the wallet, delete `wallet/owner-secret` or `wallet/agent-token`,
  and start it again: it creates a new one. The client reads the agent token from its file on
  each request; `SUPERSTABLES_WALLET_AGENT_TOKEN`, if you set it, needs the new value.

## What mainnet still needs

This client does not sign on mainnet, and no setting turns it on. This section lists what would have to be true before a
chain that is not a testnet could be added, so that what the code enforces today stays separate from what it does not.

**What the code requires.** Every signature, wallet request and broadcast, in `pay` and in every `superstables budget` rail,
passes one chain gate first. A chain whose table entry is not marked as a testnet is refused unless all three of these hold:

- **The build allows mainnet signing.** A constant in the client, `MAINNET_SIGNING`, is `false`. Nothing reads it from the
  environment or from a file.
- **Your signed settings enable the chain.** `superstables owner settings sign` has your wallet sign the list of chains
  enabled for signing, and the gate reads that list only from a valid signature. The list that command offers is empty in this
  build, so this command enables none.
- **The chain has everything mainnet needs.** The gate checks four things for the chain and names each one that fails:
  - RPC endpoints your signed settings choose for it that can decide a verdict on their own: your own node, or as many operators as your quorum needs (at least two);
  - complete token facts for the token the signing code uses;
  - a measured time to finality for the chain;
  - for the chain's budget rail, an agent key file that names the OS keychain and holds no key.

  A check that cannot run counts as missing. Mainnet signing is off in this build and no chain table names a mainnet, so these
  checks decide nothing yet. `pay` does not load the keychain check, so for `pay` the fourth always reads as missing;
  `tempo` agent keys stay in files, so that rail always misses the fourth; only two chains have a measured finality time; and
  the local wallet's key is not part of the fourth check yet.

**What is still outside the code.**

- **Evidence from real runs.** What the client assumes about a chain, such as when its blocks are final, which network fees
  count against an access key's limit and what the token's signing domain is, was checked on the testnets it supports. It has
  not been checked on any mainnet chain, and each one needs the same checks before it is added.
- **Package provenance.** The npm package is published without npm provenance, so nothing on the registry ties it to a commit;
  rebuilding it is the check ([checking a build](install.md#checking-a-build-against-its-commit)).
- **The site.** This page covers the client. What superstables.com would need before it supports mainnet is separate work.
- **A signing surface that reads like money.** Browser wallets such as MetaMask show an EIP-712 authorization in atomic
  units; a person should see "0.01 USDC to this seller" in the wallet, not only on our page. The approval page shows raw and
  readable values side by side, but the wallet's own prompt is not something this client controls.

### Limits this release leaves in place

These are known limits of this release.

- **Windows.** Windows is not supported (use WSL), and `superstables budget` refuses to run on native Windows. The code that
  opens a page in the browser still names Windows' `start`: the budget's opener and `owner settings sign` run `cmd /c start`,
  and the wallet runs `start` through a shell. Nothing on this page is claimed for native Windows.
- **`doctor` contacts other hosts.** `superstables doctor` asks the Superstables index, the demo service and each public
  facilitator whether they answer, so those hosts see this machine's address. That is what it is for.
  `SUPERSTABLES_DOCTOR_OFFLINE=1` skips every one of those checks and says so on each line.
- **The owner's-terminal check is a speed bump.** `superstables budget unlock`, `superstables owner settings` changes and
  `owner settings sign` run only when standard input is a terminal, and the first two also ask for a typed confirmation. An
  agent that drives a pseudo-terminal can pass that check. It stops an agent that runs the command carelessly, not one that
  means to. What an owner action is worth rests on the owner's wallet, not on this check.
- **Old Tempo purchase records stay unknown.** The client does not repair Tempo purchase records written by an earlier version.
  A record with no recorded expiry, or with neither a payment memo nor a transaction hash, stays `unknown`, and
  `superstables budget reconcile` does not report it `not_found` once its expiry passes. Nothing in such a record shows the
  payment can no longer settle. Do not pay again on that basis.
