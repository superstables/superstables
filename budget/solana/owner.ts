// The owner's side of the solana rail: setup, grant, revoke and fund-agent go through the owner's own wallet (Phantom or any
// Wallet Standard wallet) on the shared owner page (../owner-page.ts).
//
// The server builds, the wallet signs, the server sends (transactionPort):
//   1. When the owner presses Approve, prepare() fetches a fresh blockhash and builds the transaction: fee payer the owner, our
//      instructions only (ApproveChecked, Revoke or a SOL transfer). A blockhash lives about a minute, a link up to an hour, so
//      nothing is built before the click.
//   2. The wallet only signs (solana:signTransaction). solana:signAndSendTransaction is not used: in the 28 Sep Phantom build it
//      threw after approval and nothing landed, and this way the command knows for certain whether anything was sent.
//   3. submit() refuses, and sends nothing, unless the signed message is unchanged apart from bounded wallet-added
//      compute-budget instructions, and the one signature is the owner's. Then it sends the signed bytes itself.
// The command then reads the chain (confirmSent, then the token account) before its RESULT.
import { ComputeBudgetProgram, Message, PublicKey, Transaction, VersionedMessage, type Connection, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import type { OwnerChain, OwnerTerms, SolanaTransactionPort } from "../../src/core/signer/owner-approval-server.ts";
import { verifyEd25519 } from "../../src/core/signer/owner-approval-server.ts";
import { closeOwnerPage, ownerPageFor } from "../owner-page.ts";
import { RPC_URL, USDC_MINT, formatUnits, retryRead, sleep } from "./lib.mjs";

export { closeOwnerPage };

export const SOLANA_OWNER_CHAIN: OwnerChain = {
  family: "solana",
  chainId: 0,
  chainName: "Solana devnet",
  rpcUrl: RPC_URL,
  explorer: "https://explorer.solana.com",
  explorerQuery: "?cluster=devnet",
  walletChain: "solana:devnet",
  nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
  testnet: true,
};

/** One RESULT line, last on stdout (CLI.md), the same shape as the evm scripts. Returns `exit`. */
export function emit(command: string, exit: number, o: Record<string, unknown>): number {
  console.log(`RESULT ${JSON.stringify({ ok: exit === 0, command, rail: "solana", chain: "devnet", ...o })}`);
  return exit;
}

export const { askConnect, askSolanaTransaction, endUnapproved } = ownerPageFor({
  chain: SOLANA_OWNER_CHAIN,
  walletWords: "any Solana wallet, such as Phantom, Solflare or Backpack",
  statusCommand: "superstables budget status --rail solana",
  emit,
});

/** A fee for one signature, and a margin: the owner must hold at least this much SOL to approve anything. */
export const MIN_FEE_LAMPORTS = 10_000n;
export const sol = (lamports: bigint | number) => formatUnits(BigInt(lamports), 9);

/** Solana's compact-u16 length prefix: [value, bytes read]. */
function shortvec(buf: Buffer, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = buf[at + i];
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return [value, i + 1];
  }
  throw new Error("bad length prefix");
}

function programIds(message: Buffer): string[] {
  try {
    const m = VersionedMessage.deserialize(message);
    return m.compiledInstructions.map((ix) => m.staticAccountKeys[ix.programIdIndex]?.toBase58() ?? `#${ix.programIdIndex}`);
  } catch {
    return ["(unreadable message)"];
  }
}

