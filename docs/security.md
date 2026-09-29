# The security boundary in this release

This release is a testnet demo. It moves test USDC on Base Sepolia and nothing else. Read this
page before you point it at anything you care about, because it says plainly what the design
protects and what it does not.

The one sentence version: **the agent can ask for a payment, and only the owner can cause one.**
Everything below is the detail behind that sentence.

## Where the key is

In MetaMask, where it was before any of this was installed. Nothing in this software holds a
private key in the default mode, generates one, or reads one. There is no key file to steal on
the machine the agent runs on, and there is nothing for a hostile agent to exfiltrate, because
there is nothing there.

What this software does hold is the *asking* side: it builds the payment authorization, serves
one page that shows it, and hands the signature it gets back to a facilitator. Every one of
those steps is visible, and none of them can happen without a human pressing sign in MetaMask.

(The `--wallet local` mode is the exception, and has its own section at the end. There, a key
does live in a file on this machine.)

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
| Payer | the account MetaMask connected with. The agent never names the payer |

If any of those checks fails, the request is refused before anyone is asked, and no approval
link ever exists.

**Reported — what the agent says the payment is for**, stored under `reported` and labelled
unverified wherever it is shown:

- `target` — the URL the agent says it is calling
- `serviceId`, `serviceName`, `description` — the agent's own labels
- `quoteId`, `attemptId` — the agent's record ids

None of it changes what gets signed. The typed data MetaMask is asked to sign is built from the
verified requirement, field by field: `to` is the requirement's `payTo`, `value` is its
`amount`, `verifyingContract` is its asset. An agent that lies about a payment can only lie
about the label on it.

There is one place where reported context has an effect: the policy takes the hostname for its
`allow`/`deny` rules from `reported.target`, because the requirement does not carry the URL that
was called. A dishonest agent could therefore misreport the host and slip past a host rule. It
cannot misreport the amount, the asset, the network or the recipient, so `caps.per_call`,
`caps.per_day`, `stablecoins` and `kill_switch` are all judged on verified facts. Treat host
rules as a convenience, not as a boundary.

## The approval link is the capability

There is no password on the approval page. The authority is the id in the URL: 128 bits of
randomness, generated when the payment is created, and handed to the agent as part of its tool
result so it can pass it to you.

That id is deliberately narrow. Holding it lets someone see *one* payment and sign *that* one:

- it names one stored request, and the routes under it (`/state`, `/account`, `/signature`,
  `/reject`) only ever act on that request;
- signing still needs MetaMask. The link is an invitation to sign, not a signature;
- a decision is final: a second POST to a request that is no longer pending gets 409, so one
  approval can never produce two payments;
- it expires five minutes after it is created, on a timer and on every request, so a reader
  never sees a pending request that has in fact run out of time;
- the server binds `127.0.0.1` only. Nobody off this machine can open it at all.

When a signature arrives, it is checked before it is used: `verifyTypedData` must recover the
same account the typed data was built for. A signature made by any other key is refused with a
reason, and the request stays pending so the right account can still sign. Nothing is ever
submitted on the strength of "the page said so".

## What a compromised agent can and cannot do

Assume the agent is fully hostile — a prompt injection, a bad tool, whatever.

It **can**:

- ask for any number of payments, to any recipient, and put a misleading label on each one;
- pick which URL to call and therefore which seller's terms come back;
- read this machine's records (`records/*.jsonl`): what was quoted, attempted, paid and asked
  for;
- refuse to show you a link, or show you one for a payment you did not ask for.

It **cannot**:

- sign anything. Every payment needs a human in MetaMask, and MetaMask is not reachable from
  the agent's process;
- read a private key, because there is none here to read;
- turn one approval into two payments, or revive an expired one;
- pay a recipient other than the one in the signed authorization — the recipient is *inside*
  what MetaMask displays and what you sign.

The defence against payment spam is that every request needs a human decision and expires on
its own. There is no unattended mode in this release, by design.

## What a compromised MCP process could do

This is the sharper question, because the approval page is served by that process. A hostile
build of this software, or code injected into it, **could**:

- show you a page that describes the payment dishonestly — a smaller amount, a different
  recipient, a service you recognise;
- build typed data that differs from what the page says;
- ask for payments repeatedly, hoping for a distracted yes.

What it **cannot** do is make MetaMask lie. The popup is rendered by MetaMask from the request
it was handed, in its own window, outside this software's reach: the contract being signed, the
`to` address and the `value` in it are the ones that will actually move money. A page that says
"0.01 USDC to Superstables" while asking MetaMask to sign 50 USDC to somebody else is a page
whose lie is visible in the popup — which is exactly why the last look belongs there, and why
the demo script points at MetaMask's own fields rather than at ours.

So: read the page to know what you are being asked for, and read MetaMask to know what you are
signing. If they disagree, MetaMask is right, and something is wrong with the software.

## The same-machine caveat

Any process running as your user can serve a page on loopback, and MetaMask's permission to
connect is granted per origin. A hostile local process could serve its own page on
`127.0.0.1:4412` after this one stops and inherit a connection you granted earlier. It would
still have to get you to sign, and MetaMask would still show it the real amount and recipient,
but it would not have to ask for the connection again.

