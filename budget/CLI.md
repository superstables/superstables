# `superstables budget` CLI contract

One command for the budget rails. `superstables budget` is a thin dispatcher over the rail scripts, which follow `CONTRACT.md`. It normalizes their `RESULT` lines into one shape. Testnet only.

| `--rail` | Path | Chains (`--chain`) | Implementation |
| --- | --- | --- | --- |
| `evm` | plain approve, pull then pay | `base-sepolia` (default), `arc-testnet`, `arbitrum-sepolia`, `polygon-amoy`, `skale-base-sepolia` | `evm/` |
| `tempo` | access key, MPP charge | `moderato` | `tempo/` |
| `solana` | SPL delegate, x402 | `devnet` | `solana/` |

## Commands

| Command | Role | Does |
| --- | --- | --- |
| `superstables budget setup --rail R [--chain C]` | owner | Creates the agent key file if it is missing (never overwrites it). The owner connects their wallet on the approval page and signs a free sign-in message. Writes the public file. Prints the next steps. No owner key is created. `tempo`: also tops up the owner from the Moderato faucet when it holds less than 1 pathUSD, and `--agent LABEL` adds a new agent key (no page). |
| `superstables budget fund-agent --rail evm\|solana [--amount A]` | owner | One plain transfer from the owner's wallet to the agent, approved on the approval page. `evm`: the chain's gas token; the default amount comes from the chain table. `solana`: SOL for fees, default 0.01. `tempo` has none: the agent needs no gas. |
| `superstables budget doctor --rail R [--chain C]` | anyone | The agent key file (mode 600, no owner key in it), the public file (the owner's address), RPC, balances. Prints what to top up at which address. No transactions. No rail has an owner key file to check. |
| `superstables budget preflight --rail evm --url U [--chain C]` | anyone | Reads the seller's 402 (x402 v2 header or v1 body) and prints its offer on the chain: price, token, `payTo`, network, scheme, x402 version. `RESULT` carries `amount` (the price), `payTo` and `offer`. The price is the seller's ask, not a ceiling: `next` leaves `--max` to the caller. A seller on another chain fails, and `next` names the `--chain` it offers. Also checks the RPC and the token. **Never signs or sends**; opens no key file. |
| `superstables budget grant --rail R --amount A [--expiry ISO] [--period S] [--sellers a,b]` | owner | Prints the terms (cap, true maximum, what the chain enforces and what it doesn't). The owner approves it on the approval page. Refuses constraints the rail can't enforce (`evm` and `solana`: `--expiry`, `--period`, `--sellers`). |
| `superstables budget status --rail R` | anyone | Remaining budget, expiry, revoked, funds at risk. No secrets. |
| `superstables budget buy --rail R --url U --max M [--pay-to ADDR] [--op ID] [--method M --body JSON]` | agent | One purchase under the budget. `--method` and `--body` are for tempo and solana. On `evm`, the seller's answer to the paid request is saved as a file (see Output). |
| `superstables budget reconcile --rail R --op ID` | anyone | Reads the chain for an operation. **Never signs or sends.** |
| `superstables budget recover --rail evm [--op ID]` | owner | EVM only: stop the allowance first, then return stranded funds. The agent key signs its own steps; the owner approves on the approval page only what the agent cannot do (the rest of the allowance, gas for the agent). |
| `superstables budget revoke --rail R` | owner | Ends the budget on chain. The owner approves it on the approval page. |
| `superstables budget wait --id ID [--timeout S]` | anyone | After a detached owner command: waits up to `S` seconds (default 30, at most 300) and prints the approval's state. **Never signs or sends.** |

On tempo, `--agent LABEL` picks the access key for `doctor`, `grant`, `status`, `buy` and `revoke`, and `setup --agent LABEL` makes a new one.

Every command: `--help` exits 0 and bad input exits 2 before any secret is read. `--mainnet` or a mainnet chain id is refused.

## Owner approval

`setup`, `fund-agent`, `grant`, `revoke` and, on `evm`, the owner's part of `recover` use the owner's wallet by default. The explicit test key-file option is described below. The rail script builds the transaction and the terms, starts a page on `127.0.0.1` (random port, one-time random id in the path), and waits. The owner opens the page in the browser with their wallet, connects, and approves or rejects. For transactions, the script checks the chain before the final `RESULT`. Setup verifies a message signature and records the address. Detached commands first return a pending `RESULT`.

| Rail | Wallet | What the wallet does | What the command reads back |
| --- | --- | --- | --- |
| `evm` | EIP-1193, for example MetaMask | Sends `{to, data, value}` | Sender, target, exact data, receipt, the `Approval` event, the allowance |
| `tempo` | EIP-1193, for example MetaMask | Is asked to send a call to the AccountKeychain precompile (`authorizeKey` or `revokeKey`) with the owner paying the fee in their configured fee token, or pathUSD by default. The page adds Tempo Testnet (Moderato) with 18 decimals. | Sender, target, exact data, fee payer, receipt; then the key: type, expiry, limit, period, seller list, not an admin key; or revoked |
| `solana` | Wallet Standard, for example Phantom | Only signs. The command builds the transaction when the owner presses Review in wallet, checks that the signed message is byte for byte its own and signed by the owner, then sends it. | No error, signer the owner; then the token account: owner, mint, delegate and delegated amount (or no delegate); or the agent's SOL |

- As soon as the link exists, stdout gets one line `APPROVE {"action","url","expires","terms"}`. `terms` holds the page's plain words: `title`, `amount`, `unit`, `summary`, `enforced`, `notEnforced`. The same link goes to stderr. The final `RESULT` is still the last line, and carries `url`.
- `--timeout SECONDS` (10 to 3600, default 600): how long the link stays open. `--no-open`: do not open it in the default browser.

### Detached or blocking

An agent's shell tool usually shows output only when the command exits, and many tools stop a command after a minute or two. So an owner command has two modes:

| Mode | When | What happens |
| --- | --- | --- |
| Detached | stdout is not a terminal (an agent), or `--detach` | The command starts itself again as a background process and returns as soon as the link exists. It prints `APPROVE`, then `RESULT` with `state: "waiting_owner"`, exit 0, and `id`, `url`, `expires`, `terms` and `next`. The browser is not opened. |
| Blocking | stdout is a terminal (a person), or `--wait` | As before: the command opens the link in the default browser (unless `--no-open`), waits for the owner, reads the chain and prints the final `RESULT`. |

Then `superstables budget wait --id ID [--timeout S]` polls the approval:

- Still open: `RESULT` with `state: "waiting_owner"`, exit 0, the same `id`, `url`, `expires` and `terms`, and a `reason` describing the recorded page state (for example "the owner account is selected; waiting for wallet approval"). `recover` can ask the owner twice (the rest of the allowance, then gas for the agent). A new link ends the wait at once, with the new `url`.
- Ended: the owner command's own final `RESULT` and exit code, exactly as the blocking command prints them, plus `id`: `settled` with the `tx` the command read from the chain, `refused_precheck` (exit 3) when the owner rejected or the link expired, `unknown` (exit 5) when the wallet may have sent. Later `wait` calls return the stored final result. Waiting never approves the request or retries a transaction.
- The background process ended without a `RESULT` (killed, or the machine restarted): `refused_precheck` (exit 3) when its last page log has no recorded submission, else `unknown` (exit 5).
- An unknown id exits 2.

Run one owner command at a time per rail and chain. A tracked pending approval causes another command to be refused (exit 3). Do not use another terminal or client home to start a parallel approval. Its `RESULT` carries the pending `id` and `url`, and `next` says to run `wait --id`. `--replace` checks the page state, stops the pending worker and starts a replacement. Use it only at the owner's request, after cancelling any wallet prompt. It cannot cancel a transaction already submitted. The stopped one then ends as `refused_precheck` with a reason that names the new id.

The background worker has a timeout. The page expires its link after `--timeout`. A wallet that was asked to send gets 2 more minutes to report the hash, and the chain reads are bounded. A backstop stops the process after `--timeout` plus 9 minutes, with `unknown` (exit 5). The timeout runs without `wait`. It does not cancel a wallet request or a submitted transaction.
- A rejection or expiry before recorded submission returns `state: "refused_precheck"`, exit 3. This code alone does not prove that no transaction was submitted. The wallet was asked to send but no hash came back: `state: "unknown"`, exit 5; read `status` before trying again.
- The chain shows something other than the plan (on `evm` an allowance other than the cap, because the owner edited the spending cap in the wallet; on `tempo` another limit, expiry or seller list; on `solana` another delegate or amount): `refused_precheck`, exit 3; revoke it.
- `solana`: a wallet that changed the transaction (another amount, an added instruction) gets nothing sent. The page says so and stays open; the command logs the program ids the wallet added. A transaction the owner signed after its blockhash expired (about a minute) is not sent either: request a fresh transaction with Review in wallet only after the command confirms it did not submit the old one. Any error from the wallet's sign call ends the link as a rejection.
- `--yes` without `--owner-key-file` exits 2, on every rail.
- Tests and automation only: `--owner-key-file PATH` (mode 600) with `--yes` signs with that key file instead. `setup --owner-key-file PATH` records its address.

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

`state`: `planned`, `sent`, `settled`, `failed`, `refused_precheck`, `refused_chain`, `unknown`, `not_found`, `ok` (reads), `waiting_owner` (the detached owner command has no final result yet, including while it checks a submitted transaction). Unknown amounts are `null`, never `"0"`.

## Exit codes (same on every rail)

| Code | Meaning | What the caller does |
| --- | --- | --- |
| 0 | Done (purchase settled and delivered, or command succeeded). Also `state: "waiting_owner"`: the command has no final result yet | continue; on `waiting_owner`, show the link and run `superstables budget wait --id ID` until the state is final |
| 1 | Failed, including a chain refusal | read `next`; don't retry blindly |
| 2 | Bad input | fix the command |
| 3 | Refused; owner actions may report a mismatch after submission | respect it; never raise `--max` to get around it |
| 4 | Paid but not delivered | never pay again; report it |
| 5 | Outcome unknown | purchases: `reconcile --rail R --chain C --op ID`; owner actions: `status` on the same rail and chain, plus wallet activity. Never pay twice |

## Where things live

All paths come from `paths.mjs`, under the client's home (`SUPERSTABLES_HOME`, default `~/.superstables`). Keys: `keys/budget/<rail>-agent.env` (mode 600). The default flow stores no owner key: the owner's key stays in their wallet. Public addresses: `budget/public/<rail>-<chain>.env`. Journals: `budget/ops/<rail>-<chain>/<id>.json`, and on `evm` the seller's answer `<id>.response` (mode 600). Approval page log (state changes, no signatures): `budget/owner-approvals.jsonl`. Detached approvals: `budget/approvals/<id>.json` (the record and the final `RESULT`, mode 600), `budget/approvals/<id>.log` (the background process's output), and `budget/approvals/active-<rail>-<chain>` (the id that holds that chain).
