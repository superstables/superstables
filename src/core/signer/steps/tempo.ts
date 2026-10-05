// The wallet step for MPP tempo.charge on Tempo Moderato: the page connects an account (and switches the wallet to
// Tempo), the server builds the one call the wallet sends, pathUSD.transferWithMemo(recipient, amount, memo) with the
// memo bound to the seller's challenge, and the wallet sends it itself.
//
// Because the wallet moves the money, the order is strict:
//
//   POST /account  prepare the call for this account. Nothing is sent.
//   POST /sending  the page has switched the wallet to Tempo Moderato and checked it is there, and is about to ask it.
//                  The payment core records first that money may move (and checks the daily cap); only its go-ahead
//                  lets the page ask. Once per approval: the call is never handed to the wallet twice, so one approval
//                  can send at most one transfer. The page checks the wallet's chain again right before it asks, and
//                  the call it sends names Tempo Moderato's chain id.
//   POST /sent     the wallet's transaction hash. The payment core reads the chain for it before the seller is called.
//
// After /sending, the approval ends as known only with a hash. Everything else ends it "unknown", the wallet's own "no"
// included (EIP-1193 4001, which the page posts to /reject as { by: "wallet" }): that is the page's word, which anyone
// holding the link can send, and the wallet may have sent all the same. The chain is searched for the memo later.

import type { Hex } from "viem";
import { getAddress } from "viem";
import { TEMPO_MODERATO, isAddress } from "../../chain.js";
import type { MppChallenge } from "../../mpp.js";
import { TEMPO_SEND_MARGIN_MS, mppMemo, transferCall } from "../../rails/tempo.js";
import type { StepAnswer, StepContext, StepRecord, WalletStep } from "./types.js";

interface Prepared {
  call: ReturnType<typeof transferCall>;
  memo: Hex;
}

/** The page's side: ask the client first, then the wallet, then report the hash. Plain ES2017, no build step. */
export const TEMPO_STEP_SCRIPT = `
(function () {
  window.superstablesStep = {
    doneMessage: "Sent. You can go back to the agent.",
    approve: function (api) {
      var account = api.account();
      var prepared = api.prepared();
      if (!account || !prepared || !prepared.transaction) return;
      var call = prepared.transaction;
      // recorded: the client has written down that money may move; sending: the wallet was asked to send;
      // hash: what the wallet answered. Each decides what an error below can mean.
      var recorded = false;
      var sending = false;
      var hash = null;
      api.setBusy(true);
      api.say("Checking that your wallet is on " + api.facts.chainName + ".");
      // The wallet is switched to Tempo Moderato and checked before anything is recorded, checked again right before it
      // is asked to send, and the call names the chain: a wallet on another chain does not send it.
      api.ensureChain()
        .then(function () {
          api.say("Recording this payment before your wallet is asked.");
          return api.post("/sending", { address: account });
        })
        .then(function (answer) {
          if (!answer.ok) {
            var refused = new Error(answer.data.error || "the client would not hand this payment to your wallet");
            refused.refused = true;
            refused.status = answer.data.status;
            refused.why = answer.data.reason;
            throw refused;
          }
          recorded = true;
          api.lock();
          return api.verifyChain();
        })
        .then(function () {
          sending = true;
          api.say("Check your wallet: it is asking you to send this payment. Confirm it only if the amount and the recipient match.");
          return api.provider().request({
            method: "eth_sendTransaction",
            params: [{ from: account, to: call.to, data: call.data, value: call.value, chainId: api.facts.chainIdHex }]
          });
        })
        .then(function (sent) {
          hash = sent;
          api.say("Sent. The client is recording the transaction.");
          return api.post("/sent", { address: account, hash: sent });
        })
        .then(function (answer) {
          if (!answer.ok) {
            api.say(answer.data.error || "The client did not accept the transaction hash. Check your wallet's activity before doing anything else.", "bad");
            return;
          }
          api.ended("signed");
        })
        .catch(function (err) {
          if (err && err.refused) {
            if (err.status && err.status !== "pending") { api.ended(err.status, err.why || err.message); return; }
            api.setBusy(false);
            api.say(err.message, "bad");
            return;
          }
          if (!recorded) { api.setBusy(false); api.say("Could not hand this payment to your wallet: " + api.reason(err), "bad"); return; }
          // From here the client has recorded that money may move, so this page never asks the wallet again.
          if (!sending) {
            api.say("This page could not confirm that your wallet is on " + api.facts.chainName + ", so it did not ask it to send. The client had already recorded that the payment may be sent, so the outcome stays unconfirmed. Check the command result.", "bad");
            return;
          }
          if (hash) {
            api.say("Your wallet sent the payment (transaction " + hash + "), but the client did not confirm it received the transaction: " + api.reason(err) + ". Check the command result before trying anything else. This page does not ask your wallet again.", "bad");
            return;
          }
          if (err && err.code === 4001) { api.rejectedInWallet(); return; }
          api.say("The payment's status could not be confirmed, and it may have been sent. Check your wallet's activity and the command result before trying anything else. This page does not ask your wallet again: " + api.reason(err), "bad");
        });
    }
  };
})();
`;

