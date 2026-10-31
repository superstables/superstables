// "Recommended" is banned from shipped copy. scripts/check-banned-copy.mjs is the one check (`npm run copy:check`);
// this runs it in CI and shows it catches the word, its marker and its expiry.
import { describe, expect, it } from "vitest";
import { findBanned, isShipped, trackedShippedFiles } from "../../scripts/check-banned-copy.mjs";

describe("banned copy", () => {
  it("finds nothing in the shipped files", () => {
    expect(findBanned(trackedShippedFiles()).map((f: { message: string }) => f.message)).toEqual([]);
  });

  it("covers the surfaces the label could appear on", () => {
    for (const path of ["plugin/skills/superstables/SKILL.md", "skills/superstables-payments/SKILL.md", "plugin/plugin.json", ".claude-plugin/marketplace.json", "README.md", "docs/cli.md", "src/cli/main.ts"]) expect(isShipped(path), path).toBe(true);
    for (const path of ["test/scripts/plugin-zip.test.ts", "CHANGELOG.md", "evals/results/2026-10-18-hostile-cli-named.md"]) expect(isShipped(path), path).toBe(false);
  });

  it("fails on the word and names the fix", () => {
    const [f] = findBanned([{ path: "README.md", text: 'label: "Recommended"' }], "2026-11-01");
    expect(f.message).toMatch(/README\.md:1 says "Recommended"\. Do not label an option/);
  });

  it("allows a line with a reason, an unexpired date and a human's approval, and only that", () => {
    const line = (tail: string) => [{ path: "a.md", text: `x recommended y // ${tail}` }];
    const ok = "copy-ok(recommended): a quoted third-party label; expires 2026-12-01; approved by a human, 2026-10-31";
    expect(findBanned(line(ok), "2026-11-01")).toEqual([]);
    expect(findBanned(line(ok), "2026-12-02")[0].message).toMatch(/expired on 2026-12-01/);
    expect(findBanned(line("copy-ok(recommended): reason"), "2026-11-01")).toHaveLength(1);
  });
});
