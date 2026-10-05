// The page the owner opens to approve one payment with a browser wallet (MetaMask and
// anything else that speaks window.ethereum; a Solana wallet on Solana). One self-contained HTML string per request,
// served by the approval server on 127.0.0.1, with no build step and no external asset: a
// page that authorises a payment should be readable in full, in one file, by anyone who
// wants to check what it does before they sign.
//
// Three rules the markup follows.
//
//  1. The facts the server derived from the seller's requirement — amount, asset, network,
//     recipient — are rendered into the HTML itself, escaped. They are visible before a line
//     of JavaScript runs, and they are the only thing an approval is ever about.
//  2. Anything the agent said about the payment lives in its own block, labelled as not
//     verified. What the server checked and what the agent claimed must never look alike.
//  3. The key is the browser wallet's. This page asks it to sign typed data the server built;
//     it never sees a private key, and the signature goes straight back to loopback.
//
// The script is plain ES2017 with no bundler, so it is exported separately and parsed by a
// test: a syntax error here would only show up in front of a person about to pay. What the
// wallet is asked to do depends on the rail (./steps/): the main script below does the EVM
// steps (connect, switch chain, sign typed data); a rail whose wallet does something else
// brings a script of its own, which runs first and hands the main script its own `approve`.

import type { PaymentContext } from "../types.js";
import { esc, framePage, pageLook, type PageLook } from "./look.js";
import { eip3009Step } from "./steps/eip3009.js";
import type { WalletStep } from "./steps/types.js";

export { esc };

/** Everything the page shows and needs, all of it derived by the server. */
export interface ApprovalPageFacts {
  id: string;
  /** Which wallet step this page runs (the SignRequest kind). */
  step?: string;
  amountDecimal: number;
  asset: string;
  /** Atomic units, so the page can explain what the wallet's popup will show. */
  amountAtomic: string;
  recipient: string;
  network: string;
  networkLabel: string;
  assetAddress: string;
  expiresAt: number;
  /** EIP-155 chain id as the hex string window.ethereum expects, e.g. "0x14a34". */
  chainIdHex: string;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  /** What wallet_addEthereumChain is offered as the chain's own currency. */
  nativeCurrency?: { name: string; symbol: string; decimals: number };
  /** Solana: the Wallet Standard chain. */
  walletChain?: string;
  reported?: PaymentContext;
}

/** Where a person gets a browser wallet, when the page finds none. */
export const WALLET_DOWNLOAD_URL = "https://metamask.io/download";

/** JSON that is safe to inline: nothing in it can close the script element around it. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The page's own script. Exported so a test can parse it: there is no build step here, and a
 * syntax error would otherwise be found by the person holding the wallet.
 */
