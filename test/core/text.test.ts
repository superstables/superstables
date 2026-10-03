// untrustedText is the one rule for somebody else's text on the `pay` side; siteText is the same rule on the `budget`
// side. They are built separately, so this file holds them to the same output.

import { describe, expect, it } from "vitest";
import { untrustedText } from "../../src/core/text.js";
import { field, table } from "../../src/cli/format.js";
import { siteText } from "../../budget/site.mjs";

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
];

describe("untrustedText", () => {
  it("gives the same output as the budget half's siteText", () => {
    for (const sample of SAMPLES) {
      expect(untrustedText(sample), JSON.stringify(sample)).toBe(siteText(sample));
      expect(untrustedText(sample, 20), JSON.stringify(sample)).toBe(siteText(sample, 20));
    }
  });

  it("leaves one bounded line with no control, zero-width or bidi characters", () => {
    for (const sample of SAMPLES) {
      const out = untrustedText(sample, 100);
      expect(out.length).toBeLessThanOrEqual(100);
      expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
    }
    expect(untrustedText(undefined)).toBe("");
    expect(untrustedText(42)).toBe("42");
  });

  it("is what the CLI's field and table print", () => {
    expect(field("name", "\u001b]0;owned\u0007weather\u202e")).toBe(`  ${"name".padEnd(16)}]0;owned weather`);
    expect(table(["name"], [["a\nb"]]).split("\n")).toEqual(["name", "----", "a b"]);
  });
});
