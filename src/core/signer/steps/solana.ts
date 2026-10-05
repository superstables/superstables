// The wallet step for x402 exact on Solana devnet. The page finds the owner's Solana wallet through the Wallet Standard
// (Phantom, Solflare, Backpack...), connects one account, and on "Review in wallet" asks the server for the transaction:
// the server checks its RPC is Solana devnet, takes a fresh blockhash and builds the transfer (../../rails/
// solana-transaction.ts) with the seller's fee payer. The wallet signs it with solana:signTransaction, as the token's
// owner only. The server then checks what came back before it is believed: the message byte for byte the one it built,
// the owner's ed25519 signature valid over it, the fee payer's slot still empty, and the blockhash still good for long
// enough to reach the seller. Nothing is sent from here: the payment core hands the signed transaction to the seller, whose
// facilitator signs as fee payer and sends it.

import type { PaymentRequirements } from "@x402/core/types";
import { SOLANA_DEVNET, shortLabel } from "../../chain.js";
import { NotDevnetError, devnetBlockHeight, devnetBlockhash } from "../../rails/solana.js";
import { buildPayment, checkSigned, type BuiltPayment } from "../../rails/solana-transaction.js";
import { isSolanaAddress } from "../owner-approval-server.js";
import type { StepAnswer, StepRecord, WalletStep } from "./types.js";

/** A signed transaction whose blockhash has fewer blocks left than this is not passed on: it might not land in time. */
const BLOCKS_TO_SPARE = 15;
/** When the block height cannot be read: a blockhash is good for about a minute (150 blocks). */
const SIGNED_WITHIN_MS = 60_000;
/** A signed payment transaction is well under 2 KB; anything longer is not one. */
const MAX_SIGNED_CHARS = 4_096;
/**
 * A seller that fixes the memo leaves the blockhash the only part of the message that differs between two payments of
 * the same amount to the same recipient: two built on the same blockhash would be one transaction, and one landing would
 * pay both on paper. A message this process already handed out for another approval is built again on a newer blockhash
 * (this many times, this far apart), or not handed out. (Across processes, the payment core refuses a second attempt
 * with the same owner's signature before anything is sent.)
 */
const REBUILDS = 3;
const REBUILD_WAIT_MS = 400;
const ISSUED_KEPT = 256;
/** Messages handed out, by approval id, newest last. */
const issued = new Map<string, string>();

const PHANTOM_DOWNLOAD_URL = "https://phantom.com/download";

/** What /prepare built, for the account that was connected then. */
interface SolanaPrepared extends BuiltPayment {
  owner: string;
  lastValidBlockHeight: number;
  /** The slot devnet had reached when the blockhash was read: the transaction can only land after it. */
  slot?: number;
  builtAt: number;
}

function feePayerOf(record: StepRecord): string | undefined {
  const feePayer = (record.requirement as PaymentRequirements).extra?.feePayer;
  return isSolanaAddress(feePayer) ? feePayer : undefined;
}

function memoOf(record: StepRecord): string | undefined {
  const memo = (record.requirement as PaymentRequirements).extra?.memo;
  return typeof memo === "string" ? memo : undefined;
}

/**
 * The step's page script. It runs before the approval page's main script and gives it the Solana wallet's connect and
 * approve. Plain ES2017, no build step: exported so a test can parse and run it.
 */
