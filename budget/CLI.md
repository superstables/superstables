# `superstables budget` CLI contract

One command for the budget rails. `superstables budget` is a thin dispatcher over the rail scripts, which follow `CONTRACT.md`. It normalizes their `RESULT` lines into one shape. `buy-once` is the other way to pay: one purchase the owner approves on superstables.com, with no budget. Testnet only: test USDC, no real money.

| `--rail` | Path | Chains (`--chain`) | Implementation |
| --- | --- | --- | --- |
| `evm` | plain approve, pull then pay | `base-sepolia` (default), `arc-testnet`, `arbitrum-sepolia`, `polygon-amoy`, `skale-base-sepolia`, `ethereum-sepolia` | `evm/` |
| `tempo` | access key, MPP charge | `moderato` (default, the only one) | `tempo/` |
| `solana` | SPL delegate, x402 | `devnet` (default, the only one) | `solana/` |

Chain to rail: Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia and Ethereum Sepolia are `evm`; Tempo Moderato is `tempo`; Solana devnet is `solana`.

The owner's steps, in order, once per rail and chain: `evm` and `solana`: `setup`, `fund-agent`, `doctor`, `grant`; `tempo`: `setup`, `grant`. `fund-agent` sends the agent key gas only (the chain's gas token on `evm`, SOL on `solana`), never the budget token. The grant leaves the funds in the owner's wallet: an allowance on `evm`, a delegate on `solana`, an access key limit on `tempo`. An agent may start any owner command and hand the owner the link; only the owner approves.

## Help

`superstables budget --help` is enough to use the tool without this file: a start-here sequence for the owner and for the agent, the rails and their `--chain` values with the defaults, the chain-to-rail map, the owner's steps per rail, the commands with who runs each and whether it moves money, owner approvals, the `RESULT` fields, the exit codes and where state lives. Every command's `--help` has the same parts in the same order: usage, what it does, the `--chain` values (when it takes `--chain`), `Moves money:`, `Run by:`, `Example:`, `Prints:` and `Exit codes:`. `buy --help` also says what `--max` is and what must exist before the first buy, and how to check it.

## Commands

