// What the local wallet or a facilitator may make the client hold in memory: the wallet's answers are read up to 256 KB, a
// facilitator's /supported up to 256 KB, and the wallet's refusal text reaches an agent as one short line. fetch is replaced
// with streams that count what was pulled from them and whether they were cancelled.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_NETWORK } from "../../src/core/chain.js";
import { FACILITATORS } from "../../src/core/facilitator.js";
import { SignRefused } from "../../src/core/signer/types.js";
import { WalletSigner } from "../../src/core/signer/wallet.js";

const ESC = "\u001b";
const BEL = "\u0007";

type Counters = { pulled: number; cancelled: number };

/** An answer of `head`, `padBytes` of "x" in 64 KB chunks, then `tail`. Chunks are made only when the reader asks. */
function big(head: string, padBytes: number, tail: string, status = 200): { counters: Counters; response: () => Response } {
  const counters: Counters = { pulled: 0, cancelled: 0 };
  const enc = new TextEncoder();
  return {
    counters,
    response() {
      let phase = 0;
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (phase === 0) { const b = enc.encode(head); counters.pulled += b.length; c.enqueue(b); phase = 1; return; }
          if (phase === 1) {
            const n = Math.min(64 * 1024, padBytes - sent);
            if (n > 0) { sent += n; counters.pulled += n; c.enqueue(new Uint8Array(n).fill(120)); }
            if (sent >= padBytes) phase = 2;
            return;
          }
          const b = enc.encode(tail); counters.pulled += b.length; c.enqueue(b); c.close();
        },
        cancel() { counters.cancelled++; },
      }, { highWaterMark: 0 });
      return new Response(stream, { status, headers: { "content-type": "application/json" } });
    },
  };
}

const wallet = (fetchImpl: typeof fetch) => new WalletSigner({ url: "http://127.0.0.1:1", agentToken: "t", fetchImpl });
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as SignRefused);

describe("the wallet's answers", () => {
  it("29. a 10 MB answer is not an answer from this wallet, and is read only as far as the cap", async () => {
    const b = big('{"address":"0x1","pad":"', 10_000_000, '"}');
    const err = await refusal(wallet((async () => b.response()) as typeof fetch).status());
    expect(err).toBeInstanceOf(SignRefused);
    expect(err?.code).toBe("unavailable");
    expect(b.counters.pulled).toBeLessThan(600_000);
    expect(b.counters.cancelled).toBeGreaterThan(0);
  });

  it("30. a refusal's text reaches the caller without escape sequences", async () => {
    const fetchImpl = (async () => new Response(`bad ${ESC}]0;x${BEL} request`, { status: 400 })) as typeof fetch;
    const err = await refusal(wallet(fetchImpl).status());
    expect(err?.code).toBe("invalid");
    expect(err?.message).toContain("HTTP 400");
    expect(err?.message).toContain("bad");
    expect(err?.message).not.toContain(ESC);
    expect(err?.message).not.toContain(BEL);
  });

  it("31. an answer that is not JSON is the wallet being unavailable", async () => {
    const err = await refusal(wallet((async () => new Response("not json", { status: 200 })) as typeof fetch).status());
    expect(err?.code).toBe("unavailable");
  });

  it("31b. an answer of a few KB is read as before", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ address: "0xabc" }), { status: 200 })) as typeof fetch;
    expect(await wallet(fetchImpl).status()).toEqual({ address: "0xabc" });
  });
});

describe("doctor: a facilitator's /supported", () => {
  let home: string;
  let runDoctor: typeof import("../../src/cli/doctor.js").runDoctor;
  const hosts = FACILITATORS.map((u) => new URL(u).host);
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "superstables-doctor-caps-"));
    process.env.SUPERSTABLES_HOME = home;
    delete process.env.SUPERSTABLES_DOCTOR_OFFLINE;
    ({ runDoctor } = await import("../../src/cli/doctor.js"));
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  /** fetch where /supported answers `supported()` and everything else is a 404. */
  function stub(supported: () => Response): void {
    vi.stubGlobal("fetch", async (input: unknown) => (String(input).endsWith("/supported") ? supported() : new Response("{}", { status: 404 })));
  }
  const facilitatorChecks = async () => (await runDoctor("local")).checks.filter((c) => hosts.includes(c.name));

  it("32. a 10 MB /supported is not read past 256 KB, and no facilitator is reported as settling", async () => {
    const streams = FACILITATORS.map(() => big(`{"kinds":[{"network":"${DEFAULT_NETWORK.caip2}","scheme":"exact"}],"pad":"`, 10_000_000, '"}'));
    let next = 0;
    stub(() => streams[next++].response());
    const checks = await facilitatorChecks();
    expect(checks).toHaveLength(3);
    for (const c of checks) expect(c).toMatchObject({ ok: false, detail: "answered /supported with more than 256 KB" });
    for (const s of streams) {
      expect(s.counters.pulled).toBeLessThan(600_000);
      expect(s.counters.cancelled).toBeGreaterThan(0);
    }
  });

  it("33. a /supported that is not JSON says so", async () => {
    stub(() => new Response("<html>", { status: 200 }));
    for (const c of await facilitatorChecks()) expect(c).toMatchObject({ ok: false, detail: "answered /supported, but not with JSON" });
  });

  it("34. a /supported of null lists nothing", async () => {
    stub(() => new Response("null", { status: 200 }));
    for (const c of await facilitatorChecks()) expect(c).toMatchObject({ ok: false, detail: `answered, but does not list ${DEFAULT_NETWORK.caip2}` });
  });

  it("34b. a /supported that lists the network is still read as before", async () => {
    stub(() => new Response(JSON.stringify({ kinds: [{ network: DEFAULT_NETWORK.caip2, scheme: "exact" }] }), { status: 200 }));
    for (const c of await facilitatorChecks()) expect(c).toMatchObject({ ok: true });
  });
});
