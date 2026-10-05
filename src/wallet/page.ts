// The owner's approval page: one self-contained HTML string, served at GET / by the wallet
// process, in the look the other local pages share (src/core/signer/look.ts). No build step, no framework, no external asset — the page a person uses to
// authorise a payment should be readable in full, in one file, by anyone who wants to check
// what it does before clicking "Approve".
//
// The owner secret never reaches the server as part of a URL. It arrives in the location
// fragment (http://127.0.0.1:4411/#<secret>, from the launcher file the wallet writes), which
// browsers do not send, or the owner pastes it into the page. The page keeps it in this tab's
// sessionStorage, takes it out of the address bar and history, and puts it in an
// Authorization header itself.
//
// Two rules the markup follows everywhere: every value that came from outside is escaped
// before it is inserted, and anything the agent said about the payment is shown in its own
// block, labelled as unverified. What the wallet verified and what the agent claimed must
// never look alike.

import { inlineJson } from "../core/signer/approval-page.js";
import { framePage, pageLook, type PageLook } from "../core/signer/look.js";
import { WALLET_STATUS_LABELS } from "../core/status-labels.js";

const WALLET_STYLE = `
  h2.section { font-family: var(--mono); font-size: 11.5px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-2); margin: 40px 0 0; }
  #pending .card:first-child { margin-top: 14px; }
  #pending .card + .card { margin-top: 16px; }
  #pending > .empty, #history > .empty { margin-top: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 12px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px; }
  th { font-family: var(--mono); font-size: 10.5px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line-2); white-space: nowrap; }
  td { padding: 11px 14px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
  td.mono { font-size: 12.5px; }
  td:nth-child(-n+3) { white-space: nowrap; }
  tbody tr:last-child td { border-bottom: 0; }
  #unlock { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
  #unlock[hidden] { display: none; }
  #unlock label { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); }
  #unlock input { flex: 1; min-width: 16em; font-family: var(--mono); font-size: 13px; padding: 9px 12px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--bg-2); color: var(--ink); }
  .status-signed { color: var(--good); }
  .status-denied, .status-rejected, .status-expired { color: var(--bad); }
`;

