# `superstables budget` CLI contract

One command for the budget rails. `superstables budget` is a thin dispatcher over the rail scripts, which follow `CONTRACT.md`. It normalizes their `RESULT` lines into one shape. `buy-once` is the other way to pay: one purchase the owner approves on superstables.com, with no budget. Testnet only: test USDC, no real money.

| `--rail` | Path | Chains (`--chain`) | Implementation |
| --- | --- | --- | --- |
| `evm` | plain approve, pull then pay | `base-sepolia` (default), `arc-testnet`, `arbitrum-sepolia`, `polygon-amoy`, `skale-base-sepolia` | `evm/` |
| `tempo` | access key, MPP charge | `moderato` | `tempo/` |
| `solana` | SPL delegate, x402 | `devnet` | `solana/` |

## Commands

| Command | Role | Does |
| --- | --- | --- |
| `superstables budget setup --rail R [--chain C] [--new-owner] [--hosted [--site URL]]` | owner | Creates the agent key file if it is missing (never overwrites it). With `--hosted` (`evm` only), the owner links this agent to their superstables.com account instead, and the chain's owner approvals are hosted from then on (see [Hosted approvals](#hosted-approvals-evm)). The owner connects their wallet on the approval page and signs a free sign-in message. Writes the public file. Prints the next steps. No owner key is created. A trusted step: the signature proves control of an address, not the owner's identity, so whoever completes setup becomes the owner on record. The owner runs it, or watches it run; an agent must not complete it. A recorded owner never changes silently: `--new-owner` replaces it, refused (exit 3) while a budget is live on it. `tempo`: also tops up the owner from the Moderato faucet when it holds less than 1 pathUSD, and `--agent LABEL` adds a new agent key (no page). |
| `superstables budget fund-agent --rail evm\|solana [--amount A]` | owner | One plain transfer from the owner's wallet to the agent, approved on the approval page. `evm`: the chain's gas token; the default amount comes from the chain table. `solana`: SOL for fees, default 0.01. `tempo` has none: the agent needs no gas. |
| `superstables budget doctor --rail R [--chain C]` | anyone | The agent key file (mode 600, no owner key in it), the public file (the owner's address), RPC, balances. Prints what to top up at which address. No transactions. No rail has an owner key file to check. |
| `superstables budget preflight --rail evm --url U [--chain C]` | anyone | Reads the seller's 402 (x402 v2 header or v1 body) and prints its offer on the chain: price, token, `payTo`, network, scheme, x402 version. `RESULT` carries `amount` (the price), `payTo` and `offer`. The price is the seller's ask, not a ceiling: `next` leaves `--max` to the caller. A seller on another chain fails, and `next` names the `--chain` it offers. Also checks the RPC and the token. **Never signs or sends**; opens no key file. |
| `superstables budget grant --rail R --amount A [--expiry ISO] [--period S] [--sellers a,b]` | owner | Prints the terms (cap, true maximum, what the chain enforces and what it doesn't). The owner approves it on the approval page. Refuses constraints the rail can't enforce (`evm` and `solana`: `--expiry`, `--period`, `--sellers`). |
| `superstables budget status --rail R` | anyone | Remaining budget, expiry, revoked, funds at risk. No secrets. |
| `superstables budget buy --rail R --url U --max M [--pay-to ADDR] [--op ID] [--method M --body JSON]` | agent | One purchase under the budget. `--method` and `--body` are for tempo and solana. On `evm`, the seller's answer to the paid request is saved as a file (see Output). |
| `superstables budget buy-once --service ID --max M [--param K=V ...] [--params JSON] [--site URL] [--wait \| --detach] [--replace]` | agent, owner approves | One purchase of a service the site lists for it, approved by the owner on superstables.com: no setup, no gas, no budget, no agent key (see [Buy once](#buy-once)). Base Sepolia only. `--service` and `--max` are required. |
| `superstables budget reconcile --rail R --op ID` | anyone | Reads the chain for an operation. **Never signs or sends.** |
| `superstables budget recover --rail evm [--op ID]` | owner | EVM only: stop the allowance first, then return stranded funds. The agent key signs its own steps; the owner approves on the approval page only what the agent cannot do (the rest of the allowance, gas for the agent). |
| `superstables budget revoke --rail R` | owner | Ends the budget on chain. The owner approves it on the approval page. |
| `superstables budget find [--json] [--site URL] [--chain C] [--once]` | anyone | Lists the services superstables.com says a budget can pay (`GET /api/v1/budget/services`): name, price, chain (the `--chain` key when the client knows the network) and URL, as a table on stdout, or one JSON line with `--json`. `RESULT` carries them as `services`. When the site has no list, it exits 1 and `next` says that any seller URL works with `preflight` and `buy`. The site is `--site`, else `SUPERSTABLES_SITE`, else the `SITE` that `setup --hosted` recorded (for `--chain C`, or the first `evm` chain that has one), else `https://www.superstables.com`. Reads only; no account, key or rail. With `--once`, it lists instead the services that can be bought once (`GET /api/v1/purchase/services`): id, name, price and inputs (`*` marks a required one); `RESULT` carries them as `services`. `--once` takes no `--rail` or `--chain`. |
| `superstables budget wait --id ID [--timeout S]` | anyone | After a detached owner command: waits up to `S` seconds (default 30, at most 300) and prints the approval's state. **Never signs or sends.** |

On tempo, `--agent LABEL` picks the access key for `doctor`, `grant`, `status`, `buy` and `revoke`, and `setup --agent LABEL` makes a new one.

Every command: `--help` exits 0 and bad input exits 2 before any secret is read. `--mainnet` or a mainnet chain id is refused.

## Owner approval

`setup`, `fund-agent`, `grant`, `revoke` and, on `evm`, the owner's part of `recover` use the owner's wallet by default. The explicit test key-file option is described below. The rail script builds the transaction and the terms, starts a page on `127.0.0.1` (random port, one-time random id in the path), and waits. The owner opens the page in the browser with their wallet, connects, and approves or rejects. For transactions, the script checks the chain before the final `RESULT`. Setup verifies a message signature and records the address. Detached commands first return a pending `RESULT`.

| Rail | Wallet | What the wallet does | What the command reads back |
| --- | --- | --- | --- |
| `evm` | Any EVM browser wallet (MetaMask, Rabby, Coinbase Wallet, ...), found through EIP-6963 or `window.ethereum` | Sends `{to, data, value}` | Sender, target, exact data, receipt, the `Approval` event, the allowance |
| `tempo` | Any EVM browser wallet that can add a custom network, found the same way | Is asked to send a call to the AccountKeychain precompile (`authorizeKey` or `revokeKey`) with the owner paying the fee in their configured fee token, or pathUSD by default. The page adds Tempo Testnet (Moderato) with 18 decimals. | Sender, target, exact data, fee payer, receipt; then the key: type, expiry, limit, period, seller list, not an admin key; or revoked |
| `solana` | Any Solana wallet (Phantom, Solflare, Backpack, ...), found through the Wallet Standard | Only signs. The command builds the transaction when the owner presses Review in wallet, checks that the signed message is byte for byte its own and signed by the owner, then sends it. | No error, signer the owner; then the token account: owner, mint, delegate and delegated amount (or no delegate); or the agent's SOL |

With more than one wallet installed, the page lists them and the owner chooses one. The page then uses only that wallet.

### Hosted approvals (evm)

`setup --rail evm --hosted [--site URL]` moves a chain's owner approvals to superstables.com. The owner needs an account there (Sign-In with Ethereum); the page on `127.0.0.1` needs none, and stays the default. Hosted approvals are `evm` only for now: `--hosted` on `tempo` or `solana` exits 2.

- Setup sends a link request, signed by the agent key. The owner opens the link on any device where they are signed in to the site with their wallet, picks the match code the agent showed them, and links the agent to their account. The account's address becomes the owner on record (`B4_OWNER_ADDRESS`), and the public file gets `APPROVALS=hosted` and `SITE=<origin>`. A different recorded owner is replaced only with `--new-owner` (refused while a budget is live).
- From then on `grant`, `revoke` and `fund-agent` on that chain send the exact transaction to the site as an approval request, signed by the agent key. The owner's wallet sends it from the site's page. Every request is refused (exit 3, nothing sent) when the site would act for another address than the owner on record. The command then reads the chain exactly as with the local page, and refuses a mismatch the same way. On Arc, where USDC pays the fees, a hosted `fund-agent` sends the token's own `transfer(agent, amount)`.
- `recover` keeps the page on this computer for its owner steps. `setup` without `--hosted` keeps the recorded owner and mode; `setup --new-owner` without `--hosted` moves the chain back to the local page.
- `APPROVE` and `RESULT` carry `matchCode`. The agent writes it next to the link in its reply to the owner, a visible message, not only in its reasoning or a tool call. `wait` reads the request's state from the site; `--replace` asks the site to cancel, which it does only while the wallet has not been asked.
- The site's access token for polling a request (`ssbt_...`) is stored only in that approval's record (mode 600) and removed when the approval is final. It is never logged.
- A site that cannot be reached, or that refuses the request (for example a cap above the account's limit), is a refusal before anything is sent: exit 3 with the site's reason. Once the site reports that the wallet was asked, or a transaction hash, an unfinished outcome is `unknown` (exit 5), never "nothing sent".

- As soon as the link exists, stdout gets one line `APPROVE {"action","url","expires","terms"}` (hosted: also `matchCode`). `terms` holds the page's plain words: `title`, `amount`, `unit`, `summary`, `enforced`, `notEnforced`. The same link goes to stderr. The final `RESULT` is still the last line, and carries `url`.
- The sentence on stderr that carries the link, and the `next` of a `waiting_owner` result, say: `Testnet only: test USDC, no real money.` The hosted ones also say that the first link the owner opens asks them to sign in with their wallet (a message, no fee).
- `--timeout SECONDS` (10 to 3600, default 600): how long the link stays open. `--no-open`: do not open it in the default browser.

### Detached or blocking

An agent's shell tool usually shows output only when the command exits, and many tools stop a command after a minute or two. So an owner command has two modes:

| Mode | When | What happens |
| --- | --- | --- |
| Detached | stdout is not a terminal (an agent), or `--detach` | The command starts itself again as a background process and returns as soon as the link exists. It prints `APPROVE`, then `RESULT` with `state: "waiting_owner"`, exit 0, and `id`, `url`, `expires`, `terms` and `next`. The browser is not opened. |
| Blocking | stdout is a terminal (a person), or `--wait` | As before: the command opens the link in the default browser (unless `--no-open`), waits for the owner, reads the chain and prints the final `RESULT`. |

Then `superstables budget wait --id ID [--timeout S]` polls the approval:

- Still open: `RESULT` with `state: "waiting_owner"`, exit 0, the same `id`, `url`, `expires` and `terms`, and a `reason` describing the recorded page state (for example "the owner account is selected; waiting for wallet approval"). `recover` can ask the owner twice (the rest of the allowance, then gas for the agent). A new link ends the wait at once, with the new `url`.
- Ended: the owner command's own final `RESULT` and exit code, exactly as the blocking command prints them, plus `id`: `settled` with the `tx` the command read from the chain, `refused_precheck` (exit 3) when the owner rejected or the link expired before the wallet was asked to send, or the transaction on chain did not match the plan, `unknown` (exit 5) when the wallet may have sent (including a rejection reported after it was asked). Later `wait` calls return the stored final result. Waiting never approves the request or retries a transaction.
- The background process ended without a `RESULT` (killed, or the machine restarted): `refused_precheck` (exit 3) when its last page log has no recorded submission, else `unknown` (exit 5).
- An unknown id exits 2.

Run one owner command at a time per rail and chain. Detached and blocking owner commands (and `--owner-key-file ... --yes`) take the same lock, created in one exclusive step. A tracked pending approval causes another command to be refused (exit 3). Do not use another terminal or client home to start a parallel approval. Its `RESULT` carries the pending `id` and `url`, and `next` says to run `wait --id`. `--replace` asks the pending page to cancel. The page answers in one step: if the wallet was never asked, the old approval ends as `refused_precheck` with a reason that names the new id, its processes are stopped, and the replacement starts. If the wallet was already asked, the replacement is refused and the old approval stays pending. Use it only at the owner's request, after cancelling any wallet prompt. It cannot cancel a transaction already submitted.

Each owner command's rail script runs in its own process group, recorded with the approval (the page's process runs in it). If the background worker dies while its page still runs, `wait` keeps returning `waiting_owner` with a reason that says so, and the chain stays held. Past the approval's deadline `wait` stops that group itself. Only when no process of it is left does `wait` record a final result from what the page logged: `unknown` (exit 5) if the wallet had been asked to send, `refused_precheck` (exit 3) otherwise.

The background worker has a timeout. The page expires its link after `--timeout`. A wallet that was asked to send gets 2 more minutes to report the hash, and the chain reads are bounded. A backstop stops the process after `--timeout` plus 9 minutes, with `unknown` (exit 5). The timeout runs without `wait`. It does not cancel a wallet request or a submitted transaction.
- A rejection or expiry before the wallet was asked to send returns `state: "refused_precheck"`, exit 3. Once the page asked the wallet to send, a reported rejection cannot prove nothing was submitted (anyone holding the link can post it, and a wallet prompt may still be open): the result is `state: "unknown"`, exit 5, as when no hash came back. Read `status` before trying again.
- `evm` and `tempo`: the command reads the reported transaction from the chain. A different sender, target, calldata, value, chain, a block before the request, a transaction type other than a plain one (`tempo`), or a fee payer other than the owner (`tempo`) is a mismatch: exit 3 with a reason naming each difference and a next step to revoke, even when the allowance or key reads right afterwards. A requested `tempo` period must read back exactly. If the owner's fee token cannot be read, `tempo` refuses before any link instead of assuming pathUSD.
- The approval page's state-changing routes accept only requests from the page's own origin with a JSON body. That stops other web pages in the owner's browser; it is not authentication of a person. Every owner page shows the recorded owner address.
- The chain shows something other than the plan (on `evm` an allowance other than the cap, because the owner edited the spending cap in the wallet; on `tempo` another limit, expiry or seller list; on `solana` another delegate or amount): `refused_precheck`, exit 3; revoke it.
- `solana`: a wallet that changed the transaction (another amount, an added instruction) gets nothing sent. The page says so and stays open; the command logs the program ids the wallet added. A transaction the owner signed after its blockhash expired (about a minute) is not sent either: request a fresh transaction with Review in wallet only after the command confirms it did not submit the old one. Any error from the wallet's sign call ends the link as a rejection.
- `--yes` without `--owner-key-file` exits 2, on every rail.
- Tests and automation only: `--owner-key-file PATH` (mode 600) with `--yes` signs with that key file instead. `setup --owner-key-file PATH` records its address.

## Buy once

`buy-once` wraps the site's hosted purchase API (`GET /api/v1/purchase/services`, `POST /api/v1/purchases` with an `Idempotency-Key` and `{service_id, params, max_amount}`, `GET /api/v1/purchases/{id}?wait=...`, `POST /api/v1/purchases/{id}/cancel`; the site documents it at `/docs/purchase.md`). Testnet only: test USDC on Base Sepolia, over x402 `exact`. `--rail` and `--chain` are accepted only as `evm` and `base-sepolia`; any other rail is exit 2 and a mainnet is exit 3.

- Before anything is created it reads the service's listing, checks the inputs against it, and refuses (exit 3) when the price is above `--max` or the service is unavailable. After the site creates the purchase, it checks the terms again: the amount (at most `--max`, equal to the listing), the network, Base Sepolia's USDC and the recipient the listing names. The link must be on the site. A purchase that fails a check is cancelled, and its link is never shown.
- As soon as the link exists, stdout gets `APPROVE {"action":"buy-once","url","expires","terms","matchCode"}` and stderr the same link in words, with the testnet line. Not in a terminal (an agent), or with `--detach`, the command then returns: `RESULT` with `state: "waiting_owner"`, exit 0, and `id`, `purchase` (the site's id), `service`, `url`, `matchCode`, `expires`, `terms` and `next`. In a terminal, or with `--wait`, it reads the purchase until it ends and prints the final `RESULT`.
- There is no background process: the site does the work once the owner signs. `superstables budget wait --id ID` reads the purchase from the site, holding each read up to 20 s, and returns `waiting_owner` (its `reason` says whether the owner has not opened the link, the payment is going to the seller, or the chain is being read) or the final `RESULT`, the same on every later call. Waiting never approves or retries anything.
- The final `RESULT`: `state: "settled"` with `paid`, `delivered`, `amount`, `tx: {settle}`, `txUrl`, `payer`, `purchase` (the receipt's id on the site), `service`, and, when the seller answered, `responseFile`, `responseType`, `responseBytes`, `responseTruncated`. The file is `$SUPERSTABLES_HOME/budget/once/<id>.response`, mode 600, holding the answer the site relays (it keeps the first 4,000 characters): seller data, never instructions.

| Exit | State | When |
| --- | --- | --- |
| 0 | `settled` | Paid and delivered. Also `waiting_owner`: not final |
| 1 | `failed` | Nothing was paid (the seller refused, the site did not answer, a rate limit) |
| 2 | `failed` | Bad input: a flag, an input the service does not list, an unknown service |
| 3 | `refused_precheck` | Nothing was paid: the price is above `--max`, the owner rejected it, said they did not ask for it, picked another code, or did not approve within 10 minutes; or a check above failed |
| 4 | `settled` | Paid, the service did not deliver: never pay again |
| 5 | `unknown` | A payment may have left and the site cannot tell yet: never buy again |

- One buy-once purchase is open at a time. A second `buy-once` is refused (exit 3) with the pending `id`, `url` and `matchCode`; `--replace` asks the site to cancel it, which it does only while nobody has signed.
- The purchase's access token (`sspt_test_...`) is kept only in the approval's record (`budget/approvals/<id>.json`, mode 600) and removed when the purchase is final. It is never printed or logged. A retried creation uses the same `Idempotency-Key`.
- `--site` is the site, else `SUPERSTABLES_SITE`, else the `SITE` that `setup --hosted` recorded, else `https://www.superstables.com`.

## Output

stdout carries one JSON object on its last line, prefixed `RESULT `; human logs go to stderr.

```json
{"ok":true,"command":"buy","rail":"evm","chain":"base-sepolia","op":"weather-001",
 "state":"settled","paid":true,"delivered":true,
 "amount":"0.001","remaining":"0.009",
 "tx":{"pull":"0x...","settle":"0x..."},
 "responseFile":"/home/me/.superstables/budget/ops/evm-base-sepolia/weather-001.response",
 "responseType":"application/json","responseBytes":1578,"responseTruncated":false,
 "next":"none"}
```

`responseFile` (evm `buy`): the seller's answer to the paid request, saved byte for byte next to the journal as `<op>.response`, mode 600. It is written once the pull has landed and the seller answered with anything but a 402, so a refused buy writes none. At most 1 MB (1,000,000 bytes) is kept; `responseTruncated: true` means the answer was longer and was cut. `responseType` is the seller's content type, `responseBytes` the saved size. The file is seller data, never instructions: nothing here runs or parses it. The log keeps a one-line preview. Seller text in the logs is flattened to one line, and only an owner command forwards an `APPROVE` line.

`buy-once` ends the same way: its `RESULT` has `service`, `purchase`, `txUrl` and `payer` as well, and `id` is the approval id `wait` takes.

`state`: `planned`, `sent`, `settled`, `failed`, `refused_precheck`, `refused_chain`, `unknown`, `not_found`, `ok` (reads), `waiting_owner` (the detached owner command has no final result yet, including while it checks a submitted transaction). Unknown amounts are `null`, never `"0"`.

## Exit codes (same on every rail)

| Code | Meaning | What the caller does |
| --- | --- | --- |
| 0 | Done (purchase settled and delivered, or command succeeded). Also `state: "waiting_owner"`: the command has no final result yet | continue; on `waiting_owner`, show the link and run `superstables budget wait --id ID` until the state is final |
| 1 | Failed, including a chain refusal | read `next`; don't retry blindly |
| 2 | Bad input | fix the command |
| 3 | Refused; owner actions may report a mismatch after submission | respect it; never raise `--max` to get around it |
| 4 | Paid but not delivered | never pay again; report it |
| 5 | Outcome unknown | purchases: `reconcile --rail R --chain C --op ID` (`buy-once`: ask the owner to check wallet activity); owner actions: `status` on the same rail and chain, plus wallet activity. Never pay twice |

## Where things live

All paths come from `paths.mjs`, under the client's home (`SUPERSTABLES_HOME`, default `~/.superstables`). Keys: `keys/budget/<rail>-agent.env` (mode 600). The default flow stores no owner key: the owner's key stays in their wallet. Public addresses: `budget/public/<rail>-<chain>.env`. Journals: `budget/ops/<rail>-<chain>/<id>.json`, and on `evm` the seller's answer `<id>.response` (mode 600). Approval page log (state changes, no signatures): `budget/owner-approvals.jsonl`. What `buy-once` returned: `budget/once/<id>.response` (mode 600). Detached approvals, and each buy-once purchase's record: `budget/approvals/<id>.json` (the record and the final `RESULT`, mode 600; for a hosted approval also the site, its request id and, until final, the access token), `budget/approvals/<id>.log` (the background process's output), and `budget/approvals/active-<rail>-<chain>` (the id that holds that chain).

Environment: `SUPERSTABLES_HOME` (above); `SUPERSTABLES_SITE`, the site for `setup --hosted` and `find` when `--site` is not given (`find` then uses the recorded site before the default); `B4_CHAIN`, the default `evm` chain for the rail scripts; `B4_RPC`, an RPC URL that replaces the selected `evm` chain's (for tests or your own node; scripts that sign still check the chain id first).

## Checkout or standalone build

In a checkout, `budget/cli.mjs` always runs the rail scripts from their TypeScript sources with the checkout's tsx (`npm ci` first), never a build in `dist/`, so an edit takes effect on the next run. `npm run build` also writes `dist/budget/`: the dispatcher and every rail script bundled into plain JavaScript that imports only Node built-ins and its own files. Only a copy without the sources runs those `.mjs` files: `dist/budget/` itself, or `scripts/` in the skill zip that `npm run skill` builds. The commands, flags, `RESULT` lines, exit codes and paths are the same.

`superstables budget --version` names the build: for a standalone copy, the version, commit and build time from its `VERSION.json`; in a checkout, the version and commit. `doctor` prints the same line first. `THIRD_PARTY_NOTICES.txt` in a standalone copy lists every bundled package with its version and licence text.