export const SOLANA_STEP_SCRIPT = `
(function () {
  var api = null;
  // Wallet Standard wallets on this page that can sign a Solana devnet transaction, in the order they registered.
  var wallets = [];
  var wallet = null;
  var walletAccount = null;
  var account = null;
  // Wallets that load after the page have had their moment: only then does the page say none is installed.
  var looked = false;

  function name(w) {
    var text = String((w && w.name) || "").replace(/\\s+/g, " ").trim().slice(0, 40);
    return text || "your wallet";
  }

  // An icon comes from the wallet itself: only an image data URI is shown, and only as an image.
  function iconOf(w) {
    var icon = w && w.icon;
    return typeof icon === "string" && icon.slice(0, 11).toLowerCase() === "data:image/" ? icon : null;
  }

  function usable(w) {
    var f = w && w.features;
    if (!f || !f["standard:connect"] || !f["solana:signTransaction"]) return false;
    return !(w.chains && w.chains.length && w.chains.indexOf(api.facts.walletChain) < 0);
  }

  function b64(bytes) {
    var text = "";
    for (var i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
    return btoa(text);
  }

  function unb64(text) {
    var raw = atob(text);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  // The choice between several wallets, under the page's buttons.
  function list() {
    var node = document.getElementById("wallet-list");
    if (node) return node;
    node = document.createElement("div");
    node.id = "wallet-list";
    node.className = "actions";
    node.hidden = true;
    var actions = api.el("reject").parentNode;
    actions.parentNode.insertBefore(node, actions.nextSibling);
    return node;
  }

  function render() {
    var node = list();
    node.textContent = "";
    for (var i = 0; i < wallets.length; i += 1) {
      var b = document.createElement("button");
      b.setAttribute("data-act", "pick");
      b.setAttribute("data-wallet", String(i));
      var icon = iconOf(wallets[i]);
      if (icon) {
        var img = document.createElement("img");
        img.src = icon;
        img.width = 18;
        img.height = 18;
        img.alt = "";
        b.appendChild(img);
      }
      b.appendChild(document.createTextNode(name(wallets[i])));
      node.appendChild(b);
    }
  }

  function showWallets() {
    if (api.isDone() || account) return;
    var any = wallets.length > 0;
    api.show("no-wallet", !any && looked);
    api.show("connect", any);
  }

  function addWallet(w) {
    if (!usable(w)) return;
    for (var i = 0; i < wallets.length; i += 1) if (wallets[i] === w) return;
    wallets.push(w);
    showWallets();
    var node = document.getElementById("wallet-list");
    if (node && !node.hidden) render();
  }

  // Wallet Standard discovery: wallets that loaded first answer app-ready, later ones announce themselves.
  function discover() {
    var registry = { register: function () {
      for (var i = 0; i < arguments.length; i += 1) addWallet(arguments[i]);
      return function () {};
    } };
    window.addEventListener("wallet-standard:register-wallet", function (event) {
      if (event && typeof event.detail === "function") {
        try { event.detail(registry); } catch (e) { /* a broken wallet must not break the page */ }
      }
    });
    try { window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: registry })); } catch (e) { /* no wallets */ }
  }

  function use(w) {
    wallet = w;
    walletAccount = null;
    var choice = document.getElementById("wallet-list");
    if (choice) choice.hidden = true;
    api.setBusy(true);
    api.say("Check " + name(w) + ": it is asking to connect to this page.");
    Promise.resolve(w.features["standard:connect"].connect())
      .then(function (out) {
        var accounts = (out && out.accounts && out.accounts.length ? out.accounts : w.accounts) || [];
        if (!accounts.length) throw new Error("no account was shared");
        walletAccount = accounts[0];
        return api.post("/account", { address: walletAccount.address });
      })
      .then(function (answer) {
        if (!answer.ok) throw new Error(answer.data.error || "the approval server would not prepare this payment");
        account = walletAccount.address;
        api.el("account").textContent = account;
        api.show("account-label", true);
        api.show("account", true);
        api.show("connect", false);
        api.show("approve", true);
        api.setBusy(false);
        api.say("Ready. Press \\u201cReview in wallet\\u201d and check the amount in " + name(w) + ".");
      })
      .catch(function (err) {
        api.setBusy(false);
        api.say("Could not connect: " + api.reason(err), "bad");
      });
  }

  function connect(a) {
    api = a;
    if (api.isDone()) return;
    if (wallets.length === 1) return use(wallets[0]);
    if (wallets.length === 0) {
      looked = true;
      showWallets();
      return;
    }
    render();
    api.show("wallet-list", true);
    api.say("More than one wallet is installed. Choose the one to use.");
  }

  function saidNo(err) {
    return !!err && (err.code === 4001 || /reject|declin|denied|cancel/i.test(String(err.message || err)));
  }

  function approve(a) {
    api = a;
    if (!wallet || !walletAccount || !account) return;
    var signed = false;
    api.setBusy(true);
    api.say("Preparing the transaction...");
    api.post("/prepare", { address: account })
      .then(function (answer) {
        if (!answer.ok) {
          var refused = new Error(answer.data.error || "the client could not build the transaction");
          refused.client = true;
          throw refused;
        }
        api.say("Check " + name(wallet) + ": it is asking you to sign this payment. The seller pays the network fee and sends it.");
        return Promise.resolve(wallet.features["solana:signTransaction"].signTransaction({
          account: walletAccount,
          chain: api.facts.walletChain,
          transaction: unb64(answer.data.transaction)
        })).then(function (outputs) {
          var out = outputs && outputs[0];
          if (!out || !out.signedTransaction) throw new Error("the wallet returned no signed transaction");
          return out.signedTransaction;
        }, function (err) {
          var failed = new Error(api.reason(err));
          failed.wallet = err || true;
          throw failed;
        });
      })
      .then(function (signedTransaction) {
        signed = true;
        return api.post("/signed", { address: account, signedTransaction: b64(signedTransaction) });
      })
      .then(function (answer) {
        if (!answer.ok) {
          api.setBusy(false);
          api.say(answer.data.error || "That transaction was not accepted; you can try again.", "bad");
          return;
        }
        api.ended("signed");
      })
      .catch(function (err) {
        api.setBusy(false);
        if (signed) api.say("Your wallet signed, but the client did not confirm it received the transaction: " + api.reason(err) + ". Check the command result before trying again.", "bad");
        else if (err && err.wallet && saidNo(err.wallet)) api.rejectedInWallet();
        else if (err && err.wallet) api.say("Your wallet did not return a signed transaction: " + api.reason(err) + ". Nothing was sent; you can try again, or reject.", "bad");
        else api.say(api.reason(err), "bad");
      });
  }

  function init(a) {
    api = a;
    // What the page says when no Solana wallet is found: one to install, and that rejecting needs none.
    var note = api.el("no-wallet");
    note.textContent = "A Solana wallet (Phantom, Solflare, Backpack, ...) is needed to sign this payment. Install one, for example Phantom from ";
    var link = document.createElement("a");
    link.href = "${PHANTOM_DOWNLOAD_URL}";
    link.rel = "noreferrer noopener";
    link.textContent = "${PHANTOM_DOWNLOAD_URL}";
    note.appendChild(link);
    note.appendChild(document.createTextNode(", then reload this page. You can still reject the payment without one."));
    api.show("connect", false);
    document.addEventListener("click", function (event) {
      var button = event.target && event.target.closest ? event.target.closest("button[data-act]") : null;
      if (!button || button.disabled || button.getAttribute("data-act") !== "pick" || api.isDone()) return;
      var chosen = wallets[Number(button.getAttribute("data-wallet"))];
      if (chosen) use(chosen);
    });
    discover();
    showWallets();
    setTimeout(function () { looked = true; showWallets(); }, 1200);
  }

  window.superstablesStep = { init: init, connect: connect, approve: approve };
})();
`;

