// The version a development build is stamped with. Small, pure, and worth a test of its own,
// because it is what tells two builds of the same release apart: get it wrong and a development
// copy reports itself as the release, which is the confusion this exists to prevent.

import { describe, expect, it } from "vitest";
import { devVersion, revisionOf, utcTimestamp } from "../../scripts/dev-version.mjs";

describe("the development build version", () => {
  it("names the release and the commit it was built at", () => {
    expect(devVersion("0.1.0", { count: 14, sha: "abc1234" })).toBe("0.1.0-dev.14+gabc1234");
  });

  it("sorts below the release it comes from, as a prerelease", () => {
    // A stamped build must never look newer than the release itself.
    expect(devVersion("0.1.0", { count: 14, sha: "abc1234" }).startsWith("0.1.0-")).toBe(true);
  });

  it("falls back to the UTC minute when there is no git", () => {
    expect(devVersion("0.1.0", { timestamp: "202609181207" })).toBe("0.1.0-dev.202609181207");
    expect(utcTimestamp(new Date("2026-09-18T12:07:41.000Z"))).toBe("202609181207");
  });

  it("keeps a release's own prerelease, and replaces an earlier dev stamp", () => {
    expect(devVersion("0.2.0-rc.1", { count: 3, sha: "0badf00d" })).toBe("0.2.0-rc.1.dev.3+g0badf00d");
    // Stamping a stamped version twice must not grow it without bound.
    expect(devVersion("0.1.0-dev.13+gdeadbee", { count: 14, sha: "abc1234" })).toBe("0.1.0-dev.14+gabc1234");
  });

  it("refuses what it cannot stamp, rather than inventing a version", () => {
    expect(() => devVersion("not-a-version", { count: 1, sha: "abc1234" })).toThrow(/not a version/);
    expect(() => devVersion("0.1.0", { count: "many", sha: "abc1234" })).toThrow(/commit count/);
    expect(() => devVersion("0.1.0", { count: 1, sha: "zzz" })).toThrow(/commit hash/);
    expect(() => devVersion("0.1.0", { timestamp: "yesterday" })).toThrow(/YYYYMMDDHHmm/);
  });

  it("reads this repository's own revision, and never fails over a missing git", () => {
    const here = revisionOf(new URL("../../", import.meta.url).pathname);
    expect(devVersion("0.1.0", here)).toMatch(/^0\.1\.0-dev\.(\d+\+g[0-9a-f]{4,40}|\d{12})$/);

    // A directory that is not a checkout still produces a version, from the clock.
    const nowhere = revisionOf("/", new Date("2026-09-18T12:07:41.000Z"));
    expect(devVersion("0.1.0", nowhere)).toMatch(/^0\.1\.0-dev\.(\d+\+g[0-9a-f]{4,40}|202609181207)$/);
  });
});
