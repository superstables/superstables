// How the pages this client serves on 127.0.0.1 look: the payment approval page (approval-page.ts), the owner page
// (owner-approval-page.ts) and the local wallet's page (src/wallet/page.ts). One layout, two looks.
//
//   plain         the default. No name and no logo: system fonts and neutral colours. A page that runs on this computer,
//                 for a command run on this computer, says so and nothing more.
//   superstables  superstables.com's look: its colours, its three typefaces (inlined from look-fonts.ts, so the page
//                 still loads nothing from anywhere else) and its mark. Used once the owner points this client at
//                 superstables.com: SUPERSTABLES_SITE is a superstables.com origin, or a budget chain was set up with
//                 `setup --hosted` on superstables.com (APPROVALS=hosted in its public file).
//
// SUPERSTABLES_SITE decides when it is set, as it does for `superstables budget find`: pointing it at another site
// gives the plain look even when a chain was linked to superstables.com earlier.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "../home.js";
import { BRICOLAGE_WOFF2, FIGTREE_WOFF2, JETBRAINS_MONO_WOFF2 } from "./look-fonts.js";

export type PageLook = "plain" | "superstables";

/** The site `setup --hosted` uses when its public file names none (budget/site.mjs DEFAULT_SITE). */
const DEFAULT_HOSTED_SITE = "https://www.superstables.com";

/** Is this an https origin on superstables.com (the bare domain, www, staging, ...)? */
export function isSuperstablesSite(value: string | undefined): boolean {
  try {
    const u = new URL(String(value ?? "").trim());
    return u.protocol === "https:" && (u.hostname === "superstables.com" || u.hostname.endsWith(".superstables.com"));
  } catch {
    return false;
  }
}

/** The sites of every budget chain whose owner approvals are hosted (budget/public/<rail>-<chain>.env). */
function hostedSites(home: string): string[] {
  const dir = join(home, "budget", "public");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".env"));
  } catch {
    return [];
  }
  const sites: string[] = [];
  for (const name of names) {
    let text = "";
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (/^APPROVALS=hosted\s*$/m.test(text)) sites.push(/^SITE=(.*)$/m.exec(text)?.[1]?.trim() || DEFAULT_HOSTED_SITE);
  }
  return sites;
}

/** Which look the pages get: superstables once the owner points this client at superstables.com, plain otherwise. */
export function pageLook(env: NodeJS.ProcessEnv = process.env, home: string = homeDir()): PageLook {
  const site = env.SUPERSTABLES_SITE?.trim();
  if (site) return isSuperstablesSite(site) ? "superstables" : "plain";
  return hostedSites(home).some(isSuperstablesSite) ? "superstables" : "plain";
}

// ── colours and type ──────────────────────────────────────────────────────────────────────────────────────────────

const PLAIN_LIGHT = `
    color-scheme: light;
    --bg: #F6F7F8; --bg-2: #FFFFFF; --bg-3: #EEF0F2; --line: #E2E5E9; --line-2: #CDD2D8;
    --ink: #15181C; --ink-2: #5B6370; --ink-3: #8A919C;
    --primary: #15181C; --primary-ink: #FFFFFF; --primary-hover: #2E343B; --pick-bg: rgba(21, 24, 28, 0.06);
    --good: #1F6B45; --good-bg: rgba(31, 107, 69, 0.07); --good-line: rgba(31, 107, 69, 0.45); --ring: #15181C; --dot: #8A919C;
    --bad: #B3261E; --bad-bg: rgba(179, 38, 30, 0.06);`;

const PLAIN_DARK = `
    color-scheme: dark;
    --bg: #111315; --bg-2: #181B1E; --bg-3: #1F2327; --line: #262A2F; --line-2: #343940;
    --ink: #E8EAED; --ink-2: #9AA1AB; --ink-3: #6B727C;
    --primary: #E8EAED; --primary-ink: #111315; --primary-hover: #FFFFFF; --pick-bg: rgba(232, 234, 237, 0.08);
    --good: #6FCF97; --good-bg: rgba(111, 207, 151, 0.08); --good-line: rgba(111, 207, 151, 0.4); --ring: #E8EAED; --dot: #6B727C;
    --bad: #FF7A6B; --bad-bg: rgba(255, 122, 107, 0.07);`;

