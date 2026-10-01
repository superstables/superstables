// The page an owner opens to do one thing in their own browser wallet: connect it (and sign
// a free sign-in message that proves the address is theirs), or approve one transaction the
// command built. It is the sibling of the payment approval page (approval-page.ts): same look
// (look.ts), same rules, served by the owner approval server on 127.0.0.1.
//
// Two wallet families. evm (and Tempo): an EIP-1193 wallet found through EIP-6963, or
// window.ethereum when none announces itself, which sends the transaction itself. solana: a
// Wallet Standard wallet, which only signs; the command checks the signed bytes and sends them.
// With several wallets installed the owner chooses one, and the page uses only that one.
//
//  1. The terms are rendered into the HTML by the server, escaped, from the command's own plan.
//     Nothing an agent typed reaches this page.
//  2. The wallet is asked for exactly the transaction the server built: the page sends the
//     `to`, `data` and `value` it was given (solana: the bytes the server built) and nothing
//     else. The command then reads the chain to see what really happened.
//  3. The key stays in the wallet. The page never sees one.
//
// The script is plain ES2017 with no bundler, exported so a test can parse it.

import { WALLET_DOWNLOAD_URL, esc, inlineJson } from "./approval-page.js";
import { framePage, pageLook, type PageLook } from "./look.js";

const PHANTOM_DOWNLOAD_URL = "https://phantom.com/download";

/** One line of the terms table. */
export interface OwnerTermRow {
  label: string;
  value: string;
  mono?: boolean;
}

/** What the owner is asked to approve, in plain words, all of it derived by the command. */
export interface OwnerTerms {
  /** Short title: "Give your agent a budget". */
  title: string;
  /** The big number, e.g. "0.01", and its unit, e.g. "USDC". Optional for a connect. */
  amount?: string;
  unit?: string;
  /** One sentence under the amount. */
  summary: string;
  rows: OwnerTermRow[];
  /** What the chain enforces and what it does not. Empty lists are left out. */
  enforced: string[];
  notEnforced: string[];
  /** Small print: how to undo it, what the wallet popup will show. */
  notes: string[];
}

/** Chain parameters in the shape wallet_addEthereumChain expects (chainId as a number here). */
export interface OwnerChain {
  /** Which wallets the page talks to: "evm" (the default; also Tempo) or "solana" (Wallet Standard). */
  family?: "evm" | "solana";
  /** evm: the chain id. solana: 0. */
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  /** Added after the hash in explorer links, e.g. "?cluster=devnet". */
  explorerQuery?: string;
  /** solana: the Wallet Standard chain, e.g. "solana:devnet". */
  walletChain?: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  testnet: boolean;
}

/** Everything the page's script needs. */
export interface OwnerPageFacts {
  id: string;
  kind: "connect" | "evm-transaction" | "solana-transaction";
  chain: OwnerChain;
  chainIdHex: string;
  /** The only account that may act (a transaction), or undefined (a connect: any account). */
  account?: string;
  /** The owner address on record, shown prominently; undefined on a first setup. */
  recordedOwner?: string;
  /** Exactly what the wallet is asked to send. */
  transaction?: { to: string; data: string; value: string };
  /** The sign-in message a connect asks the wallet to sign. */
  message?: string;
  expiresAt: number;
}

const OWNER_STYLE = `
  /* What the chain enforces and what it does not, side by side. */
  .limits { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 24px; }
  .limits > div { padding: 14px 16px; border: 1px solid var(--good-line); border-radius: 6px; background: var(--good-bg); }
  .limits > div.no { border-color: var(--bad); background: var(--bad-bg); }
  .limits strong { display: block; margin: 0 0 8px; font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); }
  .limits div.no strong { color: var(--bad); }
  .limits ul { margin: 0; padding-left: 18px; font-size: 14.5px; }
  .limits li + li { margin-top: 6px; }
  .limits > div:only-child { grid-column: 1 / -1; }
  @media (max-width: 600px) { .limits { grid-template-columns: minmax(0, 1fr); } }
  .owner-box { font-size: 15px; }
  .owner-box .mono { display: block; margin: 6px 0; font-size: 14px; font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
  #wallet-list { margin-top: 12px; }
  #wallet-list button { height: 40px; padding: 0 14px; font-size: 14px; background: var(--bg-2); }
  #wallet-list img { width: 18px; height: 18px; border-radius: 4px; }
`;

/**
 * The page's own script. Exported so a test can parse it: there is no build step here, and a
 * syntax error would otherwise be found by the person holding the wallet.
 */
