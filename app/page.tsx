import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import Rails from "@/components/Rails";
import Api from "@/components/Api";
import Roadmap from "@/components/Roadmap";
import Cta from "@/components/Cta";
import Footer from "@/components/Footer";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  alternates: {
    canonical: `${SITE}`,
    types: { "text/markdown": `${SITE}/index.md` },
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE}/#organization`,
      name: "Superstables",
      url: `${SITE}`,
      logo: `${SITE}/icon.svg`,
      sameAs: ["https://x.com/superstables", "https://github.com/superstables/superstables"],
      contactPoint: { "@type": "ContactPoint", contactType: "customer support", url: `${SITE}/contact`, availableLanguage: "en" },
      description: "The neutral, liveness-probed index of services AI agents can pay with stablecoins across x402, MPP and ACP.",
    },
    {
      "@type": "WebSite",
      name: "Superstables",
      url: `${SITE}`,
      publisher: { "@id": `${SITE}/#organization` },
      potentialAction: {
        "@type": "SearchAction",
        target: `${SITE}/discover?q={search_term_string}`,
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@type": "Dataset",
      name: "Superstables index of payable services for AI agents",
      description: "Liveness-probed index of services payable with stablecoins over x402, MPP and ACP: name, endpoint, rails, chains, assets, price, facilitator, live status and sources for every entry.",
      url: `${SITE}/discover`,
      license: "https://creativecommons.org/licenses/by/4.0/",
      isAccessibleForFree: true,
      creator: { "@id": `${SITE}/#organization` },
      distribution: [
        { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE}/api/v1/services` },
        { "@type": "DataDownload", encodingFormat: "application/x-ndjson", contentUrl: `${SITE}/feeds/services.jsonl` },
      ],
    },
    {
      "@type": "Service",
      "@id": `${SITE}/#index`,
      name: "Superstables index",
      serviceType: "Index of services payable by AI agents with stablecoins",
      description: "Free, liveness-probed index of services AI agents can pay with stablecoins over x402, MPP and ACP: web directory, JSON API, MCP server and natural-language endpoint, with no key, account or paid tier.",
      url: `${SITE}/discover`,
      provider: { "@id": `${SITE}/#organization` },
      audience: { "@type": "Audience", audienceType: "AI agents and their developers" },
      isAccessibleForFree: true,
    },
    {
      "@type": "WebAPI",
      name: "Superstables Index API",
      url: `${SITE}/docs`,
      documentation: `${SITE}/openapi.json`,
      description: "Public JSON API and MCP server over the liveness-probed index of services AI agents can pay with stablecoins. No key, CORS open.",
      provider: { "@id": `${SITE}/#organization` },
      termsOfService: `${SITE}/pricing.md`,
    },
  ],
};

export default function Home() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Nav />
      <main>
        <Hero />
        <Rails />
        <Api />
        <Roadmap />
        <Cta />
      </main>
      <Footer />
    </>
  );
}