/** Phantom may prepend fee instructions before signing. Accept only those bounded additions, with every original effect intact. */
function sameTransactionWithWalletFee(builtBytes: Buffer, signedBytes: Buffer, owner: PublicKey): boolean {
  let built: Message, signed: Message;
  try {
    const a = VersionedMessage.deserialize(builtBytes);
    const b = VersionedMessage.deserialize(signedBytes);
    if (!(a instanceof Message) || !(b instanceof Message)) return false;
    built = a;
    signed = b;
  } catch {
    return false;
  }
  if (signed.recentBlockhash !== built.recentBlockhash ||
      signed.header.numRequiredSignatures !== 1 ||
      !signed.accountKeys[0]?.equals(owner) ||
      signed.instructions.length !== built.instructions.length + 2) return false;

  const budgetId = ComputeBudgetProgram.programId.toBase58();
  const originalKeys = new Set(built.accountKeys.map((key) => key.toBase58()));
  if (originalKeys.has(budgetId) || signed.accountKeys.length !== built.accountKeys.length + 1) return false;
  for (let i = 0; i < built.accountKeys.length; i++) {
    const key = built.accountKeys[i].toBase58();
    const at = signed.accountKeys.findIndex((candidate) => candidate.toBase58() === key);
    if (at < 0 || signed.isAccountSigner(at) !== built.isAccountSigner(i) ||
        signed.isAccountWritable(at) !== built.isAccountWritable(i)) return false;
  }
  const budgetAt = signed.accountKeys.findIndex((key) => key.toBase58() === budgetId);
  if (budgetAt < 0 || signed.isAccountSigner(budgetAt) || signed.isAccountWritable(budgetAt) ||
      signed.accountKeys.some((key) => !originalKeys.has(key.toBase58()) && key.toBase58() !== budgetId)) return false;

  const feeInstructions = signed.instructions.slice(0, 2);
  if (feeInstructions.some((ix) => ix.programIdIndex !== budgetAt || ix.accounts.length)) return false;
  const feeData = feeInstructions.map((ix) => Buffer.from(bs58.decode(ix.data)));
  const limitData = feeData.find((data) => data.length === 5 && data[0] === 2);
  const priceData = feeData.find((data) => data.length === 9 && data[0] === 3);
  if (!limitData || !priceData) return false;
  const units = limitData.readUInt32LE(1);
  const microLamports = priceData.readBigUInt64LE(1);
  // This caps the owner's extra priority fee at 0.001 SOL, above Phantom's observed 0.00008 SOL estimate.
  if (units < 10_000 || units > 1_400_000 || (BigInt(units) * microLamports + 999_999n) / 1_000_000n > 1_000_000n) return false;

  const instruction = (message: Message, ix: Message["instructions"][number]) => JSON.stringify({
    program: message.accountKeys[ix.programIdIndex]?.toBase58(),
    accounts: ix.accounts.map((at) => message.accountKeys[at]?.toBase58()),
    data: ix.data,
  });
  return built.instructions.every((ix, i) => instruction(built, ix) === instruction(signed, signed.instructions[i + 2]));
}

export type Issued = { signature: string; blockhash: string; lastValidBlockHeight: number };

/**
 * The owner page's Solana port for one action: builds `instructions()` with a fresh blockhash on each Approve, and sends only
 * a transaction whose signed message preserves every original effect, with only bounded wallet-added fee instructions,
 * signed by `owner`. `sent()` is what it sent last.
 */
