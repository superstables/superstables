// The checks `npm publish` runs first (scripts/publish-check.mjs, the prepublishOnly hook). The build and
// the CLI reference check are covered by their own steps in CI; this covers the decisions made before them.

import { describe, expect, it } from "vitest";
import { changelogSection, publishProblems } from "../../scripts/publish-check.mjs";

const changelog = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [0.3.0] - 2026-10-01",
  "",
  "- Something new.",
  "",
  "## [0.2.0] - 2026-09-22",
  "",
  "- Something older.",
  "",
].join("\n");

describe("the publish check", () => {
  it("finds the section for a version and stops at the next heading", () => {
    expect(changelogSection(changelog, "0.3.0")).toBe("- Something new.");
    expect(changelogSection(changelog, "0.2.0")).toBe("- Something older.");
    expect(changelogSection(changelog, "0.4.0")).toBeNull();
    // A version that is a prefix of another must not match it.
    expect(changelogSection(changelog, "0.3")).toBeNull();
  });

  it("ends a section at any level-2 heading, so an empty section cannot borrow older notes", () => {
    for (const next of ["##\t[0.2.0] - 2026-09-22", "   ## [0.2.0] - 2026-09-22", "##"]) {
      const text = ["## [0.3.0] - 2026-10-01", "", next, "", "- Something older.", ""].join("\n");
      expect(changelogSection(text, "0.3.0")).toBe("");
      expect(publishProblems({ status: "", version: "0.3.0", changelog: text })[0]).toMatch(/empty/);
    }
    // A level-3 heading, or one indented four spaces (a code block), is part of the section.
    const text = ["## [0.3.0]", "### Added", "    ## [0.2.0]", "## [0.2.0]", "- old"].join("\n");
    expect(changelogSection(text, "0.3.0")).toBe("### Added\n    ## [0.2.0]");
  });

  it("reads a changelog with Windows line endings the same way", () => {
    const crlf = ["## [0.3.0] - 2026-10-01", "", "##", "", "## [0.2.0] - 2026-09-22", "- Something older.", ""].join("\r\n");
    expect(changelogSection(crlf, "0.3.0")).toBe("");
    expect(publishProblems({ status: "", version: "0.3.0", changelog: crlf })[0]).toMatch(/empty/);
    expect(changelogSection(changelog.replaceAll("\n", "\r\n"), "0.3.0")).toBe("- Something new.");
  });

  it("finds a version heading written with a tab or indented", () => {
    expect(changelogSection("##\t[0.3.0]\n- new\n", "0.3.0")).toBe("- new");
    expect(changelogSection("  ## [0.3.0]\n- new\n", "0.3.0")).toBe("- new");
    // The dots in a version are not wildcards.
    expect(changelogSection("## [0x3y0]\n- new\n", "0.3.0")).toBeNull();
  });

  it("lets a clean checkout with release notes publish", () => {
    expect(publishProblems({ status: "", version: "0.3.0", changelog })).toEqual([]);
  });

  it("refuses uncommitted or untracked files", () => {
    const [problem] = publishProblems({ status: " M src/index.ts\n?? scratch.ts\n", version: "0.3.0", changelog });
    expect(problem).toMatch(/not committed/);
    expect(problem).toMatch(/scratch\.ts/);
  });

  it("refuses a folder that is not a git checkout", () => {
    expect(publishProblems({ status: null, version: "0.3.0", changelog })[0]).toMatch(/not the top of its own git checkout/);
  });

  it("refuses a version without release notes, or with an empty section", () => {
    expect(publishProblems({ status: "", version: "0.4.0", changelog })[0]).toMatch(/no "## \[0\.4\.0\]" section/);
    const empty = changelog.replace("- Something new.", "");
    expect(publishProblems({ status: "", version: "0.3.0", changelog: empty })[0]).toMatch(/empty/);
  });

  it("reports every problem at once", () => {
    expect(publishProblems({ status: " M package.json\n", version: "0.4.0", changelog })).toHaveLength(2);
  });
});
