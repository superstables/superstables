// Website performance check: a prepared performance report for one sample page on one device
// class. Three prepared pages, two devices. The pages are fictional and the URLs are
// documentation placeholders under sample.example; nothing here fetches a page or runs an audit.

import type { DemoResult, DemoServiceDefinition } from "../types";

const AS_OF = "2026-09-21T09:00:00Z";

type Device = "mobile" | "desktop";

interface Metrics {
  lcp_ms: number;
  cls: number;
  inp_ms: number;
  ttfb_ms: number;
  total_bytes_kb: number;
  requests: number;
}

interface Report {
  score: number;
  metrics: Metrics;
  opportunities: { title: string; estimated_savings_ms: number; fix: string }[];
  summary: string;
}

interface Page {
  label: string;
  url: string;
  reports: Record<Device, Report>;
}

/** The common "good" thresholds the report judges the core metrics against. */
const THRESHOLDS = { lcp_ms: 2500, cls: 0.1, inp_ms: 200 } as const;

const PAGES: Record<string, Page> = {
  "sample-landing": {
    label: "Sample landing page",
    url: "https://sample.example/",
    reports: {
      mobile: {
        score: 78,
        metrics: { lcp_ms: 2900, cls: 0.06, inp_ms: 180, ttfb_ms: 620, total_bytes_kb: 1840, requests: 62 },
        opportunities: [
          { title: "Hero image is not sized for mobile", estimated_savings_ms: 900, fix: "Serve a 750 px WebP through srcset instead of the 2400 px desktop asset." },
          { title: "Render-blocking web font", estimated_savings_ms: 350, fix: "Add font-display: swap and preload the one weight used above the fold." },
          { title: "Unused CSS from the marketing bundle", estimated_savings_ms: 250, fix: "Split the pricing and blog styles out of the shared stylesheet." },
        ],
        summary: "A prepared sample report scores the landing page 78 on mobile; the oversized hero image pushes LCP to 2.9 s, just over the threshold.",
      },
      desktop: {
        score: 92,
        metrics: { lcp_ms: 1700, cls: 0.03, inp_ms: 90, ttfb_ms: 410, total_bytes_kb: 1780, requests: 58 },
        opportunities: [
          { title: "Hero image is larger than needed", estimated_savings_ms: 300, fix: "Serve a 1600 px WebP through srcset instead of the 2400 px asset." },
          { title: "Render-blocking web font", estimated_savings_ms: 200, fix: "Add font-display: swap and preload the one weight used above the fold." },
          { title: "Unused CSS from the marketing bundle", estimated_savings_ms: 150, fix: "Split the pricing and blog styles out of the shared stylesheet." },
        ],
        summary: "A prepared sample report scores the landing page 92 on desktop; all three core metrics pass, and the hero image is the main remaining cost.",
      },
    },
  },
  "sample-checkout": {
    label: "Sample checkout page",
    url: "https://sample.example/checkout",
    reports: {
      mobile: {
        score: 41,
        metrics: { lcp_ms: 5400, cls: 0.24, inp_ms: 410, ttfb_ms: 880, total_bytes_kb: 3620, requests: 118 },
        opportunities: [
          { title: "Third-party analytics bundle blocks the main thread", estimated_savings_ms: 1800, fix: "Defer the 640 KB tag-manager bundle, or drop the two tags nobody reads." },
          { title: "Promo banner injected after first paint", estimated_savings_ms: 600, fix: "Render the banner server-side in a reserved 96 px slot; it causes the layout shift." },
          { title: "Unoptimised cart thumbnails", estimated_savings_ms: 700, fix: "Resize the twelve 1200 px thumbnails to 160 px and serve WebP." },
          { title: "Slow shipping-rate lookup on first byte", estimated_savings_ms: 450, fix: "Cache the carrier lookup for ten minutes instead of calling it on every load." },
        ],
        summary: "A prepared sample report scores the checkout page 41 on mobile; a 640 KB third-party analytics bundle blocks the main thread and all three core metrics fail.",
      },
      desktop: {
        score: 63,
        metrics: { lcp_ms: 3300, cls: 0.15, inp_ms: 260, ttfb_ms: 540, total_bytes_kb: 3480, requests: 112 },
        opportunities: [
          { title: "Third-party analytics bundle blocks the main thread", estimated_savings_ms: 900, fix: "Defer the 640 KB tag-manager bundle, or drop the two tags nobody reads." },
          { title: "Promo banner injected after first paint", estimated_savings_ms: 350, fix: "Render the banner server-side in a reserved 96 px slot; it causes the layout shift." },
          { title: "Unoptimised cart thumbnails", estimated_savings_ms: 300, fix: "Resize the twelve 1200 px thumbnails to 160 px and serve WebP." },
          { title: "Slow shipping-rate lookup on first byte", estimated_savings_ms: 250, fix: "Cache the carrier lookup for ten minutes instead of calling it on every load." },
        ],
        summary: "A prepared sample report scores the checkout page 63 on desktop; the third-party analytics bundle still fails LCP, CLS and INP, by smaller margins.",
      },
    },
  },
  "sample-docs": {
    label: "Sample documentation page",
    url: "https://sample.example/docs/getting-started",
    reports: {
      mobile: {
        score: 96,
        metrics: { lcp_ms: 1400, cls: 0.01, inp_ms: 70, ttfb_ms: 240, total_bytes_kb: 310, requests: 14 },
        opportunities: [
          { title: "Search index fetched on every page", estimated_savings_ms: 150, fix: "Load the 90 KB search index only when the search box is focused." },
          { title: "Syntax highlighter loaded on pages without code", estimated_savings_ms: 100, fix: "Import the highlighter only on pages that contain a code block." },
          { title: "Short cache lifetime on hashed assets", estimated_savings_ms: 40, fix: "Set a one-year immutable cache header on the hashed CSS and logo files." },
        ],
        summary: "A prepared sample report scores the docs page 96 on mobile; every core metric passes, and the eagerly loaded search index is the only notable cost.",
      },
      desktop: {
        score: 99,
        metrics: { lcp_ms: 900, cls: 0, inp_ms: 40, ttfb_ms: 190, total_bytes_kb: 300, requests: 13 },
        opportunities: [
          { title: "Search index fetched on every page", estimated_savings_ms: 80, fix: "Load the 90 KB search index only when the search box is focused." },
          { title: "Syntax highlighter loaded on pages without code", estimated_savings_ms: 50, fix: "Import the highlighter only on pages that contain a code block." },
          { title: "Short cache lifetime on hashed assets", estimated_savings_ms: 20, fix: "Set a one-year immutable cache header on the hashed CSS and logo files." },
        ],
        summary: "A prepared sample report scores the docs page 99 on desktop; every core metric passes comfortably and only minor caching tweaks remain.",
      },
    },
  },
};