export const APPROVAL_PAGE_SCRIPT = `
(function () {
  var facts = JSON.parse(document.getElementById("approval-facts").textContent);
  var base = "/approve/" + encodeURIComponent(facts.id);
  var provider = window.ethereum;
  // A rail's own wallet step, when its page brings one (it ran first); the EVM steps below otherwise.
  var step = window.superstablesStep || null;
  var account = null;
  var typedData = null;
  var prepared = null;
  var locked = false;
  var busy = false;
  var done = false;
  var unanswered = 0;

  function el(id) { return document.getElementById(id); }
  function show(id, on) { el(id).hidden = !on; }

  function say(message, kind) {
    var box = el("say");
    box.hidden = false;
    box.className = kind ? "note " + kind : "note";
    box.textContent = message;
  }

  function reason(err) {
    if (!err) return "the wallet gave no reason";
    return String(err.message || err);
  }

  function setBusy(on) {
    busy = on;
    var buttons = document.querySelectorAll("button[data-act]");
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = on || done;
  }

  function countdown() {
    var left = Math.max(0, Math.round((facts.expiresAt - Date.now()) / 1000));
    el("expiry").textContent = String(left);
    // past its expiry the payment cannot be approved, whether or not the client is still there to say so
    if (left === 0 && !done && !busy) ended("expired");
  }

  function ended(status, why) {
    if (done) return;
    done = true;
    setBusy(false);
    show("connect", false);
    show("approve", false);
    show("reject", false);
    document.body.setAttribute("data-state", status);
    if (status === "signed") say(step && step.doneMessage ? step.doneMessage : "Signed. You can go back to the agent.", "good");
    else if (status === "expired") say("This request expired. Cancel any open wallet request, then ask the agent for a new approval link.", "bad");
    else say(why || "This payment was rejected. Cancel any open wallet request.", "bad");
  }

  function post(path, body) {
    return fetch(base + path, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function refresh() {
    countdown();
    if (done) return Promise.resolve();
    return fetch(base + "/state", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (state) {
        unanswered = 0;
        if (!state) return;
        if (state.status !== "pending") ended(state.status, state.reason);
      })
      .catch(function () {
        // The client serves this page from this computer; when it stops answering, the command that opened the page
        // has ended and nothing can be approved here any more. One miss can be a hiccup; three are not.
        unanswered += 1;
        if (unanswered >= 3 && !busy) ended("gone", "The command that opened this page has stopped, so this payment can no longer be approved here. Cancel any open wallet request, and ask the agent for a new approval link if you still want to pay.");
      });
  }

  function switchChain() {
    return provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: facts.chainIdHex }] });
  }

  // The wallet is asked which chain it is on, and anything but the payment's chain stops here: a wallet that stayed
  // where it was, or added the chain without switching to it, never signs or sends for this page.
  function verifyChain() {
    return provider.request({ method: "eth_chainId" }).then(function (id) {
      if (Number(id) !== Number(facts.chainIdHex)) throw new Error("your wallet is on another chain; switch it to " + facts.chainName + " and try again");
    });
  }

  function ensureChain() {
    return switchChain().catch(function (err) {
      // 4902: the wallet has never heard of this chain. Offer to add it, then switch to it.
      if (err && (err.code === 4902 || (err.data && err.data.originalError && err.data.originalError.code === 4902))) {
        return provider.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: facts.chainIdHex,
            chainName: facts.chainName,
            rpcUrls: [facts.rpcUrl],
            nativeCurrency: facts.nativeCurrency || { name: "Ether", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: [facts.explorer]
          }]
        }).then(switchChain);
      }
      throw err;
    }).then(verifyChain);
  }

  function connect() {
    if (step && step.connect) return step.connect(api);
    if (locked) return;
    setBusy(true);
    say("Check your wallet: it is asking which account to use.");
    provider.request({ method: "eth_requestAccounts" })
      .then(function (accounts) {
        if (!accounts || accounts.length === 0) throw new Error("no account was shared");
        account = accounts[0];
        return ensureChain();
      })
      .then(function () { return post("/account", { address: account }); })
      .then(function (answer) {
        if (!answer.ok) throw new Error(answer.data.error || "the approval server would not prepare this payment");
        prepared = answer.data;
        typedData = answer.data.typedData || null;
        el("account").textContent = account;
        show("account-label", true);
        show("account", true);
        show("connect", false);
        show("approve", true);
        setBusy(false);
        say("Ready. Press \\u201cReview in wallet\\u201d and check the amount in your wallet.");
      })
      .catch(function (err) {
        setBusy(false);
        if (err && err.code === 4001) say("You cancelled the connection; nothing was signed.", "bad");
        else say("Could not connect: " + reason(err), "bad");
      });
  }

  function approve() {
    if (step && step.approve) return step.approve(api);
    if (!typedData || !account) return;
    var signed = false;
    var asking = false;
    setBusy(true);
    ensureChain()
      .then(function () {
        asking = true;
        say("Check your wallet: it is asking you to sign this payment.");
        return provider.request({
          method: "eth_signTypedData_v4",
          params: [account, JSON.stringify(typedData)]
        });
      })
      .then(function (signature) { signed = true; return post("/signature", { address: account, signature: signature }); })
      .then(function (answer) {
        if (!answer.ok) {
          setBusy(false);
          say(answer.data.error || "That signature was not accepted; you can try again.", "bad");
          return;
        }
        ended("signed");
      })
      .catch(function (err) {
        setBusy(false);
        if (signed) say("Your wallet signed, but the client did not confirm it received the signature: " + reason(err) + ". Check the command result before trying again.", "bad");
        // Declining to switch chains is not declining the payment: nothing was asked yet, and the owner can try again.
        else if (!asking) say("This page could not confirm that your wallet is on " + facts.chainName + ", so it did not ask it to sign: " + reason(err), "bad");
        else if (err && err.code === 4001) rejectedInWallet();
        else say("The wallet could not sign this: " + reason(err), "bad");
      });
  }

  // A rejection in the wallet is the owner's answer: end the payment, so the agent hears it now, not at expiry. Once a
  // wallet was asked to send the payment itself, the client cannot take this page's word that nothing was sent, and
  // says so (status "unknown").
  function rejectedInWallet() {
    setBusy(true);
    post("/reject", { by: "wallet" })
      .then(function (answer) {
        if (answer.ok && answer.data.status === "unknown") {
          ended("unknown", "You rejected this payment in your wallet. Your wallet had already been asked to send it, so the client records it as unconfirmed until the chain shows the payment. Check the command result.");
          return;
        }
        if (answer.ok) { ended("denied", "You rejected this payment in your wallet. Nothing was signed."); return; }
        if (answer.data.status) { ended(answer.data.status, answer.data.reason); return; }
        setBusy(false);
        say("You rejected in your wallet; nothing was signed. The client did not record the rejection: press Reject, or check the command result.", "bad");
      })
      .catch(function () { setBusy(false); say("You rejected in your wallet; nothing was signed. The client is not answering. Check that the agent is still running.", "bad"); });
  }

  function reject() {
    setBusy(true);
    post("/reject", {})
      .then(function (answer) {
        if (answer.ok) { ended("denied", "You rejected this payment. Cancel any open wallet request."); return; }
        // 409: the payment ended first (signed, expired, rejected); show that, not a rejection
        if (answer.data.status) { ended(answer.data.status, answer.data.reason); return; }
        setBusy(false);
        say(answer.data.error || "The client did not accept the rejection. Check the command result.", "bad");
      })
      .catch(function () { setBusy(false); say("The client is not answering. Check that the agent is still running.", "bad"); });
  }

  // What a rail's own step works with: the same helpers, and the state this script keeps.
  var api = {
    facts: facts,
    el: el,
    show: show,
    say: say,
    reason: reason,
    setBusy: setBusy,
    ended: ended,
    post: post,
    rejectedInWallet: rejectedInWallet,
    ensureChain: ensureChain,
    verifyChain: verifyChain,
    provider: function () { return provider; },
    account: function () { return account; },
    prepared: function () { return prepared; },
    isDone: function () { return done; },
    // the wallet was asked to send: nothing is prepared again, and switching accounts changes nothing
    lock: function () { locked = true; }
  };

  document.addEventListener("click", function (event) {
    var button = event.target && event.target.closest ? event.target.closest("button[data-act]") : null;
    if (!button || button.disabled || busy) return;
    var act = button.getAttribute("data-act");
    if (act === "connect") connect();
    else if (act === "approve") approve();
    else if (act === "reject") reject();
  });

  if (step && step.init) step.init(api);
  else if (!provider) {
    show("no-wallet", true);
    show("connect", false);
  }

  if (provider && provider.on && !(step && step.init)) {
    // Switching accounts mid-flow must re-prepare the payment for the new one.
    provider.on("accountsChanged", function (accounts) {
      if (done || locked || !accounts || accounts.length === 0) return;
      account = accounts[0];
      typedData = null;
      prepared = null;
      show("approve", false);
      show("connect", true);
      el("account").textContent = account;
      say("You switched accounts. Connect again so this payment is prepared for " + account + ".");
    });
    // A wallet that moves to another chain before it is asked must be brought back first: nothing prepared stays usable.
    provider.on("chainChanged", function (chainId) {
      if (done || locked || Number(chainId) === Number(facts.chainIdHex)) return;
      typedData = null;
      prepared = null;
      show("approve", false);
      show("connect", true);
      say("Your wallet switched to another chain. Connect again to switch it back to " + facts.chainName + ".");
    });
  }

  refresh();
  setInterval(refresh, 2000);
  setInterval(countdown, 1000);
})();
`;

