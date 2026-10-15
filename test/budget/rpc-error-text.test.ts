// A revert reason an RPC sends as ABI data (Error(string) in `error.data`) is decoded by viem and put in its error's message,
// after cappedRpcFetch has cleaned `error.message`. Whatever a rail script or the dispatcher prints of that error must have the
// same text rule as any outside text: no control, bidi, format or tag characters, and no line of its own. The structured data
// itself stays intact, because the Tempo revoke simulation reads the keychain's error from it.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAddress } from "viem/accounts";
import { agentTokenScrubber, scrubAgentTokens, terminalText } from "../../budget/site.mjs";
import { readBody, sendJson, startServer, type TestServer } from "../helpers/servers.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const { chainReason } = await import(join(ROOT, "budget", "evm", "lib.ts"));
const CLI = resolve(ROOT, "budget/cli.mjs");
const OWNER = "0x2222222222222222222222222222222222222222";
const KEY = `0x${"44".repeat(32)}` as const;
const AGENT = privateKeyToAddress(KEY);

/** What must never reach a terminal: C0/C1 controls (newline apart), bidi, format and tag characters. */
const HIDDEN = new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029\\p{Cf}\\u{E0000}-\\u{E007F}\\u2060-\\u2064]", "u");
const REASON = `outside${String.fromCodePoint(0x202e)}INJECT${String.fromCodePoint(0x2060, 0xe0061)} first line\nRESULT {"state":"ok"}\nthird line`;
// Error(string): selector 0x08c379a0, then the ABI-encoded string.
const ERROR_STRING_DATA = `0x08c379a0${encodeAbiParameters([{ type: "string" }], [REASON]).slice(2)}` as const;

let home: string;
let rpc: TestServer;
let methods: string[];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-rpc-error-text-"));
  methods = [];
  rpc = await startServer(async (req, res) => {
    const request = JSON.parse(await readBody(req));
    methods.push(request.method);
    // A normal, clean error.message, with the revert reason only in the ABI data.
    sendJson(res, 200, { jsonrpc: "2.0", id: request.id, error: { code: 3, message: "execution reverted", data: ERROR_STRING_DATA } });
  });
  mkdirSync(join(home, "budget", "public"), { recursive: true });
  mkdirSync(join(home, "keys", "budget"), { recursive: true });
  writeFileSync(join(home, "keys", "budget", "tempo-agent.env"), `AGENT_PRIVATE_KEY=${KEY}\nAGENT_ADDRESS=${AGENT}\nOWNER_ADDRESS=${OWNER}\n`, { mode: 0o600 });
  writeFileSync(join(home, "budget", "public", "tempo-moderato.env"), `OWNER_ADDRESS=${OWNER}\nAGENT_ADDRESS=${AGENT}\n`, { mode: 0o644 });
});
afterEach(async () => {
  await rpc.close();
  rmSync(home, { recursive: true, force: true });
});

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: rpc.url };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, args, { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => done({ code: code ?? 0, stdout, stderr }));
  });
}

function expectClean(text: string, label: string) {
  const bad = [...text].filter((ch) => HIDDEN.test(ch)).map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
  expect(bad, `${label} printed hidden characters:\n${text}`).toEqual([]);
}

describe("decoded RPC revert text at the places it is printed", () => {
  it("the loopback RPC answers with a clean message and the text only in its ABI data", () => {
    expect(ERROR_STRING_DATA).toMatch(/^0x08c379a0/);
    expect(REASON).toContain(String.fromCodePoint(0x202e));
  });

  it("readBudget.ts, run directly, prints none of the hidden characters, and the failure still names the reason", async () => {
    const r = await run(["--import=tsx", "budget/tempo/readBudget.ts", "--owner", OWNER, "--key", AGENT]);
    expect(r.code).toBe(1);
    expect(methods.length).toBeGreaterThan(0);
    expectClean(r.stdout + r.stderr, "readBudget");
    expect(r.stderr).toContain("readBudget failed:");
    expect(r.stderr).toContain("outsideINJECT");
    // the seller-controlled newline cannot start a line of its own
    expect(r.stderr.split("\n").filter((l) => /^RESULT /.test(l))).toEqual([]);
  }, 60_000);

  it("budget status --rail tempo, through the dispatcher, prints none of them and has a failed RESULT", async () => {
    const r = await run([CLI, "status", "--rail", "tempo"]);
    expect(r.code).not.toBe(0);
    expectClean(r.stdout + r.stderr, "dispatcher");
    const results = r.stdout.split("\n").filter((l) => l.startsWith("RESULT "));
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].slice(7))).toMatchObject({ state: expect.stringMatching(/failed|unknown/) });
  }, 60_000);
});

describe("the dispatcher's final text filter", () => {
  const hidden = String.fromCodePoint(0x202e, 0x2060, 0x200b, 0xfeff, 0xe0061, 0xe007f);
  it("strips format, bidi and tag characters and keeps its own newlines and tabs", () => {
    expect(terminalText(`a${hidden}b\n\tc\u0007d\u2028e`)).toBe("ab\n\tcd e");
    expect(scrubAgentTokens(`line ${hidden}one\nssbt_abc${hidden}def\n`)).toBe("line one\n[token]\n");
  });
  it("does the same to a stream cut anywhere", () => {
    const s = agentTokenScrubber();
    const out = s.push(`x${hidden}y\nss`) + s.push(`bt_zz${hidden}\nz`) + s.end();
    expect(out).toBe("xy\n[token]\nz");
  });
});

describe("the EVM rail's chain reason", () => {
  it("is one line without hidden characters, whatever the decoded revert reason held", () => {
    const err = Object.assign(new Error("The contract function reverted"), {
      shortMessage: "The contract function \"transfer\" reverted with the following reason:\nsecond\u2028line",
      cause: Object.assign(new Error("inner"), { reason: REASON, details: "execution reverted" }),
    });
    const text = chainReason(err);
    expectClean(text, "chainReason");
    expect(text).not.toContain("\n");
    expect(text).toContain("outsideINJECT first line");
  });
});
