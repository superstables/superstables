// A detached owner approval returns its link as soon as the worker records it (approvals.mjs startDetached). The rail
// writes the link on stdout and the words for the owner on stderr, two pipes read separately, so the worker records the
// link only once those words are in its log (linkGate). These tests hold the words back on purpose.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const URL_ = "https://www.superstables.com/approve/budget/bl_test0001#ssba_test_owner1";
const APPROVE = { action: "setup", url: URL_, expires: new Date(Date.now() + 600_000).toISOString(), terms: { title: "Link" }, matchCode: "ABC-DEF" };
const WORDS = `\nWrite this approval link, the match code ABC-DEF and the terms in your reply to the owner:\n\n  ${URL_}\n`;

let home: string;
let approvals: typeof import("../../budget/approvals.mjs");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-link-gate-"));
  process.env.SUPERSTABLES_HOME = home;
  approvals = await import("../../budget/approvals.mjs");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("namesUrl", () => {
  it("takes the URL as a whole token only: not with a suffix, and not as the start of a longer URL", () => {
    expect(approvals.namesUrl(WORDS, URL_)).toBe(true);
    expect(approvals.namesUrl(`"${URL_}"`, URL_)).toBe(true);
    expect(approvals.namesUrl(URL_, URL_)).toBe(true);
    expect(approvals.namesUrl(`  ${URL_}DIFFERENT\n`, URL_)).toBe(false);
    expect(approvals.namesUrl(`  ${URL_}x/more?y=1\n`, URL_)).toBe(false);
    expect(approvals.namesUrl(`  evil${URL_}\n`, URL_)).toBe(false);
    expect(approvals.namesUrl(`  ${URL_}DIFFERENT and then ${URL_}\n`, URL_)).toBe(true);
  });
});

describe("linkGate", () => {
  const gate = (waitMs = 60_000) => {
    const recorded: unknown[] = [];
    const how: unknown[] = [];
    return { recorded, how, g: approvals.linkGate("oa-test", { waitMs, record: ((_id: string, a: unknown, o: unknown) => { recorded.push(a); how.push(o); }) as never }) };
  };

  it("records a link only once the words naming its URL were written", () => {
    const { recorded, g } = gate();
    g.link(APPROVE);
    g.shown("some other log line\n");
    expect(recorded).toEqual([]);
    g.shown(WORDS.slice(0, 40));
    expect(recorded).toEqual([]);
    g.shown(WORDS.slice(40));
    expect(recorded).toEqual([APPROVE]);
  });

  it("has no short fallback: the link waits as long as the words do", async () => {
    const { recorded, how, g } = gate(approvals.LINK_TEXT_WAIT_MS);
    g.link(APPROVE);
    await new Promise((r) => setTimeout(r, 4_000));
    expect(recorded).toEqual([]);
    g.shown(WORDS);
    expect(how).toEqual([{ wordsLogged: true }]);
    expect(approvals.LINK_TEXT_WAIT_MS).toBeGreaterThanOrEqual(60_000);
    expect(approvals.LINK_TEXT_WAIT_MS).toBeLessThan(approvals.LINK_WAIT_MS);
  }, 10_000);

  it("is not released by the URL with a suffix, or by a longer URL that starts with it", () => {
    const { recorded, g } = gate();
    g.link(APPROVE);
    g.shown(`\n  ${URL_}DIFFERENT\n`);
    g.shown(`\n  ${URL_}0/other\n`);
    expect(recorded).toEqual([]);
    g.shown(WORDS);
    expect(recorded).toEqual([APPROVE]);
  });

  it("records at once when the words came before the link (the other pipe was read first)", () => {
    const { recorded, g } = gate();
    g.shown(WORDS);
    g.link(APPROVE);
    expect(recorded).toEqual([APPROVE]);
  });

  it("records without the words, marked so, only after the safety wait or when the rail ends, and only once", async () => {
    const a = gate(50);
    a.g.link(APPROVE);
    await new Promise((r) => setTimeout(r, 120));
    expect(a.recorded).toEqual([APPROVE]);
    expect(a.how).toEqual([{ wordsLogged: false }]);
    a.g.flush();
    expect(a.recorded).toHaveLength(1);
    const b = gate();
    b.g.link(APPROVE);
    b.g.flush();
    b.g.shown(WORDS);
    expect(b.recorded).toEqual([APPROVE]);
    expect(b.how).toEqual([{ wordsLogged: false }]);
  });
});