/** The page's own script. The owner secret comes from the location fragment or the owner's paste, never from the server. */
export const WALLET_PAGE_SCRIPT = `
(function () {
  var KEY = "superstables-owner-secret";
  function remember(value) { try { sessionStorage.setItem(KEY, value); } catch (e) { /* storage off: this load only */ } }
  function forget() { try { sessionStorage.removeItem(KEY); } catch (e) { /* nothing stored */ } }
  // A secret in the fragment is kept for this tab and taken out of the address bar and the history.
  function fromFragment() {
    var value = location.hash.replace(/^#/, "");
    if (!value) return "";
    remember(value);
    history.replaceState(null, "", location.pathname + location.search);
    return value;
  }
  var secret = fromFragment();
  if (!secret) {
    try { secret = sessionStorage.getItem(KEY) || ""; } catch (e) { secret = ""; }
  }
  var unlock = document.getElementById("unlock");
  var secretInput = document.getElementById("secret-input");
  var notice = document.getElementById("notice");
  var pendingEl = document.getElementById("pending");
  var historyEl = document.getElementById("history");
  var labels = JSON.parse(document.getElementById("status-labels").textContent);
  var busy = {};

  function esc(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function say(message, bad) {
    notice.hidden = false;
    notice.className = bad ? "note bad" : "note";
    notice.textContent = message;
  }

  function clear() { notice.hidden = true; }

  function ask(path, options) {
    var init = options || {};
    init.headers = { "Authorization": "Bearer " + secret };
    init.cache = "no-store";
    return fetch(path, init);
  }

  function seconds(request) {
    return Math.max(0, Math.round((request.expiresAt - Date.now()) / 1000));
  }

  function networkCell(terms) {
    var label = String(terms.networkLabel || terms.network || "");
    var testnet = /testnet/i.test(label);
    var name = esc(label.replace(/\\s*\\(testnet\\)\\s*/i, "").trim() || label);
    return name + (testnet ? ' <span class="tag">testnet</span>' : "");
  }

  function reportedBlock(reported) {
    if (!reported) return "";
    var rows = [];
    if (reported.serviceName) rows.push("<div>Service: " + esc(reported.serviceName) + "</div>");
    if (reported.target) rows.push('<div class="mono">' + esc(reported.target) + "</div>");
    if (reported.description) rows.push("<div>" + esc(reported.description) + "</div>");
    if (rows.length === 0) rows.push("<div>The agent provided no payment details.</div>");
    return '<div class="reported"><strong>Reported by the agent (not verified)</strong>' + rows.join("") + "</div>";
  }

  function card(request) {
    var terms = request.verified || {};
    var disabled = busy[request.id] ? " disabled" : "";
    return '<div class="card">' +
      '<div class="amount">' + esc(terms.amountDecimal) + "<span>" + esc(terms.asset) + "</span></div>" +
      '<dl class="rows">' +
        "<dt>Network</dt><dd>" + networkCell(terms) + "</dd>" +
        "<dt>To</dt><dd class=\\"mono\\">" + esc(terms.recipient) + "</dd>" +
        "<dt>Paying from</dt><dd class=\\"mono\\">" + esc(terms.payer) + "</dd>" +
        "<dt>Expires in</dt><dd>" + seconds(request) + " s</dd>" +
      "</dl>" +
      reportedBlock(request.reported) +
      '<div class="actions">' +
        '<button class="primary" data-act="approve" data-id="' + esc(request.id) + '"' + disabled + ">Approve and sign</button>" +
        '<button data-act="deny" data-id="' + esc(request.id) + '"' + disabled + ">Reject</button>" +
      "</div>" +
    "</div>";
  }

  function historyTable(requests) {
    var rows = requests.map(function (request) {
      var terms = request.verified || {};
      var when = new Date(request.createdAt).toLocaleTimeString();
      return "<tr>" +
        "<td>" + esc(when) + "</td>" +
        '<td class="status-' + esc(request.status) + '">' + esc(labels[request.status] || request.status) + "</td>" +
        "<td>" + esc(terms.amountDecimal) + " " + esc(terms.asset) + "</td>" +
        '<td class="mono">' + esc(terms.recipient) + "</td>" +
        "<td>" + esc(request.reason || "") + "</td>" +
      "</tr>";
    }).join("");
    return "<table><thead><tr><th>Time</th><th>Status</th><th>Amount</th><th>Recipient</th><th>Reason</th></tr></thead><tbody>" + rows + "</tbody></table>";
  }

  function render(requests) {
    var pending = requests.filter(function (r) { return r.status === "pending"; });
    var rest = requests.filter(function (r) { return r.status !== "pending"; });
    pending.sort(function (a, b) { return a.createdAt - b.createdAt; });
    rest.sort(function (a, b) { return b.createdAt - a.createdAt; });
    pendingEl.innerHTML = pending.length
      ? pending.map(card).join("")
      : '<p class="empty">No payment is waiting for approval.</p>';
    historyEl.innerHTML = rest.length ? historyTable(rest) : '<p class="empty">Nothing yet.</p>';
  }

  function askForSecret(message) {
    unlock.hidden = false;
    say(message, Boolean(secret));
  }

  // the launcher link opened in a tab that already shows this page: same document, so no new load
  window.addEventListener("hashchange", function () {
    var value = fromFragment();
    if (!value) return;
    secret = value;
    unlock.hidden = true;
    clear();
    refresh();
  });

  unlock.addEventListener("submit", function (event) {
    event.preventDefault();
    // the whole launcher URL works too: only what follows "#" is the secret
    secret = secretInput.value.trim().replace(/^[^#]*#/, "");
    secretInput.value = "";
    if (!secret) return;
    remember(secret);
    unlock.hidden = true;
    clear();
    refresh();
  });

  function refresh() {
    if (!secret) {
      if (!unlock.hidden) return Promise.resolve(); // already asking; keep what the notice says
      askForSecret("Paste the owner secret to see and decide payments. It is in the wallet's owner-secret file; the wallet printed where when it started.");
      return Promise.resolve();
    }
    return ask("/owner/requests").then(function (response) {
      if (response.status === 401 || response.status === 403) {
        forget();
        askForSecret("That owner secret is not right. Paste the one in the wallet's owner-secret file.");
        secret = "";
        return null;
      }
      unlock.hidden = true;
      if (!response.ok) {
        say("The wallet answered with HTTP " + response.status + ".", true);
        return null;
      }
      return response.json();
    }).then(function (body) {
      if (!body) return;
      clear();
      render(body.requests || []);
    }).catch(function () {
      say("The wallet is not answering. Check that it is still running.", true);
    });
  }

  function decide(id, action) {
    busy[id] = true;
    refresh();
    ask("/owner/requests/" + encodeURIComponent(id) + "/" + action, { method: "POST" })
      .then(function (response) {
        if (response.ok) return;
        // 409: the request was already decided or expired; the wallet says which
        return response.json().catch(function () { return {}; }).then(function (body) {
          say(body.error ? "Not done: " + body.error + "." : "The wallet refused that (HTTP " + response.status + ").", true);
        });
      })
      .catch(function () { say("The wallet is not answering. Check that it is still running.", true); })
      .then(function () { delete busy[id]; refresh(); });
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("button[data-act]") : null;
    if (!button || button.disabled) return;
    decide(button.getAttribute("data-id"), button.getAttribute("data-act"));
  });

  refresh();
  setInterval(refresh, 1000);
})();
`;

/** The wallet's page, ready to serve. Every payment on it arrives from the wallet's API after load. */
export function walletPage(look: PageLook = pageLook()): string {
  return framePage({
    look,
    title: "Payment approvals",
    eyebrow: "Local wallet",
    lede: "The wallet process uses a key file on this machine. Approve or reject each payment request.",
    wide: true,
    style: WALLET_STYLE,
    body: `
  <div id="notice" class="note" hidden></div>
  <form id="unlock" hidden autocomplete="off">
    <label for="secret-input">Owner secret</label>
    <input id="secret-input" type="password" autocomplete="off" spellcheck="false">
    <button class="primary" type="submit">Open</button>
  </form>

  <h2 class="section">Pending</h2>
  <div id="pending"><p class="empty">No payment is waiting for approval.</p></div>

  <h2 class="section">History</h2>
  <div id="history"><p class="empty">Nothing yet.</p></div>

<script id="status-labels" type="application/json">${inlineJson(WALLET_STATUS_LABELS)}</script>
<script>${WALLET_PAGE_SCRIPT}</script>`,
  });
}