function challengeOf(record: StepRecord): MppChallenge {
  return record.requirement as MppChallenge;
}

/** The latest the wallet may be asked to send: a margin before the seller's challenge expires. */
function sendDeadline(record: StepRecord): number {
  const expires = Date.parse(challengeOf(record).expires ?? "");
  return Number.isFinite(expires) ? expires - TEMPO_SEND_MARGIN_MS : 0;
}

export const tempoStep: WalletStep = {
  kind: "tempo-transfer",
  routes: ["/account", "/sending", "/sent"],

  account(value: unknown): string | undefined {
    return typeof value === "string" && isAddress(value) ? getAddress(value) : undefined;
  },

  async prepare(record: StepRecord, account: string): Promise<StepAnswer> {
    const challenge = challengeOf(record);
    const memo = mppMemo(challenge.id, challenge.realm);
    const call = transferCall({ from: account, recipient: record.verified.recipient, amountAtomic: record.verified.amountAtomic, memo });
    record.prepared = { call, memo } satisfies Prepared;
    return {
      http: 200,
      body: {
        transaction: call,
        summary: `${record.verified.amountDecimal} ${record.verified.asset} to ${record.verified.recipient} on ${record.verified.networkLabel}`,
      },
    };
  },

  async answer(record: StepRecord, leaf: string, body: Record<string, unknown>, context: StepContext): Promise<StepAnswer> {
    const prepared = record.prepared as Prepared | undefined;
    if (!prepared || !record.account) return { http: 409, body: { error: "connect an account first: there is nothing prepared to send" } };
    const address = typeof body.address === "string" && isAddress(body.address) ? getAddress(body.address) : undefined;
    if (address !== record.account) {
      return { http: 400, body: { error: `this payment was prepared for ${record.account}; connect that account again` } };
    }

    if (leaf === "/sending") {
      if (record.walletAsked) return { http: 409, body: { error: "your wallet was already asked to send this payment; it is not asked again" } };
      if (Date.now() > sendDeadline(record)) {
        return { http: 409, body: { error: "the seller's challenge expires too soon to send this payment; ask the agent for a new approval link" } };
      }
      // The payment core records that money may move, and checks the cap, before the wallet is asked. It throws to stop.
      await context.beforeWalletSends({ payer: record.account, memo: prepared.memo });
      record.walletAsked = true;
      return { http: 200, body: { status: "send" } };
    }

    if (leaf === "/sent") {
      if (!record.walletAsked) return { http: 409, body: { error: "this page did not ask your wallet to send this payment" } };
      const hash = typeof body.hash === "string" ? body.hash : "";
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return { http: 400, body: { error: "that is not a transaction hash" } };
      return {
        http: 200,
        body: { status: "signed" },
        signed: { kind: "tempo-transfer", hash: hash.toLowerCase(), memo: prepared.memo, signer: record.account },
      };
    }
    return { http: 404, body: { error: "no such route" } };
  },

  mayHaveSent(record: StepRecord): boolean {
    return record.walletAsked === true;
  },

  deadline: sendDeadline,

  pageFacts() {
    return {
      chainIdHex: `0x${TEMPO_MODERATO.chainId.toString(16)}`,
      chainName: TEMPO_MODERATO.wallet.chainName,
      rpcUrl: TEMPO_MODERATO.rpc,
      explorer: TEMPO_MODERATO.explorer,
      nativeCurrency: TEMPO_MODERATO.wallet.nativeCurrency,
    };
  },

  words: {
    lede: "Check the amount and the recipient, then send the payment from your browser wallet, or reject. Your wallet keeps its key.",
    fineprint: (facts) =>
      `Your wallet sends this one transfer itself and shows its network fee. ${facts.amountAtomic} in the token's smallest unit is ${facts.amountDecimal} ${facts.asset}. Nothing else is sent.`,
  },

  script: TEMPO_STEP_SCRIPT,
};