export const OWNER_PAGE_SCRIPT = `
(function () {
  var facts = JSON.parse(document.getElementById("owner-facts").textContent);
  var base = "/owner/" + encodeURIComponent(facts.id);
  var solana = facts.chain.family === "solana";
  // Wallets found on this page: { name, icon, provider } (evm, EIP-6963) or { name, icon, wallet } (solana, Wallet Standard).
  var choices = [];
  // The one the owner chose. Once it has shared an account it is used for everything on this page.
  var chosen = null;
  var kept = false;
  var provider = null;
  var watched = [];
  var account = null;
  var wallet = null;
  var walletAccount = null;
  var busy = false;
  var done = false;
  var sentHash = null;

  function el(id) { return document.getElementById(id); }
  function show(id, on) { var node = el(id); if (node) node.hidden = !on; }

  function say(message, kind, link) {
    var box = el("say");
    box.hidden = false;
    box.className = kind ? "note " + kind : "note";
    box.textContent = message;
    if (link) {
      var a = document.createElement("a");
      a.href = link;
      a.rel = "noreferrer noopener";
      a.target = "_blank";
      a.textContent = "View transaction on explorer.";
      box.appendChild(document.createTextNode(" "));
      box.appendChild(a);
    }
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
    var m = Math.floor(left / 60);
    var s = left % 60;
    el("expiry").textContent = m + ":" + (s < 10 ? "0" : "") + s;
  }

  function txLink(hash) { return facts.chain.explorer.replace(/\\/+$/, "") + "/tx/" + hash + (facts.chain.explorerQuery || ""); }

  function ended(state) {
    if (done) return;
    done = true;
    setBusy(false);
    show("connect", false);
    show("wallet-list", false);
    show("network-hint", false);
    show("send", false);
    show("reject", false);
    show("expiry-row", false);
    show("expiry-val", false);
    show("fineprint", false);
    document.body.setAttribute("data-state", state.status);
    // the address the command recorded, even when this browser did not connect it: the owner checks it is their wallet
    if (state.address) {
      el("account").textContent = state.address;
      show("account-row", true);
      show("account", true);
    }
    if (state.status === "confirmed") say(state.message || "Confirmed. You can return to the agent.", "good", state.hash ? txLink(state.hash) : null);
    else if (state.status === "failed") say(state.message || "Not confirmed. Check the command result and wallet activity before trying again.", "bad", state.hash ? txLink(state.hash) : null);
    else if (state.status === "expired") say("This link expired. If your wallet still has a request open, cancel it. Check the command result and wallet activity before requesting a new link.", "bad");
    else say(state.mine || "This request was rejected. Check the command result. Rejecting this page does not cancel a transaction already submitted in your wallet.", "bad");
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
        if (!state) return;
        if (state.status === "sent" && !sentHash) {
          sentHash = state.hash;
          waiting(state.hash);
        }
        if (["confirmed", "failed", "rejected", "expired"].indexOf(state.status) >= 0) ended(state);
      })
      .catch(function () {
        if (!done) say("The command is not answering. Cancel any open wallet request. Check wallet activity and the budget status before trying again.", "bad");
      });
  }

  function waiting(hash) {
    document.body.setAttribute("data-state", "sent");
    show("network-hint", false);
    show("send", false);
    show("reject", false);
    show("expiry-row", false);
    show("expiry-val", false);
    say("Transaction submitted. The command is checking the result on chain. Keep this page open. Do not submit it again.", null, hash ? txLink(hash) : null);
  }

  function ensureChain() {
    return provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: facts.chainIdHex }] })
      .catch(function (err) {
        // 4902: the wallet does not know this chain yet. Add it, then it is selected.
        if (err && (err.code === 4902 || (err.data && err.data.originalError && err.data.originalError.code === 4902))) {
          return provider.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: facts.chainIdHex,
              chainName: facts.chain.chainName,
              rpcUrls: [facts.chain.rpcUrl],
              nativeCurrency: facts.chain.nativeCurrency,
              blockExplorerUrls: [facts.chain.explorer]
            }]
          });
        }
        throw err;
      })
      .then(function () { return provider.request({ method: "eth_chainId" }); })
      .then(function (id) {
        if (String(id).toLowerCase() !== facts.chainIdHex.toLowerCase()) {
          throw new Error("the wallet is on another network; switch it to " + facts.chain.chainName + " and connect again");
        }
      });
  }

  function hexOf(text) {
    var bytes = new TextEncoder().encode(text);
    var out = "0x";
    for (var i = 0; i < bytes.length; i += 1) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return out;
  }

  function connect() {
    setBusy(true);
    say("Check your wallet: it is asking which account to use.");
    provider.request({ method: "eth_requestAccounts" })
      .then(function (accounts) {
        if (!accounts || accounts.length === 0) throw new Error("no account was shared");
        account = accounts[0];
        kept = true;
        el("account").textContent = account;
        show("account-row", true);
        show("account", true);
        if (facts.kind === "connect") {
          say("Check your wallet: sign the message to prove this address is yours. It grants no spending permission and has no network fee.");
          return provider.request({ method: "personal_sign", params: [hexOf(facts.message), account] })
            .then(function (signature) { return post("/connect", { address: account, signature: signature }); })
            .then(function (answer) {
              if (!answer.ok) throw new Error(answer.data.error || "the command did not accept this signature");
              document.body.setAttribute("data-state", "connected");
              show("connect", false);
              show("reject", false);
              setBusy(false);
              say("Connected. The command is recording your address.");
            });
        }
        return ensureChain()
          .then(function () { return post("/account", { address: account }); })
          .then(function (answer) {
            if (!answer.ok) throw new Error(answer.data.error || "the command would not prepare this for that account");
            document.body.setAttribute("data-state", "ready");
            show("connect", false);
            show("send", true);
            setBusy(false);
            say("Review the terms above. Press \\u201cReview in wallet\\u201d and check the transaction in the wallet popup.");
          });
      })
      .catch(function (err) {
        setBusy(false);
        if (err && err.code === 4001) say("You cancelled in your wallet. Nothing was sent. You can connect again, or reject.", "bad");
        else say("Could not connect: " + reason(err), "bad");
      });
  }

  function send() {
    if (!account || !facts.transaction) return;
    setBusy(true);
    say("Review the transaction and network fee in your wallet. Confirm only if they match your intent.");
    post("/sending", { address: account })
      .then(function (answer) {
        if (!answer.ok) throw new Error(answer.data.error || "the command will not take this transaction any more");
        return provider.request({
          method: "eth_sendTransaction",
          params: [{ from: account, to: facts.transaction.to, data: facts.transaction.data, value: facts.transaction.value }]
        });
      })
      .then(function (hash) {
        sentHash = hash;
        waiting(hash);
        return post("/sent", { address: account, hash: hash });
      })
      .then(function (answer) {
        if (answer && !answer.ok) say(answer.data.error || "The command did not accept the transaction hash. Check wallet activity and the budget status before trying again.", "bad");
      })
      .catch(function (err) {
        if (err && err.code === 4001) {
          post("/reject", { by: "wallet" }).then(function () {
            ended({ status: "rejected", mine: "Your wallet reported that you rejected this request. This link is closed. The command cannot prove from this page that nothing was submitted, so it reports the result as unknown until it checks the chain. Any existing budget stays in effect." });
          });
          return;
        }
        setBusy(false);
        say("The wallet returned an error. The transaction may have been submitted. Check wallet activity before trying again: " + reason(err), "bad");
      });
  }

  // ── solana: a Wallet Standard wallet signs, the command checks and sends ────────────────

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

  function usable(w) {
    var f = w && w.features;
    if (!f || !f["standard:connect"]) return false;
    if (w.chains && w.chains.length && w.chains.indexOf(facts.chain.walletChain) < 0) return false;
    return facts.kind === "connect" ? !!f["solana:signMessage"] : !!f["solana:signTransaction"];
  }

  // ── choosing a wallet: the same list for both families ──────────────────────────────────

  function label(c) {
    var name = String((c && c.name) || "").replace(/\\s+/g, " ").trim().slice(0, 40);
    return name || "Unnamed wallet";
  }

  // An icon comes from the wallet itself: only an image data URI is shown, and only as an image.
  function iconOf(c) {
    var icon = c && c.icon;
    return typeof icon === "string" && icon.slice(0, 11).toLowerCase() === "data:image/" ? icon : null;
  }

  function fallback() { return !solana && window.ethereum && typeof window.ethereum.request === "function"; }

  function showWallets() {
    var any = choices.length > 0 || !!fallback();
    show("no-wallet", !any);
    show("connect", any && !account && !done);
    el("connect").textContent = choices.length === 1 ? "Connect " + label(choices[0]) : "Connect wallet";
  }

  function renderChoices() {
    var list = el("wallet-list");
    list.textContent = "";
    for (var i = 0; i < choices.length; i += 1) {
      var b = document.createElement("button");
      b.setAttribute("data-act", "pick");
      b.setAttribute("data-wallet", String(i));
      var icon = iconOf(choices[i]);
      if (icon) {
        var img = document.createElement("img");
        img.src = icon;
        b.appendChild(img);
      }
      b.appendChild(document.createTextNode(label(choices[i])));
      list.appendChild(b);
    }
  }

  function addChoice(c) {
    choices.push(c);
    if (account || done || busy) return;
    showWallets();
    if (!el("wallet-list").hidden) renderChoices();
  }

  function addWallet(w) {
    if (!usable(w)) return;
    for (var i = 0; i < choices.length; i += 1) if (choices[i].wallet === w) return;
    addChoice({ name: w.name, icon: w.icon, wallet: w });
  }

  // Wallet Standard discovery: wallets that loaded first answer app-ready, later ones announce themselves.
  function discover() {
    var api = { register: function () {
      for (var i = 0; i < arguments.length; i += 1) addWallet(arguments[i]);
      return function () {};
    } };
    window.addEventListener("wallet-standard:register-wallet", function (event) {
      if (event && typeof event.detail === "function") {
        try { event.detail(api); } catch (e) { /* a broken wallet must not break the page */ }
      }
    });
    try { window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api })); } catch (e) { /* no wallets */ }
  }

  // EIP-6963 discovery: every installed EVM wallet announces itself, not only the one holding window.ethereum.
  function discoverEvm() {
    window.addEventListener("eip6963:announceProvider", function (event) {
      var d = event && event.detail;
      if (!d || !d.info || typeof d.info.name !== "string" || !d.provider || typeof d.provider.request !== "function") return;
      for (var i = 0; i < choices.length; i += 1) {
        if (choices[i].provider === d.provider || (d.info.uuid && choices[i].uuid === d.info.uuid)) return;
      }
      addChoice({ name: d.info.name, icon: d.info.icon, uuid: d.info.uuid, provider: d.provider });
    });
    try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch (e) { /* no wallets */ }
  }

  function watch(p) {
    if (!p.on || watched.indexOf(p) >= 0) return;
    watched.push(p);
    p.on("accountsChanged", function (accounts) {
      if (p !== provider || done || sentHash || !accounts || accounts.length === 0) return;
      if (account && String(accounts[0]).toLowerCase() === account.toLowerCase()) return;
      account = null;
      show("send", false);
      show("connect", true);
      say("You switched accounts. Connect again.");
    });
  }

  function use(c) {
    if (!c) return;
    chosen = c;
    show("wallet-list", false);
    if (solana) return connectSolana(c.wallet);
    provider = c.provider;
    watch(provider);
    connect();
  }

  function pickWallet() {
    if (kept && chosen) return use(chosen);
    if (choices.length === 1) return use(choices[0]);
    if (choices.length === 0) {
      if (fallback()) return use({ name: "", provider: window.ethereum });
      return showWallets();
    }
    renderChoices();
    show("wallet-list", true);
    say("More than one wallet is installed. Choose the one to use.");
  }

  function connectSolana(w) {
    wallet = w;
    show("wallet-list", false);
    setBusy(true);
    say("Check " + w.name + ": it is asking to connect to this page.");
    Promise.resolve(w.features["standard:connect"].connect())
      .then(function (out) {
        var accounts = (out && out.accounts && out.accounts.length ? out.accounts : w.accounts) || [];
        if (!accounts.length) throw new Error("no account was shared");
        walletAccount = accounts[0];
        account = walletAccount.address;
        kept = true;
        el("account").textContent = account;
        show("account-row", true);
        show("account", true);
        if (facts.kind === "connect") {
          say("Check " + w.name + ": sign the message to prove this address is yours. It grants no spending permission and has no network fee.");
          return Promise.resolve(w.features["solana:signMessage"].signMessage({ account: walletAccount, message: new TextEncoder().encode(facts.message) }))
            .then(function (outputs) {
              var o = outputs[0];
              return post("/connect", { address: account, signature: b64(o.signature), signedMessage: b64(o.signedMessage) });
            })
            .then(function (answer) {
              if (!answer.ok) throw new Error(answer.data.error || "the command did not accept this signature");
              document.body.setAttribute("data-state", "connected");
              show("connect", false);
              show("reject", false);
              setBusy(false);
              say("Connected. The command is recording your address.");
            });
        }
        return post("/account", { address: account })
          .then(function (answer) {
            if (!answer.ok) throw new Error(answer.data.error || "the command would not prepare this for that account");
            document.body.setAttribute("data-state", "ready");
            show("connect", false);
            show("send", true);
            setBusy(false);
            say("Review the terms above. Press \\u201cReview in wallet\\u201d and check the transaction in " + w.name + ".");
          });
      })
      .catch(function (err) {
        account = null;
        setBusy(false);
        show("connect", true);
        say("Could not finish connecting: " + reason(err) + ". Nothing was sent. You can connect again, or reject.", "bad");
      });
  }

  function sendSolana() {
    if (!account || !wallet) return;
    setBusy(true);
    say("Preparing the transaction...");
    post("/prepare", { address: account })
      .then(function (answer) {
        if (!answer.ok) throw new Error(answer.data.error || "the command could not build the transaction");
        say("Check " + wallet.name + ": review the transaction and fee before signing. The command will submit the signed transaction.");
        return Promise.resolve(wallet.features["solana:signTransaction"].signTransaction({ account: walletAccount, chain: facts.chain.walletChain, transaction: unb64(answer.data.transaction) }))
          .then(function (outputs) { return outputs[0].signedTransaction; }, function (err) {
            // the wallet did not sign, whatever its reason: nothing can be sent
            var e = new Error(reason(err));
            e.walletSaidNo = true;
            throw e;
          });
      })
      .then(function (signedTransaction) {
        say("Signed. The command checks that the transaction is unchanged before submitting it. Do not submit it again.");
        return post("/signed", { address: account, signedTransaction: b64(signedTransaction) });
      })
      .then(function (answer) {
        if (!answer.ok) {
          var e = new Error(answer.data.error || "the command did not send it");
          e.refused = true;
          throw e;
        }
        sentHash = answer.data.hash;
        waiting(sentHash);
      })
      .catch(function (err) {
        if (err && err.walletSaidNo) {
          post("/reject", { by: "wallet" }).then(function () {
            ended({ status: "rejected", mine: "Your wallet did not return a signed transaction (" + String(err.message).replace(/[.\\s]+$/, "") + "). The command did not submit it. Any existing budget stays in effect." });
          });
          return;
        }
        setBusy(false);
        say((err && err.refused ? "" : "Could not send this: ") + reason(err) + " Retry only if the command confirms nothing was submitted. Otherwise, check wallet activity and the budget status first.", "bad");
      });
  }

  function reject() {
    setBusy(true);
    post("/reject", { by: "page" })
      .then(function () { ended({ status: "rejected", mine: "This request is closed. Cancel any open wallet request too. A transaction already submitted can still take effect. Any existing budget stays in effect." }); })
      .catch(function () { setBusy(false); say("The command is not answering. Cancel any open wallet request and check the budget status.", "bad"); });
  }

  document.addEventListener("click", function (event) {
    var button = event.target && event.target.closest ? event.target.closest("button[data-act]") : null;
    if (!button || button.disabled || busy) return;
    var act = button.getAttribute("data-act");
    if (act === "connect") pickWallet();
    else if (act === "pick") use(choices[Number(button.getAttribute("data-wallet"))]);
    else if (act === "send") { if (solana) sendSolana(); else send(); }
    else if (act === "reject") reject();
  });

  show("connect", false);
  if (solana) discover();
  else discoverEvm();
  if (choices.length || fallback()) showWallets();
  // wallets injected before this script have answered by now; give slower ones a moment
  setTimeout(function () { if (!account && !done && !busy) showWallets(); }, 1200);

  document.body.setAttribute("data-state", "connect");
  refresh();
  setInterval(refresh, 1500);
  setInterval(countdown, 1000);
})();
`;

