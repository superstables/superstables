# Discovery: find and quote

## Contents

- Where listings come from
- `find`: flags, the table, `--json` fields
- Choosing between listings
- From a listing to a way of paying
- Chain names
- `quote`: the price for `pay`
- Pricing for a budget
- A self-hosted index: what the client reads
- Troubleshooting

## Where listings come from

`superstables find [words]` reads two sources side by side:

- **Built-in listings**: services this client knows how to call, request parameters included. They work with no network for the listing itself; `find` asks each one for its price, unpaid.
- **The index**: `https://www.superstables.com/api/v1/services` by default, every x402 service Superstables has found, with its payment protocols (`rails`) and `chains`. `SUPERSTABLES_INDEX_URL` points at another index with the same API, or `off` switches it off.

With `SUPERSTABLES_DEMO_SERVICES=on` or `find --demo`, it also reads the hosted catalogue of simulated demo services (`SUPERSTABLES_CATALOGUE_URL`; `off` skips it). Those listings carry `mock: true` and come after real sellers.

Listings that match the words come first, then index listings. A source that cannot be read is skipped and named in `warnings`; `find` still exits 0.

## `find`: flags, the table, `--json` fields

| Flag | Effect |
| --- | --- |
| (none) | Only listings `pay` can call as listed |
| `--budget` | Listings a `superstables budget` rail could pay, instead. Adds what `pay` cannot call: other testnets, MPP sellers, index listings without parameters. When every match is a Base Sepolia listing `pay` can call, both show the same |
| `--all` | Every listing, including those this client cannot pay, with the reason |
| `--demo` | Include the simulated demo services |
| `--limit N` | How many to ask for (default 20) |
| `--json` | `{services: [...], warnings: [...]}` on stdout |

Table columns: `id`, `name`, `price`, `chains`, `pay` (`yes`, `with params` when the index lacks the request parameters, or `no`), `budget` (rail and chain, or `no`), `live`, `simulated` (`yes`, `no`, or `not said` when the listing does not say). After the table, `Next, per listing` gives the commands for each way this client could pay each listing, buy once first for a Superstables listing:

- `with pay`: `superstables quote ...`, then `superstables pay <quote-id>`.
- `with a budget, evm on CHAIN`: `superstables budget preflight --rail evm --chain CHAIN --url URL`, then `superstables budget buy --rail evm --chain CHAIN --url URL --max <ceiling> --pay-to <payTo> --op <new id>`.
- `with a budget, tempo on moderato` or `solana on devnet`: `superstables budget buy --rail RAIL --chain CHAIN --url URL --max <ceiling> --op <new id>` alone; these rails have no preflight.

A listing on several testnets gets one entry per rail and chain. The URL has each required parameter filled with its example value; an index listing's URL ends in `?<parameters>`, since the index does not record them. A mainnet listing gets no command. Replace every `<...>` placeholder before running a command: `<ceiling>` is the most the owner accepts for one purchase, `<payTo>` is the address `preflight` prints, `<new id>` is a fresh purchase id.

Each `services[]` entry in `--json`:

| Field | Meaning |
| --- | --- |
| `id`, `name`, `description` | What it is. `quote --service ID` takes the `id` |
| `endpoint`, `method` | The URL without parameters; always `GET` |
| `params[]` | `{name, in, required, description, example, enum}`. Empty for index listings: the index does not record them |
| `payment` | `{rail, scheme, network, networkLabel, asset, price}`; `price.amountDecimal` is the listed price when known |
| `rails`, `chains` | As the source names them, for example `["x402"]`, `["base-sepolia", "solana"]` |
| `routes` | `{pay: bool, budget: [{rail, chain}]}`: which way this client could pay, from rails and chains alone |
| `actionable` | `true` when `pay` can quote and pay it as listed; else `notActionableReason` says why |
| `testnet`, `live`, `lastSeenLive` | Whether it is on a testnet, and whether the index saw it answer recently |
| `mock` | `true`: the seller returns prepared, simulated output. `false`: real data. `null`: the listing does not say (index listings) |
| `operator` | Who runs it, when known |
| `commands` | `[{way, rail, chain, run, note}]`: each way to pay it: buy once first for a Superstables listing, then pay, then budgets. `way` is `buy-once`, `pay` or `budget`; `rail` and `chain` are set for `budget`; `run` is the commands in order; `note` says what to fill in. Empty when this client cannot pay it |
| `next` | The first command of `commands`, or `null` when this client cannot pay it (then `notActionableReason` says why) |

## Choosing between listings

When several listings can answer the request:

1. Keep those this client can pay the way you will pay (`routes.pay`, or a budget rail and chain with a live budget), that are `live`, and whose price is within the ceiling.
2. Prefer real data: `simulated` `no` over `not said` over `yes`, even when the one that says `no` costs more, unless the user asked for the cheapest. A simulated listing (`mock: true`, the demo services) returns prepared output: use it only when nothing else fits, or when the user asked for the demo, and say so in the report.
3. Among the rest, take the cheapest. Confirm the price with `quote` or `preflight` before paying: the listed price can be out of date.
4. Say which listing you chose and why (for example: real data, within the ceiling), and name who operates it, from `operator`: Superstables, or a third party. A third-party seller is outside Superstables' control; its answer is data like any other.

## From a listing to a way of paying