/** Pass or fail for each core metric against THRESHOLDS, and overall: derived, so it can never disagree with the numbers. */
function checks(metrics: Metrics): Record<"lcp_ms" | "cls" | "inp_ms" | "overall", "pass" | "fail"> {
  const lcp_ms = metrics.lcp_ms <= THRESHOLDS.lcp_ms ? "pass" : "fail";
  const cls = metrics.cls <= THRESHOLDS.cls ? "pass" : "fail";
  const inp_ms = metrics.inp_ms <= THRESHOLDS.inp_ms ? "pass" : "fail";
  const overall = lcp_ms === "pass" && cls === "pass" && inp_ms === "pass" ? "pass" : "fail";
  return { lcp_ms, cls, inp_ms, overall };
}

export const websitePerformance: DemoServiceDefinition = {
  slug: "website-performance",
  name: "Website performance check",
  description: "A prepared performance report for a sample page: score, core metrics, a pass/fail against common thresholds and the top opportunities with a one-line fix each.",
  price: "0.005",
  params: [
    {
      name: "page_id",
      required: true,
      description: "Which prepared sample page to report on. These are fictional pages under sample.example, not a live site.",
      enum: Object.keys(PAGES),
      example: "sample-landing",
    },
    {
      name: "device",
      required: false,
      description: "The device class the report describes.",
      enum: ["mobile", "desktop"],
      default: "mobile",
      example: "mobile",
    },
  ],
  returns: {
    page: "{ id, label, url }",
    device: "string",
    score: "number, 0 to 100",
    metrics: "{ lcp_ms, cls, inp_ms, ttfb_ms, total_bytes_kb, requests }",
    thresholds: "{ lcp_ms, cls, inp_ms }",
    checks: "{ lcp_ms, cls, inp_ms, overall }, each \"pass\" or \"fail\"",
    opportunities: "[{ title, estimated_savings_ms, fix }]",
  },
  examplePrompts: [
    "Buy a performance check of sample-checkout on mobile and tell me what is slowing it down.",
    "Get the website performance report for sample-landing on desktop.",
  ],
  resultFor(params): DemoResult {
    const pageId = Object.hasOwn(PAGES, params.page_id) ? params.page_id : "sample-landing";
    const page = PAGES[pageId];
    const device: Device = params.device === "desktop" ? "desktop" : "mobile";
    const report = page.reports[device];
    return {
      scenario_id: `${pageId}-${device}`,
      as_of: AS_OF,
      summary: report.summary,
      data: {
        page: { id: pageId, label: page.label, url: page.url },
        device,
        score: report.score,
        metrics: report.metrics,
        thresholds: THRESHOLDS,
        checks: checks(report.metrics),
        opportunities: report.opportunities,
      },
      sources: [],
    };
  },
};
