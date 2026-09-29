# `superstables budget` CLI contract

One command for the budget rails. Simple on purpose: `superstables budget` is a thin dispatcher over the rail scripts, which follow `CONTRACT.md`. It normalizes their `RESULT` lines into one shape. Testnet only.

| `--rail` | Path | Chains (`--chain`) | Implementation |
| --- | --- | --- | --- |
| `evm` | plain approve, pull then pay | `base-sepolia` (default), `arc-testnet` | `evm/` |
| `tempo` | access key, MPP charge | `moderato` | `tempo/` |
| `solana` | SPL delegate, x402 | `devnet` | `solana/` |

## Commands

| Command | Role | Does |
| --- | --- | --- |
| `superstables budget doctor --rail R [--chain C]` | anyone | Key files (mode 600, owner and agent split), public file, RPC, balances. Prints what to top up at which address. No transactions. |
| `superstables budget grant --rail R --amount A [--expiry ISO] [--period S] [--sellers a,b] [--yes]` | owner | Prints the terms (cap, true maximum, what the chain enforces and what it doesn't). Only sends with `--yes`. Refuses constraints the rail can't enforce (`evm` and `solana`: `--expiry`, `--period`, `--sellers`). |
| `superstables budget status --rail R` | anyone | Remaining budget, expiry, revoked, funds at risk. No secrets. |
| `superstables budget buy --rail R --url U --max M [--pay-to ADDR] [--op ID] [--method M --body JSON]` | agent | One purchase under the budget. `--method` and `--body` are for tempo and solana. |
| `superstables budget reconcile --rail R --op ID` | anyone | Reads the chain for an operation. **Never signs or sends.** |
| `superstables budget recover --rail evm [--op ID] [--yes]` | owner | EVM only: revoke first, then return stranded funds. Prints the plan; sends only with `--yes`. |
| `superstables budget revoke --rail R [--yes]` | owner | Ends the budget on chain. Prints the plan; sends only with `--yes`. |

On tempo, `--agent LABEL` picks the access key for `doctor`, `grant`, `status`, `buy` and `revoke`.

Every command: `--help` exits 0 and bad input exits 2 before any secret is read. `--mainnet` or a mainnet chain id is refused.

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

All paths come from `paths.mjs`, under the client's home (`SUPERSTABLES_HOME`, default `~/.superstables`). Keys: `keys/budget/<rail>-owner.env` and `<rail>-agent.env` (mode 600). Public addresses: `budget/public/<rail>-<chain>.env`. Journals: `budget/ops/<rail>-<chain>/<id>.json`.
