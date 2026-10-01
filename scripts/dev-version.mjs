// The version a development build carries, so that two builds of the same release are never
// called the same thing.
//
// A development copy of the skill zip that says it is the release it came from looks exactly
// like that release once it is installed, and nothing on screen says which is running. A
// version that changes with every commit removes the ambiguity: whatever the client reports
// (`superstables --version`, `wallet_status`, the MCP server's first stderr line) names the
// exact build.
//
// The stamp is `<version>-dev.<commits>+g<sha>`: a SemVer prerelease that sorts below the
// release it is derived from, plus the commit it was built at. Without git — a tarball, a
// machine with no git — a UTC minute takes the place of the commit count.
//
// Nothing here writes to the repository's own files. `scripts/skill.mjs --dev` writes the stamp
// into the build it produces, and nowhere else.

import { execFileSync } from "node:child_process";

const SEMVER = /^(?<core>\d+\.\d+\.\d+)(?:-(?<pre>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The version string for a development build.
 *
 * @param {string} version the released version, from package.json
 * @param {{ count: number | string, sha: string } | { timestamp: string }} revision
 *   which commit this is, or the UTC minute it was built at when there is no git
 * @returns {string} for example `0.1.0-dev.14+gabc1234`, or `0.1.0-dev.202609181207`
 */
export function devVersion(version, revision) {
  const match = SEMVER.exec(String(version).trim());
  if (!match?.groups) {
    throw new Error(`"${version}" is not a version that can be stamped; expected major.minor.patch`);
  }
  const { core, pre } = match.groups;
  // Stamping twice must not grow the string forever: an earlier dev stamp is replaced, and any
  // other prerelease the release carries (`0.2.0-rc.1`) is kept in front of it.
  const kept = (pre ?? "").split(".").filter(Boolean);
  const alreadyStamped = kept.indexOf("dev");
  const carried = alreadyStamped === -1 ? kept : kept.slice(0, alreadyStamped);
  const prerelease = [...carried, "dev"].join(".");

  if ("timestamp" in revision) {
    if (!/^\d{12}$/.test(revision.timestamp)) {
      throw new Error(`"${revision.timestamp}" is not a UTC timestamp of the form YYYYMMDDHHmm`);
    }
    return `${core}-${prerelease}.${revision.timestamp}`;
  }
  const count = String(revision.count);
  const sha = String(revision.sha);
  if (!/^\d+$/.test(count)) throw new Error(`"${count}" is not a commit count`);
  if (!/^[0-9a-f]{4,40}$/.test(sha)) throw new Error(`"${sha}" is not a commit hash`);
  return `${core}-${prerelease}.${count}+g${sha}`;
}

/** `2026-09-18T12:07:41Z` -> `202609181207`. Minutes, because two builds a second apart is not a thing. */
export function utcTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

/**
 * Which commit the working tree is at, or the UTC minute when git cannot say — an export, a
 * machine without git, a directory that is not a checkout. A build never fails over this.
 *
 * @param {string} cwd the repository to ask about
 * @param {Date} [now] the clock to fall back to
 */
export function revisionOf(cwd, now = new Date()) {
  try {
    const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { count: git(["rev-list", "--count", "HEAD"]), sha: git(["rev-parse", "--short", "HEAD"]) };
  } catch {
    return { timestamp: utcTimestamp(now) };
  }
}
