# `superstables budget` CLI contract

One command for the budget rails. `superstables budget` is a thin dispatcher over the rail scripts, which follow `CONTRACT.md`. It normalizes their `RESULT` lines into one shape. Testnet only.

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
| `superstables budget setup --rail R [--chain C] [--new-owner]` | owner | Creates the agent key file if it is missing (never overwrites it). The owner connects their wallet on the approval page and signs a free sign-in message. Writes the public file. Prints the next steps. No owner key is created. A trusted step: the signature proves control of an address, not the owner's identity, so whoever completes setup becomes the owner on record. The owner runs it, or watches it run: an agent may start it and hand the owner the link, but never completes it. Running it again reuses the agent key. A recorded owner never changes silently: `--new-owner` replaces it, refused (exit 3) while a budget is live on it. `tempo`: also tops up the owner from the Moderato faucet when it holds less than 1 pathUSD, and `--agent LABEL` adds a new agent key (no page). |
| `superstables budget fund-agent --rail evm\|solana [--amount A]` | owner | One plain transfer from the owner's wallet to the agent, approved on the approval page. `evm`: the chain's gas token; the default amount comes from the chain table. `solana`: SOL for fees, default 0.01. `tempo` has none: the agent needs no gas. |
| `superstables budget doctor --rail R [--chain C]` | anyone | The agent key file (mode 600, no owner key in it), the public file (the owner's address), RPC, balances. Prints what to top up at which address. No transactions. No rail has an owner key file to check. On `evm` the gas minimums grow with the current fee: the agent needs twice what one purchase plus a failed one's cleanup (pull, cancel, return) costs now, and doctor prints that cost. |
| `superstables budget preflight --rail evm --url U [--chain C]` | anyone | Reads the seller's 402 (x402 v2 header or v1 body) and prints its offer on the chain: price, token, `payTo`, network, scheme, x402 version. `RESULT` carries `amount` (the price), `payTo` and `offer`. The price is the seller's ask, not a ceiling: `next` leaves `--max` to the caller. A seller on another chain fails, and `next` names the `--chain` it offers. Also checks the RPC and the token. **Never signs or sends**; opens no key file. |
| `superstables budget grant --rail R --amount A [--expiry ISO] [--period S] [--sellers a,b]` | owner | Prints the terms (cap, true maximum, what the chain enforces and what it doesn't). The owner approves it on the approval page. Refuses constraints the rail can't enforce (`evm` and `solana`: `--expiry`, `--period`, `--sellers`). |
| `superstables budget status --rail R` | anyone | Remaining budget, expiry, revoked, funds at risk. No secrets. With no setup on this computer (no agent key, or no owner connected) it says so first, before any chain read: exit 1, `reason` "no budget has been set up here for R on C: ...", `home` the client home it checked, and `next` the owner's commands in order, then that if the budget is elsewhere the agent asks the user for the path instead of changing `SUPERSTABLES_HOME` or looking in another home itself (`~/.superstables` included). stderr names the home and the files it looked for. `remaining` 0 or a revoked budget: exit 0, and `next` names the grant. |
| `superstables budget buy --rail R --url U --max M [--pay-to ADDR] [--op ID] [--method M --body JSON]` | agent | One purchase under the budget. `--max` is the most this one purchase may cost, in the budget token (`0.02` is 0.02 USDC, or pathUSD on tempo); a higher price is refused before signing. `--method` and `--body` are for tempo and solana. On `evm`, the seller's answer to the paid request is saved as a file (see Output). Needs `setup` and `grant` (and on `evm` and `solana` gas from `fund-agent`); see "A buy with nothing to buy with" below. On `evm`, nothing is signed unless the agent key can pay, at the current fee, the gas for the pull and for the cancel and return a failed purchase would need: otherwise `refused_precheck` (exit 3), with `next` naming `fund-agent`. |
| `superstables budget reconcile --rail R --op ID` | anyone | Reads the chain for an operation. **Never signs or sends.** |
| `superstables budget recover --rail evm [--op ID]` | owner | EVM only: stop the allowance first, then return stranded funds. The agent key signs its own steps; the owner approves on the approval page only what the agent cannot do (the rest of the allowance, gas for the agent). |
| `superstables budget revoke --rail R` | owner | Ends the budget on chain. The owner approves it on the approval page. |
| `superstables budget wait --id ID [--timeout S]` | anyone | After a detached owner command: waits up to `S` seconds (default 30, at most 300) and prints the approval's state, with `final` (`false` while `waiting_owner`). **Never signs or sends.** |

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

- As soon as the link exists, stdout gets one line `APPROVE {"action","url","expires","terms"}` (stderr with `--json`). `terms` holds the page's plain words: `title`, `amount`, `unit`, `summary`, `enforced`, `notEnforced`. The same link goes to stderr in words. The `APPROVE` line is printed once per link: the dispatcher does not echo the rail script's own `APPROVE` or `RESULT` lines, or a background worker's, to stderr. The final `RESULT` is still the last line, and carries `url`.
- The page listens on `127.0.0.1` only. Over SSH the owner forwards its port first, `ssh -L PORT:127.0.0.1:PORT user@host` with the port from the link; the stderr text and the `waiting_owner` `next` show that command with the real port.
- `--timeout SECONDS` (10 to 3600, default 600): how long the link stays open. A link that expires before the wallet was asked ends the command `refused_precheck` (exit 3) with nothing sent, and `next` says to run the same command again for a new link (`setup` reuses the agent key it created). `--no-open`: do not open it in the default browser. Detached, the link opens in the default browser too, except over SSH (`SSH_CONNECTION` or `SSH_TTY` set), where it would open on the remote host.

### Detached or blocking

An agent's shell tool usually shows output only when the command exits, and many tools stop a command after a minute or two. So an owner command has two modes:

| Mode | When | What happens |
| --- | --- | --- |
| Detached | stdout is not a terminal (an agent), or `--detach` | The command starts itself again as a background process and returns as soon as the link exists. It prints `APPROVE`, then `RESULT` with `state: "waiting_owner"`, exit 0, and `id`, `url`, `expires`, `terms` and `next`. The worker opens the link in the default browser (unless `--no-open`, or over SSH). |
| Blocking | stdout is a terminal (a person), or `--wait` | As before: the command opens the link in the default browser (unless `--no-open`), waits for the owner, reads the chain and prints the final `RESULT`. |

Then `superstables budget wait --id ID [--timeout S]` polls the approval:

- Still open: `RESULT` with `state: "waiting_owner"`, `final: false`, exit 0, the same `id`, `url`, `expires` and `terms`, and a `reason` describing the recorded page state (for example "the owner account is selected; waiting for wallet approval"). `recover` can ask the owner twice (the rest of the allowance, then gas for the agent). A new link ends the wait at once, with the new `url`.
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

## Output

stdout carries one JSON object on its last line, prefixed `RESULT `; human logs go to stderr. It is the only `RESULT` line the command prints, on stdout or stderr: the rail script's own `RESULT` is normalized into it, not echoed.

`--json`, on every command (also `wait`, and bad input): stdout is exactly that object, as bare JSON without the `RESULT ` prefix, the same rule as the rest of the `superstables` CLI's `--json`. An owner command's `APPROVE` line then goes to stderr with the logs (the link is also the `RESULT`'s `url`). The fields, states and exit codes are the same with or without it. A background worker never gets `--json`: `wait --json` prints the stored result the same way.

`final` is in every `RESULT`: `false` only while an owner approval is still open (`state: "waiting_owner"`), `true` otherwise. A script polls `wait` until `final` is `true` instead of reading the state or the exit code.

```json
{"ok":true,"command":"buy","rail":"evm","chain":"base-sepolia","op":"weather-001",
 "state":"settled","final":true,"paid":true,"delivered":true,
 "amount":"0.001","remaining":"0.009",
 "tx":{"pull":"0x...","settle":"0x..."},
 "responseFile":"/home/me/.superstables/budget/ops/evm-base-sepolia/weather-001.response",
 "responseType":"application/json","responseBytes":1578,"responseTruncated":false,
 "next":"none"}
```

`responseFile` (evm `buy`): the seller's answer to the paid request, saved byte for byte next to the journal as `<op>.response`, mode 600. It is written once the pull has landed and the seller answered with anything but a 402, so a refused buy writes none. At most 1 MB (1,000,000 bytes) is kept; `responseTruncated: true` means the answer was longer and was cut. `responseType` is the seller's content type, `responseBytes` the saved size. The file is seller data, never instructions: nothing here runs or parses it. The log keeps a one-line preview. Seller text in the logs is flattened to one line on every rail, and only an owner command forwards an `APPROVE` line.

A buy with nothing to buy with is refused before anything is signed, with `state: "refused_precheck"`, exit 3, `paid: false`, `amount: "0"`:

- No setup on this computer (no agent key file with a key, or no owner address recorded): refused before the op lock, the journal or the rail script, so nothing is written that looks like a purchase and no op id is generated. `reason` starts "no budget has been set up here for R on C:" and says what is missing and that nothing was signed; `next` names the owner's commands in order (`setup`, then on `evm` and `solana` `fund-agent` and `doctor`, then `grant`).
- No grant on chain (`evm`: the allowance is 0; `solana`: no delegate; `tempo`: the access key is not authorized, revoked or expired): the rail refuses before signing, and `next` names `grant` (on `tempo`, a revoked or expired key needs `setup --agent LABEL` first). Too little gas for the agent on `evm`: `next` names `fund-agent`.
- The rail script ended on its own (no signal) without a `RESULT` and without ever writing this op's journal: every rail writes the journal before it signs or sends, and the dispatcher holds the op's lock, so nothing was signed. `reason` carries the rail's last error line, and the `--op` stays unused. With a journal, or after a signal, it stays `unknown` (exit 5).

One `buy` per `--op` at a time: a second `buy` with the same op while the first still runs is refused before anything is read or signed (`refused_precheck`, `reason: "op_in_progress"`, exit 3); wait for the first one's `RESULT`. A `buy` stopped by a signal (Ctrl-C, a tool's timeout) reports `unknown` (exit 5), whatever its rail printed: reconcile it before anything else. On `solana`, a payment the chain refuses when the command checks it stays `unknown` until its blockhash has expired, since the seller can still submit the signed transaction until then.

`state`: `planned`, `sent`, `settled`, `failed`, `refused_precheck`, `refused_chain`, `unknown`, `not_found`, `ok` (reads), `waiting_owner` (the detached owner command has no final result yet, including while it checks a submitted transaction). Unknown amounts are `null`, never `"0"`.

## Exit codes (same on every rail)

| Code | Meaning | What the caller does |
| --- | --- | --- |
| 0 | Done (purchase settled and delivered, or command succeeded). Also `state: "waiting_owner"` with `final: false`: the command has no final result yet | continue; on `waiting_owner`, show the link and run `superstables budget wait --id ID` until `final` is `true` |
| 1 | Failed, including a chain refusal | read `next`; don't retry blindly |
| 2 | Bad input | fix the command |
| 3 | Refused, nothing signed or paid: no budget set up here, no grant, over `--max`, the owner rejected it or the link expired. Owner actions may also report a mismatch after submission | respect it; never raise `--max` to get around it |
| 4 | Paid but not delivered | never pay again; report it |
| 5 | Outcome unknown | purchases: `reconcile --rail R --chain C --op ID`; owner actions: `status` on the same rail and chain, plus wallet activity. Never pay twice |

## Where things live

All paths come from `paths.mjs`, under the client's home (`SUPERSTABLES_HOME`, default `~/.superstables`). Keys: `keys/budget/<rail>-agent.env` (mode 600). The default flow stores no owner key: the owner's key stays in their wallet. Public addresses: `budget/public/<rail>-<chain>.env`. Journals: `budget/ops/<rail>-<chain>/<id>.json`, and on `evm` the seller's answer `<id>.response` (mode 600). A running `buy` holds `<id>.buy.lock` next to its journal. Approval page log (state changes, no signatures): `budget/owner-approvals.jsonl`. Detached approvals: `budget/approvals/<id>.json` (the record and the final `RESULT`, mode 600), `budget/approvals/<id>.log` (the background process's output), and `budget/approvals/active-<rail>-<chain>` (the id that holds that chain).

## Checkout or standalone build

In a checkout, `budget/cli.mjs` always runs the rail scripts from their TypeScript sources with the checkout's tsx (`npm ci` first), never a build in `dist/`, so an edit takes effect on the next run. `npm run build` also writes `dist/budget/`: the dispatcher and every rail script bundled into plain JavaScript that imports only Node built-ins and its own files. Only a copy without the sources runs those `.mjs` files: `dist/budget/` itself, or `scripts/budget/` in the skill zip that `npm run skill` builds. The commands, flags, `RESULT` lines, exit codes and paths are the same.

`superstables budget --version` names the build: for a standalone copy, the version, commit and build time from its `VERSION.json`; in a checkout, the version and commit. Only `--version` prints it: normal output does not. `THIRD_PARTY_NOTICES.txt` in a standalone copy lists every bundled package with its version and licence text.