function list(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

const OWNER_LEDE = "Review the terms here, then confirm in your own wallet. Your wallet keeps its signing key.";

/** The whole page for one owner action, terms and all, ready to serve. */
export function ownerApprovalPage(facts: OwnerPageFacts, terms: OwnerTerms, look: PageLook = pageLook()): string {
  const left = Math.max(0, Math.round((facts.expiresAt - Date.now()) / 1000));
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const chainCell = esc(facts.chain.chainName);
  const rows = terms.rows
    .map((row) => `<dt>${esc(row.label)}</dt><dd${row.mono ? ' class="mono"' : ""}>${esc(row.value)}</dd>`)
    .join("\n      ");
  const limits =
    terms.enforced.length || terms.notEnforced.length
      ? `<div class="limits">
      ${terms.enforced.length ? `<div><strong>The chain enforces</strong>${list(terms.enforced)}</div>` : ""}
      ${terms.notEnforced.length ? `<div class="no"><strong>The chain does not enforce</strong>${list(terms.notEnforced)}</div>` : ""}
    </div>`
      : "";
  const solana = facts.chain.family === "solana";
  const primary = facts.kind === "connect" ? "" : `<button id="send" class="primary" data-act="send" hidden>Review in wallet</button>`;
  const noWallet = solana
    ? `A Solana wallet is needed in this browser (Phantom, Solflare, Backpack, ...). For example, install Phantom from
    <a href="${PHANTOM_DOWNLOAD_URL}" rel="noreferrer noopener">${PHANTOM_DOWNLOAD_URL}</a>, then reload this page.
    You can still reject without one.`
    : `An EVM wallet is needed in this browser (MetaMask, Rabby, Coinbase Wallet, ...). For example, install MetaMask from
    <a href="${WALLET_DOWNLOAD_URL}" rel="noreferrer noopener">${WALLET_DOWNLOAD_URL}</a>, then reload this page.
    You can still reject without one.`;
  // A Solana wallet cannot be switched to devnet by a page: the owner does it once in the wallet.
  const networkHint =
    solana && facts.kind !== "connect" && facts.chain.testnet
      ? `<div id="network-hint" class="note">Before you approve: switch your wallet to Solana devnet. For example, in Phantom: open Settings, Developer Settings, turn on Testnet Mode and pick Solana Devnet. If the wallet cannot simulate the transaction, its effects have not been checked by the wallet. Reject if you cannot verify what you are signing.</div>`
      : "";
  // Who this page acts for. Setup proves control of an address, not who the person is, so the
  // recorded owner is shown on every page: a person who is not that owner should stop here.
  const ownerBox = facts.recordedOwner
    ? `<div class="note owner-box">Recorded owner wallet${facts.kind === "connect" ? " (setup replaces it with the wallet you connect)" : ""}:
    <span class="mono">${esc(facts.recordedOwner)}</span>
    ${facts.kind === "connect" ? "Replace it only if you are its owner and mean to move the budget to another wallet." : "This page acts only for that wallet. If this isn't your wallet, stop: reject and do not connect."}</div>`
    : facts.kind === "connect"
      ? `<div class="note owner-box">Setup records the wallet you connect as the budget owner. Only the owner should do this, or someone with the owner watching. If an agent or someone else sent you this link and you are not the owner, stop and reject.</div>`
      : "";
  const body = `
  ${ownerBox}

  <div id="no-wallet" class="note bad" hidden>
    ${noWallet}
  </div>

  <div class="card">
    ${terms.amount ? `<div class="amount">${esc(terms.amount)}<span>${esc(terms.unit ?? "")}</span></div>` : ""}
    <p class="summary">${esc(terms.summary)}</p>
    <dl class="rows">
      ${rows}
      <dt>Network</dt><dd>${chainCell}</dd>
      <dt id="account-row" hidden>Connected wallet</dt><dd id="account" class="mono" hidden></dd>
      <dt id="expiry-row">Link expires in</dt><dd id="expiry-val"><span id="expiry">${clock}</span></dd>
    </dl>
    ${limits}
    ${networkHint}
    <div id="say" class="note" hidden></div>
    <div class="actions">
      <button id="connect" class="primary" data-act="connect">Connect wallet</button>
      ${primary}
      <button id="reject" data-act="reject">Reject</button>
    </div>
    <div id="wallet-list" class="actions" hidden></div>
    <div id="fineprint" class="fineprint">${terms.notes.map((note) => `<p>${esc(note)}</p>`).join("")}</div>
  </div>

<script id="owner-facts" type="application/json">${inlineJson(facts)}</script>
<script>${OWNER_PAGE_SCRIPT}</script>`;
  return framePage({
    look,
    title: terms.title,
    eyebrow: facts.kind === "connect" ? "Owner sign-in" : "Owner approval",
    lede: OWNER_LEDE,
    testnet: facts.chain.testnet,
    style: OWNER_STYLE,
    body,
  });
}

/** What an unknown, or already finished, link gets. Same furniture, no buttons. */
export function ownerNotFoundPage(look: PageLook = pageLook()): string {
  return framePage({
    look,
    title: "This link is unavailable",
    eyebrow: "Owner approval",
    style: OWNER_STYLE,
    body: `
  <div class="note bad">
    The request may have ended or the command may have stopped.
    Cancel any open wallet request. Check the command result and wallet activity before asking for a new link.
  </div>`,
  });
}