const PLAIN_TYPE = `
    --display: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --body: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --display-weight: 600;`;

/** superstables.com's tokens (its app/globals.css). Dark is the base; light follows the system. */
const SITE_DARK = `
    color-scheme: dark;
    --bg: #0A0C0E; --bg-2: #111417; --bg-3: #171B1F; --line: #1F252B; --line-2: #2B333A;
    --ink: #E9EDE6; --ink-2: #98A39A; --ink-3: #5E6862;
    --primary: #CBFF00; --primary-ink: #0A0C0E; --primary-hover: #D9FF3D; --pick-bg: rgba(203, 255, 0, 0.10);
    --good: #CBFF00; --good-bg: rgba(203, 255, 0, 0.07); --good-line: rgba(203, 255, 0, 0.35); --ring: #CBFF00; --dot: #CBFF00;
    --bad: #FF7A6B; --bad-bg: rgba(255, 122, 107, 0.07);
    --logo-route: #CBFF00; --logo-ring: transparent;`;

const SITE_LIGHT = `
    color-scheme: light;
    --bg: #F4F6F1; --bg-2: #FFFFFF; --bg-3: #E9EDE6; --line: #DDE3DA; --line-2: #C9D1C6;
    --ink: #0A0C0E; --ink-2: #4F5A52; --ink-3: #7A857C;
    --primary: #CBFF00; --primary-ink: #0A0C0E; --primary-hover: #BEF000; --pick-bg: rgba(203, 255, 0, 0.45);
    --good: #0A0C0E; --good-bg: rgba(203, 255, 0, 0.28); --good-line: rgba(10, 12, 14, 0.25); --ring: #0A0C0E; --dot: #CBFF00;
    --bad: #B3261E; --bad-bg: rgba(179, 38, 30, 0.06);
    --logo-route: #0A0C0E; --logo-ring: #0A0C0E;`;

const SITE_TYPE = `
    --display: "Bricolage Grotesque", "Helvetica Neue", Arial, sans-serif;
    --body: "Figtree", "Helvetica Neue", Arial, sans-serif;
    --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
    --display-weight: 500;`;

const SITE_FONTS = `
  @font-face { font-family: "Bricolage Grotesque"; font-style: normal; font-weight: 200 800; font-display: swap; src: url("data:font/woff2;base64,${BRICOLAGE_WOFF2}") format("woff2"); }
  @font-face { font-family: "Figtree"; font-style: normal; font-weight: 400 600; font-display: swap; src: url("data:font/woff2;base64,${FIGTREE_WOFF2}") format("woff2"); }
  @font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 400 600; font-display: swap; src: url("data:font/woff2;base64,${JETBRAINS_MONO_WOFF2}") format("woff2"); }`;

function tokens(look: PageLook): string {
  return look === "superstables"
    ? `${SITE_FONTS}
  :root {${SITE_DARK}${SITE_TYPE} }
  @media (prefers-color-scheme: light) { :root {${SITE_LIGHT} } }`
    : `
  :root {${PLAIN_LIGHT}${PLAIN_TYPE} }
  @media (prefers-color-scheme: dark) { :root {${PLAIN_DARK} } }`;
}

