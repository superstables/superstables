# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Testnet only.

### Upgrade and recovery

Seller URLs must be `https`, or `http` on this machine (`127.0.0.1`, `localhost` or `[::1]`). `quote`, `pay`, `budget buy` and `budget preflight` refuse anything else, including a URL with a user name or password. `pay` also refuses a quote recorded earlier for such a URL: quote the `https` URL again. `SUPERSTABLES_INDEX_URL`, `SUPERSTABLES_CATALOGUE_URL` and `SUPERSTABLES_DEMO_SERVICE_URL` follow the same rule.

Run `superstables policy show` to check your `policy.yaml`. A file with an unknown key, a `kill_switch` other than `true` or `false`, a single value where a list belongs or an unreadable amount now stops `quote` and `pay` until it is fixed; the error names the key. Caps must be plain decimals with at most six decimal places, such as `0.05`, `1` or `0.05 USDC`. A cap written as `0x10`, `1e3`, `.5`, `+1` or `-1`, or with more decimal places, or merged in with a YAML merge key (`<<`), counts as unreadable. An empty file, or a cap the file leaves out, now means the default cap (0.05 USDC per payment, 1 USDC per day), not no cap.

Your own `~/.superstables/policy.yaml` now applies as well when `SUPERSTABLES_POLICY`, `SUPERSTABLES_HOME` or `--home` selects another policy: a payment must pass both. If that file exists but can't be read, payments stop.

If a payment record's amount can't be read, today's total is now unknown, and the daily cap refuses every payment until the record is fixed. `superstables doctor` now also reports record lines it can't read at all. Those lines are skipped, so a payment on one is not shown and doesn't count toward the daily cap.

For SDK callers: `evaluatePolicy` now refuses a payment when the policy sets `caps.per_day` and no total for today is passed. Pass `spentTodayAtomic`, as `Records.spentTodayAtomic` returns it. Before, a missing total skipped the daily cap.

An EVM quote taken before this upgrade doesn't record the seller's authorization window, so `pay` ends it with `terms changed, quote again`. Quote again.

Before the client writes to its home folder (`~/.superstables`, or `SUPERSTABLES_HOME`), its payment records (`records/`) or the local wallet's folder (`wallet/`), it now checks that each one is a folder you own that no other user can write to. A folder other users can write to is refused, and the error names it: check what is in it, then run `chmod 700` on it. Under the home, a folder that is a symbolic link or belongs to another user is also refused, and one that other users can only read is set back to mode 700. The home folder itself may be a symbolic link, and its read permissions are left as they are.

The local wallet's agent token (`wallet/agent-token`) is now read only from a regular file that only you can read. If other users can read it, the token isn't sent, signing is refused and the error names the file: run `chmod 600` on it.

For scripts: a budget approval on superstables.com whose cancellation the site doesn't clearly confirm is now reported as `unknown` (exit 5) rather than cancelled. Read the chain before trying again.

`budget revoke` now sends its transaction every time it is asked on EVM chains and on Solana, even when the budget already reads empty, so the owner's wallet needs gas (SOL on Solana). For scripts: on Solana, an owner with no USDC account gets `revoked: null` and nothing is sent. On Tempo, revoke first simulates `revokeKey` for a key that reads revoked or never authorized; if that simulation can't be read, it answers `unknown` (exit 5) and sends nothing.

`budget recover` now asks the owner to sign `approve(agent, 0)` even when the allowance already reads 0, unless the agent's own revoke in the same run brought it to 0, so the owner's wallet needs gas. Without `--op`, recover sweeps nothing while any journal can't be read or any of the agent's operations can still move money: it lists them and answers `unknown` (exit 5). Check or reconcile each one, then run recover again. If a purchase's cancellation is mined but not yet final, its price stays in the agent key until a later `recover --op`.

EVM purchases that use the same agent key on the same chain now take turns. A second `budget buy` waits up to 10 minutes before it reads balances or signs, then is refused (exit 3) with nothing signed. `budget recover` waits up to 2 minutes. If the lock remains after every buy and recover on that key has stopped, the owner can clear it in their own terminal: run `superstables budget unlock --rail evm --chain CHAIN --agent-key --confirm` and type `agent-key`. If the client can't confirm that those processes have stopped, use `--confirm --unverified` and type `agent-key unverified`. Journals are kept.

`budget buy --rail evm` now refuses a seller whose authorization lifetime (`maxTimeoutSeconds`) is outside 30 to 600 seconds. The upper limit was 3,600. Such a purchase ends `refused_precheck` (exit 3) with nothing signed. `budget preflight` shows the accepted range.

