// Agent access tokens never reach the dispatcher's output, even when a pipe cuts one between two chunks.
import { describe, expect, it } from "vitest";
import { agentTokenScrubber, scrubAgentTokens } from "../../budget/site.mjs";

const SECRET = "Zx9_Kq-2".repeat(5) + "abc";
const LINE = `the site said ssbt_test_${SECRET} and sspt_${SECRET}, see https://www.superstables.com/approve/budget/ba_x#ssba_test_owner\n`;

const run = (chunks: string[]) => {
  const s = agentTokenScrubber();
  return chunks.map((c) => s.push(c)).join("") + s.end();
};

describe("agentTokenScrubber", () => {
  it("takes a token out whatever offset the stream is cut at, in two chunks or three", () => {
    const whole = scrubAgentTokens(LINE);
    expect(whole).not.toContain(SECRET.slice(0, 8));
    for (let i = 0; i <= LINE.length; i++) {
      expect(run([LINE.slice(0, i), LINE.slice(i)])).toBe(whole);
      for (let j = i; j <= LINE.length; j += 7) expect(run([LINE.slice(0, i), LINE.slice(i, j), LINE.slice(j)])).toBe(whole);
    }
    // one character at a time
    expect(run([...LINE])).toBe(whole);
  });

  it("keeps the owner's link token, and holds nothing back at the end", () => {
    expect(run([LINE])).toContain("#ssba_test_owner");
    const s = agentTokenScrubber();
    expect(s.push("ends with ss")).toBe("ends with ");
    expect(s.end()).toBe("ss");
  });

  it("a token cut at a forced flush (no newline for a long time) is still taken out, also at the end of the stream", () => {
    const long = "x".repeat(70_000);
    expect(run([long + "ssb", "t_" + SECRET + "\n"])).toBe(long + "[token]\n");
    expect(run([long + "sspt_" + SECRET.slice(0, 10), SECRET.slice(10)])).toBe(long + "[token]");
  });

  it("a run of token characters longer than any token is dropped whole, across chunks", () => {
    const out = run(["a ssbt_" + "A".repeat(600), "B".repeat(100), " end\n"]);
    expect(out).toBe("a [token] end\n");
  });
});
