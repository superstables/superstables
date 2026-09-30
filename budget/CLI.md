# `superstables budget` CLI contract

One command for the budget rails. Simple on purpose: `superstables budget` is a thin dispatcher over the rail scripts, which follow `CONTRACT.md`. It normalizes their `RESULT` lines into one shape. Testnet only.

| `--rail` | Path | Chains (`--chain`) | Implementation |
| --- | --- | --- | --- |
| `evm` | plain approve, pull then pay | `base-sepolia` (default), `arc-testnet`, `arbitrum-sepolia`, `polygon-amoy`, `skale-base-sepolia` | `evm/` |
| `tempo` | access key, MPP charge | `moderato` | `tempo/` |
| `solana` | SPL delegate, x402 | `devnet` | `solana/` |

## Commands

| Command | Role | Does |
| --- | --- | --- |
| `superstables budget setup --rail evm [--chain C]` | owner | Creates the agent key file if it is missing (never overwrites it). The owner connects their wallet on the approval page and signs a free sign-in message. Writes the public file. Prints the next steps. |
| `superstables budget fund-agent --rail evm [--amount GAS]` | owner | One plain transfer of the chain's gas token from the owner's wallet to the agent, approved on the approval page. The default amount comes from the chain table. |
| `superstables budget doctor --rail R [--chain C]` | anyone | Key files (mode 600, owner and agent split), public file, RPC, balances. Prints what to top up at which address. No transactions. On `evm` there is no owner key file to check: it checks the agent file and the owner's address in the public file. |
| `superstables budget grant --rail R --amount A [--expiry ISO] [--period S] [--sellers a,b]` | owner | Prints the terms (cap, true maximum, what the chain enforces and what it doesn't). `evm`: the owner approves it on the approval page. `tempo` and `solana`: sends only with `--yes`. Refuses constraints the rail can't enforce (`evm` and `solana`: `--expiry`, `--period`, `--sellers`). |
| `superstables budget status --rail R` | anyone | Remaining budget, expiry, revoked, funds at risk. No secrets. |
| `superstables budget buy --rail R --url U --max M [--pay-to ADDR] [--op ID] [--method M --body JSON]` | agent | One purchase under the budget. `--method` and `--body` are for tempo and solana. |
| `superstables budget reconcile --rail R --op ID` | anyone | Reads the chain for an operation. **Never signs or sends.** |
| `superstables budget recover --rail evm [--op ID]` | owner | EVM only: stop the allowance first, then return stranded funds. The agent key signs its own steps; the owner approves on the approval page only what the agent cannot do (the rest of the allowance, gas for the agent). |
| `superstables budget revoke --rail R` | owner | Ends the budget on chain. `evm`: the owner approves it on the approval page. `tempo` and `solana`: sends only with `--yes`. |

On tempo, `--agent LABEL` picks the access key for `doctor`, `grant`, `status`, `buy` and `revoke`.

Every command: `--help` exits 0 and bad input exits 2 before any secret is read. `--mainnet` or a mainnet chain id is refused.

## Owner approval on evm

`setup`, `fund-agent`, `grant`, `revoke` and the owner's part of `recover` never sign with a key on this machine. The rail script builds the transaction and the terms, starts a page on `127.0.0.1` (random port, one-time random id in the path), and waits. The owner opens the page in the browser with their wallet (EIP-1193, for example MetaMask), connects, and approves or rejects. The script then reads the transaction from the chain (sender, target, exact data, receipt, `Approval` event, allowance) before it prints `RESULT`.

- As soon as the link exists, stdout gets one line `APPROVE {"action","url","expires"}`. The same link goes to stderr. The final `RESULT` is still the last line, and carries `url`.
- `--timeout SECONDS` (10 to 3600, default 600): how long the link stays open. `--no-open`: do not open it in the default browser.
- The owner rejects, or the link expires: `state: "refused_precheck"`, exit 3, nothing sent. The wallet was asked to send but no hash came back: `state: "unknown"`, exit 5; read `status` before trying again.
- The chain shows an allowance other than the cap (the owner edited the spending cap in the wallet): `refused_precheck`, exit 3, the budget is not recorded; revoke it.
- `--yes` on `evm` without `--owner-key-file` exits 2.
- Tests and automation only: `--owner-key-file PATH` (mode 600) with `--yes` signs with that key file instead. `setup --owner-key-file PATH` records its address.

## Output

stdout carries one JSON object on its last line, prefixed `RESULT `; human logs go to stderr.

```json
{"ok":true,"command":"buy","rail":"evm","chain":"base-sepolia","op":"weather-001",
 "state":"settled","paid":true,"delivered":true,
 "amount":"0.001","remaining":"0.009",
 "tx":{"pull":"0x...","settle":"0x..."},
 "next":"none"}
```

`state`: `planned`, `sent`, `settled`, `failed`, `refused_precheck`, `refused_chain`, `unknown`, `not_found`, `ok` (reads). Unknown amounts are `null`, never `"0"`.

## Exit codes (same on every rail)

| Code | Meaning | What the caller does |
| --- | --- | --- |
| 0 | Done (purchase settled and delivered, or command succeeded) | continue |
| 1 | Failed, including a chain refusal | read `next`; don't retry blindly |
| 2 | Bad input | fix the command |
| 3 | Refused before anything was signed | respect it; never raise `--max` to get around it |
| 4 | Paid but not delivered | never pay again; report it |
| 5 | Outcome unknown | run `superstables budget reconcile --op ID`; never pay again |

## Where things live

All paths come from `paths.mjs`, under the client's home (`SUPERSTABLES_HOME`, default `~/.superstables`). Keys: `keys/budget/<rail>-agent.env`, and `<rail>-owner.env` for `tempo` and `solana` only (mode 600). Public addresses: `budget/public/<rail>-<chain>.env`. Journals: `budget/ops/<rail>-<chain>/<id>.json`. Approval page log (state changes, no signatures): `budget/owner-approvals.jsonl`.
