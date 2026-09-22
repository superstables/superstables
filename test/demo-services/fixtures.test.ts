// Every prepared demo service is held to the same contract: closed parameter sets, a fixed
// as_of, a result for every valid combination, a paid body that fits the client's 4,000
// character limit with room to spare, and prices that match the brief. One describe per
// service, so a failing fixture names itself.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEMO_SERVICES,
  ID_PREFIX,
  NOTICE,
  atomicUnits,
  envelope,
  parameterSets,
  serviceId,
  validate,
} from "../../lib/demoServices/registry";

/** The brief's price table, test USDC per call. */
const PRICES: Record<string, string> = {
  "wallet-briefing": "0.003",
  "contract-screening": "0.005",
  "web-search": "0.003",
  "whitepaper-extraction": "0.005",
  "specialist-research": "0.020",
  "image-creation": "0.020",
  "audio-transcription": "0.010",
  "product-search": "0.003",
  "job-search": "0.003",
  "website-performance": "0.005",
};

/** The client truncates service bodies at 4,000 characters; fixtures stay well under it. */
const BODY_BUDGET = 3_500;
const FIXED_AS_OF = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const PUBLIC_DIR = join(__dirname, "..", "..", "public");
const PAID = { amount: "0.020", asset: "USDC", network: "eip155:84532", transaction: `0x${"f".repeat(64)}` };

describe("the catalogue as a whole", () => {
  it("has the ten services of the brief, with unique ids and the agreed prices", () => {
    expect(DEMO_SERVICES.map((s) => s.slug).sort()).toEqual(Object.keys(PRICES).sort());
    expect(new Set(DEMO_SERVICES.map(serviceId)).size).toBe(DEMO_SERVICES.length);
    for (const def of DEMO_SERVICES) expect(def.price, def.slug).toBe(PRICES[def.slug]);
  });

  it("adds up to 0.077 test USDC for one call of each, every call under the 0.05 example cap", () => {
    const total = DEMO_SERVICES.reduce((sum, def) => sum + BigInt(atomicUnits(def.price)), BigInt(0));
    expect(total).toBe(BigInt(77_000));
    for (const def of DEMO_SERVICES) expect(Number(def.price), def.slug).toBeLessThanOrEqual(0.05);
  });

  it("converts decimal prices to atomic units exactly", () => {
    expect(atomicUnits("0.003")).toBe("3000");
    expect(atomicUnits("0.020")).toBe("20000");
    expect(atomicUnits("0.01")).toBe("10000");
    expect(atomicUnits("1")).toBe("1000000");
    expect(() => atomicUnits("0.0000001")).toThrow(/decimals/);
    expect(() => atomicUnits("0")).toThrow(/positive/);
    expect(() => atomicUnits("1e-3")).toThrow(/decimal/);
  });
});

for (const def of DEMO_SERVICES) {
  describe(def.slug, () => {
    it("is described honestly, with prompts and a documented return shape", () => {
      expect(serviceId(def)).toBe(`${ID_PREFIX}${def.slug}`);
      expect(def.slug).toMatch(/^[a-z0-9-]+$/);
      expect(def.name.length).toBeGreaterThan(3);
      expect(def.description.length).toBeGreaterThan(40);
      expect(JSON.stringify(def)).not.toContain("PLACEHOLDER");
      expect(def.examplePrompts.length).toBeGreaterThanOrEqual(1);
      expect(Object.keys(def.returns).length).toBeGreaterThanOrEqual(1);
    });

    it("declares closed parameter sets an agent can build a request from", () => {
      expect(def.params.length).toBeGreaterThanOrEqual(1);
      expect(def.params.some((p) => p.required)).toBe(true);
      for (const p of def.params) {
        expect(p.name, `${def.slug}.${p.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(p.enum.length, `${def.slug}.${p.name} enum`).toBeGreaterThanOrEqual(2);
        expect(new Set(p.enum.map((v) => v.toLowerCase())).size).toBe(p.enum.length);
        expect(p.enum, `${def.slug}.${p.name} example`).toContain(p.example);
        if (p.required) expect(p.default, `${def.slug}.${p.name} required params take no default`).toBeUndefined();
        else expect(p.enum, `${def.slug}.${p.name} default`).toContain(p.default);
        expect(p.description.length).toBeGreaterThan(10);
      }
    });

    it("answers every valid combination with a fixed, sized, disclosed result", () => {
      const sets = parameterSets(def);
      expect(sets.length).toBeGreaterThanOrEqual(2);
      for (const params of sets) {
        const label = `${def.slug} ${JSON.stringify(params)}`;
        const result = def.resultFor(params);
        expect(result.scenario_id, label).toMatch(/^[a-z0-9-]+$/);
        expect(result.as_of, label).toMatch(FIXED_AS_OF);
        expect(result.summary.length, label).toBeGreaterThanOrEqual(40);
        expect(Object.keys(result.data).length, label).toBeGreaterThanOrEqual(1);
        const body = envelope(def, result, "https://www.superstables.com", PAID);
        const text = JSON.stringify(body, null, 2);
        expect(text.length, `${label} body is ${text.length} chars`).toBeLessThanOrEqual(BODY_BUDGET);
        expect(text).not.toContain("PLACEHOLDER");
        expect(body.notice).toBe(NOTICE);
        expect(body.mock).toBe(true);
        for (const source of result.sources) {
          expect(source.title.length, label).toBeGreaterThan(3);
          if (/^https?:\/\//i.test(source.url)) {
            expect(source.url, label).toMatch(/^https:\/\//);
          } else {
            expect(source.url, label).toMatch(/^\/demo\/services\//);
            expect(existsSync(join(PUBLIC_DIR, source.url)), `${label}: ${source.url} is missing from public/`).toBe(true);
          }
        }
      }
    });

    it("gives the same answer whether an optional parameter is defaulted or spelled out", () => {
      const required = Object.fromEntries(def.params.filter((p) => p.required).map((p) => [p.name, p.example]));
      const defaulted = validate(def, new URLSearchParams(required));
      expect(defaulted.ok).toBe(true);
      if (!defaulted.ok) return;
      const explicit = { ...required, ...Object.fromEntries(def.params.filter((p) => !p.required).map((p) => [p.name, p.default as string])) };
      expect(defaulted.params).toEqual(explicit);
      expect(def.resultFor(defaulted.params)).toEqual(def.resultFor(explicit));
    });

    it("refuses what it does not sell, before any payment", () => {
      const first = def.params[0];
      const good = Object.fromEntries(def.params.filter((p) => p.required).map((p) => [p.name, p.example]));
      expect(validate(def, new URLSearchParams({ ...good, [first.name]: "not-a-real-value" }))).toMatchObject({ ok: false, status: 400 });
      expect(validate(def, new URLSearchParams({ ...good, nonsense: "1" }))).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("nonsense") });
      const doubled = new URLSearchParams(good);
      doubled.append(first.name, first.example);
      expect(validate(def, doubled)).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("once") });
      const missing = new URLSearchParams(good);
      const requiredName = def.params.find((p) => p.required)!.name;
      missing.delete(requiredName);
      expect(validate(def, missing)).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("required") });
      // Case does not matter, and the canonical spelling comes back.
      const upper = new URLSearchParams(Object.fromEntries(Object.entries(good).map(([k, v]) => [k, v.toUpperCase()])));
      expect(validate(def, upper)).toMatchObject({ ok: true, params: expect.objectContaining(good) });
    });
  });
}
