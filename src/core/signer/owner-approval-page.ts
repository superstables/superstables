// The page an owner opens to do one thing in their own browser wallet: connect it (and sign
// a free sign-in message that proves the address is theirs), or send one transaction the
// command built. It is the sibling of the payment approval page (approval-page.ts): same look,
// same rules, served by the owner approval server on 127.0.0.1.
//
//  1. The terms are rendered into the HTML by the server, escaped, from the command's own plan.
//     Nothing an agent typed reaches this page.
//  2. The wallet is asked for exactly the transaction the server built: the page sends the
//     `to`, `data` and `value` it was given and nothing else. The command then reads the chain
//     to see what really happened; the hash the page reports back is only a pointer.
//  3. The key stays in the wallet. The page never sees one.
//
// The script is plain ES2017 with no bundler, exported so a test can parse it.

import { STYLE, WALLET_DOWNLOAD_URL, esc, inlineJson } from "./approval-page.js";

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
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  testnet: boolean;
}

/** Everything the page's script needs. */
export interface OwnerPageFacts {
  id: string;
  kind: "connect" | "evm-transaction";
  chain: OwnerChain;
  chainIdHex: string;
  /** The only account that may act (a transaction), or undefined (a connect: any account). */
  account?: string;
  /** Exactly what the wallet is asked to send. */
  transaction?: { to: string; data: string; value: string };
  /** The sign-in message a connect asks the wallet to sign. */
  message?: string;
  expiresAt: number;
}

const OWNER_STYLE = `
  .summary { margin: 6px 0 0; color: var(--muted); }
  .limits { margin-top: 16px; display: grid; gap: 10px; font-size: 13px; }
  .limits div { padding: 10px 14px; border: 1px solid var(--line); border-radius: 10px; }
  .limits div.no { border-color: var(--warn-line); background: var(--warn-bg); }
  .limits strong { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
  .limits ul { margin: 0; padding-left: 18px; }
  .fineprint p { margin: 0 0 6px; }
`;

/**
 * The page's own script. Exported so a test can parse it: there is no build step here, and a
 * syntax error would otherwise be found by the person holding the wallet.
 */
export const OWNER_PAGE_SCRIPT = `
(function () {
  var facts = JSON.parse(document.getElementById("owner-facts").textContent);
  var base = "/owner/" + encodeURIComponent(facts.id);
  var provider = window.ethereum;
  var account = null;
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
      a.textContent = "View it on the explorer.";
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

  function txLink(hash) { return facts.chain.explorer.replace(/\\/+$/, "") + "/tx/" + hash; }

  function ended(state) {
    if (done) return;
    done = true;
    setBusy(false);
    show("connect", false);
    show("send", false);
    show("reject", false);
    show("expiry-row", false);
    show("expiry-val", false);
    show("fineprint", false);
    document.body.setAttribute("data-state", state.status);
    if (state.status === "confirmed") say(state.message || "Done. You can go back to the agent.", "good", state.hash ? txLink(state.hash) : null);
    else if (state.status === "failed") say(state.message || "The command could not confirm this on chain.", "bad", state.hash ? txLink(state.hash) : null);
    else if (state.status === "expired") say("This link expired. Nothing was sent. Ask the agent to run the command again if you still want this.", "bad");
    else say(state.mine || "This was rejected. Nothing was sent.", "bad");
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
        if (!done) say("The command that opened this page is not answering. If it stopped, nothing more happens here.", "bad");
      });
  }

  function waiting(hash) {
    document.body.setAttribute("data-state", "sent");
    show("send", false);
    show("reject", false);
    show("expiry-row", false);
    show("expiry-val", false);
    say("Sent. Waiting for the chain to confirm it. The command checks the result on chain itself; keep this page open.", null, hash ? txLink(hash) : null);
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
        el("account").textContent = account;
        show("account-row", true);
        show("account", true);
        if (facts.kind === "connect") {
          say("Check your wallet: sign the message to prove this address is yours. It sends nothing and costs nothing.");
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
            say("Ready. Press \\u201cApprove in wallet\\u201d and check the transaction in the wallet popup.");
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
    say("Check your wallet: it is asking you to approve this transaction.");
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
        if (answer && !answer.ok) say(answer.data.error || "The command did not take the transaction hash; it still reads the chain.", "bad");
      })
      .catch(function (err) {
        if (err && err.code === 4001) {
          post("/reject", { by: "wallet" }).then(function () {
            ended({ status: "rejected", mine: "You rejected this in your wallet. Nothing was sent. The agent can do nothing more with this link." });
          });
          return;
        }
        setBusy(false);
        say("The wallet could not send this: " + reason(err), "bad");
      });
  }

  function reject() {
    setBusy(true);
    post("/reject", { by: "page" })
      .then(function () { ended({ status: "rejected", mine: "You rejected this. Nothing was sent. The agent can do nothing more with this link." }); })
      .catch(function () { setBusy(false); say("The command is not answering. Is it still running?", "bad"); });
  }

  document.addEventListener("click", function (event) {
    var button = event.target && event.target.closest ? event.target.closest("button[data-act]") : null;
    if (!button || button.disabled || busy) return;
    var act = button.getAttribute("data-act");
    if (act === "connect") connect();
    else if (act === "send") send();
    else if (act === "reject") reject();
  });

  if (!provider) {
    show("no-wallet", true);
    show("connect", false);
  }

  if (provider && provider.on) {
    provider.on("accountsChanged", function (accounts) {
      if (done || sentHash || !accounts || accounts.length === 0) return;
      if (account && accounts[0].toLowerCase() === account.toLowerCase()) return;
      account = null;
      show("send", false);
      show("connect", true);
      say("You switched accounts. Connect again.");
    });
  }

  document.body.setAttribute("data-state", "connect");
  refresh();
  setInterval(refresh, 1500);
  setInterval(countdown, 1000);
})();
`;

