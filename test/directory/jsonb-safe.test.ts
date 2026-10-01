// Postgres jsonb refuses U+0000. A Bazaar listing with "[\u0000-\u001f]" in a schema
// pattern stopped every full crawl, so stored source copies replace NUL with its escape text.

import { describe, expect, it } from "vitest";
import { jsonbSafe } from "@/lib/directory/normalize";

describe("jsonbSafe", () => {
  it("replaces NUL in nested strings and keys with the text \\u0000", () => {
    const raw = { schema: { not: { pattern: "[\u0000-\u001f]" } }, list: ["a\u0000b"], ["k\u0000"]: 1 };
    const safe = jsonbSafe(raw);
    expect(safe.schema.not.pattern).toBe("[\\u0000-\u001f]");
    expect(safe.list[0]).toBe("a\\u0000b");
    expect(Object.keys(safe)).toContain("k\\u0000");
  });

  it("leaves values without NUL unchanged", () => {
    const raw = { a: 1, b: null, c: [true, "x"], d: { e: "f" } };
    expect(jsonbSafe(raw)).toEqual(raw);
  });
});
