// A journal file that parses but is not a journal of this operation on this rail is never used as one, and never read as "no
// purchase": that purchase may have paid. Every reader stops before it signs, sends, asks a seller or writes, and keeps the file.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAddress } from "viem/accounts";
import { guardedNode } from "../helpers/guarded-process.js";

const DIRS = { evm: "evm-base-sepolia", tempo: "tempo-moderato", solana: "solana-devnet" } as const;
type Rail = keyof typeof DIRS;
const RAILS = ["evm", "tempo", "solana"] as const;
const now = "2026-10-15T00:00:00.000Z";
const A = (byte: string) => `0x${byte.repeat(20)}`;

const PURCHASE_STATES = ["quoted", "submitted", "settled", "failed", "refused_precheck", "refused_chain", "unknown", "not_found"];
const SOLANA_STATES = ["intent", "refused_precheck", "submitted", "unknown", "settled", "failed", "refused_chain", "not_found"];

type Json = Record<string, any>;
const VALID: Record<Rail, () => Json> = {
  evm: () => ({ op: "x", rail: "base-sepolia", path: "approve", state: "submitted", createdAt: now, updatedAt: now, url: "http://127.0.0.1:9/x", owner: A("22"), agent: A("33"), token: A("44"), max: "0.01", signed: false, delivered: null, notes: [] }),
  tempo: () => ({ op: "x", rail: "tempo", kind: "buy", state: "submitted", createdAt: now, updatedAt: now, intent: { amount: "10000", amountDecimal: "0.01", token: "0x20c0000000000000000000000000000000000000", recipient: A("11"), chainId: 42431, owner: A("22"), agent: A("33") }, history: [{ at: now, state: "submitted" }] }),
  solana: () => ({ op: "x", state: "submitted", updatedAt: now, agentSig: "sig", history: [{ at: now, state: "submitted" }] }),
};
const without = (j: Json, key: string) => { const copy = { ...j }; delete copy[key]; return copy; };
const SHAPES: Json[] = [{}, { op: "other" }, { op: "x", state: "weird" }, { op: "x" }];
const MISSING: Record<Rail, string> = { evm: "agent", tempo: "intent", solana: "history" };
const NEAR = (rail: Rail): Json[] => [{ ...VALID[rail](), op: "other" }, without(VALID[rail](), MISSING[rail])];
const BAD = (rail: Rail): Json[] => [...SHAPES, ...NEAR(rail)];
const label = (j: Json) => JSON.stringify(j).slice(0, 60);