function reportedBlock(reported?: PaymentContext): string {
  const rows: string[] = [];
  if (reported?.serviceName) rows.push(`<div>Service: ${esc(reported.serviceName)}</div>`);
  if (reported?.target) rows.push(`<div class="mono">${esc(reported.target)}</div>`);
  if (reported?.description) rows.push(`<div>${esc(reported.description)}</div>`);
  if (rows.length === 0) rows.push("<div>The agent provided no payment details.</div>");
  return `<div class="reported"><strong>Reported by the agent (not verified)</strong>${rows.join("")}</div>`;
}

/** The network's name, without the "(testnet)" the bar's pill already says. */
function networkCell(facts: ApprovalPageFacts): string {
  const label = facts.networkLabel || facts.network;
  return esc(label.replace(/\s*\(testnet\)\s*/i, "").trim() || label);
}

/** The whole page for one pending approval, facts and all, ready to serve. */
export function approvalPage(facts: ApprovalPageFacts, step: WalletStep = eip3009Step, look: PageLook = pageLook()): string {
  const seconds = Math.max(0, Math.round((facts.expiresAt - Date.now()) / 1000));
  const body = `
  <div id="no-wallet" class="note bad" hidden>
    MetaMask (or another browser wallet) is needed to sign this payment. Install one at
    <a href="${WALLET_DOWNLOAD_URL}" rel="noreferrer noopener">${WALLET_DOWNLOAD_URL}</a>, then reload this page.
    You can still reject the payment without one.
  </div>

  <div class="card">
    <div class="amount">${esc(facts.amountDecimal)}<span>${esc(facts.asset)}</span></div>
    <dl class="rows">
      <dt>To</dt><dd class="mono">${esc(facts.recipient)}</dd>
      <dt>Network</dt><dd>${networkCell(facts)}</dd>
      <dt>Token</dt><dd class="mono">${esc(facts.assetAddress)}</dd>
      <dt>Expires in</dt><dd><span id="expiry">${seconds}</span> s</dd>
      <dt id="account-label" hidden>Paying from</dt><dd id="account" class="mono" hidden></dd>
    </dl>
    ${reportedBlock(facts.reported)}
    <div id="say" class="note" hidden></div>
    <div class="actions">
      <button id="connect" class="primary" data-act="connect">Connect wallet</button>
      <button id="approve" class="primary" data-act="approve" hidden>Review in wallet</button>
      <button id="reject" data-act="reject">Reject</button>
    </div>
    <p class="fineprint">
      ${esc(step.words.fineprint(facts))}
    </p>
  </div>

<script id="approval-facts" type="application/json">${inlineJson(facts)}</script>
${step.script ? `<script>${step.script}</script>\n` : ""}<script>${APPROVAL_PAGE_SCRIPT}</script>`;
  return framePage({
    look,
    title: "Approve a payment",
    eyebrow: "Payment request",
    lede: step.words.lede,
    testnet: /testnet/i.test(facts.networkLabel || facts.network),
    body,
  });
}

/** What an unknown, or already forgotten, approval id gets. Same page furniture, no buttons. */
export function approvalNotFoundPage(look: PageLook = pageLook()): string {
  return framePage({
    look,
    title: "This approval link is unavailable",
    eyebrow: "Payment request",
    body: `
  <div class="note bad">
    The request may have ended or the client may have restarted. Cancel any open wallet request.
    Check the command result and wallet activity before asking for a new one.
  </div>`,
  });
}
