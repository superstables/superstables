// Product lookup: a prepared comparison for one of three fixed shopping queries, filtered by a
// price ceiling in EUR. The products, vendors, prices and ratings are fictional and were written
// for the demo; nothing here queries a shop, and nothing in it is a live price or a stock level.

import type { DemoResult, DemoServiceDefinition } from "../types";

const AS_OF = "2026-09-21T09:00:00Z";

const QUERY_IDS = ["usb-c-hub", "standing-desk", "noise-cancelling-headphones"] as const;
const MAX_EUR = ["50", "150", "400"] as const;

type QueryId = (typeof QUERY_IDS)[number];
type MaxEur = (typeof MAX_EUR)[number];

interface Product {
  name: string;
  vendor: "Sample Store" | "Demo Outlet" | "Example Electronics";
  price_eur: number;
  rating: number;
  availability: "in stock" | "2–3 days";
  note: string;
}

interface Query {
  query: string;
  /** Sorted by price, and the first is always at or under the lowest ceiling, so no filter empties the list. */
  products: Product[];
  /** The pick for each ceiling; always one of the products at or under it. */
  best_value: Record<MaxEur, { name: string; reason: string }>;
}

const QUERIES: Record<QueryId, Query> = {
  "usb-c-hub": {
    query: "USB-C hub",
    products: [
      { name: "Portly 4", vendor: "Sample Store", price_eur: 24.9, rating: 4.1, availability: "in stock", note: "Four USB-A ports and nothing else; fine for a keyboard, a mouse and a drive." },
      { name: "Hubline Six", vendor: "Demo Outlet", price_eur: 44.5, rating: 4.3, availability: "in stock", note: "Six ports with HDMI at 4K30 and 60 W passthrough; runs warm under load." },
      { name: "Docklet Pro 8", vendor: "Example Electronics", price_eur: 89, rating: 4.5, availability: "2–3 days", note: "Eight ports, HDMI at 4K60, 100 W passthrough and an SD reader." },
      { name: "Harbor Dock 11", vendor: "Sample Store", price_eur: 179, rating: 4.6, availability: "in stock", note: "Dual-display dock with Ethernet; needs its own power brick." },
      { name: "Harbor Dock Max", vendor: "Example Electronics", price_eur: 329, rating: 4.7, availability: "2–3 days", note: "Triple-display dock with 140 W charging; more than one laptop needs." },
    ],
    best_value: {
      "50": { name: "Hubline Six", reason: "The only option under 50 EUR with a video output and passthrough charging." },
      "150": { name: "Docklet Pro 8", reason: "Twice the Hubline Six for 4K60, full-speed charging and a card reader." },
      "400": { name: "Docklet Pro 8", reason: "The docks above it cost two to four times as much for displays most setups never use." },
    },
  },
  "standing-desk": {
    query: "Standing desk",
    products: [
      { name: "Riser Lite", vendor: "Demo Outlet", price_eur: 49, rating: 3.9, availability: "in stock", note: "Tabletop sit-stand riser with a manual lift; one monitor and a laptop at most." },
      { name: "Tabletop Lift Plus", vendor: "Sample Store", price_eur: 129, rating: 4.2, availability: "in stock", note: "Gas-spring riser wide enough for two monitors; heavy to move." },
      { name: "Liftframe Basic", vendor: "Example Electronics", price_eur: 249, rating: 4.4, availability: "2–3 days", note: "Single-motor frame with a 120 cm top; sways a little at full height." },
      { name: "Deskrise 140", vendor: "Sample Store", price_eur: 349, rating: 4.6, availability: "in stock", note: "Dual motors, 140 cm top, four height presets; the quiet one." },
      { name: "Deskrise 160 Pro", vendor: "Demo Outlet", price_eur: 399, rating: 4.7, availability: "2–3 days", note: "Dual motors, 160 cm top, anti-collision; assembly takes an hour." },
    ],
    best_value: {
      "50": { name: "Riser Lite", reason: "The only prepared option at or under 50 EUR; a riser, not a full desk." },
      "150": { name: "Tabletop Lift Plus", reason: "Holds a two-monitor setup, which the Riser Lite cannot, without the cost of a motorised frame." },
      "400": { name: "Deskrise 140", reason: "Dual motors and presets for 50 EUR less than the 160 Pro; the wider top is the only thing given up." },
    },
  },
  "noise-cancelling-headphones": {
    query: "Noise-cancelling headphones",
    products: [
      { name: "Quietbud Go", vendor: "Demo Outlet", price_eur: 39.9, rating: 3.8, availability: "in stock", note: "In-ear with basic cancellation; fine on a train, weak in wind." },
      { name: "Hushtone 200", vendor: "Sample Store", price_eur: 119, rating: 4.2, availability: "in stock", note: "Over-ear, 30 h battery; cuts low rumble, not nearby voices." },
      { name: "Hushtone 300", vendor: "Example Electronics", price_eur: 189, rating: 4.5, availability: "2–3 days", note: "Adds multipoint pairing and a transparency mode." },
      { name: "Silentwave X", vendor: "Sample Store", price_eur: 279, rating: 4.6, availability: "in stock", note: "Stronger cancellation and a clearer call mic; the cups run warm." },
      { name: "Silentwave X Studio", vendor: "Example Electronics", price_eur: 379, rating: 4.7, availability: "2–3 days", note: "Adds a wired studio mode and a hard case; steep for the extras." },
    ],
    best_value: {
      "50": { name: "Quietbud Go", reason: "The only prepared option at or under 50 EUR; earbuds, not over-ear." },
      "150": { name: "Hushtone 200", reason: "Over-ear cancellation and a long battery for about three times the Quietbud Go." },
      "400": { name: "Hushtone 300", reason: "Multipoint and transparency for 90 EUR less than the Silentwave X; the step up mostly buys a better mic." },
    },
  },
};