On Arc Testnet, `budget buy` is now refused while an earlier purchase's price is still in the agent key (pulled, but not settled or returned in its journal), and while any journal for the chain can't be read. Run `superstables budget reconcile --rail evm --chain arc-testnet --op ID`. If the purchase is still not settled, the owner runs `superstables budget recover --rail evm --chain arc-testnet --op ID`.

For scripts: on EVM chains and Solana, `budget status` now reports an empty budget as `remaining: "0"`, `revoked: false` unless this machine recorded its revoke (see Security). A Solana budget revoked with an earlier version has no such record, so it now reads `revoked: false`.

For scripts: `budget buy`, `budget reconcile` and `budget recover --op` now answer `unknown` (exit 5) for a journal file that parses but isn't that operation's journal (see Security), and keep the file. Check the file and the agent's payments on chain, and don't pay again for that operation.

On Solana, `SUPERSTABLES_SOLANA_RPC` must point at Solana devnet. Otherwise `fund-agent`, `grant`, `revoke`, `buy`, and `setup` when it funds, grants or replaces a recorded owner, refuse (exit 3), and `status` reports that the budget could not be read.

On Tempo, `SUPERSTABLES_TEMPO_RPC` must point at Tempo Moderato. `budget buy` checks the RPC's chain id and otherwise refuses before signing, and `budget reconcile` keeps an undecided purchase `unknown`.

For scripts: Tempo `budget buy` has new refusal reasons, all given before anything is signed (exit 3): `machine_token`, `challenge_too_long`, `challenge_used`, `bad_split` and `bad_recipient`. `bad_challenge` now also covers a challenge with no id or realm, or with an expiry that isn't a date. After `challenge_used`, buy again with a new `--op`.

This upgrade doesn't repair Tempo purchase journals written by earlier versions. If the client sent the payment itself and no expiry was recorded, the purchase may stay `unknown`. A journal with neither a payment memo nor a transaction hash, for example from a seller challenge that named no realm, now stays `unknown`, and `budget reconcile` no longer reports it `not_found` once its expiry passes. Don't pay again on that basis.

### Added

- `superstables budget unlock --rail evm --agent-key` lets the owner clear the lock that EVM purchases on one agent key and chain take turns on (see Upgrade and recovery).
- SDK exports `toAtomicExact`, `fromAtomicString`, `CAP_DECIMALS`, `capUnits` and `policyAmount`, and `Records.spentTodayAtomic` and `Records.skippedLines`.
- `superstables owner settings sign` has the owner's wallet sign the owner settings, the spend policy and the retired agent keys; the local wallet's page has a card that does the same with its key. Signed settings apply only to approvals made with the wallet that signed them: `pay` and the local wallet refuse a policy file that differs from the signed one until the owner signs again, and the approval page shows who signed.

### Changed