export function transactionPort(conn: Connection, owner: PublicKey, instructions: () => TransactionInstruction[], log: (s: string) => void = console.log) {
  let issued: { message: Buffer; blockhash: string; lastValidBlockHeight: number } | null = null;
  let last: Issued | null = null;
  const refused = (reason: string) => ({ status: "refused" as const, reason });
  const port: SolanaTransactionPort = {
    async prepare() {
      const { blockhash, lastValidBlockHeight } = await retryRead(() => conn.getLatestBlockhash("confirmed"));
      const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight }).add(...instructions());
      issued = { message: tx.serializeMessage(), blockhash, lastValidBlockHeight };
      log(`prepared a transaction for the wallet (blockhash ${blockhash}, valid to block height ${lastValidBlockHeight}; programs ${programIds(issued.message).join(", ")})`);
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    },
    async submit(signedB64, broadcasting) {
      const want = issued;
      if (!want) return refused("There is no prepared transaction.");
      const raw = Buffer.from(signedB64, "base64");
      let count: number, at: number;
      try {
        [count, at] = shortvec(raw, 0);
      } catch {
        return refused("The wallet returned something that is not a transaction.");
      }
      const message = raw.subarray(at + 64 * count);
      if (!message.equals(want.message) && !sameTransactionWithWalletFee(want.message, message, owner)) {
        const ours = programIds(want.message);
        const theirs = programIds(message);
        log(`REFUSED: the wallet changed the transaction. Built: ${ours.join(", ")}. Signed: ${theirs.join(", ")}. Nothing was sent.`);
        return refused("Your wallet changed the transaction, so the command did not send it.");
      }
      if (count !== 1) return refused(`The wallet returned ${count} signatures; this transaction has exactly one signer, you.`);
      const signature = raw.subarray(at, at + 64);
      if (!verifyEd25519(owner.toBase58(), message, signature)) return refused(`That is not a signature by ${owner.toBase58()}.`);
      const height = await retryRead(() => conn.getBlockHeight("confirmed"));
      if (height > want.lastValidBlockHeight) {
        issued = null;
        return refused("That took too long: the transaction expired before it was signed.");
      }
      if (!broadcasting()) return refused("The link expired while the wallet was signing.");
      const sig = bs58.encode(signature);
      last = { signature: sig, blockhash: want.blockhash, lastValidBlockHeight: want.lastValidBlockHeight };
      issued = null;
      try {
        await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 });
        log(`sent ${sig}`);
      } catch (err) {
        const text = String((err as Error)?.message ?? err);
        // A JSON-RPC answer to sendTransaction with preflight on is the node's refusal: nothing was forwarded.
        if ((err as Error)?.name === "SendTransactionError" && !/already been processed/i.test(text)) {
          last = null;
          log(`the RPC refused the transaction before sending it: ${text.slice(0, 300)}`);
          return refused(`The network refused it before sending: ${text.slice(0, 160)}.`);
        }
        log(`the send answered with an error (${text.slice(0, 160)}); it may have gone out, the command reads the chain`);
      }
      return { status: "sent", hash: sig };
    },
  };
  return { port, sent: () => last };
}

export type Confirmed = { status: "success" | "failed" | "expired" | "unknown"; slot?: number; err?: unknown; signer?: string; meta?: any; accountKeys?: string[] };

/**
 * Read a transaction the command sent: confirmed with no error, and signer 0 the owner. "expired" means its blockhash ran out
 * and the chain answered that it has no such signature: it can no longer land. A read that fails is never taken as "not
 * there": if the last reads failed, or nothing is decided within the wait, the answer is "unknown".
 */
export async function confirmSent(conn: Connection, s: Issued, waitMs = 120_000): Promise<Confirmed> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    let tx: any = null;
    let txRead = true;
    try {
      tx = await retryRead(() => conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
    } catch {
      txRead = false;
    }
    if (tx) {
      const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
      return { status: tx.meta?.err ? "failed" : "success", slot: tx.slot, err: tx.meta?.err ?? undefined, signer: keys[0], meta: tx.meta, accountKeys: keys };
    }
    const height = txRead ? await retryRead(() => conn.getBlockHeight("confirmed")).catch(() => null) : null;
    if (height !== null && height > s.lastValidBlockHeight + 10) {
      // expired only on a successful answer that the signature is unknown to the chain
      const st = await retryRead(() => conn.getSignatureStatus(s.signature, { searchTransactionHistory: true })).then((v) => ({ ok: true as const, v }), () => ({ ok: false as const }));
      if (st.ok && !st.v?.value) return { status: "expired" };
    }
    await sleep(2000);
  }
  return { status: "unknown" };
}

// ── terms ────────────────────────────────────────────────────────────────────────────────────────────────

const walletNote =
  "Check the terms before signing. The command preserves the original transaction effects and permits only bounded wallet-added fee instructions, then checks the chain. If the wallet cannot show or simulate the effects, reject if you cannot verify them.";

