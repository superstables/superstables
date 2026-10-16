// The agreement engine: endpoints are believed together, never one alone. In-process fakes, no network.

import { afterEach, describe, expect, it } from "vitest";
import { KNOWN_NETWORKS } from "../../src/core/chain.js";
import { EVM_CHAINS } from "../../budget/evm/chains.mjs";
import { callerSet, endpointId, endpointSet, mainnetRpcReady, operatorOf, providerOf, RPC_ENDPOINTS, RPC_TESTNETS, useOwnerSettings } from "../../src/core/rpc-endpoints.mjs";
import { agreeAtFinalEvm, agreeAtFinalSolana, agreementWords, canonical, checkIdentity, forgetIdentities } from "../../src/core/rpc-quorum.mjs";

type Fake = { chainId?: number; finalized?: number | string; timestamp?: string; hashes?: Record<number, string>; value?: unknown; genesis?: string; slot?: number; readSlot?: number; fail?: boolean };

function transport(fakes: Record<string, Fake>) {
  const hits: string[] = [];
  const call = async (url: string, method: string, params: unknown[]): Promise<unknown> => {
    hits.push(`${url} ${method}`);
    const f = fakes[url];
    if (!f || f.fail) throw new Error("connection refused");
    if (method === "eth_chainId") return `0x${(f.chainId ?? 84532).toString(16)}`;
    if (method === "getGenesisHash") return f.genesis ?? "GEN";
    if (method === "getSlot") return f.slot ?? 100;
    if (method === "eth_getBlockByNumber") {
      const tag = params[0] as string;
      if (tag === "finalized" || tag === "latest") {
        if (typeof f.finalized === "string") return { number: f.finalized, hash: "0xaa", timestamp: "0x10" };
        const h = f.finalized ?? 100;
        return { number: `0x${h.toString(16)}`, hash: f.hashes?.[h] ?? `0xaa${h}`, timestamp: f.timestamp ?? "0x10" };
      }
      const n = Number(BigInt(tag));
      return { number: `0x${n.toString(16)}`, hash: f.hashes?.[n] ?? `0xaa${n}`, timestamp: f.timestamp ?? "0x10" };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { call, hits };
}

const mk = (urls: Record<string, string>, quorum = 2, agreement: "quorum" | "owner-node" | "single" | "caller" = "quorum") => ({ verdict: Object.entries(urls).map(([url, operator]) => ({ url, operator })), quorum, agreement });
const read = (fakes: Record<string, Fake>) => async (url: string) => fakes[url].value ?? "0x0";
const A = "https://a.example", B = "https://b.example";

afterEach(() => {
  forgetIdentities();
  useOwnerSettings(() => undefined);
});

describe("agreeAtFinalEvm", () => {
  it("two operators on the same block and value agree", async () => {
    const fakes = { [A]: { finalized: 100 }, [B]: { finalized: 120 } };
    const { call } = transport(fakes);
    const r = await agreeAtFinalEvm({ set: mk({ [A]: "a", [B]: "b" }), call, chainId: 84532, finality: "finalized", read: read(fakes) });
    expect(r).toMatchObject({ agreed: true, agreement: "quorum", operators: ["a", "b"], block: { number: 100n, hash: "0xaa100" } });
  });

  it("reads every endpoint at the lowest final head, by number", async () => {
    const fakes = { [A]: { finalized: 100 }, [B]: { finalized: 120 } };
    const { call } = transport(fakes);
    const blocks: string[] = [];
    await agreeAtFinalEvm({ set: mk({ [A]: "a", [B]: "b" }), call, chainId: 84532, finality: "finalized", read: async (_u, b) => (blocks.push(b), "0x1") });
    expect(blocks).toEqual(["0x64", "0x64"]);
  });

  it("uses latest for instant finality", async () => {
    const fakes = { [A]: { finalized: 7 }, [B]: { finalized: 7 } };
    const { call } = transport(fakes);
    const tags: unknown[] = [];
    const spy = async (u: string, m: string, p: unknown[]) => (m === "eth_getBlockByNumber" && tags.push(p[0]), call(u, m, p));
    const r = await agreeAtFinalEvm({ set: mk({ [A]: "a", [B]: "b" }), call: spy, chainId: 84532, finality: "instant", read: read(fakes) });
    expect(r.agreed).toBe(true);
    expect(tags[0]).toBe("latest");
    expect(tags).not.toContain("finalized");
  });

  it("a different hash at the agreement block is a disagreement", async () => {
    const fakes = { [A]: { finalized: 100 }, [B]: { finalized: 100, hashes: { 100: "0xbad" } } };
    const { call } = transport(fakes);
    const r = await agreeAtFinalEvm({ set: mk({ [A]: "a", [B]: "b" }), call, chainId: 84532, finality: "finalized", read: read(fakes) });
    expect(r).toMatchObject({ agreed: false, why: "disagree" });
    expect(agreementWords(r as never)).toBe("the RPC endpoints disagree");
  });

  it("a different value at the block is a disagreement, even when a third agrees", async () => {
    const fakes = { [A]: { value: "0x0" }, [B]: { value: "0x1" }, "https://c.example": { value: "0x0" } };
    const { call } = transport(fakes);
    const r = await agreeAtFinalEvm({ set: mk({ [A]: "a", [B]: "b", "https://c.example": "c" }), call, chainId: 84532, finality: "finalized", read: read(fakes) });
    expect(r).toMatchObject({ agreed: false, why: "disagree" });
  });

  it("an endpoint on the wrong chain is left out, then a second endpoint is missing", async () => {
    const fakes = { [A]: {}, [B]: { chainId: 1 } };
    const { call } = transport(fakes);
    const r = await agreeAtFinalEvm({ set: mk({ [A]: "a", [B]: "b" }), call, chainId: 84532, finality: "finalized", read: read(fakes) });
    expect(r).toMatchObject({ agreed: false, why: "missing" });
    expect(agreementWords(r as never)).toContain("a second RPC endpoint was not available to confirm it");
    expect(agreementWords(r as never)).toContain("answers chain id 1, not 84532");
  });

  it("two URLs of one operator count once", async () => {
    const fakes = { [A]: {}, [B]: {} };
    const { call } = transport(fakes);
    const r = await agreeAtFinalEvm({ set: mk({ [A]: "same", [B]: "same" }), call, chainId: 84532, finality: "finalized", read: read(fakes) });
    expect(r).toMatchObject({ agreed: false, why: "missing" });
  });

  it("an owner node answers alone", async () => {
    const fakes = { [A]: {} };
    const { call } = transport(fakes);
    const r = await agreeAtFinalEvm({ set: mk({ [A]: "a" }, 1, "owner-node"), call, chainId: 84532, finality: "finalized", read: read(fakes) });
    expect(r).toMatchObject({ agreed: true, agreement: "owner-node" });
  });

  it("a single-RPC testnet answers alone, labelled single", async () => {
    const fakes = { [A]: {} };
    const { call } = transport(fakes);
    const r = await agreeAtFinalEvm({ set: mk({ [A]: "a" }, 1, "single"), call, chainId: 84532, finality: "finalized", read: read(fakes) });
    expect(r).toMatchObject({ agreed: true, agreement: "single" });
  });

  it("an endpoint whose read throws is left out", async () => {
    const fakes = { [A]: {}, [B]: {} };
    const { call } = transport(fakes);
    const r = await agreeAtFinalEvm({ set: mk({ [A]: "a", [B]: "b" }), call, chainId: 84532, finality: "finalized", read: async (u) => { if (u === B) throw new Error("boom"); return "0x0"; } });
    expect(r).toMatchObject({ agreed: false, why: "missing" });
  });

  it("no endpoint answering is unreadable", async () => {
    const fakes = { [A]: { fail: true }, [B]: { fail: true } };
    const { call } = transport(fakes);
    const r = await agreeAtFinalEvm({ set: mk({ [A]: "a", [B]: "b" }), call, chainId: 84532, finality: "finalized", read: read(fakes) });
    expect(r).toMatchObject({ agreed: false, why: "unreadable" });
  });

  it("a final head below atLeast is not final yet", async () => {
    const fakes = { [A]: { finalized: 100 }, [B]: { finalized: 100 } };
    const { call } = transport(fakes);
    const r = await agreeAtFinalEvm({ set: mk({ [A]: "a", [B]: "b" }), call, chainId: 84532, finality: "finalized", read: read(fakes), atLeast: 101n });
    expect(r).toMatchObject({ agreed: false, why: "not_final_yet" });
    expect(agreementWords(r as never)).toBe("it is not final on chain yet");
  });

  it("a malformed settings set is unreadable", async () => {
    const { call } = transport({});
    const r = await agreeAtFinalEvm({ set: { error: "settings broken" }, call, chainId: 1, finality: "finalized", read: async () => 0 });
    expect(r).toMatchObject({ agreed: false, why: "unreadable", reason: "settings broken" });
  });
});

describe("agreeAtFinalSolana", () => {
  const fakes: Record<string, Fake> = { [A]: { slot: 50 }, [B]: { slot: 60 } };
  const readAt = (slots: Record<string, number>, values: Record<string, unknown>) => async (url: string) => ({ slot: slots[url], value: values[url] });

  it("agrees at the lowest finalized slot", async () => {
    const { call } = transport(fakes);
    const seen: bigint[] = [];
    const r = await agreeAtFinalSolana({ set: mk({ [A]: "a", [B]: "b" }), call, genesis: "GEN", read: async (u, s) => (seen.push(s), { slot: 70, value: 5n }) });
    expect(r).toMatchObject({ agreed: true, slot: 50n, agreement: "quorum" });
    expect(seen).toEqual([50n, 50n]);
  });

  it("a context slot below S makes that endpoint unreadable", async () => {
    const { call } = transport(fakes);
    const r = await agreeAtFinalSolana({ set: mk({ [A]: "a", [B]: "b" }), call, genesis: "GEN", minSlot: 55n, read: readAt({ [A]: 54, [B]: 56 }, { [A]: 1, [B]: 1 }) });
    expect(r).toMatchObject({ agreed: false, why: "missing" });
  });

  it("different values disagree; the wrong genesis is left out", async () => {
    const { call } = transport({ ...fakes, [B]: { genesis: "OTHER" } });
    const r = await agreeAtFinalSolana({ set: mk({ [A]: "a", [B]: "b" }), call, genesis: "GEN", read: readAt({ [A]: 99, [B]: 99 }, { [A]: 1, [B]: 2 }) });
    expect(r).toMatchObject({ agreed: false, why: "missing" });
    forgetIdentities();
    const t = transport(fakes);
    const d = await agreeAtFinalSolana({ set: mk({ [A]: "a", [B]: "b" }), call: t.call, genesis: "GEN", read: readAt({ [A]: 99, [B]: 99 }, { [A]: 1, [B]: 2 }) });
    expect(d).toMatchObject({ agreed: false, why: "disagree" });
  });
});

describe("canonical and identity", () => {
  it("compares a bigint with its decimal string, hex case-insensitively, keys in any order", () => {
    expect(canonical(5n)).toBe(canonical("5"));
    expect(canonical({ b: "0xAB", a: [1n] })).toBe(canonical({ a: ["1"], b: "0xab" }));
    expect(canonical("0x01")).not.toBe(canonical("0x02"));
  });

  it("caches success per process and not failure", async () => {
    let chain = 1;
    let calls = 0;
    const call = async () => (calls++, `0x${chain.toString(16)}`);
    expect(await checkIdentity(A, { kind: "evm", chainId: 84532 }, call)).toContain("answers chain id 1, not 84532");
    chain = 84532;
    expect(await checkIdentity(A, { kind: "evm", chainId: 84532 }, call)).toBe("");
    expect(await checkIdentity(A, { kind: "evm", chainId: 84532 }, call)).toBe("");
    expect(calls).toBe(2);
  });
});

describe("endpoint sets", () => {
  it("builds the table's set for a chain with two operators", () => {
    const s = endpointSet("base-sepolia", "verdict", { testnet: true });
    expect(s).toMatchObject({ quorum: 2, agreement: "quorum", primary: { url: RPC_ENDPOINTS["base-sepolia"][0].url, source: "builtin" } });
    expect("error" in s ? [] : s.verdict).toHaveLength(2);
  });

  it("a testnet chain with one operator is single", () => {
    expect(endpointSet("arc-testnet", "verdict", { testnet: true })).toMatchObject({ quorum: 1, agreement: "single" });
    expect(endpointSet("arc-testnet", "verdict", { testnet: false })).toMatchObject({ quorum: 2, agreement: "quorum" });
  });

  it("an owner node is a quorum of one; pinned owner urls replace the table", () => {
    useOwnerSettings(() => ({ urls: ["http://127.0.0.1:8545", "https://x.example"], ownNode: true }));
    const s = endpointSet("base-sepolia", "verdict", { testnet: true });
    expect(s).toMatchObject({ quorum: 1, agreement: "owner-node", verdict: [{ url: "http://127.0.0.1:8545", source: "settings" }] });
    useOwnerSettings(() => ({ urls: ["https://a.one.example", "https://b.one.example"] }));
    expect(endpointSet("base-sepolia", "verdict", { testnet: false })).toMatchObject({ quorum: 2 });
  });

  it("an env URL is the read primary but joins a verdict only when it is already in the set", () => {
    const env = "https://liar.example";
    expect(endpointSet("base-sepolia", "read", { envUrl: env, testnet: true })).toMatchObject({ primary: { url: env, source: "env" } });
    const v = endpointSet("base-sepolia", "verdict", { envUrl: env, testnet: true });
    expect(v).toMatchObject({ note: expect.stringContaining("not used") });
    expect("error" in v ? [] : v.verdict.map((e) => e.url)).not.toContain(env);
    const same = RPC_ENDPOINTS["base-sepolia"][1].url;
    expect(endpointSet("base-sepolia", "verdict", { envUrl: same, testnet: true })).not.toHaveProperty("note");
  });

  it("settings that cannot be read give an error, never a negative; unknown chains too", () => {
    useOwnerSettings(() => { throw new Error("bad json"); });
    expect(endpointSet("base-sepolia", "verdict", { testnet: true })).toEqual({ error: expect.stringContaining("bad json") });
    expect(endpointSet("nowhere", "read", { testnet: true })).toHaveProperty("error");
  });

  it("a caller set is one endpoint labelled caller", () => {
    expect(callerSet("http://127.0.0.1:1")).toMatchObject({ quorum: 1, agreement: "caller", verdict: [{ source: "caller" }] });
  });

  it("names operators by registrable domain and endpoints by a hash, never the URL", () => {
    expect(operatorOf("https://a.publicnode.com/x")).toBe("publicnode.com");
    expect(operatorOf("https://x.y.example.co.uk")).toBe("example.co.uk");
    expect(operatorOf("http://127.0.0.1:8545")).toBe("127.0.0.1");
    expect(endpointId("https://k.example/?key=secret")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is mainnet-ready with an owner node or two operators", () => {
    expect(mainnetRpcReady("arc-testnet")).toBe(false);
    expect(mainnetRpcReady("base-sepolia")).toBe(true);
    useOwnerSettings(() => ({ urls: ["http://127.0.0.1:1"], ownNode: true }));
    expect(mainnetRpcReady("arc-testnet")).toBe(true);
  });
});

// Probes from the round-1 review, kept as permanent tests.
describe("a liar can delay a verdict but cannot decide one", () => {
  const evm = (fakes: Record<string, Fake>, extra: Record<string, unknown> = {}) =>
    agreeAtFinalEvm({ set: mk({ [A]: "a", [B]: "b" }), call: transport(fakes).call, chainId: 84532, finality: "finalized", read: read(fakes), ...extra });

  it("the block time must be the same on every endpoint", async () => {
    const r = await evm({ [A]: { timestamp: "0xffffffff" }, [B]: { timestamp: "0x10" } });
    expect(r).toMatchObject({ agreed: false, why: "disagree" });
  });

  it("the agreed block carries its time, the hash and the highest head", async () => {
    const r = await evm({ [A]: { finalized: 100 }, [B]: { finalized: 120 } });
    expect(r).toMatchObject({ agreed: true, block: { number: 100n, hash: "0xaa100", timestamp: 16, highest: 120n } });
  });

  it("a missing or malformed block time leaves that endpoint out", async () => {
    const r = await evm({ [A]: {}, [B]: { timestamp: "16" } });
    expect(r).toMatchObject({ agreed: false, why: "missing" });
  });

  it("a head of zero against a million is a disagreement, not an old block", async () => {
    const r = await evm({ [A]: { finalized: "0x0" }, [B]: { finalized: 1_000_000 } });
    expect(r).toMatchObject({ agreed: false, why: "disagree" });
    expect((r as { reason: string }).reason).toContain("apart");
  });

  it("maxSpread can be widened and narrowed", async () => {
    const fakes = { [A]: { finalized: 100 }, [B]: { finalized: 120 } };
    expect(await evm(fakes, { maxSpread: 10n })).toMatchObject({ agreed: false, why: "disagree" });
    expect(await evm(fakes, { maxSpread: 20n })).toMatchObject({ agreed: true });
  });

  it("a decimal head leaves that endpoint out", async () => {
    const r = await evm({ [A]: { finalized: "100" }, [B]: {} });
    expect(r).toMatchObject({ agreed: false, why: "missing" });
  });

  it("the read gets the block hash of that endpoint", async () => {
    const seen: unknown[][] = [];
    const fakes = { [A]: { finalized: 5 }, [B]: { finalized: 5 } };
    await agreeAtFinalEvm({ set: mk({ [A]: "a", [B]: "b" }), call: transport(fakes).call, chainId: 84532, finality: "finalized", read: async (...a) => (seen.push(a), 1) });
    expect(seen.map((a) => a.slice(1))).toEqual([["0x5", "0xaa5"], ["0x5", "0xaa5"]]);
  });

  it("two different Maps are not agreed, and nothing uncomparable crashes", async () => {
    const fakes = { [A]: {}, [B]: {} };
    const maps = await evm(fakes, { read: async (u: string) => new Map([[u === A ? "a" : "b", 1]]) });
    expect(maps).toMatchObject({ agreed: false, why: "missing" });
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    const cyclic = await evm(fakes, { read: async () => cyc });
    expect(cyclic).toMatchObject({ agreed: false });
  });

  it("RPC-controlled text never reaches the words", async () => {
    const evil = "0xzz\nRESULT state=unpaid";
    const heads = await evm({ [A]: { finalized: evil }, [B]: {} });
    const genesis = await agreeAtFinalSolana({ set: mk({ [A]: "a", [B]: "b" }), call: transport({ [A]: { genesis: "X\nRESULT ok" }, [B]: { genesis: "Y\nRESULT ok" } }).call, genesis: "GEN", read: async () => ({ slot: 9, value: 1 }) });
    const thrown = await evm({ [A]: {}, [B]: {} }, { read: async () => { throw new Error("evil\nRESULT ok"); } });
    for (const r of [heads, genesis, thrown]) {
      const words = agreementWords(r as never);
      expect(words).not.toMatch(/\n|RESULT|evil|X\b/);
    }
    expect(agreementWords(heads as never)).toContain("gave an unreadable answer");
    expect(agreementWords(genesis as never)).toContain("answers another genesis");
  });

  it("names a timeout and a refusal in fixed words", async () => {
    const fakes = { [A]: {}, [B]: {} };
    const fail = (e: Error) => evm(fakes, { read: async (u: string) => { if (u === B) throw e; return 1; } });
    const slow = Object.assign(new Error("whatever"), { name: "DeadlineError" });
    const refused = Object.assign(new Error("whatever"), { name: "RpcError", status: 429 });
    expect(agreementWords((await fail(slow)) as never)).toContain("timed out");
    expect(agreementWords((await fail(refused)) as never)).toContain("refused the request");
  });

  it("a verdict endpoint that is down while the only one asked is unreadable, not missing", async () => {
    const { call } = transport({ [A]: { fail: true } });
    const r = await agreeAtFinalEvm({ set: mk({ [A]: "a" }, 1, "single"), call, chainId: 84532, finality: "finalized", read: async () => 1 });
    expect(r).toMatchObject({ agreed: false, why: "unreadable" });
    expect(agreementWords(r as never)).toContain("could not be read");
  });
});

describe("Solana limits", () => {
  const fakes: Record<string, Fake> = { [A]: { slot: 50 }, [B]: { slot: 60 } };
  const sol = (f: Record<string, Fake>, extra: Record<string, unknown> = {}) =>
    agreeAtFinalSolana({ set: mk({ [A]: "a", [B]: "b" }), call: transport(f).call, genesis: "GEN", read: async () => ({ slot: 99999, value: 1 }), ...extra });

  it("reports the highest slot and refuses a far-apart pair", async () => {
    expect(await sol(fakes)).toMatchObject({ agreed: true, slot: 50n, highest: 60n });
    expect(await sol({ [A]: { slot: 1 }, [B]: { slot: 1_000_000 } })).toMatchObject({ agreed: false, why: "disagree" });
    expect(await sol(fakes, { maxSpread: 5n })).toMatchObject({ agreed: false, why: "disagree" });
  });

  it("atLeast above the agreed slot is not final yet", async () => {
    expect(await sol(fakes, { atLeast: 51n })).toMatchObject({ agreed: false, why: "not_final_yet" });
    expect(await sol(fakes, { atLeast: 50n })).toMatchObject({ agreed: true });
  });

  it("an uncomparable value leaves the endpoint out; a bad slot is left out", async () => {
    const r = await sol(fakes, { read: async (u: string) => ({ slot: 99, value: u === A ? new Set([1]) : 1 }) });
    expect(r).toMatchObject({ agreed: false, why: "missing" });
    const bad = await sol({ [A]: { slot: "7" as never }, [B]: { slot: 60 } });
    expect(bad).toMatchObject({ agreed: false, why: "missing" });
  });
});

describe("canonical accepts plain data only", () => {
  it("throws on Map, Set, Date, class instances, NaN and cycles; encodes bytes as hex", () => {
    class P { x = 1; }
    for (const v of [new Map([["a", 1]]), new Set([1]), new Date(0), new P(), NaN, Infinity, undefined, () => 1, Symbol("s")]) {
      expect(() => canonical(v)).toThrow();
    }
    const c: unknown[] = [];
    c.push(c);
    expect(() => canonical(c)).toThrow();
    expect(canonical(new Uint8Array([1, 255]))).toBe(canonical("0x01ff"));
    expect(canonical(Object.create(null))).toBe("{}");
    expect(canonical({ a: null, b: [true, 1.5, "x"] })).toBe('{"a":null,"b":[true,1.5,"x"]}');
  });
});

describe("endpoint sets, round 1 fixes", () => {
  afterEach(() => useOwnerSettings(() => undefined));

  it("pinning one URL does not lower the quorum: single belongs to the chain's table", () => {
    useOwnerSettings(() => ({ urls: ["https://only.example"] }));
    expect(endpointSet("base-sepolia", "verdict", { testnet: true })).toMatchObject({ quorum: 2, agreement: "quorum" });
    useOwnerSettings(() => ({ urls: ["https://a.same.example", "https://b.same.example"] }));
    expect(endpointSet("ethereum-sepolia", "verdict", { testnet: true })).toMatchObject({ quorum: 2, agreement: "quorum" });
  });

  it("an owner node with a quorum above one keeps all its URLs and that quorum", () => {
    useOwnerSettings(() => ({ urls: ["http://127.0.0.1:1", "http://127.0.0.1:2"], ownNode: true, quorum: 2 }));
    const s = endpointSet("base-sepolia", "verdict", { testnet: true });
    expect(s).toMatchObject({ quorum: 2, agreement: "quorum" });
    expect("error" in s ? [] : s.verdict).toHaveLength(2);
    useOwnerSettings(() => ({ urls: ["http://127.0.0.1:1", "http://127.0.0.1:2"], ownNode: true, quorum: 1 }));
    expect(endpointSet("base-sepolia", "verdict", { testnet: true })).toMatchObject({ quorum: 1, agreement: "owner-node" });
  });

  it("testnet must be stated, and the testnet list is explicit and matches the chain tables", () => {
    expect(endpointSet("arc-testnet", "verdict", {} as never)).toHaveProperty("error");
    expect([...RPC_TESTNETS].sort()).toEqual(Object.keys(RPC_ENDPOINTS).sort());
    const known = new Map(KNOWN_NETWORKS.map((n) => [n.key, n.testnet]));
    for (const k of RPC_TESTNETS) expect(known.get(k), k).toBe(true);
    for (const k of RPC_TESTNETS) if (k in EVM_CHAINS) expect((EVM_CHAINS as Record<string, { testnet?: boolean }>)[k].testnet, k).toBe(true);
  });

  it("a URL that cannot be parsed is never an operator label", () => {
    const label = operatorOf("not a url ?key=SECRET");
    expect(label).not.toContain("SECRET");
    expect(label).toMatch(/^[0-9a-f]{12}$/);
  });

  it("an env URL equal to a built-in URL is allowed for every purpose, with no note", () => {
    useOwnerSettings(() => ({ urls: ["https://mine.example", "https://mine2.example"] }));
    const builtin = RPC_ENDPOINTS["base-sepolia"][0].url;
    for (const purpose of ["read", "verdict", "owner"] as const) {
      const s = endpointSet("base-sepolia", purpose, { envUrl: builtin, envName: "SUPERSTABLES_RPC_URL", testnet: true });
      expect(s).not.toHaveProperty("note");
      expect(s).toMatchObject({ primary: { url: builtin, source: "env", operator: "base" } });
    }
  });
});

// Provider aliases (the website's providers.md): one provider under several domains counts once.
describe("providers", () => {
  afterEach(() => useOwnerSettings(() => undefined));
  const operators = (s: ReturnType<typeof endpointSet>) => ("error" in s ? [] : s.verdict.map((e) => e.operator));

  it("pins on arc.io and arc.network are one provider, so they cannot confirm each other", async () => {
    const io = "https://rpc.testnet.arc.io", net = "https://rpc.testnet.arc.network";
    useOwnerSettings(() => ({ urls: [io, net] }));
    const s = endpointSet("arc-testnet", "verdict", { testnet: true });
    expect(operators(s)).toEqual(["circle", "circle"]);
    expect(s).toMatchObject({ quorum: 2, agreement: "quorum" });
    const fakes = { [io]: {}, [net]: {} };
    const { call } = transport(fakes);
    const r = await agreeAtFinalEvm({ set: s as never, call, chainId: 84532, finality: "finalized", read: read(fakes) });
    expect(r).toMatchObject({ agreed: false, why: "missing" });
  });

  it("a third party's host under arc.io is Circle", () => {
    expect(providerOf("arc-testnet", "https://rpc.blockdaemon.testnet.arc.io")).toBe("circle");
    useOwnerSettings(() => undefined);
    const s = endpointSet("arc-testnet", "read", { envUrl: "https://rpc.blockdaemon.testnet.arc.io", testnet: true });
    expect(s).toMatchObject({ primary: { operator: "circle", source: "env" } });
  });

  it("a pin on arbitrum.io with a trailing slash and a pin on publicnode are two providers", () => {
    useOwnerSettings(() => ({ urls: ["https://sepolia-rollup.arbitrum.io/rpc/", "https://arbitrum-sepolia-rpc.publicnode.com"] }));
    expect(operators(endpointSet("arbitrum-sepolia", "verdict", { testnet: true }))).toEqual(["offchain-labs", "publicnode"]);
  });

  it("resolves by exact URL, then the entry's domains, then the URL's own registrable domain", () => {
    expect(providerOf("arc-testnet", RPC_ENDPOINTS["arc-testnet"][0].url)).toBe("circle");
    expect(providerOf("base-sepolia", "https://other.publicnode.com/x")).toBe("publicnode");
    expect(providerOf("polygon-amoy", "https://x.polygon.technology")).toBe("polygon-labs");
    expect(providerOf("nowhere", "https://a.b.example.co.uk")).toBe("example.co.uk");
    expect(providerOf("arc-testnet", "not a url ?key=SECRET")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("example.org and example.co.uk stay two providers", () => {
    useOwnerSettings(() => ({ urls: ["https://a.example.org", "https://b.example.co.uk"] }));
    const ops = operators(endpointSet("base-sepolia", "verdict", { testnet: true }));
    expect(ops).toEqual(["example.org", "example.co.uk"]);
    expect(new Set(ops).size).toBe(2);
  });

  it("the table keeps its url and operator, and the env membership rule stays an exact URL", () => {
    useOwnerSettings(() => ({ urls: ["https://rpc.testnet.arc.io", "https://x.example"] }));
    const s = endpointSet("arc-testnet", "verdict", { envUrl: "https://rpc.testnet.arc.network/", testnet: true });
    expect(s).toMatchObject({ note: expect.stringContaining("not used") });
  });
});