- `attempts --json` and SDK attempts from `Records` and `PaymentEngine` no longer include the `runner` field. The `Attempt` type no longer includes it either. Attempt records on disk are unchanged.
- `evaluatePolicy` takes the payment as `amountAtomic` (a `bigint` in the token's smallest units) with `decimals`, and today's total as `spentTodayAtomic` (a `bigint` in millionths of the cap's unit). `policyAmount(terms)` gives the first two from a quote's terms. `amountDecimal` is now optional.
- `Money` has an `atomic` field, the cap in millionths as a whole-number string, which `parseMoney` and `parsePolicy` always set. A cap whose `amount` and `atomic` disagree refuses every payment it applies to. `parseMoney` accepts plain decimals with at most six decimal places.
- `toAtomic`, `fromAtomic`, `round6` and `Records.spentToday` round through floating point and are for display only. `Records.spentToday` returns `NaN` when the total can't be read.
- On EVM chains, `PaymentTerms` carries the seller's `maxTimeoutSeconds`, and `sameTerms` compares it.
- `ensureDir` now applies the private-folder check described under Upgrade and recovery. It throws, naming the folder, when one is not a folder you own that no other user can write to.

### Deprecated

- `evaluatePolicy`'s `amountDecimal` and `spentTodayDecimal`: pass `amountAtomic` and `spentTodayAtomic`. The decimal fields are read exactly at six decimals, and a value with more places is refused.

### Security

- On Solana, budget commands now check that the RPC is on Solana devnet before they fetch a blockhash, offer a transaction to the owner's wallet, sign or send. An RPC on another cluster, or one whose cluster can't be read, is refused with nothing sent. Before, a SOL transfer meant for devnet could be built and sent on another cluster, such as mainnet, through a replacement RPC.
- Every signature, wallet request and broadcast now passes through a separate chain check. `quote`, `pay`, the approval page, the local wallet and every budget rail refuse any chain whose table entry isn't marked as a testnet, and mainnet signing is switched off in this build. A budget command refuses with exit 3 before it reads a key file or the chain. Before, the client stayed on testnets only because no mainnet was in its chain tables. The check uses the client's own chain tables, not what an RPC reports.
- A budget approval on superstables.com counts as cancelled with nothing sent only when the site's answer confirms that request was cancelled, including its documented answer for a request already cancelled, and no answer, then or earlier, showed a wallet request, a transaction or money that may have moved. An empty, unreadable or contradictory answer, or none, is `unknown`. Before, any successful answer without a state counted as cancelled.
- `budget find` builds the command it suggests only from the client's own chain table, and quotes each word. Before, a crafted chain name in a listing could add a shell command to the suggestion.
- `budget preflight` now puts the seller's payee into the suggested `buy` command only when it is a valid address for that rail. `budget find` now names the chain keys this client knows, instead of asking the agent to copy values from a listing into a command. A listing's price note is cut to one short line. An index or catalogue answer that isn't JSON is reported in the client's own words. A budget command that stops on an RPC error now gives the RPC's reason, not Node's version line.
- Seller URLs outside this machine must be `https`: on plain `http`, anyone on the path can change the price and recipient and read the signed payment. `budget preflight` and discovery reads of the index and catalogue no longer follow redirects, and discovery answers are capped at 2 MB.
- A seller that answers with a redirect is now named as redirecting. When this happens before anything is signed, `pay` reports that nothing was sent. If the redirect answers the request that carried the signed payment, the payment stays `uncertain`, because the seller has received it and may still settle it.
- The spend policy is read strictly: a file that can't be read as written stops payments instead of counting as no rule, and another home or policy path no longer lifts a rule in your own `~/.superstables/policy.yaml`. Caps are read from the text as written, never from the number YAML makes of it, so `0x10` no longer counts as 16 or `1e3` as 1000. Host rules now match names with a trailing dot and in any letter case. The policy is still a check in this software: an agent running as you can edit the file.
- Spend caps, daily totals and payment amounts are compared as whole numbers of the token's smallest unit, not as floating-point numbers. A payment that brings the day's total exactly to the cap is allowed. Before, a third payment of 0.1 under a 0.3 daily cap was refused as over it, and very large amounts could pass a cap they exceeded. On the browser signer's path, totals and comparisons are exact from the payment records to the policy check. The local wallet adds up its own records in whole units, but it still passes its total and the payment's amount to the policy check as decimal numbers. From about 8.6 billion dollars upward, those can be off by one smallest unit or more.
- `budget revoke` sends its transaction every time it is asked, even when the budget already reads empty or revoked: `approve(agent, 0)` on EVM chains and the SPL `Revoke` on Solana. On Solana it skips the transaction only when the owner has no USDC account, and then reports `revoked: null`, not `true`. On Tempo, revoke checks a key that reads revoked or never authorized by simulating `revokeKey` from the owner. It skips the transaction only when the keychain refuses that simulation with `KeyAlreadyRevoked` or `KeyNotFound`. A simulation that can't be read gives `unknown` (exit 5), with nothing sent. When revoke sends a transaction, it reports `revoked` only after that transaction and a read that shows it. When the Tempo key reads revoked and the simulation is refused with one of those errors, revoke reports `revoked: true` with an empty `tx` and sends nothing. Before, a single read of 0, of no delegate or of a revoked key reported the budget revoked with nothing sent.
- `budget status` reports `revoked: true` only for a revoke this machine recorded that the chain still shows: on EVM chains an allowance of 0, on Solana no delegate, each with the revoke recorded here, and on Tempo the keychain's revoked flag. A new Solana grant or owner clears that record. Before, every empty EVM or Solana budget was reported as revoked.
- On EVM chains, a purchase's price goes back to the owner, after a failed `budget buy` or from `budget recover`, only once its payment authorization can no longer settle at a final block. That means it was never signed, was cancelled in a final block, or expired by a final block's time. A cancellation that is mined but not final leaves the price in the agent key and the outcome `unknown` (exit 5). Before, a cancellation that had just been mined was enough. Recovery amounts are exact token units, never floating point. Finality is read from the configured RPC.
- `budget recover` asks the owner for `approve(agent, 0)` unless the agent's own revoke in the same run brought the allowance to 0 and a later read shows 0. Before, one read of 0 skipped the owner's revoke. Without `--op`, recover now names the journals and operations that block its sweep (see Upgrade and recovery). That scan of the journal folder checks fewer fields than a named journal read, so it may not name every malformed journal that `budget buy`, `budget reconcile` or `recover --op` would refuse.
- Budget purchases refuse payment terms whose recipient is the zero address, the token contract, the agent or the owner. On EVM chains they also refuse an authorization lifetime that is missing, not a whole number of seconds, or outside 30 to 600 seconds. Before the pull, the client has the x402 library build the payment it would send and checks it against the option that passed these checks: the token's EIP-712 domain name and version, the other fields and the whole typed data. A mismatch is refused with nothing pulled, where before it could cost gas for a cancel and a return after the pull. That check lets the payment expire up to five seconds later than the offered timeout allows, as a clock tolerance. The purchase then signs only that option, and only once.
- EVM purchases and `budget recover` that use the same agent key on the same chain now take turns on this machine, so two of them can no longer read the same balance and sign the same nonce. Copies of the agent key on other machines are outside this lock.
- On Arc Testnet, where USDC also pays for gas, a price that an earlier purchase left in the agent key, or a journal that can't be read, now blocks a new purchase at any amount. Before, up to 2 USDC was treated as gas reserve. After a purchase, money that arrived in the agent key from outside, such as a seller refund, is reported in the output and the journal. A balance that no journal explains is still tolerated up to the 2 USDC reserve.
- `quote` and `pay` refuse an EVM payment request whose amount is zero, not a whole number of base units in canonical form, or 2^256 or more, or whose recipient is the zero address or the token contract.
- `pay` now signs an EVM authorization valid for at most 600 seconds, even when the seller allows up to an hour. The seller's requirement is sent back as offered. A quote records the seller's authorization window, and `pay` refuses a quote whose window has changed since. A request that a program sends to the local wallet directly, not through `pay`, is still signed for the window it names, up to an hour.
- `quote` and `pay` now refuse:
  - an EVM offer that asks for a transfer method other than EIP-3009, or whose `extra` holds anything other than the token's signing domain, its decimals and that method;
  - a Solana or Tempo payment to the all-zero address or to the token itself, as on EVM chains;
  - a Tempo challenge that turns on mppx's machine-token route.

  On any chain, the approval page on your machine refuses to prepare a payment whose recipient is the connected account. The local wallet doesn't make this check yet for requests sent to it directly.
- The `pay` approval page on your machine can no longer be framed by another site. It, the budget approval page and the local wallet's page send no referrer and are served with `nosniff`. Budget commands cap answers from superstables.com at 1 MB, and the chain reads that confirm a single purchase on superstables.com at 4 MB; a longer or cut-off answer counts as a failed read.
- Chain log searches on EVM chains (`status`, `budget reconcile` and the owner-page lookups) now start at each chain's known block range, 200 blocks on Base Sepolia. They narrow the window when an RPC refuses a range, and they read at most a day of blocks. A search that couldn't read every block it needed reports that the chain could not be read, never that nothing was paid. Before, Base Sepolia's RPC refused these searches, and `status` left such payments unchecked.
- More answers are now read only up to a fixed size: RPC and Tempo faucet answers to budget commands (4 MB, or 10 MB on EVM chains and 16 MB on Solana, where some reads return whole blocks), the budget approval page on your machine, a seller's `budget preflight` answer and its 402 answer in an EVM budget purchase (64 KB), the local wallet's answers, and the facilitator capability lists that `superstables doctor` reads (256 KB). A longer, cut-off or non-JSON answer counts as a failed read, never as an answer from the chain. On Tempo, `budget reconcile` searches at most 2,000,000 blocks for a purchase's memo. If the payment could have landed beyond that range, it answers `unknown`, never `not_found`.
- Tempo budget purchases check the seller's terms and the RPC before anything is signed. Malformed payment splits, splits that add up to the price or more, a split of 0, more than 10 splits, or a split memo that is not 32 bytes of hex are refused, and so is an RPC that does not answer Tempo Moderato's chain id. `budget reconcile` on Tempo no longer judges a purchase from an RPC on another chain; the purchase stays `unknown`.
- Tempo budget purchases now refuse three kinds of challenge: one that turns on mppx's machine-token route, one that names no realm (its payment could not be found on chain as this purchase's), and one that stays open for more than 600 seconds. Before signing, a purchase claims the challenge's payment memo on this machine. A challenge that another operation here has already used is refused. The payment that mppx signs is read back before it leaves the process, whether to the seller or to the RPC. It must make exactly the quoted pathUSD transfers and stay valid for at most 600 seconds.
- On Tempo, when the client sends the payment itself, the purchase journal records the signed transaction's hash and expiry before the broadcast begins. A purchase ends `failed` with nothing sent only when no broadcast began; after that, an error leaves it `unknown`, and `budget reconcile` can decide it from the recorded expiry and the chain. Before, such a purchase could stay `unknown` for good.
- A purchase journal now answers `unknown` (exit 5) when it exists but can't be read (including through a symlink loop or a directory the command can't enter), isn't valid JSON, or parses but isn't this operation's journal on its rail (it names another operation, or lacks a field that rail always writes). This applies in `budget buy`, `budget reconcile` and EVM `budget recover --op`, before anything is sent, and the file is kept. Before, such a journal could crash the command or count as no journal, and with the setup files missing one could be reported as a refusal with nothing paid.
- Text from sellers, listings and RPCs is cleaned more thoroughly in terminal and `--json` output. Every invisible formatting character, including Unicode tag characters, is removed, and control characters become spaces. This covers the listing, quote, attempt and receipt JSON, the reasons and notes the CLI prints, and the RPC and library errors that budget commands print, including revert reasons that an RPC sends as encoded data. An EVM budget script that crashes prints a single `error:` line. A Solana one prints its error on one line, and each program log entry after it starts with the fixed text `RPC log: `. Payment records and journals on disk keep what was received.
- Approval records are written through a randomly named temporary file opened exclusively, so a symlink planted at the old, predictable temporary name can no longer redirect the write.
- The approval page on your machine and the local wallet answer 404, not 500, to a request id with a malformed percent-escape.
- Payment records and quote claims are now flushed to disk, with their folder entries, before the client goes on. A payment's `submitting` line and the claim on its quote are therefore on disk before the signed payment leaves this machine, and a write that is cut short continues until the whole line is written. Where a platform or filesystem can't flush a folder, that step is skipped.
- The client checks its home, `records/` and `wallet/` folders before it writes to them, and reads the local wallet's agent token only from a private regular file (see Upgrade and recovery). Budget folders (`keys/budget/`, `budget/`) are created with mode 700 but aren't checked this way yet.
- `budget doctor` flags an owner key file that other users can read. The operation IDs the budget commands generate now carry 64 random bits. The budget approval page on your machine no longer sends internal error details to the browser in its 500 answer. They go to the command's error output instead.
- Pinned to exact versions: the runtime dependencies, the packages bundled into the budget engine, and the compiler and bundler that build the package. Four packages further down (`@noble/ciphers`, `@scure/base`, `@adraffy/ens-normalize`, and zod 3 under `@x402/core` and `@x402/evm`) can still resolve to a newer compatible version. The npm package and the skill zip each carry a CycloneDX SBOM (`dist/sbom.cdx.json`, `scripts/sbom.cdx.json`) of every package they install or bundle. That includes the bundled Solana and Tempo libraries, which `npm audit` in your project can't see. Builds are dated with the commit's time, and source maps are no longer shipped. In a checkout, `node scripts/repro-check.mjs` builds a commit twice, the way a release is built, and prints the checksums to compare with a published release. `npm run audit:shipped` checks the SBOM's packages against the registry's advisories, and refuses an SBOM with no components or a component without a path. The package is not published with npm provenance.