/** The layout every local page shares: the site's bar, heading, card, rows, notes and buttons. */
const LAYOUT = `
  :root { --gutter: clamp(20px, 4vw, 48px); --page: 640px; }
  * { box-sizing: border-box; }
  /* A class that sets display must never unhide an element the script hid. */
  [hidden] { display: none !important; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; background: var(--bg); color: var(--ink); font-family: var(--body); font-size: 16px; line-height: 1.55; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  body.wide { --page: 860px; }
  a { color: inherit; text-decoration: underline; text-decoration-color: var(--line-2); text-underline-offset: 3px; }
  a:hover { text-decoration-color: currentColor; }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }
  .mono { font-family: var(--mono); }
  .wrap { width: 100%; max-width: calc(var(--page) + 2 * var(--gutter)); margin: 0 auto; padding: 0 var(--gutter); }

  .top { border-bottom: 1px solid var(--line); flex: none; }
  .top .wrap { height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .logo { display: inline-flex; align-items: center; gap: 10px; font-family: var(--display); font-weight: 600; font-size: 19px; letter-spacing: -0.02em; }
  .logo svg { width: 22px; height: 22px; display: block; }
  .mk-node { fill: var(--logo-route); }
  .mk-path { stroke: var(--logo-route); }
  .mk-end { fill: #CBFF00; stroke: var(--logo-ring); }
  .logo.local { font-family: var(--body); font-size: 15px; font-weight: 600; letter-spacing: 0; color: var(--ink); }
  .logo.local svg { width: 20px; height: 20px; fill: none; stroke: var(--ink-2); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .pill { font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2); border: 1px solid var(--line-2); border-radius: 3px; padding: 4px 8px; white-space: nowrap; }
  main.wrap { flex: 1 0 auto; padding-top: 32px; padding-bottom: 48px; }
  .foot { border-top: 1px solid var(--line); flex: none; }
  .foot .wrap { padding-top: 20px; padding-bottom: 28px; font-size: 13px; color: var(--ink-2); }

  .eyebrow { font-family: var(--mono); font-size: 11.5px; line-height: 14px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-2); display: flex; width: fit-content; align-items: center; gap: 10px; margin: 0; }
  .eyebrow::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--dot); box-shadow: 0 0 0 3px var(--pick-bg); }
  h1 { font-family: var(--display); font-weight: var(--display-weight); letter-spacing: -0.025em; margin: 0; text-wrap: balance; font-size: clamp(30px, 5.4vw, 42px); line-height: 1.05; }
  p { margin: 0; }
  .lede { color: var(--ink-2); font-size: 17px; margin-top: 14px; max-width: 52ch; }

  /* The heading, with the outcome's mark once there is one (the script sets body[data-state]). */
  .head { display: flex; align-items: center; gap: 14px; margin-top: 14px; }
  .mark { display: none; flex: none; width: 40px; height: 40px; border-radius: 50%; place-items: center; background: var(--bg-3); color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--line-2); }
  .mark svg { display: none; width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  body[data-state="confirmed"] .mark, body[data-state="signed"] .mark, body[data-state="connected"] .mark { display: grid; background: var(--primary); color: var(--primary-ink); box-shadow: none; }
  body[data-state="confirmed"] [data-g="check"], body[data-state="signed"] [data-g="check"], body[data-state="connected"] [data-g="check"] { display: block; }
  body[data-state="rejected"] .mark, body[data-state="denied"] .mark, body[data-state="failed"] .mark, body[data-state="expired"] .mark { display: grid; background: var(--bad-bg); color: var(--bad); box-shadow: inset 0 0 0 1px var(--bad); }
  body[data-state="rejected"] [data-g="cross"], body[data-state="denied"] [data-g="cross"], body[data-state="failed"] [data-g="cross"], body[data-state="expired"] [data-g="clock"] { display: block; }
  body[data-state="sent"] .mark { display: grid; }
  body[data-state="sent"] [data-g="clock"] { display: block; }

  .card { background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px; padding: clamp(20px, 4vw, 28px); margin-top: 28px; }
  .note { margin-top: 24px; padding: 14px 16px; border: 1px solid var(--line-2); border-radius: 6px; background: var(--bg-2); color: var(--ink-2); font-size: 15px; overflow-wrap: anywhere; }
  .note.bad { border-color: var(--bad); background: var(--bad-bg); color: var(--bad); }
  .note.good { border-color: var(--good-line); background: var(--good-bg); color: var(--good); }
  .note a { color: inherit; }

  .amount { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; font-family: var(--display); font-weight: var(--display-weight); font-size: clamp(46px, 10vw, 64px); line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .amount span { font-family: var(--body); font-size: 18px; font-weight: 500; letter-spacing: 0; color: var(--ink-2); }
  .summary { margin-top: 16px; font-size: 16px; color: var(--ink-2); max-width: 56ch; }
  .card > .summary:first-child { margin-top: 0; }
  .tag { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2); border: 1px solid var(--line-2); border-radius: 3px; padding: 2px 6px; margin-left: 8px; vertical-align: 1px; white-space: nowrap; }
  .rows { display: grid; grid-template-columns: 150px minmax(0, 1fr); margin: 24px 0 0; border-top: 1px solid var(--line); }
  .rows dt, .rows dd { padding: 11px 0; border-bottom: 1px solid var(--line); }
  .rows dt { font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); padding-top: 14px; padding-right: 12px; }
  .rows dd { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
  .rows dd.mono { font-size: 13px; padding-top: 13px; }
  @media (max-width: 540px) {
    .rows { grid-template-columns: minmax(0, 1fr); }
    .rows dt { border-bottom: 0; padding-bottom: 0; }
    .rows dd, .rows dd.mono { padding-top: 4px; }
  }

  /* What the agent said: its own block, never styled like the facts above it. */
  .reported { margin-top: 20px; padding: 14px 16px; border: 1px dashed var(--line-2); border-radius: 6px; background: var(--bg); font-size: 14.5px; color: var(--ink-2); overflow-wrap: anywhere; }
  .reported strong { display: block; font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 6px; }
  .reported .mono { font-size: 13px; }

  button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 48px; padding: 0 20px; font-family: var(--body); font-size: 15px; font-weight: 600; color: var(--ink); background: transparent; border: 1px solid var(--line-2); border-radius: 3px; cursor: pointer; white-space: nowrap; transition: border-color 0.15s, background 0.15s, color 0.15s; }
  button:hover:not([disabled]) { border-color: var(--ink-3); background: var(--bg-3); }
  button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-ink); }
  button.primary:hover:not([disabled]) { background: var(--primary-hover); border-color: var(--primary-hover); }
  button[disabled] { opacity: 0.45; cursor: not-allowed; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 24px; }
  @media (max-width: 540px) {
    .actions button { flex: 1 1 auto; }
    .actions button.primary { flex-basis: 100%; }
  }
  .fineprint { color: var(--ink-2); font-size: 14px; margin-top: 18px; }
  .fineprint p + p { margin-top: 6px; }
  .empty { color: var(--ink-2); font-size: 15px; }
`;