export const solanaStep: WalletStep = {
  kind: "solana-transaction",
  routes: ["/account", "/prepare", "/signed"],

  account(value: unknown): string | undefined {
    return isSolanaAddress(value) ? value : undefined;
  },

  async prepare(record: StepRecord, account: string): Promise<StepAnswer> {
    // The transaction is built when the owner presses "Review in wallet", so its blockhash is fresh: nothing yet.
    record.prepared = undefined;
    const feePayer = feePayerOf(record);
    if (!feePayer) return { http: 409, body: { error: "the seller named no fee payer, so this payment cannot be built; nothing was signed" } };
    if (feePayer === account) {
      return { http: 409, body: { error: "the seller's fee payer is your own address, so this payment cannot be built; nothing was signed. Connect another account, or reject" } };
    }
    return {
      http: 200,
      body: { summary: `${record.verified.amountDecimal} ${record.verified.asset} to ${record.verified.recipient} on ${record.verified.networkLabel}` },
    };
  },

  async answer(record: StepRecord, leaf: string, body: Record<string, unknown>): Promise<StepAnswer> {
    const address = typeof body.address === "string" ? body.address : "";
    if (!record.account) return { http: 409, body: { error: "connect an account first: there is nothing prepared to sign" } };
    if (address !== record.account) {
      return { http: 400, body: { error: `this payment was prepared for ${record.account}; connect that account again, or reconnect to prepare a new one` } };
    }
    if (leaf === "/prepare") return build(record, record.account);
    if (leaf === "/signed") return signed(record, record.account, body.signedTransaction);
    return { http: 404, body: { error: "no such route" } };
  },

  pageFacts(record: StepRecord) {
    const network = record.network;
    return {
      chainIdHex: "",
      chainName: network.wallet.chainName || shortLabel(network),
      rpcUrl: network.rpc,
      explorer: network.explorer,
      nativeCurrency: network.wallet.nativeCurrency,
      walletChain: network.wallet.walletChain ?? SOLANA_DEVNET.wallet.walletChain,
    };
  },

  words: {
    lede: "Check the amount and the recipient, then sign with your Solana wallet, or reject. Your wallet keeps its key.",
    fineprint: (facts) =>
      `Signing approves this one transfer of ${facts.amountDecimal} ${facts.asset} and nothing else; the seller pays the network fee and sends it. ` +
      "Before you sign, switch your wallet to Solana devnet. For example, in Phantom: open Settings, Developer Settings, turn on Testnet Mode and pick Solana Devnet.",
  },

  script: SOLANA_STEP_SCRIPT,
};