export const productSearch: DemoServiceDefinition = {
  slug: "product-search",
  name: "Product lookup",
  description: "A prepared product comparison for one of three fixed shopping queries under a price ceiling in EUR: fictional products with vendor, price, rating, availability, a one-line note and a best-value pick.",
  price: "0.003",
  params: [
    {
      name: "query_id",
      required: true,
      description: "Which prepared shopping query to answer. The products and vendors are fictional.",
      enum: QUERY_IDS,
      example: "usb-c-hub",
    },
    {
      name: "max_eur",
      required: false,
      description: "The price ceiling in EUR; only prepared products at or under it are returned.",
      enum: MAX_EUR,
      default: "400",
      example: "400",
    },
  ],
  returns: {
    query: "string",
    filters: "{ max_eur, currency }",
    products: "[{ name, vendor, price_eur, rating, availability, note }]",
    best_value: "{ name, price_eur, reason }",
  },
  examplePrompts: [
    "Find me a usb-c-hub for under 50 EUR and tell me which one to buy.",
    "Compare noise-cancelling-headphones up to 400 EUR and pick the best value.",
  ],
  resultFor(params): DemoResult {
    const queryId = (QUERY_IDS as readonly string[]).includes(params.query_id) ? (params.query_id as QueryId) : "usb-c-hub";
    const maxEur = (MAX_EUR as readonly string[]).includes(params.max_eur) ? (params.max_eur as MaxEur) : "400";
    const query = QUERIES[queryId];
    const products = query.products.filter((p) => p.price_eur <= Number(maxEur));
    const pick = products.find((p) => p.name === query.best_value[maxEur].name) ?? products[0];
    return {
      scenario_id: queryId,
      as_of: AS_OF,
      summary: `Prepared sample results for "${query.query}" at or under ${maxEur} EUR: ${products.length} of ${query.products.length} prepared products matched; the best value is the ${pick.name} at ${pick.price_eur} EUR.`,
      data: {
        query: query.query,
        filters: { max_eur: Number(maxEur), currency: "EUR" },
        products,
        best_value: { name: pick.name, price_eur: pick.price_eur, reason: query.best_value[maxEur].reason },
      },
      sources: [],
    };
  },
};