/** superstables.com's mark: a payment leaving one node and arriving at another. */
const MARK = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle class="mk-node" cx="5" cy="7" r="2.4"/><path class="mk-path" d="M7.4 7h4.1a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 0 2.5 2.5h0.1" stroke-width="2.2" stroke-linecap="round"/><circle class="mk-end" cx="19" cy="17" r="2.4" stroke-width="1.6"/></svg>`;
/** The plain look's sign: this computer. */
const COMPUTER = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>`;
/** The outcome marks; the CSS shows one, from body[data-state]. */
const OUTCOMES = [
  `<svg data-g="check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  `<svg data-g="cross" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>`,
  `<svg data-g="clock" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5"/><path d="M12 8v4.5l3 2"/></svg>`,
].join("");

/** One local page. Every string but `body` and `style` is escaped here; `body` is the page's own escaped markup. */
export interface FrameParts {
  look: PageLook;
  /** The heading, also the window title. */
  title: string;
  /** The small line above the heading: what kind of page this is. */
  eyebrow: string;
  lede?: string;
  /** Shows a Testnet pill in the bar. */
  testnet?: boolean;
  /** A wider page (the wallet's history table). */
  wide?: boolean;
  /** The page's own CSS, after the shared layout. */
  style?: string;
  body: string;
}

/** HTML-escape one value. */
export function esc(value: unknown): string {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The whole document around a page's body: bar, heading, body, footer. */
export function framePage(parts: FrameParts): string {
  const site = parts.look === "superstables";
  const brand = site ? `<span class="logo">${MARK}Superstables</span>` : `<span class="logo local">${COMPUTER}Approval on this machine</span>`;
  const foot = site
    ? "Served on this machine by the Superstables client, for the command that opened it."
    : "Served on this machine by the command that opened it.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${site ? "Superstables &middot; " : ""}${esc(parts.title)}</title>
<style>${tokens(parts.look)}${LAYOUT}${parts.style ?? ""}</style>
</head>
<body${parts.wide ? ' class="wide"' : ""}>
<header class="top"><div class="wrap">
  ${brand}
  ${parts.testnet ? '<span class="pill">Testnet</span>' : ""}
</div></header>
<main class="wrap">
  <p class="eyebrow">${esc(parts.eyebrow)}</p>
  <div class="head"><span class="mark">${OUTCOMES}</span><h1>${esc(parts.title)}</h1></div>
  ${parts.lede ? `<p class="lede">${esc(parts.lede)}</p>` : ""}
${parts.body}
</main>
<footer class="foot"><div class="wrap">${foot}</div></footer>
</body>
</html>
`;
}