That is the shape of the boundary here: it is between *asking* and *signing*, and MetaMask holds
the signing side. It is not a boundary between processes on your machine, and nothing in this
release pretends to be one.

## Expiry

Nothing stays signable.

- A **quote** is good for 10 minutes. Paying re-reads the seller's challenge and refuses if the
  terms moved.
- An **approval** expires five minutes after it is created. Expiry is the signer's own decision,
  checked on a timer and on every request.
- The **EIP-3009 authorization** carries its own on-chain window: `validBefore` is set to now
  plus the seller's `maxTimeoutSeconds` (300 seconds unless the seller asks for something else).
  After that the facilitator cannot submit it at all.
- Stopping the agent denies everything still pending, with the reason "the agent stopped before
  this payment was approved". There is no queue that survives a restart.

## The approvals log

Every state change of every approval appends one JSON line to
`~/.superstables/records/approvals.jsonl` (0600): the time, the id, the new status, the reason
if there is one, the verified terms, the reported context, and the account that connected.

It never contains a signature and never contains a key. It is a file for reading:

```bash
grep -o '"status":"[^"]*"' ~/.superstables/records/approvals.jsonl | tail -3
```

The agent side keeps its own append-only records next to it — quotes, attempts and receipts,
0600. No secrets, but they do say what was bought and for how much.

## Policy is software, not chain enforcement

`policy.yaml` is read and applied by this client: once advisory, at quote time, and once
authoritative, at the gate, before an approval is created at all. A payment the policy refuses
never becomes a link, so there is nothing to open and nobody is asked.

Nothing in the policy is enforced by the blockchain, and nothing in it is enforced by MetaMask.
A cap of 0.05 USDC per payment means this software will not ask you to sign more than that; it
does not mean your account cannot sign more. The only limits that survive a compromised machine
are the ones inside what you sign — the amount and the recipient in the authorization — and the
balance of the account, which is why this release is testnet only.

The daily cap is counted from local files, the receipts in this directory, not from chain
history. Delete them and the count starts again.

## Testnet only

One network (`eip155:84532`, Base Sepolia), one asset (test USDC at
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`), one scheme (x402 `exact`). A requirement naming
anything else is refused before anyone is asked. There is no configuration that turns on
mainnet.

Payments are settled by public facilitators, which submit the transfer and pay the gas. A
facilitator sees the signed authorization, so it learns who paid whom and how much; it cannot
alter the amount or the recipient, because those are inside what was signed. A facilitator that
cannot be reached is skipped; a facilitator that answers "no" is believed, and the payment is
not re-offered to the next one.

## The local wallet mode

`--wallet local` (or `SUPERSTABLES_WALLET=local`) replaces MetaMask with a wallet process that
holds a key in `~/.superstables/wallet/key`, mode 0600. It exists for a machine with no browser,
and it moves the boundary.

It generates two random 32-byte hex secrets at first start, in `~/.superstables/wallet/`:

| Credential | File | What it can do |
| --- | --- | --- |
| Agent token | `wallet/agent-token` | Ask. `POST /requests`, `GET /requests/:id`, `GET /status`, `GET /address` |
| Owner secret | `wallet/owner-secret` | Decide. Everything above, plus `GET /owner/requests`, `POST /owner/requests/:id/approve`, `POST /owner/requests/:id/deny` |

Both are sent as `Authorization: Bearer …` and compared in constant time. A missing or unknown
token gets 401; the agent token on an `/owner/…` route gets 403 — asking and approving are
different powers, so they are different secrets. The owner secret never reaches an agent and
never reaches the wallet's own HTTP log either: the owner opens
`http://127.0.0.1:4411/#<owner-secret>`, and a URL fragment is not sent to the server. The
wallet verifies the same facts the approval page does and signs the stored requirement byte for
byte, and every state change goes to `wallet/audit.jsonl`.

The caveat is the one browser mode removes. This is credential separation inside one operating
system account, not a hardware boundary: any process running as you can read
`wallet/owner-secret` and `wallet/key` directly, and at that point it is you as far as the
wallet is concerned. A hostile agent confined to the wallet's HTTP API cannot pay. Arbitrary
code running as your user can. Run that mode with a key that holds testnet funds only.

## What changes in the next milestone

- **Budgets.** Approval per payment is the only mode of the MCP tools and `pay`. A budget,
  approved once and spent down, now exists as a separate testnet tool, `superstables budget`
  ([budget/README.md](../budget/README.md)): the owner grants an agent key a USDC allowance on
  chain and revokes it with one transaction. It has its own keys and its own boundary. The
  chain enforces only the total cap, and a stolen agent key can spend all of it. Bringing
  budgets into the approval flow, with terms a person can read in the wallet, is the next step.
- **A signing surface that reads like money.** MetaMask shows an EIP-712 authorization in atomic
  units; a person should see "0.01 USDC to this seller" in the wallet, not only on our page.
- **A boundary that survives the machine.** Spending limits that hold even when the host is
  compromised have to live somewhere other than the host.

Until then, treat this as what it is: a demonstration that the owner, and only the owner,
decides.