describe("startDetached", () => {
  /** Run a worker that sees the link first and writes the words `delayMs` later (never, for null), as the two pipes allow. */
  async function detached(delayMs: number | null, waitMs?: number, cut?: "truncate" | "replace") {
    const worker = join(home, `worker-${delayMs}-${waitMs}-${cut}.mjs`);
    // cut: after a long first part the parent has read, the words are written and the log is at once cut short
    // (truncated) or replaced by a new file, before the link is recorded
    writeFileSync(worker, `
      import { truncateSync, unlinkSync, writeFileSync } from "node:fs";
      import { linkGate, logFile, WORKER_ENV } from ${JSON.stringify(resolve(ROOT, "budget/approvals.mjs"))};
      const id = process.env[WORKER_ENV];
      const gate = linkGate(id${waitMs ? `, { waitMs: ${waitMs} }` : ""});
      ${cut ? `process.stderr.write("earlier output\\n".repeat(1000));` : ""}
      process.stdout.write("APPROVE " + JSON.stringify(${JSON.stringify(APPROVE)}) + "\\n");
      gate.link(${JSON.stringify(APPROVE)});
      ${delayMs === null ? "" : `setTimeout(() => {
        const words = ${JSON.stringify(WORDS)};
        process.stderr.write(words);
        ${cut === "truncate" ? `truncateSync(logFile(id), 0); process.stderr.write("after\\n");` : ""}
        ${cut === "replace" ? `unlinkSync(logFile(id)); writeFileSync(logFile(id), "a new file\\n");` : ""}
        gate.shown(words);
      }, ${delayMs});`}
      setTimeout(() => {}, 20000);
    `);
    const id = approvals.newApprovalId();
    expect(approvals.claim("evm", "base-sepolia", id).ok).toBe(true);
    let log = "";
    const started = Date.now();
    const r = await approvals.startDetached({ id, command: "setup", rail: "evm", chain: "base-sepolia", cmd: process.execPath, args: [worker], cwd: ROOT, timeoutS: 30, onLog: ((t: string) => { log += t; }) as never });
    const took = Date.now() - started;
    await approvals.stopGroup(r.record.pid, { start: r.record.pidStart });
    approvals.release("evm", "base-sepolia", id);
    return { r, log, took };
  }

  for (const delayMs of [600, 4_000]) {
    it(`returns the words for the owner with the link when the rail writes them ${delayMs} ms after it`, async () => {
      const { r, log, took } = await detached(delayMs);
      expect(r.kind).toBe("waiting");
      expect(r.record.url).toBe(URL_);
      expect(r.record.wordsMissing).toBeUndefined();
      expect(took).toBeGreaterThanOrEqual(delayMs);
      expect(log).toContain(WORDS);
      // copied once, not twice
      expect(log.split("Write this approval link").length).toBe(2);
    }, 30_000);
  }

  for (const cut of ["truncate", "replace"] as const) {
    it(`a log ${cut === "truncate" ? "truncated" : "replaced"} after the words: read again from its start; the words forwarded or the link marked wordsMissing`, async () => {
      const { r, log } = await detached(600, undefined, cut);
      expect(r.kind).toBe("waiting");
      // never a link without the words, silently: either the parent read them before the cut (it may, through a file
      // it had open), or the link is marked wordsMissing, in the record too
      if (log.includes(WORDS)) expect(r.record.wordsMissing).toBeUndefined();
      else {
        expect(r.record.wordsMissing).toBe(true);
        expect(approvals.readApproval(r.record.id)!.wordsMissing).toBe(true);
      }
      // the new start of the file was forwarded, not skipped by the old offset
      expect(log).toContain(cut === "truncate" ? "after\n" : "a new file\n");
    }, 30_000);
  }

  it("past the safety wait with no words: the link comes back marked wordsMissing, never as if complete", async () => {
    const { r, log } = await detached(null, 500);
    expect(r.kind).toBe("waiting");
    expect(r.record.wordsMissing).toBe(true);
    expect(log).not.toContain("Write this approval link");
  }, 30_000);
});