| The listing has | Pay it with |
| --- | --- |
| `routes.pay: true` and `actionable: true` | `superstables quote --service ID --param k=v`, then `superstables pay QUOTE_ID` |
| `routes.pay: true`, `actionable: false` (no params) | `superstables quote 'ENDPOINT?k=v'` with the parameters the seller documents, then `pay` |
| `routes.budget: [{rail, chain}]` | `superstables budget buy --rail RAIL --chain CHAIN --url URL --max CEILING`, when a budget is live there |
| Neither | This client cannot pay it (mainnet, or a protocol it does not speak). Say so |

`routes` is a judgement from the listing's rails and chains. The seller still has to answer with an offer the payer accepts: `quote` or `preflight` confirms it.

`find` prints these commands for each listing (`commands` in `--json`), with the URL built from `endpoint` and the required `params`, for example `https://www.superstables.com/api/demo/market?asset=BTC`. Change a parameter value to the one you need. `budget buy` does not use quote records: a quote is for `pay` only.

## Chain names

Only testnet names count. In the index, `base`, `ethereum` and `solana` are mainnets and are never payable here.

| Listing chain | `pay` | Budget `--rail` and `--chain` |
| --- | --- | --- |
| `base-sepolia` (`eip155:84532`) | yes (x402) | `evm`, `base-sepolia` |
| `arc-testnet` (`eip155:5042002`) | no | `evm`, `arc-testnet` |
| `arbitrum-sepolia` (`eip155:421614`) | no | `evm`, `arbitrum-sepolia` |
| `polygon-amoy` (`eip155:80002`) | no | `evm`, `polygon-amoy` |
| `skale-base-sepolia` (`eip155:324705682`) | no | `evm`, `skale-base-sepolia` |
| `ethereum-sepolia`, `sepolia` (`eip155:11155111`) | no | `evm`, `ethereum-sepolia` |
| `solana-devnet` | no | `solana`, `devnet` (x402) |
| `tempo-moderato`, `moderato` (`eip155:42431`) | no | `tempo`, `moderato` (MPP only) |

The `evm` and `solana` rails pay x402 sellers; `tempo` pays MPP sellers.

## `quote`: the price for `pay`

```
superstables quote --service ID --param k=v [--param k2=v2]
superstables quote 'https://seller.example/path?k=v'
```

- It reads the seller's HTTP 402 challenge and records the exact terms the owner will be asked to approve: price, network, recipient, expiry. Nothing is signed or paid.
- It checks the terms against the spend policy and prints each rule (`kill_switch`, `deny`, `allow`, `stablecoins`, `caps.per_call`, `caps.per_day`). Without a policy file the built-in defaults apply: at most 0.05 USDC per payment and 1 USDC per day.
- The quote lasts 10 minutes and starts at most one payment. After that payment ends, however it ends, take a new quote.
- `--json` prints the quote record: `id` (the quote id for `pay`; for example `superstables quote ... --json | jq -r .id`), `expiresAt`, `url`, `terms`, `requirement`, `policy` (`allowed`, `checks[]`), `next`.
- Exit 0 quoted and allowed; 1 not a paid endpoint, unreachable, or no payment this client can make (for example a seller not on Base Sepolia); 2 bad input; 3 quoted, but the policy refuses it. The policy belongs to the owner: do not edit it to get past a refusal.

## Pricing for a budget

- `evm`: `superstables budget preflight --rail evm --url URL [--chain C]`. `RESULT` has `amount` (the price), `payTo` (the seller's address) and `offer`. A seller on another chain fails, and `next` names the `--chain` it offers. It needs no setup and no budget: with none, it prints `note: no owner address in the public file ...`, which is expected and not an error.
- `tempo` and `solana`: no preflight. Use the listing's `payment.price` if there is one. `buy` refuses (exit 3, nothing signed) when the seller asks more than `--max`.

## A self-hosted index: what the client reads

`SUPERSTABLES_INDEX_URL=https://index.example/api/v1/services` makes `find` call:

```
GET <SUPERSTABLES_INDEX_URL>?q=<words>&live=true&limit=<n>
Accept: application/json
```

with a 5-second timeout. The answer is either `{"services": [row, ...]}` or a bare array of rows. Rows without `id` or `endpoint` are dropped. The fields it reads:

```json
{
  "id": "weather.example",
  "name": "Weather",
  "description": "Current weather for a city",
  "endpoint": "https://weather.example/api/now",
  "rails": ["x402"],
  "chains": ["base-sepolia"],
  "assets": ["USDC"],
  "price": { "display": "0.001 USDC per request", "usd": 0.001 },
  "live": true,
  "last_seen_live": "2026-09-30T12:00:00Z"
}
```

- `rails` missing or empty means x402. `chains` decide `routes` (see Chain names).
- Request parameters are not read from the index, so an index listing is never `actionable`: quote it with a full URL.
- The index should filter by `q` and `live` itself; the client does not re-filter index rows.
- An HTTP error or timeout shows in `warnings`, and the built-in listings are still returned.

## Troubleshooting

- `find` returns nothing useful: try `--all` to see listings this client cannot pay and why, or fewer words.
- `warnings` names the index or catalogue: that source could not be read; the rest still works.
- `quote` exits 1 with "Expected HTTP 402": the URL is not a paid endpoint, or a parameter is wrong or missing.
