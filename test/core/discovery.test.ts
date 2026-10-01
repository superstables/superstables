// Discovery has two jobs: put the one service that can actually be paid in front of the
// agent, and be honest about the rest. A listing that cannot be acted on must say why, in
// words that tell the agent whether to wait for a release or to look elsewhere.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_SERVICE_ID,
  EXTERNAL_COIN_PRICE_ID,
  HOSTED_CATALOGUE_URL,
  HOSTED_DEMO_SERVICE_URL,
  allListings,
  catalogue,
  clearHostedCatalogueCache,
  demoService,
  fetchHostedCatalogue,
  findServices,
  getService,
  hostedCatalogueUrl,
  resolveRequest,
} from "../../src/core/discovery.js";
import { startServer } from "../helpers/servers.js";

/** A response shaped like the public index: a testnet service and a mainnet one. */
const INDEX_FIXTURE = {
  services: [
    {
      id: "example-weather",
      name: "Example weather",
      description: "Hourly forecasts for one city.",
      endpoint: "https://api.example.com/weather",
      rails: ["x402"],
      chains: ["base-sepolia"],
      assets: ["USDC"],
      price: { display: "0.005 USDC per call", usd: 0.005 },
      live: true,
      last_seen_live: "2026-09-15T08:00:00.000Z",
    },
    {
      id: "example-filings",
      name: "Example filings",
      description: "Company filings, paid per document.",
      endpoint: "https://api.example.net/filings",
      rails: ["x402"],
      chains: ["base"],
      assets: ["USDC"],
      price: { display: "0.25 USDC per document", usd: 0.25 },
      live: true,
      last_seen_live: "2026-09-16T08:00:00.000Z",
    },
  ],
};

/** A response shaped like the hosted catalogue: the market service and one prepared service. */
const CATALOGUE_FIXTURE = {
  generated_at: "2026-09-21T09:00:00.000Z",
  services: [
    {
      id: DEMO_SERVICE_ID,
      name: "Superstables demo market data",
      description: "Market data for BTC and ETH, priced per request and paid with test USDC on Base Sepolia.",
      endpoint: HOSTED_DEMO_SERVICE_URL,
      method: "GET",
      params: [
        { name: "asset", in: "query", required: true, description: "Which asset to return market data for", enum: ["BTC", "ETH"], example: "BTC" },
      ],
      payment: {
        rail: "x402",
        scheme: "exact",
        network: "eip155:84532",
        networkLabel: "Base Sepolia (testnet)",
        asset: "USDC",
        price: { amountDecimal: 0.01, asset: "USDC", display: "0.01 USDC per request" },
        payTo: "0x000000000000000000000000000000000000dEaD",
      },
      operator: "Superstables (demo service on the testnet)",
      testnet: true,
      mock: false,
    },
    {
      id: "superstables-demo-wallet-briefing",
      name: "Wallet briefing",
      description: "A briefing on a sample wallet. Simulated service output. Payment uses test USDC on Base Sepolia.",
      endpoint: "https://www.superstables.com/api/demo/services/wallet-briefing",
      method: "GET",
      params: [
        { name: "sample_wallet", in: "query", required: true, description: "Which sample wallet", enum: ["demo-active", "demo-dormant"], example: "demo-active" },
        { name: "period", in: "query", required: false, description: "How far back. Default: 7d.", enum: ["7d", "30d"], example: "7d" },
      ],
      payment: {
        rail: "x402",
        scheme: "exact",
        network: "eip155:84532",
        networkLabel: "Base Sepolia (testnet)",
        asset: "USDC",
        price: { amountDecimal: 0.003, asset: "USDC", display: "0.003 USDC per request" },
        payTo: "0x000000000000000000000000000000000000dEaD",
      },
      operator: "Superstables (prepared demo service on the testnet)",
      testnet: true,
      mock: true,
      example_prompts: ["Buy me a briefing on the sample wallet demo-active."],
    },
    {
      id: "superstables-demo-audio-transcription",
      name: "Audio transcription",
      description: "A timestamped transcript of a sample clip. Simulated service output. Payment uses test USDC on Base Sepolia.",
      endpoint: "https://www.superstables.com/api/demo/services/audio-transcription",
      method: "GET",
      params: [
        { name: "clip_id", in: "query", required: true, description: "Which prepared sample clip", enum: ["standup-2026-09-14", "customer-call-excerpt"], example: "standup-2026-09-14" },
      ],
      payment: {
        rail: "x402",
        scheme: "exact",
        network: "eip155:84532",
        networkLabel: "Base Sepolia (testnet)",
        asset: "USDC",
        price: { amountDecimal: 0.01, asset: "USDC", display: "0.01 USDC per request" },
        payTo: "0x000000000000000000000000000000000000dEaD",
      },
      operator: "Superstables (prepared demo service on the testnet)",
      testnet: true,
      mock: true,
    },
  ],
};