## [0.4.0] - Robinhood Chain Testnet and Sign in with Solana

Testnet only.

### Upgrade and recovery

The client now needs Node 22 or newer. Node 20 reached end of life on 30 April 2026 and is no longer supported.

Stop all older client processes, including agents, servers and approval processes, and upgrade every install before restarting.

Ordinary payment lock recovery now requires proof that its processes have stopped; unverifiable locks need an explicit owner override. Recovery also covers cap locks, approval locks and single-purchase runners. Agents must stop and ask the owner. Recovery keeps payment evidence; check the original payment next. See [owner recovery instructions](https://github.com/superstables/superstables/blob/v0.4.0/budget/CLI.md#operation-lock-recovery).

For `pay`, owners whose `policy.yaml` explicitly lists allowed stablecoins must add `USDG` if they want to allow it. Defaults include it.

For scripts that read exit codes: once a payment may have moved, or an owner's wallet was asked to send, the client answers `unknown` (exit 5) where it answered `waiting_owner` (exit 0), `failed` (exit 1) or `refused_precheck` (exit 3). An approval still open answers `unknown` with `final: false`, so test `final`, not the exit code. From then on, an owner command answers `failed` only with chain proof that its transaction did not take effect, named in the new `proof` field. Treat `unknown` as "do not pay again" and follow the next step the result names. See [exit codes](https://github.com/superstables/superstables/blob/v0.4.0/budget/CLI.md#exit-codes-same-on-every-rail).

### Added

- Budgets and Single purchase now support Robinhood Chain Testnet, `robinhood-testnet`, on your machine and on superstables.com, using Paxos test USDG. Budgets need ETH for gas; for single purchases, the seller or facilitator pays gas. `pay` caps count USDC, pathUSD and USDG together. See [Budgets](https://superstables.com/docs/client/budget).
- The client supports owners using Sign in with Solana on superstables.com. Solana accounts support only Solana agents, budgets and single purchases, using the wallet they signed in with. Signing in grants no spending authority. See [Single purchase](https://superstables.com/docs/client/buy-once).
- `quote --chain <chain>` selects that chain's offer. Quotes list other supported chains the seller offers; `pay` and suggested requotes keep the quoted chain.

### Fixed

- Refused purchase-status reads on superstables.com remain `unknown`, with `paid: null`. Resolve the account issue and check the original purchase; do not buy again. `--site https://superstables.com` now accepts the site's www approval links.
- Budget journal writes are now durable. Approval pages on your machine offer wallets public RPCs, keeping configured RPC access keys out of those offers. `SUPERSTABLES_TEMPO_RPC` now also applies to Tempo payments.
- Once a payment may have moved, `superstables receipts`, `superstables budget wait`, `superstables budget buy` and the approval page on your machine report it as unknown, never as unpaid, rejected or expired. On EVM chains, a pulled price that can no longer settle stays unknown until `superstables budget recover` returns it, including what is left after a partial return.
- When the owner's transaction differs from the plan, the approval page on your machine and the result's `reason` name what differs, such as the spender or the amount.
- On Solana, `superstables budget fund-agent` reports a transfer as done when its transaction moved the planned SOL, even if the agent's balance reads lower afterwards.

## [0.3.1] - Safer payment recovery

This release makes budget payments and single purchases on superstables.com safer to recover. Agents arriving from superstables.com's setup page are directed to approval there.

Testnet only.

Stop every 0.3.0 client process before upgrading, including agents, servers and approval processes.

On Linux, run commands sharing a client home either inside the same sandbox or outside it. Mixing the two can exceed the daily cap or misreport an approval as "abandoned"; do not pay again on that status alone. To clear a lock, the owner must first stop every process working on that operation, then run `superstables budget unlock --confirm` in their own terminal, outside any agent's sandbox.

- For scripts: the additive `chain_final` CLI and `chainFinal` SDK fields report chain finality. `final` and `verified` keep their 0.3.0 meanings. An included payment with provisional or legacy evidence can become uncertain again after a reorg; treat uncertain as "don't pay again". Established final proof stays final.

The installation docs cover `npm install -g @superstables/client`.

For cap accounting, chain evidence rules and recovery commands, see [`budget/CLI.md`](https://github.com/superstables/superstables/blob/v0.3.1/budget/CLI.md).


## [0.3.0] - Agent budgets and single purchases

Give an agent a budget to buy compatible services without approving each purchase. Approve the budget in your wallet, and revoke it by signing a transaction.

Testnet only: test tokens, no real money.

### Added

- Budgets on eight chains, with budget approvals on superstables.com or on your machine. Limits differ by chain. See [Budgets](https://superstables.com/docs/client/budget).

  | Chain | Approve on your machine | Approve on superstables.com |
  | --- | --- | --- |
  | Base Sepolia | Yes | Yes |
  | Arc Testnet | Yes | Yes |
  | Arbitrum Sepolia | Yes | Yes |
  | Polygon Amoy | Yes | Yes |
  | SKALE Base Sepolia | Yes | Yes |
  | Ethereum Sepolia | Yes | Yes |
  | Tempo Moderato | Yes | Yes |
  | Solana devnet | Yes | Yes |

- Single purchase on superstables.com, with wallet approval for each purchase and no budget or agent key required. Available on Base Sepolia, Arc Testnet, Solana devnet and Tempo Moderato. See [Single purchase](https://superstables.com/docs/client/buy-once).
- A standalone agent skill that includes the CLI. See [Installation](https://superstables.com/docs/client).

### Changed

- Single purchase on your machine (`pay`) expands from Base Sepolia to all eight supported chains. See [Single purchase](https://superstables.com/docs/client/buy-once).
- Unresolved payments remain uncertain until evidence resolves them, and count against the daily cap while they can still move money. See [Payment records](https://superstables.com/docs/client/records).
- Scripts need updates for changed exit codes, `status` and `find` JSON, and the `abandoned` outcome. Replace `wallet init --import-key` with `--import-key-file`. Approval links may use a different port; over SSH, forward the port shown. See [CLI reference](https://superstables.com/docs/client/cli).

### Security

- Added checks for approval requests, payment amounts, chain confirmation and key-file permissions. Budget authority differs by chain: on EVM and Solana, anyone holding the agent key can spend the remaining budget to any address. Read the [security model](https://superstables.com/docs/client/security).

## [0.2.0] - 2026-09-22

Discovery reads the hosted catalogue of prepared demo services and ranks matches by
relevance; the docs say where the Claude Desktop bundle comes from.

### Added

- **The hosted catalogue, behind a demo switch.** With `SUPERSTABLES_DEMO_SERVICES=on` (set by
  the Claude Desktop bundle, the demo setup snippets and `find --demo`), discovery also reads
  `https://www.superstables.com/api/demo/catalogue`, where the website publishes its prepared
  demo services with their request parameters, so a new demo service there reaches demo users
  without a client release. Off, the default, the catalogue is never read and no simulated
  listing appears. Simulated listings (`mock: true`) always come after the real sellers. The
  built-in listings stay authoritative for the ids they know and still work with no network. A hosted entry this release cannot pay (another network, no payout
  address configured) is listed with the reason. When the catalogue cannot be read, discovery
  carries on from the built-in listings and says so in `warnings`. `SUPERSTABLES_CATALOGUE_URL`
  points at another deployment; the empty string or `off` disables it. Listings gained two
  optional fields, `mock` (the seller says its output is prepared, simulated data) and
  `examplePrompts`. A hosted entry whose endpoint is not https (other than on this machine) is
  listed but not payable, with the reason.

### Changed

- **Ranking.** `find` and `find_services` now order catalogue matches by how well the words of
  the query match each listing's own id, name, description and parameters (stopwords ignored,
  word stems matched), put index listings after them, and reserve the demo vocabulary
  ("bitcoin", "price", "testnet"...) for the market data service alone, so a dozen prepared
  services no longer crowd out the index. The hosted catalogue and the index are read side by
  side, only the listings being returned are probed, in parallel, and a failed catalogue read
  is remembered for a minute rather than retried on every call. The CLI's `find` table gained a
  `simulated` column.
- The README and `docs/install.md` now say where the Claude Desktop bundle comes from: the
  `.mcpb` is never committed to the repository, users download it from the GitHub Release,
  where it is built from the exact tagged commit, and `npm run bundle` exists only to install
  an unreleased build from a checkout.

## [0.1.0] - 2026-09-18

The first release of the Superstables client: a TypeScript SDK, a local MCP server and a CLI
that let an agent find a service that charges per request, ask it what a call costs, and pay for
it — only after the owner has looked at the amount, the asset, the network and the recipient and
said yes.

The key stays where it already was. In the default mode that is MetaMask: the client serves an
approval page on `127.0.0.1`, the owner connects their wallet there, and MetaMask signs. The
agent can ask for a payment and can never approve one. This release is a testnet
demonstration — it pays in test USDC on Base Sepolia over [x402](https://x402.org) — so no real
money moves.

### The flow

- **Find.** List services that can be paid for, and say which ones the client can actually call
  and why the others cannot be.
- **Quote.** Read a service's HTTP 402 challenge and write down its exact terms. Free, and
  nothing is signed.
- **Approve.** `pay` stops and hands back an approval link. The page shows the amount, the
  asset, the network and the recipient, all derived from the seller's own payment requirement
  rather than from anything the agent said; what the agent claims the payment is *for* is shown
  separately and marked unverified. The owner approves in MetaMask, or in a local wallet
  process on a machine with no browser.
- **Pay.** A public facilitator submits the transfer and pays the gas, the service answers, and
  a receipt with the transaction hash is written.
- **Refuse.** A rejected payment — on the page or in MetaMask's own popup — signs nothing,
  submits nothing, and never calls the service. The agent is told so plainly.

### In pictures

Installing the Claude Desktop bundle and running `superstables setup`:

![Install](https://raw.githubusercontent.com/superstables/superstables-client/main/docs/images/0-install.png)

Claude Desktop asking permission before the agent uses a tool:

![Tool permissions](https://raw.githubusercontent.com/superstables/superstables-client/main/docs/images/1-permissions.png)

The approval page next to MetaMask's signature request, both showing the same payment:

![Approve in MetaMask](https://raw.githubusercontent.com/superstables/superstables-client/main/docs/images/2-approve.png)

The agent returning the service's answer and the transaction link:

![The result](https://raw.githubusercontent.com/superstables/superstables-client/main/docs/images/3-result.png)

### What is supported

x402 with the `exact` scheme, on Base Sepolia (`eip155:84532`), paying in USDC. Any other
scheme, network or asset is refused before the owner is asked to sign anything. There is no
mainnet switch and no unattended mode.

### Interfaces

Six MCP tools over stdio, for Claude Code, Claude Desktop or any other MCP client:

- `find_services` — search for payable services and say which are actionable
- `quote` — read a service's terms and record them; nothing is signed
- `pay` — ask the owner to approve a quote, return the `approval_url`, then pay and return the
  service's answer
- `payment_status` — wait for an attempt to finish and report where it got to
- `wallet_status` — which signer is in use, and its address, network, balance and policy, plus
  the `client_version` and `home` of the server that answered, so a host running an older build
  than the one just installed can be told apart from one running the new one
- `list_receipts` — the payments that settled on this machine

The `superstables` CLI does the same work from a terminal: `setup`, `doctor`, `find`, `quote`,
`pay`, `status`, `receipts`, `attempts`, `policy show` / `policy init`, `mcp`, `demo-service`,
and `wallet init` / `wallet serve` / `wallet status` for the local wallet. `superstables
--version` prints the version of the build that is running, `doctor` prints it and the home
directory above its checks, and the MCP server logs the same three facts to stderr on start.
The same code is published as a TypeScript SDK.

### Records and state

Every quote, attempt, approval and receipt is appended to JSONL files in `~/.superstables`, mode
0600, and nothing outside that directory is written. An attempt is an explicit state machine:
`awaiting_approval` → `denied`, `expired`, `failed`, or `approved` → `submitting` → `settled`,
`paid_service_failed`, `failed` or `uncertain`. `failed` means the money did not move and that
is known; `uncertain` means the credential left the machine and what became of it is not, and
the client never retries it automatically. A receipt exists exactly when money moved.

`policy.yaml` holds a per-payment cap, a daily cap, an allowed-host list and a kill switch.
These are checks in this software, on the owner's machine — not on-chain limits.

### Something to buy

Superstables hosts the demo seller, a real x402 market-data service on the testnet, so there is
something to pay for without anyone running a seller. The catalogue also lists a third-party
x402 service on Base Sepolia, run by an independent developer, so a payment to a seller nobody
at Superstables controls can be shown too. `superstables demo-service` runs the seller locally
for anyone who wants to watch that side of a payment.

### Claude Desktop bundle

`npm run bundle` builds `build/superstables-<version>.mcpb`, an MCP bundle that installs into
Claude Desktop through Settings → Extensions → Advanced → Install Extension…. Both Claude Code
and Claude Desktop have been tested end to end with the MetaMask flow.

`npm run bundle -- --dev` stamps the staged bundle — never the repository's own files — with a
version derived from the commit, for example `0.1.0-dev.14+gabc1234`, so that two development
builds of the same release are never called the same thing and a host cannot silently keep the
copy it already has. [docs/install.md](docs/install.md) says how to update an installed
extension and how to confirm which build is running.

### Known limitations

- Testnet only: one network (Base Sepolia), one asset (USDC), one scheme (x402 `exact`).
- MetaMask's signature popup shows the value in USDC's smallest unit, so `10000` is 0.01 USDC.
  The approval page prints the conversion, but the popup is what it is.
- Listings from the public Superstables index are shown but cannot be paid yet: the index does
  not record the request parameters a service needs, and each listing says so.
- An attempt that ends `uncertain` is never retried automatically; it has to be looked at.
- With `--wallet local` the key is a file on the machine, readable by any process running as the
  owner. That mode exists for a machine with no browser.

[Unreleased]: https://github.com/superstables/superstables-client/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/superstables/superstables-client/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/superstables/superstables-client/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/superstables/superstables-client/releases/tag/v0.1.0