/** POST /prepare: a fresh transaction for the connected account, on a blockhash from an RPC that is Solana devnet. */
async function build(record: StepRecord, owner: string): Promise<StepAnswer> {
  const feePayer = feePayerOf(record);
  if (!feePayer || feePayer === owner) return { http: 409, body: { error: "the seller's fee payer cannot pay for this account, so nothing was built" } };
  let latest: { blockhash: string; lastValidBlockHeight: number; slot?: number };
  let built: BuiltPayment;
  for (let attempt = 0; ; attempt += 1) {
    try {
      latest = await devnetBlockhash();
    } catch (err) {
      if (err instanceof NotDevnetError) return { http: 409, body: { error: `${err.message}; nothing was signed` } };
      return { http: 503, body: { error: "Solana devnet did not answer, so the payment could not be built; nothing was signed. Try again" } };
    }
    built = buildPayment({
      owner,
      recipient: record.verified.recipient,
      mint: SOLANA_DEVNET.token.address,
      decimals: SOLANA_DEVNET.token.decimals,
      amountAtomic: record.verified.amountAtomic,
      feePayer,
      blockhash: latest.blockhash,
      memo: memoOf(record),
    });
    const holder = issued.get(built.message);
    if (holder === undefined || holder === record.id) break;
    if (attempt >= REBUILDS) {
      return {
        http: 503,
        body: { error: "this payment came out the same transaction as an earlier one (the same terms, memo and blockhash), so it was not handed to your wallet; nothing was signed. Try again in a moment" },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, REBUILD_WAIT_MS));
  }
  issued.delete(built.message);
  issued.set(built.message, record.id);
  if (issued.size > ISSUED_KEPT) issued.delete(issued.keys().next().value!);
  const prepared: SolanaPrepared = { ...built, owner, lastValidBlockHeight: latest.lastValidBlockHeight, ...(latest.slot !== undefined ? { slot: latest.slot } : {}), builtAt: Date.now() };
  record.prepared = prepared;
  return { http: 200, body: { transaction: built.transaction, chain: SOLANA_DEVNET.wallet.walletChain } };
}

/** POST /signed: what the wallet signed, checked against what was built, and handed on as the signed result. */
async function signed(record: StepRecord, owner: string, value: unknown): Promise<StepAnswer> {
  const prepared = record.prepared as SolanaPrepared | undefined;
  if (!prepared || prepared.owner !== owner) {
    return { http: 409, body: { error: "press “Review in wallet” first: there is no transaction prepared for this account" } };
  }
  if (typeof value !== "string" || value.length > MAX_SIGNED_CHARS) return { http: 400, body: { error: "that is not a signed transaction" } };
  const checked = checkSigned(value, prepared);
  if (!checked.ok) {
    // The request stays pending on purpose: a wallet that changed the transaction, or another key, is not a decision.
    return { http: 400, body: { error: `${checked.reason}; nothing was accepted, and you can sign again`, code: checked.code } };
  }
  // A transaction that can no longer land in time is not passed on: the owner signs a fresh one instead.
  let late: boolean;
  try {
    late = (await devnetBlockHeight()) > prepared.lastValidBlockHeight - BLOCKS_TO_SPARE;
  } catch {
    late = Date.now() - prepared.builtAt > SIGNED_WITHIN_MS;
  }
  if (late) {
    record.prepared = undefined;
    return { http: 409, body: { error: "this transaction's blockhash is about to expire, so it was not accepted. Press “Review in wallet” to sign a fresh one" } };
  }
  return {
    http: 200,
    body: { status: "signed" },
    signed: {
      kind: "solana-transaction",
      transaction: checked.transaction,
      signature: checked.signature,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      ...(prepared.slot !== undefined ? { searchFromSlot: prepared.slot } : {}),
      signer: owner,
    },
  };
}
