import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import "../app.css";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Pricing",
  description: "The Superstables index is free: web directory, JSON API, MCP server and natural-language endpoint. No key, no account, no paid tiers.",
  alternates: { canonical: `${SITE}/pricing`, types: { "text/markdown": `${SITE}/pricing.md` } },
};

/** Service, not Product/Offer: the index is free and there is no checkout, so no commerce signal. */
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "Service",
  name: "Superstables index",
  serviceType: "Index of services payable by AI agents with stablecoins",
  description: "Liveness-probed index of services AI agents can pay with stablecoins over x402, MPP and ACP. Free to use: web directory, JSON API, MCP server and natural-language endpoint, with no key, account or paid tier.",
  url: `${SITE}/pricing`,
  provider: { "@type": "Organization", name: "Superstables", url: `${SITE}` },
  audience: { "@type": "Audience", audienceType: "AI agents and their developers" },
};

export default function Pricing() {
  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: 56, paddingBottom: 96, maxWidth: 760 }}>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <span className="eyebrow plain">Pricing</span>
        <h1 style={{ fontSize: "clamp(32px, 4vw, 44px)", marginTop: 10 }}>Free, all of it.</h1>
        <p className="lede" style={{ marginTop: 12 }}>
          The index is free for humans and for agents: the <Link className="link" href="/discover">directory</Link>, the{" "}
          <Link className="link" href="/docs">JSON API</Link>, the MCP server and the natural-language endpoint, with no key,
          no account and no paid tiers. Listing a service is free too; the only requirement is that your endpoint answers a
          payment challenge when we probe it.
        </p>
        <div className="panel" style={{ marginTop: 28 }}>
          <div className="settings-row"><span><b>Web directory</b><p>Browse and filter every indexed service.</p></span><span className="pill ok">Free</span></div>
          <div className="settings-row"><span><b>JSON API</b><p>Full index, CORS open, soft limit of 300 requests per minute.</p></span><span className="pill ok">Free</span></div>
          <div className="settings-row"><span><b>MCP server</b><p>find_services, get_service and get_stats as native agent tools.</p></span><span className="pill ok">Free</span></div>
          <div className="settings-row"><span><b>Listing your service</b><p>Submitted endpoints are probed before they appear.</p></span><span className="pill ok">Free</span></div>
        </div>
        <p style={{ marginTop: 24, fontSize: 14, color: "var(--ink-2)" }}>
          If paid tiers ever exist, <a className="link" href={`${SITE}/pricing.md`}>pricing.md</a> changes first. Questions:{" "}
          <a className="link" href="https://x.com/superstables" target="_blank" rel="noopener noreferrer">@superstables</a>.
        </p>
      </main>
      <Footer />
    </>
  );
}
