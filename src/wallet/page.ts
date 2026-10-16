// The owner's approval page: one self-contained HTML string, served at GET / by the wallet
// process, in the look the other local pages share (src/core/signer/look.ts). No build step, no framework, no external asset — the page a person uses to
// authorise a payment should be readable in full, in one file, by anyone who wants to check
// what it does before clicking "Approve".
//
// The owner secret never reaches the server as part of a URL. It arrives in the location
// fragment (http://127.0.0.1:4411/#<secret>, from the launcher file the wallet writes), which
// browsers do not send, or the owner pastes it into the page. The page keeps it in the script's
// memory only, never in storage; a reload asks for it again. It takes it out of the address bar and history, and puts
// it in an Authorization header itself.
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
  #pending-empty[hidden] { display: none; }
  .policy { margin-top: 20px; font-size: 14.5px; color: var(--ink-2); overflow-wrap: anywhere; }
  .note code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; white-space: nowrap; }
  .policy .mono { font-size: 13px; }
  #pending .card:first-child { margin-top: 14px; }
  .card.ended { opacity: 0.55; }
  .ended-label { margin: 22px 0 0; font-family: var(--mono); font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); }
  .confirm { margin: 24px 0 0; font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
  .confirm .mono { font-size: 14px; }
  .raw { margin: 10px 0 0; font-size: 14px; color: var(--ink-2); }
  .raw .mono { font-size: 13px; }
  #pending .card + .card { margin-top: 16px; }
  #pending-empty, #history > .empty { margin-top: 12px; }
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

/**
 * The page's own script. The owner secret comes from the location fragment or the owner's paste, never from the
 * server, and it is kept in this script's memory only: not in storage, not in the address bar.
 */
export const WALLET_PAGE_SCRIPT = `
(function () {
  // A secret in the fragment is taken out of the address bar and the history at once. It is not stored anywhere: a
  // reload asks for it again.
  function fromFragment() {
    var value = location.hash.replace(/^#/, "");
    if (!value) return "";
    history.replaceState(null, "", location.pathname + location.search);
    return value;
  }
  var secret = fromFragment();
  var unlock = document.getElementById("unlock");
  var secretInput = document.getElementById("secret-input");
  var notice = document.getElementById("notice");
  var policyEl = document.getElementById("policy");
  var pendingEl = document.getElementById("pending");
  var emptyEl = document.getElementById("pending-empty");
  var historyEl = document.getElementById("history");
  var labels = JSON.parse(document.getElementById("status-labels").textContent);
  var busy = {};
  // id -> { el, expiry, actions, data, confirming, request, ended }; a request keeps its card for as long as it is listed
  var cards = {};
  // set while a refusal from the wallet is on show, so the refresh that follows does not wipe it
  var decisionNote = false;
  var lastHistory = "";
  var policyAt = 0;

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

  // fixed markup only (never the owner's or a request's text): the command shown as one unbreakable unit
  function sayLocked() {
    notice.hidden = false;
    notice.className = "note";
    notice.innerHTML = "This page does not keep the owner secret. Open it with <code>superstables --wallet local wallet open</code> or with the launcher file the wallet printed, or paste the secret from the wallet's owner-secret file.";
  }

  function clear() { notice.hidden = true; }

  function ask(path, options) {
    var init = options || {};
    init.headers = Object.assign({ "Authorization": "Bearer " + secret }, init.headers || {});
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

  function lifetime(total) {
    if (!(total > 0)) return "";
    return total < 120 ? total + " seconds" : Math.round(total / 60) + " minutes";
  }

  function actionsHtml(entry) {
    var id = esc(entry.request.id);
    var disabled = busy[entry.request.id] ? " disabled" : "";
    if (entry.confirming) {
      // the sentence is built from what a confirmation posts, so what is shown is what is sent
      var shown = entry.shown;
      var sent = entry.data;
      var valid = lifetime(entry.request.validForSeconds);
      return '<p class="confirm">Sign ' + esc(shown.amountDecimal) + " " + esc(shown.asset) +
          ' to <span class="mono">' + esc(sent.recipient) + "</span> on " + esc(shown.networkLabel || sent.network) + "?</p>" +
        '<p class="raw">The authorization\\'s value is <span class="mono">' + esc(sent.amountAtomic) + "</span> in the token's smallest unit." +
          (valid ? " Once signed, it can be used for " + esc(valid) + "." : "") + "</p>" +
        '<div class="actions">' +
          '<button class="primary" data-act="confirm" data-id="' + id + '"' + disabled + ">Yes, sign</button>" +
          '<button data-act="back" data-id="' + id + '"' + disabled + ">Back</button>" +
        "</div>";
    }
    return '<div class="actions">' +
      '<button class="primary" data-act="approve" data-id="' + id + '"' + disabled + ">Approve and sign</button>" +
      '<button data-act="deny" data-id="' + id + '"' + disabled + ">Reject</button>" +
    "</div>";
  }

  function makeCard(request) {
    var terms = request.verified || {};
    var el = document.createElement("div");
    el.className = "card";
    var top = document.createElement("div");
    top.innerHTML = '<div class="amount">' + esc(terms.amountDecimal) + "<span>" + esc(terms.asset) + "</span></div>";
    el.appendChild(top);
    var rows = document.createElement("dl");
    rows.className = "rows";
    rows.innerHTML = "<dt>Network</dt><dd>" + networkCell(terms) + "</dd>" +
        "<dt>To</dt><dd class=\\"mono\\">" + esc(terms.recipient) + "</dd>" +
        "<dt>Paying from</dt><dd class=\\"mono\\">" + esc(terms.payer) + "</dd>" +
        "<dt>Value</dt><dd class=\\"mono\\">" + esc(terms.amountAtomic) + " = " + esc(terms.amountDecimal) + " " + esc(terms.asset) + "</dd>";
    el.appendChild(rows);
    // the last row; its text is updated where it stands, and both nodes are hidden when the request ends
    var expiryLabel = document.createElement("dt");
    expiryLabel.textContent = "Expires in";
    var expiry = document.createElement("dd");
    rows.appendChild(expiryLabel);
    rows.appendChild(expiry);
    var reported = document.createElement("div");
    reported.innerHTML = reportedBlock(request.reported);
    el.appendChild(reported);
    var actions = document.createElement("div");
    actions.className = "choice";
    el.appendChild(actions);
    var entry = {
      el: el, expiry: expiry, expiryLabel: expiryLabel, actions: actions, request: request, confirming: false, ended: false,
      // what the owner is shown now is what a confirmation sends back
      data: { amountAtomic: String(terms.amountAtomic), recipient: String(terms.recipient), network: String(terms.network) },
      // the display-only parts of the confirmation, fixed at the same moment as the data
      shown: { amountDecimal: terms.amountDecimal, asset: terms.asset, networkLabel: terms.networkLabel }
    };
    return entry;
  }

  function paint(entry) {
    entry.expiry.textContent = seconds(entry.request) + " s";
    entry.actions.innerHTML = actionsHtml(entry);
  }

  function end(entry, request) {
    entry.ended = true;
    entry.confirming = false;
    entry.el.className = "card ended";
    entry.expiryLabel.hidden = true;
    entry.expiry.hidden = true;
    entry.actions.innerHTML = '<p class="ended-label status-' + esc(request.status) + '">' +
      esc(request ? (labels[request.status] || request.status) : "No longer waiting") + "</p>";
  }

  function anyConfirming() {
    return Object.keys(cards).some(function (id) { return cards[id].confirming; });
  }

  // Cards are kept by request id and updated where they stand. A request that ends stays in its place, greyed, while
  // the pointer is on the list or a confirmation is open, so nothing the owner is about to click moves.
  function render(requests) {
    var byId = {};
    requests.forEach(function (r) { byId[r.id] = r; });
    var pending = requests.filter(function (r) { return r.status === "pending"; });
    var rest = requests.filter(function (r) { return r.status !== "pending"; });
    pending.sort(function (a, b) { return a.createdAt - b.createdAt; });
    rest.sort(function (a, b) { return b.createdAt - a.createdAt; });

    pending.forEach(function (request) {
      var entry = cards[request.id];
      if (!entry) {
        entry = makeCard(request);
        cards[request.id] = entry;
        pendingEl.appendChild(entry.el);
        entry.request = request;
        paint(entry);
        return;
      }
      entry.request = request;
      entry.expiry.textContent = seconds(request) + " s";
    });

    Object.keys(cards).forEach(function (id) {
      var entry = cards[id];
      if (entry.ended || (byId[id] && byId[id].status === "pending")) return;
      end(entry, byId[id] || { status: "expired" });
    });

    if (!pendingEl.matches(":hover") && !anyConfirming()) {
      Object.keys(cards).forEach(function (id) {
        if (!cards[id].ended) return;
        pendingEl.removeChild(cards[id].el);
        delete cards[id];
      });
    }
    emptyEl.hidden = Object.keys(cards).length > 0;

    var html = rest.length ? historyTable(rest) : '<p class="empty">Nothing yet.</p>';
    if (html !== lastHistory) {
      lastHistory = html;
      historyEl.innerHTML = html;
    }
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

  function caps(p) {
    if (p.killSwitch) return "kill switch on, every payment is refused";
    var parts = [];
    if (p.perCall) parts.push(p.perCall + " a payment");
    if (p.perDay) parts.push(p.perDay + " a day");
    if (p.allow && p.allow.length) parts.push("only " + p.allow.join(", "));
    if (p.deny && p.deny.length) parts.push("never " + p.deny.join(", "));
    return parts.join(", ") || "no caps set";
  }

  function showPolicy(status) {
    if (status.policyProblem) {
      // the file exists and cannot be used: say only that, the caps below would be false
      policyEl.innerHTML = "Nothing is signed: " + esc(status.policyProblem);
      policyEl.hidden = false;
      return;
    }
    var lines = [];
    var policy = status.policy || {};
    lines.push("Policy <span class=\\"mono\\">" + esc(policy.file || "built in, no policy file") + "</span>: " + esc(caps(policy)));
    if (status.also) lines.push("Also applies <span class=\\"mono\\">" + esc(status.also.file) + "</span>: " + esc(caps(status.also.policy || {})));
    policyEl.innerHTML = lines.join("<br>");
    policyEl.hidden = false;
  }

  // the policy changes rarely, and the status route may ask an RPC for the balance: once a minute is enough
  function refreshPolicy() {
    if (Date.now() - policyAt < 60000) return;
    policyAt = Date.now();
    ask("/status").then(function (response) { return response.ok ? response.json() : null; })
      .then(function (status) { if (status) showPolicy(status); })
      .catch(function () { policyAt = 0; });
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
    decisionNote = false;
    clear();
    refresh();
  });

  unlock.addEventListener("submit", function (event) {
    event.preventDefault();
    // the whole launcher URL works too: only what follows "#" is the secret
    secret = secretInput.value.trim().replace(/^[^#]*#/, "");
    secretInput.value = "";
    if (!secret) return;
    unlock.hidden = true;
    decisionNote = false;
    clear();
    refresh();
  });

  function refresh() {
    if (!secret) {
      if (!unlock.hidden) return Promise.resolve(); // already asking; keep what the notice says
      unlock.hidden = false;
      sayLocked();
      return Promise.resolve();
    }
    return ask("/owner/requests").then(function (response) {
      if (response.status === 401 || response.status === 403) {
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
      if (!decisionNote) clear();
      render(body.requests || []);
      refreshPolicy();
    }).catch(function () {
      decisionNote = false;
      say("The wallet is not answering. Check that it is still running.", true);
    });
  }

  function decide(id, action, body) {
    decisionNote = false;
    busy[id] = true;
    if (cards[id]) paint(cards[id]);
    var init = { method: "POST" };
    if (body) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    ask("/owner/requests/" + encodeURIComponent(id) + "/" + action, init)
      .then(function (response) {
        if (response.ok) return;
        // 409: the request was already decided or expired, or is not the one confirmed; the wallet says which
        return response.json().catch(function () { return {}; }).then(function (answer) {
          say(answer.error ? "Not done: " + answer.error + "." : "The wallet refused that (HTTP " + response.status + ").", true);
          decisionNote = true;
        });
      })
      .catch(function () { say("The wallet is not answering. Check that it is still running.", true); })
      .then(function () {
        delete busy[id];
        if (cards[id]) { cards[id].confirming = false; if (!cards[id].ended) paint(cards[id]); }
        refresh();
      });
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("button[data-act]") : null;
    if (!button || button.disabled) return;
    var id = button.getAttribute("data-id");
    var act = button.getAttribute("data-act");
    var entry = cards[id];
    // Approving takes two clicks: the first opens a confirmation in the card, the second sends what the card showed.
    if (act === "approve" && entry) { entry.confirming = true; paint(entry); return; }
    if (act === "back" && entry) { entry.confirming = false; paint(entry); return; }
    if (act === "confirm" && entry) { decide(id, "approve", entry.data); return; }
    if (act === "deny") decide(id, "deny");
  });

  refresh();
  setInterval(refresh, 1000);
})();
`;

/** The wallet's page, ready to serve. Every payment on it arrives from the wallet's API after load. */
export function walletPage(look: PageLook = pageLook(), nonce?: string): string {
  return framePage({
    look,
    title: "Payment approvals",
    eyebrow: "Local wallet",
    lede: "The wallet process uses a key file on this machine. Approve or reject each payment request.",
    wide: true,
    style: WALLET_STYLE,
    body: `
  <div id="notice" class="note" hidden></div>
  <p id="policy" class="policy" hidden></p>
  <form id="unlock" hidden autocomplete="off">
    <label for="secret-input">Owner secret</label>
    <input id="secret-input" type="password" autocomplete="off" spellcheck="false">
    <button class="primary" type="submit">Open</button>
  </form>

  <h2 class="section">Pending</h2>
  <div id="pending"></div>
  <p id="pending-empty" class="empty">No payment is waiting for approval.</p>

  <h2 class="section">History</h2>
  <div id="history"><p class="empty">Nothing yet.</p></div>

<script id="status-labels" type="application/json">${inlineJson(WALLET_STATUS_LABELS)}</script>
<script${nonce ? ` nonce="${nonce}"` : ""}>${WALLET_PAGE_SCRIPT}</script>`,
  });
}