let hits: Record<string, number> = {};
let seller: Server;
let sellerUrl = "";
beforeAll(async () => {
  seller = createServer((req, res) => {
    hits[req.url ?? ""] = (hits[req.url ?? ""] ?? 0) + 1;
    res.writeHead(402, { "content-type": "application/json" });
    res.end('{"x402Version":1,"accepts":[]}');
  });
  await new Promise<void>((ready) => seller.listen(0, "127.0.0.1", ready));
  sellerUrl = `http://127.0.0.1:${(seller.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((done) => seller.close(() => done())); });

const homes: string[] = [];
afterAll(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

let counter = 0;
/** A home whose journal of op "x" is `text` on `rail`. `path` is this test's own seller path, so its request count is its own. */
function home(rail: Rail, text: string, setup = false) {
  const dir = mkdtempSync(join(tmpdir(), "journal-shape-"));
  homes.push(dir);
  const ops = join(dir, "budget/ops", DIRS[rail]);
  mkdirSync(ops, { recursive: true });
  writeFileSync(join(ops, "x.json"), text);
  if (setup) {
    const keys = join(dir, "keys/budget");
    const pub = join(dir, "budget/public");
    mkdirSync(keys, { recursive: true, mode: 0o700 });
    mkdirSync(pub, { recursive: true, mode: 0o700 });
    chmodSync(join(dir, "keys"), 0o700);
    const key = `0x${"11".repeat(32)}` as const;
    if (rail === "evm") {
      writeFileSync(join(keys, "evm-agent.env"), `B4_AGENT_KEY=${key}\n`, { mode: 0o600 });
      writeFileSync(join(pub, "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=${A("22")}\nB4_AGENT_ADDRESS=${privateKeyToAddress(key)}\n`);
    } else if (rail === "solana") {
      writeFileSync(join(keys, "solana-agent.env"), "SOLANA_AGENT_SECRET_BASE58=unused\n", { mode: 0o600 });
      writeFileSync(join(pub, "solana-devnet.env"), "SOLANA_OWNER_ADDRESS=11111111111111111111111111111111\n");
    } else {
      writeFileSync(join(keys, "tempo-agent.env"), `AGENT_PRIVATE_KEY=${key}\nAGENT_ADDRESS=${privateKeyToAddress(key)}\nOWNER_ADDRESS=${A("22")}\n`, { mode: 0o600 });
    }
  }
  const guardLog = join(dir, "network.log");
  writeFileSync(guardLog, "");
  const path = `/p${++counter}`;
  return {
    dir, path, url: sellerUrl + path, text,
    file: join(ops, "x.json"),
    env: { HOME: dir, SUPERSTABLES_HOME: dir, SUPERSTABLES_NETWORK_GUARD_LOG: guardLog },
    guard: () => readFileSync(guardLog, "utf8"),
    requests: () => hits[path] ?? 0,
  };
}
const resultOf = (output: string) => JSON.parse(output.split("\n").filter((l) => l.startsWith("RESULT ")).pop()!.slice(7));
const REASON = /^journal_unreadable: it does not hold a journal of this operation \(/;
const NOT_A_CRASH = /SyntaxError|TypeError|at .*\.(ts|mjs):\d+/;

/** After a refusal: nothing was written, asked or read from the network. */
function untouched(h: ReturnType<typeof home>) {
  expect(readFileSync(h.file, "utf8")).toBe(h.text);
  expect(h.guard()).toBe("");
  expect(h.requests()).toBe(0);
}

describe("each rail's shape check", () => {
  const load = () => import("../../budget/journal.mjs") as Promise<any>;

  it("accepts every shape this client writes", async () => {
    const j = await load();
    for (const state of PURCHASE_STATES) {
      expect(j.evmJournalProblem({ ...VALID.evm(), state }, "x"), `evm ${state}`).toBe("");
      expect(j.tempoOpProblem({ ...VALID.tempo(), state }, "x"), `tempo ${state}`).toBe("");
    }
    // buy.ts's earliest tempo refusal, and the legacy journal of lock-recovery.test.ts (no updatedAt)
    const refusal = { ...VALID.tempo(), state: "refused_precheck", intent: { ...VALID.tempo().intent, amount: "0", recipient: "" }, history: [] };
    expect(j.tempoOpProblem(refusal, "x")).toBe("");
    expect(j.tempoOpProblem(without(VALID.tempo(), "updatedAt"), "x")).toBe("");
    for (const state of SOLANA_STATES) expect(j.solanaOpProblem({ ...VALID.solana(), state }, "x"), `solana ${state}`).toBe("");
    // solana/buy.mjs step 4 writes no agent, rail or creation time
    expect(j.solanaOpProblem({ op: "x", state: "refused_precheck", reasons: ["owner address unknown"], updatedAt: now, history: [] }, "x")).toBe("");
    // the older fixture of lock-recovery.test.ts: no createdAt, updatedAt or agent
    expect(j.solanaOpProblem({ op: "x", rail: "solana", kind: "buy", state: "submitted", history: [] }, "x")).toBe("");
  });

  it("refuses what is not this operation's journal", async () => {
    const j = await load();
    const check = { evm: j.evmJournalProblem, tempo: j.tempoOpProblem, solana: j.solanaOpProblem } as const;
    for (const rail of RAILS) for (const shape of BAD(rail)) expect(check[rail](shape, "x"), `${rail} ${label(shape)}`).not.toBe("");
    expect(j.evmJournalProblem({ ...VALID.evm(), path: "permit" }, "x")).not.toBe("");
    expect(j.evmJournalProblem({ ...VALID.evm(), owner: "nobody" }, "x")).not.toBe("");
    expect(j.evmJournalProblem({ ...VALID.evm(), createdAt: 7 }, "x")).not.toBe("");
    expect(j.evmJournalProblem(without(VALID.evm(), "notes"), "x")).not.toBe("");
    expect(j.tempoOpProblem({ ...VALID.tempo(), rail: "evm" }, "x")).not.toBe("");
    expect(j.tempoOpProblem({ ...VALID.tempo(), intent: [] }, "x")).not.toBe("");
    expect(j.solanaOpProblem({ ...VALID.solana(), state: "quoted" }, "x")).not.toBe("");
  });

  it("names no file text in its reason", async () => {
    const j = await load();
    for (const check of [j.evmJournalProblem, j.tempoOpProblem, j.solanaOpProblem]) {
      expect(check({ op: "x\nRESULT {}", state: "settled" }, "x")).toBe("it names another operation");
    }
  });

  it("journalProblem picks the rail's check", async () => {
    const j = await load();
    expect(j.journalProblem("solana", VALID.solana(), "x")).toBe("");
    expect(j.journalProblem("evm", VALID.solana(), "x")).not.toBe("");
    expect(j.journalProblem("nowhere", VALID.solana(), "x")).not.toBe("");
  });
});

const DIRECT: Record<string, (h: ReturnType<typeof home>) => { rail: Rail; args: string[]; noRead?: boolean }> = {
  "evm readJournal": () => ({ rail: "evm", noRead: true, args: ["--import=tsx", "--input-type=module", "-e", 'const { readJournal } = await import("./budget/evm/ops.ts"); readJournal("x"); console.log("READ");'] }),
  "evm reconcile": () => ({ rail: "evm", args: ["--import=tsx", "budget/evm/reconcile.ts", "--op", "x"] }),
  "tempo reconcile": () => ({ rail: "tempo", args: ["--import=tsx", "budget/tempo/reconcile.ts", "--op", "x"] }),
  "tempo buy": (h) => ({ rail: "tempo", args: ["--import=tsx", "budget/tempo/buy.ts", "--url", h.url, "--max", "0.01", "--op", "x"] }),
  "solana reconcile": () => ({ rail: "solana", args: ["budget/solana/reconcile.mjs", "--op", "x"] }),
  "solana buy": (h) => ({ rail: "solana", args: ["budget/solana/buy.mjs", "--url", h.url, "--max", "0.01", "--op", "x"] }),
  "solana buy --check": (h) => ({ rail: "solana", args: ["budget/solana/buy.mjs", "--check", "--url", h.url, "--op", "x"] }),
};

describe.concurrent("a rail command run directly", () => {
  for (const [name, make] of Object.entries(DIRECT)) {
    const rail = name.split(" ")[0] as Rail;
    for (const [i, shape] of BAD(rail).entries()) {
      it(`${name}: stops on ${label(shape)} (${i})`, async () => {
        const h = home(rail, JSON.stringify(shape));
        const cmd = make(h);
        const child = await guardedNode(cmd.args, h.env);
        expect(child.code, child.output).toBe(5);
        expect(resultOf(child.output)).toMatchObject({ rail, op: "x", state: "unknown", reason: expect.stringMatching(REASON) });
        expect(child.output).not.toMatch(NOT_A_CRASH);
        if (cmd.noRead) expect(child.output).not.toContain("READ");
        untouched(h);
      }, 60_000);
    }
  }
});

describe.concurrent("the dispatcher's buy, with and without setup files", () => {
  for (const setup of [false, true]) {
    for (const rail of RAILS) {
      for (const [i, shape] of BAD(rail).entries()) {
        it(`${setup ? "with" : "without"} setup, ${rail}: ${label(shape)} (${i}) is unknown, never refused`, async () => {
          const h = home(rail, JSON.stringify(shape), setup);
          const child = await guardedNode(["budget/cli.mjs", "buy", "--rail", rail, "--url", h.url, "--max", "0.01", "--op", "x"], h.env);
          expect(child.code, child.output).toBe(5);
          expect(child.output).toMatch(/op_already_unreadable/);
          expect(child.output).toMatch(/"paid":null/);
          expect(child.output).not.toMatch(/Nothing was signed or paid|refused_precheck/);
          untouched(h);
        }, 60_000);
      }
    }
  }
});

describe.concurrent("the dispatcher's reconcile", () => {
  for (const rail of RAILS) {
    for (const [i, shape] of BAD(rail).entries()) {
      it(`${rail}: ${label(shape)} (${i}) is unknown, never 'no journal'`, async () => {
        const h = home(rail, JSON.stringify(shape));
        const child = await guardedNode(["budget/cli.mjs", "reconcile", "--rail", rail, "--op", "x"], h.env);
        expect(child.code, child.output).toBe(5);
        expect(child.output).toMatch(/journal_unreadable: it does not hold a journal of this operation/);
        expect(child.output).not.toMatch(/no journal for op/);
        untouched(h);
      }, 60_000);
    }
  }
});

describe.concurrent("journals this client writes stay readable", () => {
  const ALL = JSON.stringify(PURCHASE_STATES);
  const children: Record<Rail, (h: ReturnType<typeof home>) => string> = {
    evm: () => `const ops = await import("./budget/evm/ops.ts");
      const j = ops.newJournal({ op: "x", url: "http://127.0.0.1:9/x", owner: "${A("22")}", agent: "${A("33")}", token: "${A("44")}", max: "0.01" });
      ops.writeJournal(j);
      for (const s of ${ALL}) { j.state = s; ops.writeJournal(j); if (!ops.readJournal("x")) throw new Error("unreadable " + s); }
      console.log("READ");`,
    tempo: () => `const ops = await import("./budget/tempo/lib/ops.ts");
      ops.writeOp({ op: "x", rail: "tempo", kind: "buy", state: "refused_precheck", createdAt: "${now}", intent: { amount: "0", amountDecimal: "0", recipient: "", owner: "${A("22")}", agent: "${A("33")}" }, history: [] });
      if (!ops.readOp("x")) throw new Error("unreadable refusal");
      for (const s of ${ALL}) { ops.writeOp(Object.assign(ops.readOp("x"), { state: s })); if (!ops.readOp("x")) throw new Error("unreadable " + s); }
      console.log("READ");`,
    solana: () => `const ops = await import("./budget/solana/ops.mjs");
      ops.updateOp("x", { state: "refused_precheck", reasons: ["owner address unknown"] });
      if (!ops.readOp("x")) throw new Error("unreadable refusal");
      for (const s of ${JSON.stringify(SOLANA_STATES)}) { ops.updateOp("x", { state: s }); if (!ops.readOp("x")) throw new Error("unreadable " + s); }
      console.log("READ");`,
  };
  for (const rail of RAILS) {
    it(`${rail}: every state the rail writes reads back`, async () => {
      const h = home(rail, "");
      rmSync(h.file);
      const child = await guardedNode(["--import=tsx", "--input-type=module", "-e", children[rail](h)], h.env);
      expect(child.code, child.output).toBe(0);
      expect(child.output).toContain("READ");
    }, 60_000);

    it(`${rail}: the dispatcher still lets a refused op be reused, and stops a submitted one`, async () => {
      const refused = home(rail, JSON.stringify({ ...VALID[rail](), state: "refused_precheck" }));
      const first = await guardedNode(["budget/cli.mjs", "buy", "--rail", rail, "--url", refused.url, "--max", "0.01", "--op", "x"], refused.env);
      expect(first.code, first.output).toBe(3);
      expect(first.output).toMatch(/no budget has been set up here/);
      const submitted = home(rail, JSON.stringify(VALID[rail]()));
      const second = await guardedNode(["budget/cli.mjs", "buy", "--rail", rail, "--url", submitted.url, "--max", "0.01", "--op", "x"], submitted.env);
      expect(second.code, second.output).toBe(5);
      expect(second.output).toMatch(/op_already_submitted/);
      expect(second.output).not.toMatch(/unreadable/);
    }, 60_000);
  }
});
