import { SITE } from "@/lib/site";
/**
 * Trust pages (About, Privacy) as data, rendered both as HTML pages and as markdown twins.
 * Everything here describes what the code in this repository actually does; nothing about
 * legal entities, addresses or people.
 */

export type TrustSection = { heading: string; paragraphs: string[]; bullets?: string[] };
export type TrustFaq = { q: string; a: string };
export type TrustDoc = { slug: "about" | "privacy" | "contact"; title: string; description: string; lede: string; sections: TrustSection[]; faq?: TrustFaq[]; updated: string };

export const ABOUT: TrustDoc = {
  slug: "about",
  title: "About Superstables",
  description: "What Superstables is, how the index of payable services for AI agents is built, what live means, and what the project does not do.",
  lede: "Superstables is the neutral index of services an AI agent can pay with stablecoins. Every payable endpoint we can find, across every payment rail, in one place, deduplicated and independently probed for liveness.",
  updated: "2026-09-18",
  sections: [
    {
      heading: "What the index is",
      paragraphs: [
        "Agents increasingly pay for what they use: data feeds, GPU and compute time, tools, and other agents. Those services announce their prices over payment protocols such as x402, MPP and ACP, on chains such as Base, Solana, Tempo and Robinhood Chain, in stablecoins such as USDC, EURC, USDT, PYUSD and USDG. Superstables collects those announcements into one directory so an agent, or the person building one, can find something payable and check that it actually works before calling it. Next to the services agents pay for, the index also lists on-chain places for idle balances: RWA yield vaults, tokenized stocks and stablecoin yield.",
        "The index is free for humans and for agents. There is a web directory, a public JSON API with no key and CORS open, an MCP server, and a natural-language endpoint. Listing a service is free as well. There are no paid tiers and no paid placement; if that ever changes, pricing.md changes first.",
      ],
    },
    {
      heading: "How it is built",
      paragraphs: [
        "A crawler reads public directories of payable services on a schedule, normalises chains, assets and prices, and merges entries that point at the same endpoint host. Every entry keeps a record of the sources it was found in, so provenance is never lost.",
        "Each HTTP endpoint is then probed on a rolling schedule with a plain GET request that identifies itself as SuperstablesCrawler. A service is marked live when it answers with a payment challenge: an HTTP 402 status, a payment-challenge response header in the x402 v2 style, or an x402 or MPP challenge body. Endpoints that are not HTTP, such as acp:// addresses, are listed but never marked dead. Probe history is kept and shown on every service page, and services that stop appearing in their sources are delisted after seven days.",
      ],
    },
    {
      heading: "Neutrality",
      paragraphs: [
        "Superstables does not operate a payment rail, a facilitator, a chain or a stablecoin, and does not take a fee on anything listed. Ranking in the directory follows liveness and recency, not commercial relationships. Field names in the API are treated as a stable contract so that agents can integrate once.",
      ],
    },
    {
      heading: "What it does not do",
      paragraphs: [
        "Superstables indexes and probes. It does not execute, route or settle payments, and it never holds funds. The wider product described on the homepage, a payment router for agents, is the roadmap: a router across rails, then a control plane with policies and treasury basics, then agent identity and trust. The index is the part that exists today, and the reason it is public is that a router is only as good as its map.",
      ],
    },
    {
      heading: "For agents and developers",
      paragraphs: ["The fastest way in is the machine-readable material:"],
      bullets: [
        `[llms.txt](${SITE}/llms.txt): the site index written for agents`,
        `[API reference](${SITE}/docs) and [OpenAPI spec](${SITE}/openapi.json)`,
        `[MCP server card](${SITE}/.well-known/mcp/server-card.json)`,
        `[Authentication](${SITE}/auth.md): none required`,
        `[Privacy](${SITE}/privacy): what we store and why`,
      ],
    },
  ],
  faq: [
    { q: "What is Superstables?", a: "A free, neutral index of services an AI agent can pay with stablecoins over x402, MPP or ACP, with every HTTP endpoint independently probed for liveness. It is the map for the payment router described on the homepage." },
    { q: "Is it free?", a: "Yes. The web directory, the JSON API, the MCP server and the natural-language endpoint need no key, no account and no payment, and listing a service is free. There is no paid placement." },
    { q: "What does live mean?", a: "The endpoint answered a valid payment challenge on our last probe: an HTTP 402 status, a payment-challenge response header, or an x402 or MPP challenge body. Probe history is shown on every service page." },
    { q: "Does the directory execute payments?", a: "No. It indexes and probes. It does not route, execute or settle payments and never holds funds." },
    { q: "How do I get a service listed or corrected?", a: "Submit the endpoint through the form or POST /api/v1/submit. It is probed before it appears, and submitting the same endpoint again updates it. To remove a listing, contact us with the service id." },
  ],
};

