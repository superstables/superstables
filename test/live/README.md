# Live testnet checks

`npm run test:live` checks the real Tempo Moderato MPP and Solana devnet x402
sellers used in the budget quickstarts. Unpaid checks need no wallet. Each
asserts the expected price, token, network and recipient. A seller outage or
changed terms fails the check. Normal `npm test` excludes this directory.

Paid checks require a separate opt-in home for each rail:

| Variable | Check | Test tokens spent per successful run |
| --- | --- | --- |
| `SUPERSTABLES_LIVE_TEMPO_HOME` | QuickNode MPP, Tempo Moderato | 0.001 pathUSD; the seller sponsors network fees |
| `SUPERSTABLES_LIVE_SOLANA_HOME` | Urban Game Theory oracle, Solana devnet | 0.01 USDC, plus devnet SOL if the agent pays fees |
| `SUPERSTABLES_LIVE_HOME` | Existing Base Sepolia local-wallet approval test | 0.01 USDC |

Unset variables skip the corresponding paid checks. A configured budget home
must be an absolute path with a primary agent set up, funded and granted a
budget. A missing file, expired or revoked grant, insufficient budget or seller
failure fails the test. Use dedicated test wallets and homes, and run these
checks sequentially with no other purchases using those budgets.

For Tempo and Solana, follow the [budget quickstarts](../../budget/README.md)
with `SUPERSTABLES_HOME` set to your chosen test home on every setup, funding
and grant command. Tempo needs a one-time limit without period refills and an
expiry long enough for the run. Solana needs devnet USDC in the owner's account
and a delegate allowance for the primary agent; fund the agent's devnet SOL as
described in the quickstart. The test only uses the agent key and public state.
It does not create a grant, read an owner key, or revoke the budget.

```sh
# Both paid budget checks, plus their unpaid preflights:
SUPERSTABLES_LIVE_TEMPO_HOME="$HOME/.superstables-live-tempo" \
SUPERSTABLES_LIVE_SOLANA_HOME="$HOME/.superstables-live-solana" \
npm run test:live

# One rail, using Vitest's test-name filter:
SUPERSTABLES_LIVE_TEMPO_HOME="$HOME/.superstables-live-tempo" \
npm run test:live -- -t tempo
```

Each paid budget check refuses a price above its ceiling and an unexpected
recipient, then makes one purchase. It checks delivery, the saved response,
the operation journal and an independent public RPC read of the transfer and
agent signer. It checks that the remaining budget falls by exactly the price,
then replays the operation ID and reconciles it: both must leave the budget
unchanged and reference the original transaction.
The Solana purchase uses the maximum supported 64-character operation ID to
check that its memo fits within the transaction's compute budget.

Operation IDs and transaction hashes are printed. Journals and responses remain
under the dedicated home's `budget/ops/` directory, including after failures.
An interrupted or unknown purchase may still settle: reconcile its printed ID
before another run. The suite refuses a new purchase while a previous live-test
journal remains submitted or unknown. It does not retry a payment or raise its ceiling when
a seller changes terms. Only read-only lookups are repeated for RPC indexing lag.

These checks depend on external sellers and public testnet RPCs. Keep them in
an opt-in or separate non-blocking lane; they are not part of the merge checks.