/**
 * Stub the network: the index answers with `body`, the hosted catalogue with `catalogue`
 * (the fixture unless a test says otherwise). Each stub can be told to fail.
 */
function stubIndex(
  body: unknown,
  init: { status?: number; catalogue?: unknown; catalogueStatus?: number } = {},
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const isCatalogue = url.startsWith(hostedCatalogueUrl() ?? HOSTED_CATALOGUE_URL);
    const payload = isCatalogue ? (init.catalogue ?? CATALOGUE_FIXTURE) : body;
    const status = isCatalogue ? (init.catalogueStatus ?? 200) : (init.status ?? 200);
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearHostedCatalogueCache();
  delete process.env.SUPERSTABLES_DEMO_SERVICE_URL;
  delete process.env.SUPERSTABLES_CATALOGUE_URL;
  delete process.env.SUPERSTABLES_DEMO_SERVICES;
});

describe("findServices", () => {
  it("puts the built-in demo service first and marks it payable", async () => {
    stubIndex(INDEX_FIXTURE);
    const { services, warnings } = await findServices({});
    expect(warnings).toEqual([]);
    expect(services[0]).toMatchObject({
      id: DEMO_SERVICE_ID,
      source: "demo-catalogue",
      actionable: true,
      testnet: true,
      operator: "Superstables (demo service on the testnet)",
    });
    expect(services[0].payment).toMatchObject({
      rail: "x402",
      scheme: "exact",
      network: "eip155:84532",
      networkLabel: "Base Sepolia (testnet)",
      asset: "USDC",
      price: { amountDecimal: 0.01, asset: "USDC", display: "0.01 USDC per request" },
    });
    expect(services[0].params).toEqual([
      {
        name: "asset",
        in: "query",
        required: true,
        description: "Which asset to return market data for",
        example: "BTC",
        enum: ["BTC", "ETH"],
      },
    ]);
  });

  it("surfaces the demo service for the words a person would search with", async () => {
    stubIndex({ services: [] });
    for (const query of ["btc", "Bitcoin", "market data", "price", "demo", ""]) {
      const { services } = await findServices({ query });
      expect(services.map((s) => s.id), `query: ${query}`).toContain(DEMO_SERVICE_ID);
    }
  });

  it("leaves the demo service out of a search it has nothing to do with", async () => {
    stubIndex(INDEX_FIXTURE);
    const { services } = await findServices({ query: "shipping container tracking" });
    expect(services.map((s) => s.id)).not.toContain(DEMO_SERVICE_ID);
    expect(services[0].source).toBe("superstables-index");
  });

  it("maps index rows and says exactly why each one cannot be paid yet", async () => {
    stubIndex(INDEX_FIXTURE);
    const { services } = await findServices({ query: "example" });
    const weather = services.find((s) => s.id === "example-weather");
    const filings = services.find((s) => s.id === "example-filings");

    expect(weather).toMatchObject({
      name: "Example weather",
      endpoint: "https://api.example.com/weather",
      source: "superstables-index",
      params: [],
      actionable: false,
      notActionableReason: "the index does not yet record the request parameters this service needs",
      testnet: true,
      live: true,
      lastSeenLive: "2026-09-15T08:00:00.000Z",
    });
    expect(weather?.payment).toMatchObject({
      network: "eip155:84532",
      networkLabel: "Base Sepolia (testnet)",
      price: { amountDecimal: 0.005, display: "0.005 USDC per call" },
    });

    expect(filings).toMatchObject({
      actionable: false,
      notActionableReason: "mainnet only (x402 on base); this client pays on testnets only",
      testnet: false,
    });
    expect(filings?.payment.networkLabel).toBe("Base (mainnet)");
  });

  it("keeps the rails and chains the index returns, and says which way each listing could be paid", async () => {
    stubIndex({
      services: [
        ...INDEX_FIXTURE.services,
        // "solana" in the index is mainnet: no rail may claim it.
        { ...INDEX_FIXTURE.services[0], id: "dual", chains: ["base", "base-sepolia", "solana"] },
        { ...INDEX_FIXTURE.services[0], id: "arb", chains: ["arbitrum-sepolia"] },
        { ...INDEX_FIXTURE.services[0], id: "sol-main", chains: ["solana"] },
        { ...INDEX_FIXTURE.services[0], id: "sol-dev", chains: ["solana-devnet"] },
        { ...INDEX_FIXTURE.services[0], id: "tempo", rails: ["mpp"], chains: ["tempo-moderato"] },
      ],
    });
    const { services } = await findServices({ query: "example" });
    const by = (id: string) => services.find((s) => s.id === id);

    expect(by("example-weather")).toMatchObject({
      rails: ["x402"],
      chains: ["base-sepolia"],
      routes: { pay: true, budget: [{ rail: "evm", chain: "base-sepolia" }] },
    });
    expect(by("example-filings")?.routes).toEqual({ pay: false, budget: [] });
    const dual = by("dual");
    expect(dual?.chains).toEqual(["base", "base-sepolia", "solana"]);
    expect(dual?.routes).toEqual({ pay: true, budget: [{ rail: "evm", chain: "base-sepolia" }] });
    expect(dual?.payment.network).toBe("eip155:84532");
    expect(by("arb")?.routes).toEqual({ pay: false, budget: [{ rail: "evm", chain: "arbitrum-sepolia" }] });
    expect(by("arb")?.notActionableReason).toContain("superstables budget");
    expect(by("sol-main")?.routes).toEqual({ pay: false, budget: [] });
    expect(by("sol-dev")?.routes).toEqual({ pay: false, budget: [{ rail: "solana", chain: "devnet" }] });
    expect(by("tempo")?.routes).toEqual({ pay: false, budget: [{ rail: "tempo", chain: "moderato" }] });
  });

  it("asks the index with the query, live and limit it documents", async () => {
    const fetchMock = stubIndex(INDEX_FIXTURE);
    await findServices({ query: "weather", limit: 5 });
    const indexCall = fetchMock.mock.calls.find(([input]) => !String(input).startsWith(HOSTED_CATALOGUE_URL));
    const asked = new URL(String(indexCall?.[0]));
    expect(asked.searchParams.get("q")).toBe("weather");
    expect(asked.searchParams.get("live")).toBe("true");
    expect(asked.searchParams.get("limit")).toBe("5");
  });

  it("turns an index failure into a warning, not an error", async () => {
    stubIndex({ error: "gateway" }, { status: 502, catalogue: { services: [] } });
    const { services, warnings } = await findServices({ query: "market" });
    expect(services.map((s) => s.id)).toEqual([DEMO_SERVICE_ID]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("index could not be read");
  });

  it("does not ask the index when told not to", async () => {
    const fetchMock = stubIndex(INDEX_FIXTURE);
    const { services } = await findServices({ includeIndex: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(services).toHaveLength(2);
  });

  it("returns at most the limit asked for", async () => {
    stubIndex(INDEX_FIXTURE);
    const { services } = await findServices({ limit: 2 });
    expect(services).toHaveLength(2);
  });
});

describe("where the demo service is", () => {
  it("points at the service Superstables hosts, so there is nothing to run", () => {
    expect(HOSTED_DEMO_SERVICE_URL).toBe("https://www.superstables.com/api/demo/market");
    expect(demoService().endpoint).toBe(HOSTED_DEMO_SERVICE_URL);
  });

  it("lets the environment point at another instance, which is how a local seller is used", () => {
    process.env.SUPERSTABLES_DEMO_SERVICE_URL = "http://127.0.0.1:4402/v1/market";
    expect(demoService().endpoint).toBe("http://127.0.0.1:4402/v1/market");
    expect(resolveRequest(demoService(), { asset: "BTC" }).url).toBe(
      "http://127.0.0.1:4402/v1/market?asset=BTC",
    );
  });
});

describe("getService", () => {
  it("knows the demo service without asking anyone", async () => {
    const fetchMock = stubIndex(INDEX_FIXTURE);
    expect((await getService(DEMO_SERVICE_ID))?.name).toBe("Superstables demo market data");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds an index service by id, and nothing for an unknown one", async () => {
    stubIndex(INDEX_FIXTURE);
    expect((await getService("example-weather"))?.source).toBe("superstables-index");
    expect(await getService("no-such-service")).toBeUndefined();
  });
});

describe("the demo services switch", () => {
  it("is off by default: the catalogue is never read, nothing simulated is listed, and an outage is silent", async () => {
    const fetchMock = stubIndex(INDEX_FIXTURE, { catalogueStatus: 503 });
    const { services, warnings } = await findServices({ query: "" });
    expect(warnings).toEqual([]);
    expect(services.map((s) => s.id)).toEqual([DEMO_SERVICE_ID, EXTERNAL_COIN_PRICE_ID, "example-weather", "example-filings"]);
    expect(services.some((s) => s.mock)).toBe(false);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith(HOSTED_CATALOGUE_URL))).toHaveLength(0);
    expect(await getService("superstables-demo-wallet-briefing")).toBeUndefined();
  });

  it("is switched on by SUPERSTABLES_DEMO_SERVICES, or by the caller", async () => {
    stubIndex({ services: [] });
    expect((await findServices({ demoServices: true })).services.some((s) => s.mock)).toBe(true);
    process.env.SUPERSTABLES_DEMO_SERVICES = "on";
    expect((await findServices({})).services.some((s) => s.mock)).toBe(true);
    expect((await findServices({ demoServices: false })).services.some((s) => s.mock)).toBe(false);
    expect((await getService("superstables-demo-wallet-briefing"))?.mock).toBe(true);
  });

  it("lists simulated services after every real seller, however well they match", async () => {
    process.env.SUPERSTABLES_DEMO_SERVICES = "on";
    stubIndex(INDEX_FIXTURE);
    const { services } = await findServices({ query: "sample", limit: 10 });
    expect(services.map((s) => s.id)).toEqual([
      "example-weather",
      "example-filings",
      "superstables-demo-wallet-briefing",
      "superstables-demo-audio-transcription",
    ]);
    const all = await findServices({ query: "", limit: 10 });
    expect(all.services.map((s) => s.id)).toEqual([
      DEMO_SERVICE_ID,
      EXTERNAL_COIN_PRICE_ID,
      "example-weather",
      "example-filings",
      "superstables-demo-wallet-briefing",
      "superstables-demo-audio-transcription",
    ]);
  });
});

describe("the hosted catalogue", () => {
  beforeEach(() => {
    process.env.SUPERSTABLES_DEMO_SERVICES = "on";
  });

  it("adds hosted entries after the built-in ones, parameters and all, without repeating an id", async () => {
    stubIndex({ services: [] });
    const { listings, warnings } = await allListings();
    expect(warnings).toEqual([]);
    expect(listings.map((s) => s.id)).toEqual([DEMO_SERVICE_ID, EXTERNAL_COIN_PRICE_ID, "superstables-demo-wallet-briefing", "superstables-demo-audio-transcription"]);
    const briefing = listings[2];
    expect(briefing).toMatchObject({
      source: "demo-catalogue",
      actionable: true,
      testnet: true,
      mock: true,
      operator: "Superstables (prepared demo service on the testnet)",
      examplePrompts: ["Buy me a briefing on the sample wallet demo-active."],
    });
    expect(briefing.params.map((p) => p.name)).toEqual(["sample_wallet", "period"]);
    expect(briefing.params[1]).toMatchObject({ required: false, enum: ["7d", "30d"] });
    expect(briefing.payment.price).toEqual({ amountDecimal: 0.003, asset: "USDC", display: "0.003 USDC per request" });
    // The hosted entry can be resolved into a request like any built-in one.
    expect(resolveRequest(briefing, { sample_wallet: "demo-dormant" }).url).toBe(
      "https://www.superstables.com/api/demo/services/wallet-briefing?sample_wallet=demo-dormant",
    );
  });

  it("is searched by findServices and getService like the built-in catalogue", async () => {
    stubIndex({ services: [] });
    const { services } = await findServices({ query: "wallet briefing" });
    expect(services.map((s) => s.id)).toContain("superstables-demo-wallet-briefing");
    expect((await getService("superstables-demo-wallet-briefing"))?.name).toBe("Wallet briefing");
  });

  it("returns the listing that matches the question, and not the ones that merely share the demo vocabulary", async () => {
    stubIndex({ services: [] });
    const { services } = await findServices({ query: "a briefing on a sample wallet", limit: 2 });
    // The transcription listing mentions "a sample clip", so it follows; the market data and coin
    // price listings share no word with the question and stay out.
    expect(services.map((s) => s.id)).toEqual(["superstables-demo-wallet-briefing", "superstables-demo-audio-transcription"]);
    // An empty query keeps catalogue order.
    const all = await findServices({ query: "" });
    expect(all.services.map((s) => s.id)).toEqual([DEMO_SERVICE_ID, EXTERNAL_COIN_PRICE_ID, "superstables-demo-wallet-briefing", "superstables-demo-audio-transcription"]);
  });

  it("matches word stems and ignores stopwords, so 'transcribe this clip' finds the transcription service first", async () => {
    stubIndex({ services: [] });
    const { services } = await findServices({ query: "transcribe this clip" });
    expect(services.map((s) => s.id)).toEqual(["superstables-demo-audio-transcription"]);
    const byName = await findServices({ query: "Please get me the audio transcription of a clip" });
    expect(byName.services[0].id).toBe("superstables-demo-audio-transcription");
  });

  it("keeps index listings visible behind a query that only touches the demo vocabulary", async () => {
    stubIndex(INDEX_FIXTURE);
    const { services } = await findServices({ query: "Find me a paid service for BTC market data", limit: 10 });
    expect(services[0].id).toBe(DEMO_SERVICE_ID);
    expect(services.map((s) => s.id)).toContain("example-weather");
    expect(services.map((s) => s.id)).not.toContain("superstables-demo-audio-transcription");
    // "ether" is demo vocabulary no listing literally contains: it still surfaces the demo
    // service, after the index rows, and nothing else from the catalogue.
    const vocabulary = await findServices({ query: "ether", limit: 10 });
    expect(vocabulary.services.map((s) => s.id)).toEqual(["example-weather", "example-filings", DEMO_SERVICE_ID]);
  });

  it("probes only the listings it returns, and only the payable ones, side by side", async () => {
    const fetchMock = stubIndex(INDEX_FIXTURE);
    await findServices({ query: "", limit: 2, probe: true });
    const probes = fetchMock.mock.calls.filter(([input]) => {
      const url = String(input);
      return !url.startsWith(HOSTED_CATALOGUE_URL) && !url.startsWith("https://www.superstables.com/api/v1/services");
    });
    expect(probes).toHaveLength(2);
  });

  it("refuses a hosted endpoint that is not https, unless it is this machine", async () => {
    const plain = { ...CATALOGUE_FIXTURE.services[1], id: "hosted-plain-http", endpoint: "http://demo.example/api/pay" };
    const local = { ...CATALOGUE_FIXTURE.services[1], id: "hosted-local-http", endpoint: "http://127.0.0.1:3000/api/demo/services/wallet-briefing" };
    const noOperator = { ...CATALOGUE_FIXTURE.services[1], id: "hosted-no-operator", operator: undefined };
    stubIndex({ services: [] }, { catalogue: { services: [plain, local, noOperator] } });
    const { listings } = await allListings();
    expect(listings.find((s) => s.id === "hosted-plain-http")).toMatchObject({
      actionable: false,
      notActionableReason: "the endpoint is not https, so a payment credential would travel in the clear",
    });
    expect(listings.find((s) => s.id === "hosted-local-http")?.actionable).toBe(true);
    // No operator is invented for a row that names none.
    expect(listings.find((s) => s.id === "hosted-no-operator")?.operator).toBeUndefined();
  });

  it("remembers a failed read briefly instead of timing out on every call", async () => {
    const fetchMock = stubIndex({ services: [] }, { catalogueStatus: 503 });
    const first = await allListings();
    const second = await allListings();
    expect(first.warnings).toEqual(second.warnings);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith(HOSTED_CATALOGUE_URL))).toHaveLength(1);
  });

  it("returns nothing from fetchHostedCatalogue itself when switched off", async () => {
    process.env.SUPERSTABLES_CATALOGUE_URL = "off";
    const fetchMock = stubIndex({ services: [] });
    expect(await fetchHostedCatalogue()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the built-in market entry, so a local demo seller still wins", async () => {
    process.env.SUPERSTABLES_DEMO_SERVICE_URL = "http://127.0.0.1:4402/v1/market";
    stubIndex({ services: [] });
    const { listings } = await allListings();
    expect(listings.find((s) => s.id === DEMO_SERVICE_ID)?.endpoint).toBe("http://127.0.0.1:4402/v1/market");
    expect(listings.filter((s) => s.id === DEMO_SERVICE_ID)).toHaveLength(1);
    expect(listings.map((s) => s.id)).toContain("superstables-demo-wallet-briefing");
  });

  it("falls back to the built-in listings with a warning when the host cannot be read", async () => {
    stubIndex({ services: [] }, { catalogueStatus: 503 });
    const { listings, warnings } = await allListings();
    expect(listings.map((s) => s.id)).toEqual([DEMO_SERVICE_ID, EXTERNAL_COIN_PRICE_ID]);
    expect(warnings).toEqual(["The hosted catalogue could not be read (HTTP 503); showing the built-in listings only."]);
    // findServices carries the same warning to the agent.
    const found = await findServices({});
    expect(found.warnings).toContain(warnings[0]);
    expect(found.services[0].id).toBe(DEMO_SERVICE_ID);
  });

  it("drops entries it cannot make sense of, one by one", async () => {
    const broken = {
      services: [
        CATALOGUE_FIXTURE.services[1],
        { id: "no-endpoint", name: "Broken", description: "", method: "GET", params: [], payment: { rail: "x402", scheme: "exact", network: "eip155:84532", asset: "USDC" } },
        { id: "bad-url", name: "Broken", description: "", endpoint: "not a url", method: "GET", params: [], payment: { rail: "x402", scheme: "exact", network: "eip155:84532", asset: "USDC" } },
        "not even an object",
      ],
    };
    stubIndex({ services: [] }, { catalogue: broken });
    const { listings, warnings } = await allListings();
    expect(warnings).toEqual([]);
    expect(listings.map((s) => s.id)).toEqual([DEMO_SERVICE_ID, EXTERNAL_COIN_PRICE_ID, "superstables-demo-wallet-briefing"]);
  });

  it("treats a body that is not a catalogue as unreadable", async () => {
    stubIndex({ services: [] }, { catalogue: { hello: "world" } });
    const { warnings } = await allListings();
    expect(warnings[0]).toMatch(/not a catalogue/);
  });

  it("marks a hosted entry this release cannot pay, and says why", async () => {
    const mainnet = { ...CATALOGUE_FIXTURE.services[1], id: "hosted-mainnet", payment: { ...CATALOGUE_FIXTURE.services[1].payment, network: "eip155:8453", networkLabel: "Base (mainnet)" } };
    const unconfigured = { ...CATALOGUE_FIXTURE.services[1], id: "hosted-unconfigured", payment: { ...CATALOGUE_FIXTURE.services[1].payment, payTo: undefined, configured: false } };
    stubIndex({ services: [] }, { catalogue: { services: [mainnet, unconfigured] } });
    const { listings } = await allListings();
    expect(listings.find((s) => s.id === "hosted-mainnet")).toMatchObject({
      actionable: false,
      testnet: false,
      notActionableReason: "Base (mainnet) in USDC is not supported in this release",
    });
    expect(listings.find((s) => s.id === "hosted-unconfigured")).toMatchObject({
      actionable: false,
      notActionableReason: "the seller has no payout address configured, so it cannot be paid right now",
    });
  });

  it("is read once and then remembered for a while", async () => {
    const fetchMock = stubIndex({ services: [] });
    await allListings();
    await allListings();
    await findServices({ includeIndex: false });
    const catalogueReads = fetchMock.mock.calls.filter(([input]) => String(input).startsWith(HOSTED_CATALOGUE_URL));
    expect(catalogueReads).toHaveLength(1);
  });

  it("is not read when the caller asked for no network, or switched it off", async () => {
    const fetchMock = stubIndex({ services: [] });
    await findServices({ includeIndex: false });
    await getService(DEMO_SERVICE_ID, { includeIndex: false });
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.SUPERSTABLES_CATALOGUE_URL = "off";
    expect(hostedCatalogueUrl()).toBeUndefined();
    const { listings, warnings } = await allListings();
    expect(warnings).toEqual([]);
    expect(listings.map((s) => s.id)).toEqual([DEMO_SERVICE_ID, EXTERNAL_COIN_PRICE_ID]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("can be pointed at another deployment", async () => {
    process.env.SUPERSTABLES_CATALOGUE_URL = "http://127.0.0.1:3000/api/demo/catalogue";
    const fetchMock = stubIndex({ services: [] });
    await allListings();
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:3000/api/demo/catalogue");
  });
});

describe("probing the demo service", () => {
  it("counts a 402 as alive, because that is how a paid endpoint answers", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end("{}");
    });
    process.env.SUPERSTABLES_DEMO_SERVICE_URL = `${server.url}/v1/market`;
    try {
      const { services } = await findServices({ includeIndex: false, probe: true });
      expect(services[0].live).toBe(true);
      expect(services[0].lastSeenLive).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it("reports a service that is not there as not live", async () => {
    process.env.SUPERSTABLES_DEMO_SERVICE_URL = "http://127.0.0.1:1/v1/market";
    const { services } = await findServices({ includeIndex: false, probe: true });
    expect(services[0].live).toBe(false);
    expect(services[0].lastSeenLive).toBeUndefined();
  });

  it("says nothing about liveness when it was not asked to look", async () => {
    const { services } = await findServices({ includeIndex: false });
    expect(services[0].live).toBeUndefined();
  });
});

describe("resolveRequest", () => {
  const service = demoService();

  it("builds the URL that will be quoted and paid", () => {
    const request = resolveRequest(service, { asset: "btc" });
    expect(request.serviceId).toBe(DEMO_SERVICE_ID);
    expect(request.method).toBe("GET");
    // The documented spelling is used, so the seller sees what it published.
    expect(request.params).toEqual({ asset: "BTC" });
    expect(new URL(request.url).searchParams.get("asset")).toBe("BTC");
  });

  it("refuses a missing required parameter and says what is allowed", () => {
    expect(() => resolveRequest(service, {})).toThrow(
      "Cannot call Superstables demo market data: asset is required (one of BTC, ETH).",
    );
  });

  it("refuses a value outside the documented set", () => {
    expect(() => resolveRequest(service, { asset: "DOGE" })).toThrow(/asset="DOGE" is not one of BTC, ETH/);
  });

  it("passes through parameters a listing does not document", () => {
    const listing = { ...service, params: [] };
    const request = resolveRequest(listing, { city: "Lisbon" });
    expect(new URL(request.url).searchParams.get("city")).toBe("Lisbon");
  });
});

describe("the third-party listing", () => {
  it("is in the catalogue after the demo service, actionable, on the testnet", async () => {
    expect(catalogue().map((s) => s.id)).toEqual([DEMO_SERVICE_ID, EXTERNAL_COIN_PRICE_ID]);
    // Both mention BTC; the tie keeps catalogue order, ours first.
    const { services } = await findServices({ query: "btc", includeIndex: false });
    expect(services.map((s) => s.id)).toEqual([DEMO_SERVICE_ID, EXTERNAL_COIN_PRICE_ID]);
    // Ask for what only the third party calls itself, and it comes first.
    const byName = await findServices({ query: "coin price api", includeIndex: false });
    expect(byName.services[0].id).toBe(EXTERNAL_COIN_PRICE_ID);
    const external = services[1];
    expect(external.actionable).toBe(true);
    expect(external.testnet).toBe(true);
    expect(external.operator).toMatch(/not operated by Superstables/);
    expect((await getService(EXTERNAL_COIN_PRICE_ID, { includeIndex: false }))?.id).toBe(EXTERNAL_COIN_PRICE_ID);
  });

  it("builds the request from its symbol parameter", () => {
    const request = resolveRequest(catalogue()[1], { symbol: "BTC" });
    expect(request.url).toBe("https://x402-coin-api.vercel.app/api/price?symbol=BTC");
    expect(() => resolveRequest(catalogue()[1], {})).toThrow(/symbol/);
  });
});
