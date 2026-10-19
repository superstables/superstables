// Preload for a test: mppx builds a transfer that is not the quoted one (the price plus one base unit), so the read-back of the
// signed payment (budget/tempo/lib/signed.ts) is the only thing standing between it and the seller or the RPC.
import { Actions } from 'viem/tempo'
const orig = Actions.token.transfer.call
Actions.token.transfer.call = (client, p) => orig(client, { ...p, amount: p.amount + 1n })
