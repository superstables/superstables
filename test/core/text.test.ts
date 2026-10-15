// One rule, five copies: untrustedText is the rule for somebody else's text on the `pay` side; siteText and the three
// rails' oneLine are the same rule on the `budget` side. They are built separately, so this file holds all five to the
// same output.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { untrustedJson, untrustedText, untrustedUrl } from "../../src/core/text.js";
import { field, table } from "../../src/cli/format.js";
import { siteText } from "../../budget/site.mjs";
import { oneLine as solanaOneLine } from "../../budget/solana/lib.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const { oneLine: tempoOneLine } = await import(join(REPO, "budget", "tempo", "lib", "common.ts"));
const { oneLine: evmOneLine } = await import(join(REPO, "budget", "evm", "lib.ts"));
const COPIES = { siteText, solana: solanaOneLine, tempo: tempoOneLine, evm: evmOneLine } as Record<string, (s: unknown, max?: number) => string>;
const HIDDEN = /[\p{Cf}\u{E0000}-\u{E007F}\u2060-\u2064\u0000-\u001f\u007f-\u009f]/u;

const SAMPLES = [
  "plain text",
  "line one\nline two\r\nline three",
  "\u001b]0;owned\u0007title",
  "\u001b[2J\u001b[Hcleared",
  "a\u200bzero\u200dwidth\ufeff",
  "\u202eevil\u202c \u2066isolate\u2069",
  "para\u2028graph\u2029",
  "  padded  ",
  "x".repeat(1_000),
  "a\u{E0041}\u{E0042}tag\u{E007F}", "\u{E0000}\u{E0001}\u{E0002}x", "ops\u2060\u2061\u2062\u2063\u2064",
  "soft\u00adhy\u061c\u180e\ufff9\u{1D173}", "rlo\u202e mid \u2067iso\u2069", "café 👍 ₿ stay",
];

describe("untrustedText", () => {
  it("all five give the same output", () => {
    for (const sample of SAMPLES) {
      for (const [name, copy] of Object.entries(COPIES)) {
        expect(untrustedText(sample), `${name} ${JSON.stringify(sample)}`).toBe(copy(sample));
        expect(untrustedText(sample, 20), `${name} ${JSON.stringify(sample)}`).toBe(copy(sample, 20));
      }
    }
  });

  it("none leaves a control, format, bidi or tag character", () => {
    for (const sample of SAMPLES) {
      for (const out of [untrustedText(sample, 100), ...Object.values(COPIES).map((copy) => copy(sample, 100))]) {
        expect(out, JSON.stringify(sample)).not.toMatch(HIDDEN);
      }
    }
    expect(untrustedText("café 👍 ₿ stay")).toBe("café 👍 ₿ stay");
  });

  it("leaves one bounded line with no control, zero-width or bidi characters", () => {
    for (const sample of SAMPLES) {
      const out = untrustedText(sample, 100);
      expect(out.length).toBeLessThanOrEqual(100);
      expect(out).not.toMatch(/[\u2028\u2029]/);
      expect(out).not.toMatch(HIDDEN);
    }
    expect(untrustedText(undefined)).toBe("");
    expect(untrustedText(42)).toBe("42");
  });

  it("is what the CLI's field and table print", () => {
    expect(field("name", "\u001b]0;owned\u0007weather\u202e")).toBe(`  ${"name".padEnd(16)}]0;owned weather`);
    expect(table(["name"], [["a\nb"]]).split("\n")).toEqual(["name", "----", "a b"]);
  });
});

describe("untrustedJson", () => {
  it("prints a value with no hidden characters byte for byte", () => {
    const clean = {
      payer: `0x${"ab".repeat(20)}`, transaction: `0x${"cd".repeat(32)}`, at: "2026-10-15T10:00:00.000Z",
      amount: 0.01, ok: true, none: null, list: ["a", "b c", 3], nested: { "key one": "café 👍 ₿" },
    };
    expect(JSON.stringify(untrustedJson(clean))).toBe(JSON.stringify(clean));
  });

  it("strips keys and values, at any depth", () => {
    const out = untrustedJson({ "k\u200b": { deep: ["a\u{E0041}b\u202e", { "\u{E0042}x": "y\nz" }] }, n: 1 });
    expect(out).toEqual({ k: { deep: ["ab", { x: "y z" }] }, n: 1 });
    expect(JSON.stringify(out)).not.toMatch(HIDDEN);
  });

  it("replaces a value nested more than 64 deep with a note", () => {
    let deep: unknown = "bottom";
    for (let i = 0; i < 100; i++) deep = { in: deep };
    let node = untrustedJson(deep) as unknown;
    for (let i = 0; i < 64; i++) node = (node as { in: unknown }).in;
    expect(node).toBe("(nested too deep to print)");
    expect(() => JSON.stringify(untrustedJson(deep))).not.toThrow();
  });
});

describe("untrustedUrl", () => {
  it("keeps a clean URL byte for byte, with no slash added", () => {
    expect(untrustedUrl("https://x.example")).toBe("https://x.example");
    expect(untrustedUrl("https://x.example/paid/w?a=b%20c")).toBe("https://x.example/paid/w?a=b%20c");
  });

  it("writes hidden characters in a path percent-encoded", () => {
    expect(untrustedUrl("https://a.example/\u202eevil")).toBe("https://a.example/%E2%80%AEevil");
  });

  it("flattens a URL the parser refuses", () => {
    const out = untrustedUrl("https://a\u202e.example/x\n");
    expect(out).not.toMatch(HIDDEN);
    expect(out).toContain("a.example/x");
  });
});