| Command | Role | Does |
| --- | --- | --- |
| `superstables budget setup --rail R [--chain C] [--new-owner] [--hosted [--site URL] [--grant A] [--fund [AMOUNT]]]` | owner | Creates the agent key file if it is missing (never overwrites it). With `--hosted`, the owner links this agent to their superstables.com account instead, and the chain's owner approvals are hosted from then on (see [Hosted approvals](#hosted-approvals)); with `--grant A` and `--fund` (not on `tempo`), the same link also asks for the agent's gas and a budget of A. The owner connects their wallet on the approval page and signs a free sign-in message. Writes the public file. Prints the next steps. No owner key is created. A trusted step: the signature proves control of an address, not the owner's identity, so whoever completes setup becomes the owner on record. The owner runs it, or watches it run: an agent may start it and hand the owner the link, but never completes it. Running it again reuses the agent key. A recorded owner never changes silently: `--new-owner` replaces it, refused (exit 3) while a budget is live on it. `tempo`: also tops up the owner from the Moderato faucet when it holds less than 1 pathUSD (`--fund-only` tops up the owner on record again and does nothing else: no page, no file changed, refused with `--hosted`, `--grant` or `--fund`), and `--agent LABEL` adds a new agent key (no page; on a hosted chain, one link that links the new key). |
| `superstables budget fund-agent --rail evm\|solana [--amount A]` | owner | One plain transfer from the owner's wallet to the agent, approved on the approval page. `evm`: the chain's gas token; the default amount comes from the chain table. `solana`: SOL for fees, default 0.01. `tempo` has none: the agent needs no gas. |
| `superstables budget doctor --rail R [--chain C]` | anyone | The agent key file (mode 600, no owner key in it), the public file (the owner's address), RPC, balances. Prints what to top up at which address. No transactions. No rail has an owner key file to check. On `evm` the gas minimums grow with the current fee: the agent needs twice what one purchase plus a failed one's cleanup (pull, cancel, return) costs now, and doctor prints that cost. |
| `superstables budget preflight --rail R --url U [--chain C] [--method M --body JSON]` | anyone | Reads the seller's 402 and prints the offer this rail can pay: price, token, `payTo`, network. `evm`: x402 v2 header or v1 body on the chain (also scheme and x402 version; also checks the RPC and the token; a seller on another chain fails, and `next` names the `--chain` it offers; GET only). `tempo`: an MPP `tempo.charge` on Moderato, and whether the seller pays the fee. `solana`: an x402 `exact` offer on devnet. `RESULT` carries `amount` (the price), `payTo` and `offer`. The price is the seller's ask, not a ceiling: `next` leaves `--max` to the caller. Needs no setup. Sends one unpaid HTTP request to read the seller's terms; **signs nothing and submits no payment**; opens no key file. |
| `superstables budget grant --rail R --amount A [--expiry ISO] [--period S] [--sellers a,b]` | owner | Prints the terms (cap, true maximum, what the chain enforces and what it doesn't). The owner approves it on the approval page. Refuses constraints the rail can't enforce (`evm` and `solana`: `--expiry`, `--period`, `--sellers`). |
| `superstables budget status --rail R` | anyone | Remaining budget, expiry, revoked, funds at risk. No secrets. With no setup on this computer (no agent key, or no owner connected) it says so first, before any chain read: exit 1, `reason` "no budget has been set up here for R on C: ...", `home` the client home it checked, and `next` the owner's commands in order, then that if the budget is elsewhere the agent asks the user for the path instead of changing `SUPERSTABLES_HOME` or looking in another home itself (`~/.superstables` included). stderr names the home and the files it looked for. `remaining` 0 or a revoked budget: exit 0, and `next` says what is next. `tempo` also has `expired`, and `refillsAt`: the end of the current period of a live period budget, when the limit refills (`null` otherwise; it does not mean nothing is left). |
| `superstables budget buy --rail R --url U --max M [--pay-to ADDR] [--op ID] [--method M --body JSON]` | agent | One purchase under the budget. `--max` is the most this one purchase may cost, in the budget token (`0.02` is 0.02 USDC, or pathUSD on tempo); a higher price is refused before signing. `--method` and `--body` are for tempo and solana. On `evm`, the seller's answer to the paid request is saved as a file (see Output). Needs `setup` and `grant` (and on `evm` and `solana` gas from `fund-agent`); see "A buy with nothing to buy with" below. On `evm`, nothing is signed unless the agent key can pay, at the current fee, the gas for the pull and for the cancel and return a failed purchase would need: otherwise `refused_precheck` (exit 3), with `next` naming `fund-agent`. |
| `superstables budget buy-once --service ID --max M [--param K=V ...] [--params JSON] [--site URL] [--wait \| --detach] [--replace]` | agent, owner approves | One purchase of a service the site lists for it, approved by the owner on superstables.com: no setup, no gas, no budget, no agent key (see [Buy once](#buy-once)). On Base Sepolia, Tempo Moderato or Solana devnet, as the listing says. `--service` and `--max` are required. |
| `superstables budget reconcile --rail R --op ID` | anyone | Reads the chain for an operation. **Never signs or sends.** |
| `superstables budget recover --rail evm [--op ID]` | owner | EVM only: stop the allowance first, then return stranded funds. The agent key signs its own steps; the owner approves on the approval page only what the agent cannot do (the rest of the allowance, gas for the agent). |
| `superstables budget revoke --rail R` | owner | Ends the budget on chain. The owner approves it on the approval page. |
| `superstables budget find [--rail R] [--chain C] [--once] [--site URL]` | anyone | Lists the services superstables.com says a budget can pay (`GET /api/v1/budget/services`): name, price, chain (the `--chain` key when the client knows the network), simulated and URL, as a table on stdout; `RESULT` carries them as `services` (with `--json`, stdout is that object alone). `--rail R` or `--chain C` lists only that rail or chain: every key the budget commands take works, `moderato` (tempo) and `devnet` (solana) as well as the `evm` chains; an unknown one is refused (exit 2) with every valid key. `simulated` is `true` (`yes` in the table) when the listing says the service returns prepared sample output, `false` (`no`) when the listing marks it as not sample output (this does not verify that the data is real), and `null` (`not said`) when the listing does not say; the client reads the site's `simulated`, `mock` or `sample` field. When the site has no list, it exits 1 and `next` says that any seller URL works with `preflight` and `buy`. The site is `--site`, else `SUPERSTABLES_SITE`, else the `SITE` that `setup --hosted` recorded (for `--rail` and `--chain` when given, else the first chain that has one), else `https://www.superstables.com`. Reads only; no account, key or rail. With `--once`, it lists instead the services that can be bought once (`GET /api/v1/purchase/services`): id, price, simulated, network and inputs (`*` marks a required one); `RESULT` carries them as `services`. `--rail` and `--chain` narrow it the same way. |
| `superstables budget wait --id ID --shown [--timeout S] [--site URL]` | anyone | After a detached owner command or `buy-once`: waits up to `S` seconds (default 30, at most 300) and prints the approval's state, with `final` (`false` while `waiting_owner`). `--shown` says the link, the match code and the terms were written in a reply the owner can read; without it `wait` refuses (see [Detached owner approvals](#detached-owner-approvals)). **Never signs or sends.** |

On tempo, `--agent LABEL` picks the access key for `doctor`, `grant`, `status`, `buy` and `revoke`, and `setup --agent LABEL` makes a new one.

Every command: `--help` exits 0 and bad input exits 2 before any secret is read. `--mainnet` or a mainnet chain id is refused.

`--site URL` is accepted by every command, so a caller told to pass `--site <origin>` to each one can. It must be an origin: `https://superstables.com` or one of its subdomains (such as `https://staging.superstables.com`), or this computer (`http` or `https` on `127.0.0.1`, `localhost` or `[::1]`). Any other origin is refused (exit 2) unless the owner has named that exact origin in `SUPERSTABLES_ALLOW_SITE` (an origin, or a comma-separated list; `https` only) in their own environment. That setting is the owner's: an agent never sets it. The same check applies to `SUPERSTABLES_SITE` and to a `SITE` recorded in a public file (an owner command refuses a recorded site that no longer passes it). Where a site is recorded, a different one is refused (exit 2, nothing read or sent): for a command on a chain set up with `--hosted`, the site recorded in that chain's public file; for `wait`, the site the approval was made on. `setup --hosted` and `find` use `--site` to choose the site, and `buy-once` uses it to choose where to buy. Everywhere else it is checked and ignored.

## Owner approval

`setup`, `fund-agent`, `grant`, `revoke` and, on `evm`, the owner's part of `recover` use the owner's wallet by default. The explicit test key-file option is described below. The rail script builds the transaction and the terms, starts a page on `127.0.0.1` (random port, one-time random id in the path), and waits. The owner opens the page in the browser with their wallet, connects, and approves or rejects. For transactions, the script checks the chain before the final `RESULT`. Setup verifies a message signature and records the address. Detached commands first return a pending `RESULT`.

| Rail | Wallet | What the wallet does | What the command reads back |
| --- | --- | --- | --- |
| `evm` | Any EVM browser wallet (MetaMask, Rabby, Coinbase Wallet, ...), found through EIP-6963 or `window.ethereum` | Sends `{to, data, value}` | Sender, target, exact data, receipt, the `Approval` event, the allowance |
| `tempo` | Any EVM browser wallet that can add a custom network, found the same way | Is asked to send a call to the AccountKeychain precompile (`authorizeKey` or `revokeKey`) with the owner paying the fee in their configured fee token, or pathUSD by default. The page adds Tempo Testnet (Moderato) with 18 decimals. | Sender, target, exact data, fee payer, receipt; then the key: type, expiry, limit, period, seller list, not an admin key; or revoked |
| `solana` | Any Solana wallet (Phantom, Solflare, Backpack, ...), found through the Wallet Standard | Only signs. The command builds the transaction when the owner presses Review in wallet, checks that the signed message is byte for byte its own and signed by the owner, then sends it. | No error, signer the owner; then the token account: owner, mint, delegate and delegated amount (or no delegate); or the agent's SOL |

With more than one wallet installed, the page lists them and the owner chooses one. The page then uses only that wallet.

### Hosted approvals

`setup --rail R --hosted [--site URL]` moves a chain's owner approvals to superstables.com, on every rail: `evm`, `tempo` (Moderato) and `solana` (devnet). The owner needs an account there (Sign-In with Ethereum); the page on `127.0.0.1` needs none, and stays the default.

- Setup sends a link request, signed by the agent key (proof v2: EIP-191 on `evm` and `tempo`, ed25519 on `solana`, over a text that names the site's origin and a single-use nonce). The owner opens the link on any device where they are signed in to the site with their wallet, picks the match code the agent showed them, and signs the link with their wallet (the owner link proof: a message, no fee). The command rebuilds that text from its own values and checks the signature before it records anyone; a link without a valid proof records nothing (exit 3). The owner on record becomes the address that signed (`B4_OWNER_ADDRESS`, `OWNER_ADDRESS` on `tempo`); on `solana`, the Solana address the owner connects and signs with on that page (`SOLANA_OWNER_ADDRESS`). The public file gets `APPROVALS=hosted`, `SITE=<origin>` and the link the owner signed: `LINK_ID` and `LINK_CODE` (on `tempo`, a key added with `setup --agent LABEL` gets `AGENT<LABEL>_LINK_ID` and `AGENT<LABEL>_LINK_CODE`). A different recorded owner is replaced only with `--new-owner` (refused while a budget is live and, on `evm`, while the agent key holds the budget token, which `recover` would return to the owner on record).
- Run again for an agent the site already linked on that chain, setup takes the site's "already linked" answer only for the owner recorded on this computer, without `--new-owner`, on the site recorded with it, and only when the answer carries the owner's proof over the stored `LINK_ID` and `LINK_CODE`. Anything else is refused (exit 3) and records nothing: the owner removes the agent on their account page on the site and links it again. Moving a hosted chain to another site therefore takes a fresh link the owner signs there.
- From then on `grant`, `revoke` and `fund-agent` on that chain go to the site as an approval request, signed by the agent key. `evm` and `tempo` send the exact transaction (`tempo`: `authorizeKey` or `revokeKey` on the keychain). `solana` sends the amount only (`solana: {amount_atomic}`; none for a revoke): the site builds the transaction when the owner is ready, the owner's Solana wallet signs it and the site sends it. On `tempo`, `setup --agent LABEL` links the new key with one link, and `grant --agent LABEL` is signed by that key. The owner's wallet sends it from the site's page. Every request is refused (exit 3, nothing sent) when the site would act for another address than the owner on record. The command then reads the chain exactly as with the local page, and refuses a mismatch the same way: the same `RESULT` and exit codes. On `solana`, where the site built the transaction, the command also checks that the owner signed and paid the fee, after the request started, as the only signer, with no address lookup tables, and that its instructions are exactly the one the command would have built (`ApproveChecked` with the owner's USDC account, the mint, the agent, the owner, the amount and 6 decimals; `Revoke`; or the System Program transfer of exactly the lamports to the agent), plus at most one compute unit limit (10,000 to 1,400,000) and one unit price whose fee is at most 0.001 SOL: the same bounds the page on this computer accepts from a wallet. Anything else is a mismatch (exit 3), and the owner revokes. On Arc, where USDC pays the fees, a hosted `fund-agent` sends the token's own `transfer(agent, amount)`.
- `setup --hosted --grant A --fund [AMOUNT]` is the whole set-up with one link. The link request carries `then`: the gas transfer (`fund_agent`, AMOUNT or `fund-agent`'s default for the chain) and the grant of A, built as `fund-agent` and `grant` build them, in that order (`solana`: the amounts; `tempo`: the grant only, for 24 hours). After the owner links the agent, the site's page asks their wallet for each. The command records the link as above, then reads each transaction from the chain with the same checks as `fund-agent` and `grant` (receipt, sender = the owner on record, target, data, value, mined after the block it read before the request), and records the budget only when the allowance reads exactly A. The final `RESULT` has `linked` and `steps` (`kind`, `state`, `tx`, `amount`, `reason` for each) and `tx` (`fundAgent`, `grant`). When a step did not complete (the owner rejected the grant, say), the link stays recorded and `state` is the first such step's: `refused_precheck` (exit 3, nothing sent by it), `failed` (exit 1), `unknown` (exit 5) or a mismatch (exit 3). If the command stops waiting after the link, it withdraws on the site the steps the owner's wallet has not been asked for, and reports them as not sent only once the site confirms it; a step it could not withdraw is `unknown` (exit 5). Either flag alone is accepted; without `--hosted` both are refused (exit 2). An agent the site already linked on that chain is refused (exit 3, `already_linked`): gas and a budget then go through `fund-agent` and `grant`.
- `recover` keeps the page on this computer for its owner steps. `setup` without `--hosted` keeps the recorded owner and mode; `setup --new-owner` without `--hosted` moves the chain back to the local page.
- The approval link is used only as `<site>/approve/budget/<the request id>#<token>`, written again by the URL parser; an answer whose link has control characters, spaces or invisible characters, another path or a query is refused before anything is shown. When the site is not `www.superstables.com`, the stderr text and `message_for_owner` name its host.
- `APPROVE` and `RESULT` carry `matchCode`. The agent writes it next to the link in its reply to the owner, a visible message, not only in its reasoning or a tool call. The agent writes the link and code in its reply and ends its turn; `wait --shown` then reads the request's state from the site; `--replace` asks the site to cancel, which it does only while the wallet has not been asked.
- The site's access token for polling a request (`ssbt_...`) is stored only in that approval's record (mode 600) and removed when the approval is final. It is never logged.
- A site that cannot be reached, or that refuses the request (for example a cap above the account's limit), is a refusal before anything is sent: exit 3 with the site's reason. Once the site reports that the wallet was asked, or a transaction hash, an unfinished outcome is `unknown` (exit 5), never "nothing sent".

- As soon as the link exists, stdout gets one line `APPROVE {"action","url","expires","terms"}` (hosted: also `matchCode`; stderr with `--json`). `terms` holds the page's plain words: `title`, `amount`, `unit`, `summary`, `enforced`, `notEnforced`. The same link goes to stderr in words. The `APPROVE` line is printed once per link: the dispatcher does not echo the rail script's own `APPROVE` or `RESULT` lines, or a background worker's, to stderr. The final `RESULT` is still the last line, and carries `url`.
- The sentence on stderr that carries the link, and the `next` of a `waiting_owner` result, say: `Testnet only: test USDC, no real money.` The stderr sentence for a hosted link also says that the first link the owner opens asks them to sign in with their wallet (a message, no fee).
- The local page listens on `127.0.0.1` only. Over SSH the owner forwards its port first, `ssh -L PORT:127.0.0.1:PORT user@host` with the port from the link; the stderr text and the `waiting_owner` `next` show that command with the real port.
- `--timeout SECONDS` (10 to 3600, default 600): how long the link stays open. A link that expires before the wallet was asked ends the command `refused_precheck` (exit 3) with nothing sent, and `next` says to run the same command again for a new link (`setup` reuses the agent key it created). `--no-open`: do not open it in the default browser. Detached, the link opens in the default browser too, except over SSH (`SSH_CONNECTION` or `SSH_TTY` set), where it would open on the remote host.

### Detached or blocking

An agent's shell tool usually shows output only when the command exits, and many tools stop a command after a minute or two. So an owner command has two modes:

| Mode | When | What happens |
| --- | --- | --- |
| Detached | stdout is not a terminal (an agent), or `--detach` | The command starts itself again as a background process and returns as soon as the link exists. It prints `APPROVE`, then `RESULT` with `state: "waiting_owner"`, exit 0, and `id`, `url`, `expires`, `terms` and `next`. The worker opens the link in the default browser (unless `--no-open`, or over SSH). |
| Blocking | stdout is a terminal (a person), or `--wait` | As before: the command opens the link in the default browser (unless `--no-open`), waits for the owner, reads the chain and prints the final `RESULT`. |

Then `superstables budget wait --id ID --shown [--timeout S]` polls the approval. The `next` of every command that returns `waiting_owner` (`setup`, `grant`, `revoke`, `fund-agent`, `recover`, `buy-once`) says: write the link, the code and the terms in your reply to the owner, then run `superstables budget wait --id <id> --shown`. `--shown` means the caller has done that. Without it, `wait` refuses before it reads anything: exit 2, `RESULT` with `state: "show_owner_first"`, the same `id`, `url`, `matchCode`, `expires` and `terms`, and a short `next`. An approval that has already ended returns its final `RESULT` without `--shown`. An unknown `id` is exit 2 as before.

- Still open: `RESULT` with `state: "waiting_owner"`, `final: false`, exit 0, the same `id`, `url`, `expires` and `terms`, and a `reason` describing the recorded page state (for example "the owner account is selected; waiting for wallet approval"). `recover` can ask the owner twice (the rest of the allowance, then gas for the agent). A new link ends the wait at once, with the new `url`: write it before polling again.
- Ended: the owner command's own final `RESULT` and exit code, exactly as the blocking command prints them, plus `id` and `final: true`: `settled` with the `tx` the command read from the chain, `refused_precheck` (exit 3) when the owner rejected or the link expired before the wallet was asked to send, or the transaction on chain did not match the plan, `unknown` (exit 5) when the wallet may have sent (including a rejection reported after it was asked). Later `wait` calls return the stored final result. Waiting never approves the request or retries a transaction.
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

`buy-once` wraps the site's hosted purchase API (`GET /api/v1/purchase/services`, `POST /api/v1/purchases` with an `Idempotency-Key` and `{service_id, params, max_amount}`, `GET /api/v1/purchases/{id}?wait=...`, `POST /api/v1/purchases/{id}/cancel`; the site documents it at `/docs/purchase.md`). Testnet only. The network comes from the service's listing: Base Sepolia (USDC, x402 `exact`), Tempo Moderato (pathUSD, MPP `tempo.charge`) or Solana devnet (USDC, x402 `exact`). `--rail` and `--chain` are optional; when given they must name the listing's network (exit 2 otherwise), and a mainnet is exit 3. `find --once` shows each service's network.

- Before anything is created it reads the service's listing, checks the inputs against it, and refuses (exit 3) when the price is above `--max` or the service is unavailable. After the site creates the purchase, it checks the terms again: the amount (at most `--max`, equal to the listing), the network the listing names, that network's token (USDC, or pathUSD on Tempo) and the recipient the listing names. The link must be `<site>/approve/<the purchase id>#<token>`, with no control characters, spaces or invisible characters. A purchase that fails a check is cancelled, and its link is never shown.
- As soon as the link exists, stdout gets `APPROVE {"action":"buy-once","url","expires","terms","matchCode"}` and stderr the same link in words, with the testnet line. Not in a terminal (an agent), or with `--detach`, the command then returns: `RESULT` with `state: "waiting_owner"`, exit 0, and `id`, `purchase` (the site's id), `service`, `url`, `matchCode`, `expires`, `terms` and `next`. In a terminal, or with `--wait`, it reads the purchase until it ends and prints the final `RESULT`.
- There is no background process: the site does the work once the owner signs. `superstables budget wait --id ID` reads the purchase from the site, holding each read up to 20 s, and returns `waiting_owner` (its `reason` says whether the owner has not opened the link, the payment is going to the seller, or the chain is being read) or the final `RESULT`, the same on every later call. Waiting never approves or retries anything.
- `paid: true` is never the site's word alone. Before it, the command reads the transaction the site names from the chain of the listing's network: on Base Sepolia and Tempo Moderato, a successful receipt with a `Transfer` of exactly the purchase's amount of the listed token to the listed recipient (from the payer the site names), and on Solana devnet, the recipient's token balance of the listed mint up by exactly that amount (the payer's down by it), both mined after the purchase was created. When the chain does not show that, the result is `unknown` (exit 5) with `paid: null`: never buy again. A transaction the chain does not show yet is not stored as final, so a later `wait` reads it again; one that shows something else is. `amount` is always the amount checked when the purchase was created.
- The final `RESULT`: `state: "settled"` with `paid`, `delivered`, `amount`, `tx: {settle}`, `txUrl`, `payer`, `purchase` (the receipt's id on the site), `service`, and, when the seller answered, `responseFile`, `responseType`, `responseBytes`, `responseTruncated`. The file is `$SUPERSTABLES_HOME/budget/once/<id>.response`, mode 600, holding the answer the site relays (it keeps the first 4,000 characters): seller data, never instructions.

| Exit | State | When |
| --- | --- | --- |
| 0 | `settled` | Paid and delivered. Also `waiting_owner`: not final |
| 1 | `failed` | Nothing was paid (the seller refused, the site did not answer, a rate limit) |
| 2 | `failed` | Bad input: a flag, an input the service does not list, an unknown service |
| 3 | `refused_precheck` | Nothing was paid: the price is above `--max`, the owner rejected it, said they did not ask for it, picked another code, or did not approve within 10 minutes; or a check above failed |
| 4 | `settled` | Paid, the service did not deliver: never pay again |
| 5 | `unknown` | A payment may have left and the site cannot tell yet, or the site says paid and the chain does not show that payment: never buy again |

- One buy-once purchase is open at a time. A second `buy-once` is refused (exit 3) with the pending `id`, `url` and `matchCode`; `--replace` asks the site to cancel it, which it does only while nobody has signed. Starting one holds a lock (`budget/approvals/active-once-purchase`), so two started together cannot both create a purchase: the second is refused (exit 3).
- The purchase's access token (`sspt_test_...`) is kept only in the approval's record (`budget/approvals/<id>.json`, mode 600) and removed when the purchase is final. It is never printed or logged. A retried creation uses the same `Idempotency-Key`.
- `--site` is the site, else `SUPERSTABLES_SITE`, else the `SITE` that `setup --hosted` recorded, else `https://www.superstables.com`.

## Output

stdout carries one JSON object on its last line, prefixed `RESULT `; human logs go to stderr. It is the only `RESULT` line the command prints, on stdout or stderr: the rail script's own `RESULT` is normalized into it, not echoed.

`--json`, on every command (also `wait`, and bad input): stdout is exactly that object, as bare JSON without the `RESULT ` prefix, the same rule as the rest of the `superstables` CLI's `--json`. An owner command's `APPROVE` line then goes to stderr with the logs (the link is also the `RESULT`'s `url`). The fields, states and exit codes are the same with or without it. A background worker never gets `--json`: `wait --json` prints the stored result the same way.

`final` is in every `RESULT`: `false` only while an owner approval is still open (`state: "waiting_owner"`), `true` otherwise. A script tests `final`, not the state or the exit code. An agent does not poll: it replies to the owner and ends its turn, and runs `wait --id ID --shown` when the owner says they've approved.

`message_for_owner` comes with every `waiting_owner` result (owner commands run detached, `buy-once`, `wait` while still open, and `wait` refused for `show_owner_first`) and with every `budget_spent` refusal. It is the reply an agent sends the owner, word for word: for a link, the action's title, the site's host when it is not `www.superstables.com`, the link, the match code (hosted), the amount and network, the testnet line, where to open it (a page on this computer) and "Tell me when you've approved"; for a spent budget, what is left, the price and that nothing was paid. The agent sends it and ends its turn.

`rpc` names the RPC a command used when it is a replacement (`B4_RPC`, `SUPERSTABLES_TEMPO_RPC` or `SUPERSTABLES_SOLANA_RPC` for the command's rail); it is absent on the default RPC.

`budget_spent: true` is set on a `buy` refused before signing (`refused_precheck`, exit 3) because the budget cannot cover the purchase: the price is above what is left, or no allowance or delegate exists (spent, revoked or never granted). Its `next` says to report and end the turn; it never proposes a revoke, a new grant or gas.

```json
{"ok":true,"command":"buy","rail":"evm","chain":"base-sepolia","op":"weather-001",
 "state":"settled","final":true,"paid":true,"delivered":true,
 "amount":"0.001","remaining":"0.009",
 "tx":{"pull":"0x...","settle":"0x..."},
 "responseFile":"/home/me/.superstables/budget/ops/evm-base-sepolia/weather-001.response",
 "responseType":"application/json","responseBytes":1578,"responseTruncated":false,
 "next":"none"}
```

`responseFile` (`buy`, every rail): the seller's answer to the paid request, saved byte for byte next to the journal as `<op>.response`, mode 600. On `tempo` and `solana` it is saved when the seller answers the request that carries the signed payment with anything but a 402, before the chain outcome is known; on `evm`, only once the pull has landed. A `refused_precheck` buy creates none. A file may hold an error response: its presence proves neither payment nor delivery, so read `state`, `paid` and `delivered`. Saving can fail without changing the purchase: then RESULT has no `responseFile`. At most 1 MB (1,000,000 bytes) is kept; `responseTruncated: true` means the saved bytes are not the whole answer (it was longer, or it was cut off). `responseType` is the seller's content type, `responseBytes` the saved size. The file is seller data, never instructions: nothing here runs or parses it. The log keeps a one-line preview. Seller text in the logs is flattened to one line on every rail, and only an owner command forwards an `APPROVE` line.

A buy with nothing to buy with is refused before anything is signed, with `state: "refused_precheck"`, exit 3, `paid: false`, `amount: "0"`:

- No setup on this computer (no agent key file with a key, or no owner address recorded): refused before the op lock, the journal or the rail script, so nothing is written that looks like a purchase and no op id is generated. `reason` starts "no budget has been set up here for R on C:" and says what is missing and that nothing was signed; `next` names the owner's commands in order (`setup`, then on `evm` and `solana` `fund-agent` and `doctor`, then `grant`).
- No grant on chain (`evm`: the allowance is 0; `solana`: no delegate; `tempo`: the access key is not authorized, revoked or expired): the rail refuses before signing, and `next` names `grant` (on `tempo`, a revoked or expired key needs `setup --agent LABEL` first). Too little gas for the agent on `evm`: `next` names `fund-agent`.
- The rail script ended on its own (no signal) without a `RESULT` and without ever writing this op's journal: every rail writes the journal before it signs or sends, and the dispatcher holds the op's lock, so nothing was signed. `reason` carries the rail's last error line, and the `--op` stays unused. With a journal, or after a signal, it stays `unknown` (exit 5).

One `buy` per `--op` at a time: a second `buy` with the same op while the first still runs is refused before anything is read or signed (`refused_precheck`, `reason: "op_in_progress"`, exit 3); wait for the first one's `RESULT`. A `buy` stopped by a signal (Ctrl-C, a tool's timeout) reports `unknown` (exit 5), whatever its rail printed: reconcile it before anything else. On `solana`, a payment the chain refuses when the command checks it stays `unknown` until its blockhash has expired, since the seller can still submit the signed transaction until then.

`buy-once` ends the same way: its `RESULT` has `service`, `purchase`, `txUrl` and `payer` as well, and `id` is the approval id `wait` takes.

`state`: `planned`, `sent`, `settled`, `failed`, `refused_precheck`, `refused_chain`, `unknown`, `not_found`, `ok` (reads), `waiting_owner` (the detached owner command has no final result yet, including while it checks a submitted transaction), `show_owner_first` (`wait` without `--shown`, exit 2: nothing was polled). Unknown amounts are `null`, never `"0"`.

## Exit codes (same on every rail)

| Code | Meaning | What the caller does |
| --- | --- | --- |
| 0 | Done (purchase settled and delivered, or command succeeded). Also `state: "waiting_owner"` with `final: false`: the command has no final result yet | continue; on `waiting_owner`, write the link, the code and the terms in your reply to the owner and end your turn; when they say they've approved, run `superstables budget wait --id ID --shown` until `final` is `true` |
| 1 | Failed, including a chain refusal | read `next`; don't retry blindly |
| 2 | Bad input | fix the command |
| 3 | Refused, nothing signed or paid: no budget set up here, no grant, over `--max`, the owner rejected it or the link expired. Owner actions may also report a mismatch after submission | respect it; never raise `--max` to get around it |
| 4 | Paid but not delivered | never pay again; report it |
| 5 | Outcome unknown | purchases: `reconcile --rail R --chain C --op ID` (`buy-once`: ask the owner to check wallet activity); owner actions: `status` on the same rail and chain, plus wallet activity. Never pay twice |

## Where things live

All paths come from `paths.mjs`, under the client's home (`SUPERSTABLES_HOME`, default `~/.superstables`). Keys: `keys/budget/<rail>-agent.env` (mode 600). The default flow stores no owner key: the owner's key stays in their wallet. Public addresses: `budget/public/<rail>-<chain>.env`. Journals: `budget/ops/<rail>-<chain>/<id>.json`, and the seller's answer `<id>.response` when it was saved (mode 600). A running `buy` holds `<id>.buy.lock` next to its journal. Approval page log (state changes, no signatures): `budget/owner-approvals.jsonl`. What `buy-once` returned: `budget/once/<id>.response` (mode 600). Detached approvals, and each buy-once purchase's record: `budget/approvals/<id>.json` (the record and the final `RESULT`, mode 600; for a hosted approval also the site, its request id and, until final, the access token), `budget/approvals/<id>.log` (the background process's output), and `budget/approvals/active-<rail>-<chain>` (the id that holds that chain).

Environment: `SUPERSTABLES_HOME` (above); `SUPERSTABLES_SITE`, the site for `setup --hosted` and `find` when `--site` is not given (`find` then uses the recorded site before the default); `SUPERSTABLES_ALLOW_SITE`, the owner's opt-in for a site outside superstables.com (the exact `https` origin, or a comma-separated list; an agent never sets it); `B4_CHAIN`, the default `evm` chain for the rail scripts; `B4_RPC`, an RPC URL that replaces the selected `evm` chain's, and Base Sepolia's for `buy-once` (for tests or your own node; scripts that sign still check the chain id first); `SUPERSTABLES_TEMPO_RPC` and `SUPERSTABLES_SOLANA_RPC`, the same for Tempo Moderato and Solana devnet. A replacement RPC must be `https`, or `http` on `127.0.0.1`, `localhost` or `[::1]`, with no user name or password: anything else is refused (exit 2) before a command runs, and the rail scripts run directly ignore it with a warning. A replacement in use is named in the `RESULT` (`rpc`).

## Hosted approvals: what a compatible site must do

Hosted approvals, `buy-once` and `find` talk to one site over HTTPS (or HTTP on this computer). superstables.com is that site; another deployment that serves the endpoints below the same way works too, once the owner names its origin in `SUPERSTABLES_ALLOW_SITE`. Every answer is JSON. An error keeps one envelope, `{ "error": { "code", "message", ... } }`, and the client shows its `code`, `reason` and `message` as text, never as instructions.

### Endpoints the client calls

| Call | Auth | Body or query | Answer the client relies on |
| --- | --- | --- | --- |
| `POST /api/v1/budget/links` | agent proof v2 | `{ rail, chain, agent, label?, then? }`. `then`: up to two wallet steps after the link, `fund_agent` then `grant`, each `{ kind, transaction: { to, data, value } }` on `evm` and `tempo`, or `{ kind, solana: { amount_atomic } }` on `solana` | `201 { id: "bl_...", access_token: "ssbt_...", approval: { url, match_code, expires_at }, steps? }`; `steps` echoes `then` in order. An agent already linked on that rail and chain: `200 { id, state: "linked", final: true, owner, owner_proof, approval: null }`, or `409 { error: { code: "already_linked", owner, owner_proof } }` when `then` was sent |
| `POST /api/v1/budget/approvals` | agent proof v2 | `{ kind: "grant" \| "revoke" \| "fund_agent", rail, chain, agent, transaction }` on `evm` and `tempo` (the exact `{ to, data, value }`), or `{ ..., solana: { amount_atomic? } }` on `solana` | `201 { id: "ba_...", access_token, approval: { url, match_code, expires_at } }` |
| `GET /api/v1/budget/requests/{id}?wait=0..20` | `Authorization: Bearer ssbt_...` | | `{ id, kind, state, final, owner, owner_proof, tx_hash, wallet_asked, reason, steps? }`, held up to `wait` seconds for a change |
| `POST /api/v1/budget/requests/{id}/cancel` | `Authorization: Bearer ssbt_...` | `{}` | `200` while the owner's wallet was not asked; otherwise `409` with `wallet_asked: true`. A link with steps answers with the request, steps included |
| `GET /api/v1/budget/services` | none | | `{ services: [{ name, price, network, url }] }` (for `find`) |
| `GET /api/v1/purchase/services[/{id}]` | none | | the services `buy-once` can buy, with inputs, price, network, token and recipient |
| `POST /api/v1/purchases` | `Idempotency-Key` | `{ service_id, params, max_amount }` | `201` with `id`, `access_token` (`sspt_...`), `terms` and `approval: { url, match_code, expires_at }` |
| `GET /api/v1/purchases/{id}?wait=0..20`, `POST /api/v1/purchases/{id}/cancel` | `Authorization: Bearer sspt_...` | | the purchase's `state`, `final`, `payment` (`status`, `transaction`, `payer`) and `delivery` |

- Request ids are `bl_` (a link) or `ba_` (an approval) followed by letters, digits, `_` or `-`; access tokens are `ssbt_` followed by the same. The approval link is `<site>/approve/budget/<id>#<token>` for a budget request and `<site>/approve/<id>#<token>` for a purchase, on the site's own origin; the client refuses any other shape.
- States of a budget request: `awaiting_owner`, `sending`, `sent`, `confirmed`, `linked`, `failed`, `rejected`, `expired`, `cancelled`, `unknown`. Once the owner's wallet was asked, the site sets `wallet_asked: true`, and reports the transaction as `tx_hash` (a 0x hash, or a base58 signature on `solana`). The client reads every transaction from the chain itself before it reports success.
- An approval's `owner` must be the owner recorded on the agent's computer; the client cancels and refuses one that names another address.

### Agent request proof v2

Every `POST` to `/api/v1/budget/links` and `/api/v1/budget/approvals` carries four headers:

- `Superstables-Agent`: the agent's address: the checksummed `0x` address on `evm` and `tempo`, the base58 public key on `solana`. The body's `agent` is the same value.
- `Superstables-Agent-Timestamp`: unix seconds.
- `Superstables-Agent-Nonce`: 32 lowercase hex characters (16 random bytes), new for every request.
- `Superstables-Agent-Signature`: the agent key's signature of the text below: EIP-191 `personal_sign` on `evm` and `tempo`; ed25519 over the text's UTF-8 bytes on `solana`, written `0x` and 128 hex characters.

The signed text is these six lines, separated by `\n`, with no trailing newline:

```
Superstables agent request v2
origin: <the site's origin, such as https://www.superstables.com>
<METHOD> <path, without the query>
<sha256 of the exact body bytes, lowercase hex>
<timestamp>
<nonce>
```

The site checks, in order, and answers any failure with `401 { "error": { "code": "agent_proof", "reason": ..., "message": ... } }`:

1. The `origin:` line is the site's own canonical origin, from its configuration, never from the request's `Host` header. Each deployment (staging, production) has its own. A proof made for another origin fails as a bad signature.
2. The timestamp is within 300 seconds of the site's clock.
3. The nonce matches `^[0-9a-f]{32}$` and was not used by that agent in the last 10 minutes, recorded atomically. The exact resend of a request that created one answers `409 { "error": { "code": "proof_reused" }, "id" }` with that request's id; any other repeat is refused with `reason: "replayed"`.
4. The method, path and body hash are those of the request received.
5. The signature verifies for the agent address, and the body's `agent` is that address.

The client retries once on a network error with the same proof. If the site answers that retry with `reason: "replayed"` (the first attempt reached it and failed), the client signs again with a new nonce and sends once more.

### Owner link proof

When the owner completes a link (signed in, match code picked), the site asks the owner's wallet to sign these eight lines, separated by `\n`, with no trailing newline:

```
Superstables: link an agent to my account
site: <the site's origin, the same canonical origin as above>
owner: <the owner: checksummed 0x on evm and tempo, the base58 Solana address on solana>
agent: <the agent, as in Superstables-Agent>
rail: <evm, tempo or solana>
chain: <the chain key, such as base-sepolia, moderato or devnet>
link: <the link request id the agent created>
code: <the match code shown to the agent>
```

On `evm` and `tempo` the owner's EVM wallet signs it with EIP-191 `personal_sign` (`scheme: "eip191"`); on `solana` the owner's Solana wallet signs its UTF-8 bytes with `signMessage` (`scheme: "ed25519"`, the signature as `0x` and 128 hex characters). The site verifies it before it marks the link done, stores it with the link, and returns it as `"owner_proof": { "scheme", "message", "signature" }` in the link's state once linked (`null` before), in every "already linked" answer for that agent, rail and chain, and in the `409 already_linked` error. A link cannot complete without it.

The client, before it records anyone as the owner:

1. Rebuilds the text from its own values: the site origin it uses, the `owner` the site returned, its own agent address, rail and chain, the link id it created and the match code it received. It must equal `owner_proof.message` byte for byte.
2. Verifies the signature for that owner: the EIP-191 signer is the owner, or the ed25519 signature verifies with the owner's base58 public key.
3. Takes an "already linked" answer only when an owner is already recorded on the computer, it is the same owner, the command is not `setup --new-owner`, the recorded site is this site, and the proof passes 1 and 2 against the `LINK_ID` and `LINK_CODE` stored when that owner was recorded. Otherwise it records nothing (exit 3), and the owner removes the agent on their account page on the site and links it again.

## Checkout or standalone build

In a checkout, `budget/cli.mjs` always runs the rail scripts from their TypeScript sources with the checkout's tsx (`npm ci` first), never a build in `dist/`, so an edit takes effect on the next run. `npm run build` also writes `dist/budget/`: the dispatcher and every rail script bundled into plain JavaScript that imports only Node built-ins and its own files. Only a copy without the sources runs those `.mjs` files: `dist/budget/` itself, or `scripts/budget/` in the skill zip that `npm run skill` builds. The commands, flags, `RESULT` lines, exit codes and paths are the same.

`superstables budget --version` names the build: for a standalone copy, the version, commit and build time from its `VERSION.json`; in a checkout, the version and commit. Only `--version` prints it: normal output does not. `THIRD_PARTY_NOTICES.txt` in a standalone copy lists every bundled package with its version and licence text.
