// The owner's side of the solana rail: setup, grant, revoke and fund-agent go through the owner's own wallet (Phantom or any
// Wallet Standard wallet) on the shared owner page (../owner-page.ts).
//
// The server builds, the wallet signs, the server sends (transactionPort):
//   1. When the owner presses Approve, prepare() fetches a fresh blockhash and builds the transaction: fee payer the owner, our
//      instructions only (ApproveChecked, Revoke or a SOL transfer). A blockhash lives about a minute, a link up to an hour, so
//      nothing is built before the click.
//   2. The wallet only signs (solana:signTransaction). solana:signAndSendTransaction is not used: in the 28 Sep Phantom build it
//      threw after approval and nothing landed, and this way the command knows for certain whether anything was sent.
//   3. submit() refuses, and sends nothing, unless the signed message is byte for byte the one it built and the one signature
//      is the owner's; it logs the program ids of anything a wallet added. Then it sends the signed bytes itself.
// The command then reads the chain (confirmSent, then the token account) before its RESULT.
import { PublicKey, Transaction, VersionedMessage, type Connection, type TransactionInstruction } from "@solana/web3.js";
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
  walletWords: "Phantom or another Solana wallet",
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

export type Issued = { signature: string; blockhash: string; lastValidBlockHeight: number };

/**
 * The owner page's Solana port for one action: builds `instructions()` with a fresh blockhash on each Approve, and sends only
 * a transaction whose signed message is exactly the one it built, signed by `owner`. `sent()` is what it sent last.
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
      if (!message.equals(want.message)) {
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
 * and the chain never shows it: it can no longer land. "unknown": no answer within the wait.
 */
export async function confirmSent(conn: Connection, s: Issued, waitMs = 120_000): Promise<Confirmed> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const tx = await retryRead(() => conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).catch(() => null);
    if (tx) {
      const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
      return { status: tx.meta?.err ? "failed" : "success", slot: tx.slot, err: tx.meta?.err ?? undefined, signer: keys[0], meta: tx.meta, accountKeys: keys };
    }
    const height = await retryRead(() => conn.getBlockHeight("confirmed")).catch(() => 0);
    if (height > s.lastValidBlockHeight + 10) {
      const st = await retryRead(() => conn.getSignatureStatus(s.signature, { searchTransactionHistory: true })).catch(() => null);
      if (!st?.value) return { status: "expired" };
    }
    await sleep(2000);
  }
  return { status: "unknown" };
}

// ── terms ────────────────────────────────────────────────────────────────────────────────────────────────

const walletNote =
  "Phantom may show no amount and no delegate, and on devnet it may say it cannot simulate this. The terms on this page are what the transaction does: the command sends only the exact transaction it built, and then reads the result from the chain.";

export function grantTerms(p: { owner: string; agent: string; ata: string; cap: bigint; held: bigint }): OwnerTerms {
  const amt = `${formatUnits(p.cap)} USDC`;
  return {
    title: "give your agent a budget",
    amount: formatUnits(p.cap),
    unit: "USDC",
    summary: `Your agent may move up to ${amt} from your wallet, in total, to pay for what it buys.`,
    rows: [
      { label: "Agent", value: p.agent, mono: true },
      { label: "Your wallet", value: p.owner, mono: true },
      { label: "Token", value: `USDC ${USDC_MINT.toBase58()}`, mono: true },
      { label: "Your USDC account", value: p.ata, mono: true },
      { label: "You hold", value: `${formatUnits(p.held)} USDC` },
      { label: "Transaction", value: `SPL Token ApproveChecked: delegate ${p.agent}, ${p.cap} (${amt})`, mono: true },
    ],
    enforced: [
      `A total cap of ${amt}. Once the agent has used it, it can move nothing more.`,
      "The agent can never move more than your USDC account holds.",
    ],
    notEnforced: [
      "No expiry. The budget stays until it is spent or you revoke it.",
      "No seller list. Whoever holds the agent's key can pay any address, up to the cap.",
      "No per-payment limit. The agent's command checks each price against a maximum, but a stolen key skips that check.",
    ],
    notes: [
      walletNote,
      "Your USDC account has one delegate slot: this budget replaces nothing, because the command refuses while another delegate is live.",
      "To end the budget at any time: superstables budget revoke --rail solana. You approve that in your wallet too.",
      "Grant only what you are willing to lose. This costs a network fee of about 0.000005 SOL and moves no money now.",
    ],
  };
}

export function revokeTerms(p: { owner: string; agent: string | null; ata: string; remaining: bigint }): OwnerTerms {
  return {
    title: "end your agent's budget",
    amount: formatUnits(p.remaining),
    unit: "USDC",
    summary: `This ends your agent's budget: the ${formatUnits(p.remaining)} USDC it has left goes to 0. From the slot it lands in, the agent can move nothing more from your wallet.`,
    rows: [
      { label: "Agent", value: p.agent ?? "none", mono: true },
      { label: "Your wallet", value: p.owner, mono: true },
      { label: "Your USDC account", value: p.ata, mono: true },
      { label: "Transaction", value: "SPL Token Revoke: clears the delegate", mono: true },
    ],
    enforced: ["From that slot on, every payment by the agent key fails, even one signed earlier, even with a stolen key."],
    notEnforced: ["A payment that landed before this transaction."],
    notes: [walletNote, "This costs a network fee of about 0.000005 SOL and moves no money. You can grant a new budget later."],
  };
}

export function fundTerms(p: { owner: string; agent: string; lamports: bigint; agentHas: bigint }): OwnerTerms {
  return {
    title: "send your agent SOL for fees",
    amount: sol(p.lamports),
    unit: "SOL",
    summary: `Your agent pays a small SOL network fee when a seller does not pay it. This sends it ${sol(p.lamports)} SOL from your wallet, once.`,
    rows: [
      { label: "To your agent", value: p.agent, mono: true },
      { label: "From your wallet", value: p.owner, mono: true },
      { label: "Agent has now", value: `${sol(p.agentHas)} SOL` },
      { label: "Transaction", value: `a plain transfer of ${sol(p.lamports)} SOL` },
    ],
    enforced: [],
    notEnforced: [],
    notes: [
      walletNote,
      "This is a plain transfer. It gives the agent no budget: you grant that separately, and approve it in your wallet too.",
      "Send the agent only what it needs. What it does not spend stays in its key.",
    ],
  };
}
