import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import Rails from "@/components/Rails";
import Api from "@/components/Api";
import Roadmap from "@/components/Roadmap";
import Cta from "@/components/Cta";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  alternates: {
    canonical: "https://www.superstables.com",
    types: { "text/markdown": "https://www.superstables.com/index.md" },
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://www.superstables.com/#organization",
      name: "Superstables",
      url: "https://www.superstables.com",
      logo: "https://www.superstables.com/icon.svg",
      sameAs: ["https://x.com/superstables", "https://github.com/superstables/superstables"],
      description: "The neutral, liveness-probed index of services AI agents can pay with stablecoins across x402, MPP and ACP.",
    },
    {
      "@type": "WebSite",
      name: "Superstables",
      url: "https://www.superstables.com",
      publisher: { "@id": "https://www.superstables.com/#organization" },
      potentialAction: {
        "@type": "SearchAction",
        target: "https://www.superstables.com/discover?q={search_term_string}",
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@type": "Dataset",
      name: "Superstables index of payable services for AI agents",
      description: "Liveness-probed index of services payable with stablecoins over x402, MPP and ACP: name, endpoint, rails, chains, assets, price, facilitator, live status and sources for every entry.",
      url: "https://www.superstables.com/discover",
      license: "https://creativecommons.org/licenses/by/4.0/",
      isAccessibleForFree: true,
      creator: { "@id": "https://www.superstables.com/#organization" },
      distribution: [
        { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: "https://www.superstables.com/api/v1/services" },
        { "@type": "DataDownload", encodingFormat: "application/x-ndjson", contentUrl: "https://www.superstables.com/feeds/services.jsonl" },
      ],
    },
    {
      "@type": "WebAPI",
      name: "Superstables Index API",
      url: "https://www.superstables.com/docs",
      documentation: "https://www.superstables.com/openapi.json",
      description: "Public JSON API and MCP server over the liveness-probed index of services AI agents can pay with stablecoins. No key, CORS open.",
      provider: { "@id": "https://www.superstables.com/#organization" },
      termsOfService: "https://www.superstables.com/pricing.md",
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