function list(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Superstables &middot; ${esc(title)}</title>
<style>${STYLE}${OWNER_STYLE}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Superstables &middot; ${esc(title)}</h1>
    <p>Your browser wallet holds the key &middot; the agent can ask, only you can approve.</p>
  </header>
${body}
</div>
</body>
</html>
`;
}

/** The whole page for one owner action, terms and all, ready to serve. */
export function ownerApprovalPage(facts: OwnerPageFacts, terms: OwnerTerms): string {
  const left = Math.max(0, Math.round((facts.expiresAt - Date.now()) / 1000));
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const chainCell = esc(facts.chain.chainName) + (facts.chain.testnet ? ' <span class="tag">testnet</span>' : "");
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
  const primary = facts.kind === "connect" ? "" : `<button id="send" class="primary" data-act="send" hidden>Approve in wallet</button>`;
  const body = `
  <div id="say" class="note" hidden></div>

  <div id="no-wallet" class="note bad" hidden>
    MetaMask (or another browser wallet) is needed here. Install one at
    <a href="${WALLET_DOWNLOAD_URL}" rel="noreferrer noopener">${WALLET_DOWNLOAD_URL}</a>, then reload this page.
    You can still reject without one.
  </div>

  <div class="card">
    ${terms.amount ? `<div class="amount">${esc(terms.amount)}<span>${esc(terms.unit ?? "")}</span></div>` : ""}
    <p class="summary">${esc(terms.summary)}</p>
    <dl class="rows">
      ${rows}
      <dt>On</dt><dd>${chainCell}</dd>
      <dt id="account-row" hidden>Your wallet</dt><dd id="account" class="mono" hidden></dd>
      <dt id="expiry-row">Link expires in</dt><dd id="expiry-val"><span id="expiry">${clock}</span></dd>
    </dl>
    ${limits}
    <div class="actions">
      <button id="connect" class="primary" data-act="connect">Connect wallet</button>
      ${primary}
      <button id="reject" data-act="reject">Reject</button>
    </div>
    <div id="fineprint" class="fineprint">${terms.notes.map((note) => `<p>${esc(note)}</p>`).join("")}</div>
  </div>

<script id="owner-facts" type="application/json">${inlineJson(facts)}</script>
<script>${OWNER_PAGE_SCRIPT}</script>`;
  return page(terms.title, body);
}

/** What an unknown, or already finished, link gets. Same furniture, no buttons. */
export function ownerNotFoundPage(): string {
  return page(
    "approve in your wallet",
    `
  <div class="note bad">
    Nothing is waiting under this link. It may have been approved, rejected or expired already,
    or the command that opened it has stopped. Nothing was sent. Ask the agent to run the command again.
  </div>`,
  );
}