export function grantTerms(p: { owner: string; agent: string; ata: string; cap: bigint; held: bigint }): OwnerTerms {
  const amt = `${formatUnits(p.cap)} USDC`;
  return {
    title: "Grant a spending budget",
    amount: formatUnits(p.cap),
    unit: "USDC",
    summary: `Allow the agent to transfer up to ${amt} from your USDC account in total. Purchases within this allowance need no further approval.`,
    rows: [
      { label: "Agent", value: p.agent, mono: true },
      { label: "Your wallet", value: p.owner, mono: true },
      { label: "Token", value: `USDC ${USDC_MINT.toBase58()}`, mono: true },
      { label: "Your USDC account", value: p.ata, mono: true },
      { label: "Your balance", value: `${formatUnits(p.held)} USDC` },
      { label: "Transaction", value: `SPL Token ApproveChecked: delegate ${p.agent}, ${p.cap} (${amt})`, mono: true },
    ],
    enforced: [
      `Transfers or burns under this delegation total at most ${amt}. Once used, this delegation permits no more.`,
      "Each transfer is limited by your USDC account balance at that time. Later deposits can also be spent while allowance remains.",
    ],
    notEnforced: [
      "No expiry. The budget stays until it is spent or you revoke it.",
      "No seller list or purchase requirement. Whoever holds the agent key can transfer to any address or burn tokens, up to the cap.",
      "No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it.",
    ],
    notes: [
      walletNote,
      "A delegate is a key allowed to spend from your token account. There is one delegate slot. Revoke a live delegation before granting another.",
      "To end the budget at any time: superstables budget revoke --rail solana. You approve that in your wallet too.",
      "This grants permission; it does not transfer USDC now. You pay a network fee, typically 0.000005 SOL for this transaction. Check the wallet fee and grant only an amount you accept putting at risk.",
    ],
  };
}

export function revokeTerms(p: { owner: string; agent: string | null; ata: string; remaining: bigint }): OwnerTerms {
  return {
    title: "Revoke spending permission",
    amount: formatUnits(p.remaining),
    unit: "USDC",
    summary: `Remove the delegate from your USDC account. Its remaining allowance is ${formatUnits(p.remaining)} USDC. Once confirmed on chain, that key can no longer spend from this account as its delegate.`,
    rows: [
      { label: "Agent", value: p.agent ?? "none", mono: true },
      { label: "Your wallet", value: p.owner, mono: true },
      { label: "Your USDC account", value: p.ata, mono: true },
      { label: "Transaction", value: "SPL Token Revoke: clears the delegate", mono: true },
    ],
    enforced: ["Once this revoke takes effect, transactions using this delegation fail, including ones signed earlier. The key cannot use this delegation even if stolen."],
    notEnforced: ["No reversal of transfers confirmed before this revoke. It does not recover tokens already moved or stop the key spending its own funds."],
    notes: [walletNote, "This removes spending permission; it does not return funds. You pay a network fee, typically 0.000005 SOL. Check the wallet fee. You can grant a new budget later."],
  };
}

export function fundTerms(p: { owner: string; agent: string; lamports: bigint; agentHas: bigint }): OwnerTerms {
  return {
    title: "Send funds for network fees",
    amount: sol(p.lamports),
    unit: "SOL",
    summary: `Send ${sol(p.lamports)} SOL from your wallet to the agent for fees when the seller does not pay them. You also pay the fee for this transfer, shown in your wallet.`,
    rows: [
      { label: "To your agent", value: p.agent, mono: true },
      { label: "From your wallet", value: p.owner, mono: true },
      { label: "Agent balance", value: `${sol(p.agentHas)} SOL` },
      { label: "Transaction", value: `a plain transfer of ${sol(p.lamports)} SOL` },
    ],
    enforced: [],
    notEnforced: [],
    notes: [
      walletNote,
      "The agent controls the transferred SOL and can send it elsewhere. This does not grant permission to spend your USDC.",
      "Revoking the budget does not undo this transfer. Unspent SOL stays in the agent account. This tool has no Solana recovery command.",
    ],
  };
}
