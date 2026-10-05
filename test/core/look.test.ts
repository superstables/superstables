// The look of the pages served on 127.0.0.1: plain unless the owner pointed this client at superstables.com.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approvalNotFoundPage } from "../../src/core/signer/approval-page.js";
import { isSuperstablesSite, pageLook } from "../../src/core/signer/look.js";
import { ownerNotFoundPage } from "../../src/core/signer/owner-approval-page.js";

const homes: string[] = [];
function home(publicFiles: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ss-look-"));
  homes.push(dir);
  mkdirSync(join(dir, "budget", "public"), { recursive: true });
  for (const [name, text] of Object.entries(publicFiles)) writeFileSync(join(dir, "budget", "public", name), text);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("which look the local pages get", () => {
  it("is plain with nothing pointing at superstables.com", () => {
    expect(pageLook({}, home())).toBe("plain");
    expect(pageLook({}, home({ "evm-base-sepolia.env": "B4_OWNER_ADDRESS=0x1\nB4_AGENT_ADDRESS=0x2\n" }))).toBe("plain");
  });

  it("is superstables when SUPERSTABLES_SITE is a superstables.com origin", () => {
    expect(pageLook({ SUPERSTABLES_SITE: "https://www.superstables.com" }, home())).toBe("superstables");
    expect(pageLook({ SUPERSTABLES_SITE: "https://staging.superstables.com" }, home())).toBe("superstables");
  });

  it("is superstables when a budget chain's approvals are hosted on superstables.com", () => {
    expect(pageLook({}, home({ "evm-base-sepolia.env": "APPROVALS=hosted\nSITE=https://www.superstables.com\n" }))).toBe("superstables");
    // a hosted chain with no SITE uses the default site, superstables.com
    expect(pageLook({}, home({ "evm-arc.env": "APPROVALS=hosted\n" }))).toBe("superstables");
  });

  it("stays plain for another site, and SUPERSTABLES_SITE decides over a recorded one", () => {
    expect(pageLook({}, home({ "evm-base-sepolia.env": "APPROVALS=hosted\nSITE=http://127.0.0.1:3000\n" }))).toBe("plain");
    const linked = home({ "evm-base-sepolia.env": "APPROVALS=hosted\nSITE=https://www.superstables.com\n" });
    expect(pageLook({ SUPERSTABLES_SITE: "https://pay.example.com" }, linked)).toBe("plain");
  });

  it("accepts only https origins on superstables.com", () => {
    expect(isSuperstablesSite("https://superstables.com")).toBe(true);
    expect(isSuperstablesSite("http://www.superstables.com")).toBe(false);
    expect(isSuperstablesSite("https://superstables.com.example.org")).toBe(false);
    expect(isSuperstablesSite("https://notsuperstables.com")).toBe(false);
    expect(isSuperstablesSite("not a url")).toBe(false);
  });
});

describe("the two looks", () => {
  it("plain names no brand; superstables carries the name and the site's typefaces, inlined", () => {
    for (const page of [approvalNotFoundPage("plain"), ownerNotFoundPage("plain")]) {
      expect(page).not.toMatch(/superstables/i);
      expect(page).not.toContain("@font-face");
    }
    for (const page of [approvalNotFoundPage("superstables"), ownerNotFoundPage("superstables")]) {
      expect(page).toContain("<title>Superstables &middot;");
      expect(page).toContain("Bricolage Grotesque");
      expect(page).toMatch(/url\("data:font\/woff2;base64,/);
    }
  });

  it("loads nothing from another origin in either look", () => {
    for (const look of ["plain", "superstables"] as const) {
      const page = ownerNotFoundPage(look);
      expect(page).not.toMatch(/<script[^>]+src=/i);
      expect(page).not.toMatch(/<link[^>]+href=/i);
      expect(page).not.toMatch(/url\((?!"data:)/);
    }
  });
});