export const PRIVACY: TrustDoc = {
  slug: "privacy",
  title: "Privacy",
  description: "What data Superstables stores about services, submitters, early-access applicants and visitors, where it is kept, and how to have it removed.",
  lede: "Most of what Superstables stores is about services, not people. This page lists exactly what the site records, why, and how to reach us about it.",
  updated: "2026-09-18",
  sections: [
    {
      heading: "Reading the index",
      paragraphs: [
        "Browsing the directory, calling the JSON API, using the MCP server or the natural-language endpoint requires no account, key or login. We do not set cookies for these. Requests pass through our hosting provider, which keeps standard request logs (IP address, user agent, path, time) for a limited period as part of operating the service; we do not build profiles from them.",
        "On public pages, Google Analytics 4 may load when a measurement ID is configured. It is never loaded in the private review area. Events recorded are limited to page views and the start and completion of the early-access form. Your theme preference is kept in your browser's local storage only.",
      ],
    },
    {
      heading: "Data about services",
      paragraphs: [
        "Index records describe endpoints: name, description, category, URL, payment rails, chains, assets, advertised price, facilitator, the sources the entry was found in, and the results of our liveness probes (time, status code, latency, how the challenge was detected). Probe history is kept indefinitely. This is information the services publish about themselves; if you operate a listed service and want a record corrected or removed, contact us and we will delist it.",
      ],
    },
    {
      heading: "Listing a service",
      paragraphs: [
        "When you submit a service, we store the endpoint URL, the name and the contact you give us, and the time of submission. We probe the endpoint once immediately and, when notifications are configured, notify our team by email with the result. The contact is used only to reach you about the listing. Repeated submissions of the same endpoint within 24 hours are deduplicated.",
      ],
    },
    {
      heading: "Early access",
      paragraphs: [
        "The early-access form stores your email address, your answers to the qualifying questions, your optional free-text note, a short share code, the share code of whoever referred you, and the browser user agent and referring page at the time you submitted. One row is kept per email; submitting again updates it. When notifications are configured, our team receives an email for each application and a copy is posted to an internal webhook. Your place in line is derived from these rows and can be looked up with your share code; that lookup returns position and referral count only, never your email.",
      ],
    },
    {
      heading: "Demo feedback",
      paragraphs: [
        "The demo feedback form is hosted by Tally. A submission stores your written report, any screenshots you attach, and a contact if you choose to give one, together with the fixed context of the form (which page it was on, testnet). Each submission is copied into our issue tracker so the team can act on it. Nothing from the form is written to the index database, and the page forwards nothing from your browser's address bar to the form.",
      ],
    },
    {
      heading: "Review build",
      paragraphs: [
        "The password-gated product preview keeps everything you do in it (sample keys, policies, wallets, activity) in your browser's local storage. It sends nothing to a backend and moves no money. A small operator-editable settings store on the server holds site settings such as a published contract address; it contains no personal data.",
      ],
    },
    {
      heading: "Where data lives",
      paragraphs: [
        "The site is served from Vercel and the database is Neon Postgres. Transactional email, when configured, is sent through Resend. Demo feedback is collected by Tally and copied into Linear, our issue tracker. These providers process data on our behalf under their own terms.",
      ],
    },
    {
      heading: "Your choices",
      paragraphs: [
        "You can ask us to delete your early-access application, your service submission, your demo feedback, or a listed service record, or to tell you what we hold about you. Use the contact links in the footer of any page. Standard AI crawler directives for this site are published in robots.txt, and machine-readable guidance in llms.txt.",
      ],
    },
  ],
};

export const CONTACT: TrustDoc = {
  slug: "contact",
  title: "Contact",
  description: "How to reach Superstables about the index, a listing, a correction or your data, and what to expect when you do.",
  lede: "Superstables is a small project. The channels below are the ones we actually read; none of them requires an account with us.",
  updated: "2026-09-18",
  sections: [
    {
      heading: "Listings and corrections",
      paragraphs: [
        "To list a service, use the form or the API; every submission is probed before it appears, and repeated submissions of the same endpoint within 24 hours are deduplicated. To correct a listing, submit the same endpoint again with the corrected details. To have a listed service removed, or a record about it corrected, tell us the service id shown on its page (the host slug) and what should change.",
      ],
      bullets: [`[List a service](${SITE}/submit): the form`, `[POST /api/v1/submit](${SITE}/submit.md): the same thing for agents and scripts`],
    },
    {
      heading: "Questions, demos and problems",
      paragraphs: [
        "Questions about the index, the API, the MCP server, the roadmap or a demo go to the public profile on X; direct messages are open. Bugs and feature requests for the site are welcome as issues on the GitHub repository linked in the footer. Please do not put payment details, keys or other secrets in any message.",
      ],
      bullets: [`[X / @superstables](https://x.com/superstables): questions, demos, direct messages`, `[Documentation](${SITE}/docs): the API reference, with a [markdown version](${SITE}/docs.md) for agents`],
    },
    {
      heading: "Your data",
      paragraphs: [
        "You can ask us to delete your early-access application or your service submission, or to tell you what we hold about you. Send the request through either channel above and mention the email address or share code you used, so we can find the record. The Privacy page explains what is stored and why.",
      ],
      bullets: [`[Privacy](${SITE}/privacy): what we store and why`],
    },
    {
      heading: "Security",
      paragraphs: [
        "If you believe you have found a security problem in the site or the API, send the details as a direct message rather than a public post, and give us time to look before publishing anything. The index holds no funds and moves no money, so the main risks are data accuracy and availability; we still want to hear about them.",
      ],
    },
  ],
};

/** Markdown twin of a trust doc, opening with frontmatter (title, description, canonical, last-updated). */
export function trustMarkdown(doc: TrustDoc): string {
  const lines = [
    "---",
    `title: ${doc.title}`,
    `description: ${doc.description}`,
    `canonical: ${SITE}/${doc.slug}`,
    `last-updated: ${doc.updated}`,
    "---",
    "",
    `# ${doc.title}`,
    "",
    `> ${doc.lede}`,
  ];
  for (const s of doc.sections) {
    lines.push("", `## ${s.heading}`);
    for (const p of s.paragraphs) lines.push("", p);
    if (s.bullets) {
      lines.push("");
      for (const b of s.bullets) lines.push(`- ${b}`);
    }
  }
  if (doc.faq) {
    lines.push("", "## Questions and answers");
    for (const f of doc.faq) lines.push("", `### ${f.q}`, "", f.a);
  }
  lines.push("", `Last updated: ${doc.updated}`, "");
  return lines.join("\n");
}
