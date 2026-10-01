# Rail safety contract

Every rail's main path follows these rules.

| Rail | Main path | Scripts |
| --- | --- | --- |
| EVM | Plain approve, pull then pay | `evm/` (`--chain base-sepolia|arc-testnet|arbitrum-sepolia|polygon-amoy|skale-base-sepolia|ethereum-sepolia`) |
| Tempo | Keychain access key, MPP charge | `tempo/` |
| Solana | SPL delegate, x402 exact | `solana/` |

## 1. Owner and agent keys are separate

- The agent key lives in `$SUPERSTABLES_HOME/keys/budget/<rail>-agent.env` (mode 600). Public addresses go in a public state file under `$SUPERSTABLES_HOME/budget/public/`.
- Every rail: the owner's key stays in the owner's wallet. Owner commands (`setup`, `fundAgent`, `setBudget`/`grant`, `revoke`, the owner's part of `recover` on EVM) build the transaction and ask the owner's wallet to approve it through the owner approval page on `127.0.0.1`. The terms on that page come from the command's own plan, never from agent text. The command then verifies on chain. An owner key file is used only when a test names it with `--owner-key-file`.
  - EVM and Tempo: an EIP-1193 browser wallet (for example MetaMask) sends exactly the transaction the command built. On Tempo that is a plain type-2 call to the AccountKeychain precompile, and the owner pays its own fee.
  - Solana: a Wallet Standard wallet (for example Phantom) only signs. The command builds the transaction when the owner presses Approve and sends it itself, only if the signed message is byte for byte the one it built and the signature is the owner's.
- `setup` is a trusted step. Its link is the only credential, and the page's origin check stops cross-site requests, not local programs: anyone holding the link, the agent included, can complete it with a key they control. So the owner runs it, and setup's result and its page both name the connected owner address for the owner to check it is their wallet.
- Agent commands (`buy`, `reconcile`) open only the agent file. They must work with no owner key file anywhere.
- Read commands (`read`/`readBudget`/`status`) need no secret file.
- Never print, log or copy key material.

## 2. A budget never allows more than it says

- One-shot budgets: exactly one period. No early start that creates an extra reset.
- Periodic budgets: the total that can move by `end` is stated in the output (allowance x number of periods touched).
- Granting a new budget for the same agent revokes the previous one in the same transaction, or refuses until it is revoked.

## 3. The kill switch is stated and tested

The README says which owner action stops the agent even if the agent key is stolen, and what exposure remains after it. Tested on testnet, not only read from source.

## 4. Every purchase is checked before anything is signed

`buy` must refuse, before any signature, pull or transaction, when:
- the price exceeds `--max <amount>` (required; no default);
- the token is not the rail's expected token (the chain's USDC, Tempo pathUSD, the Solana devnet USDC mint) or decimals don't match;
- the recipient is not the one in `--pay-to <address>`, when given;
- the amount has more precision than the token allows.

Refusal exits with code 3 and a `RESULT` line with `state: "refused_precheck"` and the reason.

## 5. Every purchase has an operation ID and can be reconciled

- `buy --op <id>` (generated and printed if absent). A journal file per operation lives outside the code folder: `$SUPERSTABLES_HOME/budget/ops/<rail>-<chain>/<id>.json`, written **before** submission (intent: seller URL, amount, recipient, token) and updated after (tx ids, state).
- If an operation with that ID is already `submitted` or `unknown`, `buy` refuses and says to run `reconcile --op <id>`.
- `reconcile --op <id>` reads the chain and sets `settled`, `failed` or `not_found`. It never pays.
- A purchase is `settled` only when its own transaction succeeded on chain. Seller HTTP status is recorded separately as `delivered: true|false` (`null` when the process died before the response). Delivery failure never triggers a new payment.
- Final output line: `RESULT {"rail","op","state","tx","debit","remaining","delivered","next"}` where `state` is one of `quoted`, `submitted`, `settled`, `failed`, `refused_precheck`, `refused_chain`, `not_found` (reconcile only), `unknown`.

## 6. Help and bad input never sign

For every script: `--help` / `-h` prints usage and exits 0, and unknown flags or missing required flags exit 2. Both happen before any secret file is read or any RPC write. No script may default to a spending action when arguments are missing.
