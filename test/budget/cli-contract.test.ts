// budget/CLI.md is written by hand. These checks hold it to the code: the commands it lists, the flags it names for each
// command (asked of the dispatcher's own flag parser), the environment variables it documents (each must be read in the
// budget code, not only mentioned in a comment), and the two texts it tells a compatible site to sign and check (rebuilt
// with the client's own functions and compared line for line).
//
// The command list and the flags named in prose are compared with docs/cli-budget.md, the saved --help of every budget
// command. That file is authoritative for this purpose because `npm run docs:cli -- --check`, which CI runs, fails when
// it differs from the help the built CLI prints.

import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AGENT_PROOF_TITLE, OWNER_PROOF_TITLE, agentProof, agentProofText, bodyHash, ownerProofText } from "../../budget/hosted.js";

const REPO = join(import.meta.dirname, "..", "..");
const contract = readFileSync(join(REPO, "budget", "CLI.md"), "utf8");
const reference = readFileSync(join(REPO, "docs", "cli-budget.md"), "utf8");

/** The help of each budget command, by name ("" for `superstables budget` itself), from the generated reference. */
const help = new Map<string, string>();
for (const part of reference.split(/^## /m).slice(1)) {
  const [title, ...body] = part.split("\n");
  const m = /^superstables budget(?: (\S+))?$/.exec(title.trim());
  if (m) help.set(m[1] ?? "", body.join("\n"));
}
const commands = [...help.keys()].filter(Boolean);

const flagsIn = (text: string) => new Set([...text.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((m) => m[1]));

/** The rows of CLI.md's Commands table: the command and its usage, the first cell (`superstables budget <command> ...`). */
const rows = contract
  .split("\n")
  .map((line) => /^\| `superstables budget ([a-z-]+)([^`]*)`/.exec(line))
  .filter((m) => m !== null)
  .map((m) => ({ command: m[1], line: m[2] }));

const home = mkdtempSync(join(tmpdir(), "superstables-cli-contract-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** The budget dispatcher from the checkout, with an empty home and no budget settings from this environment. */
function budget(args: string[]): Promise<{ code: number; out: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SUPERSTABLES_") && !k.startsWith("B4_")));
  return new Promise((done) => {
    execFile(process.execPath, [join(REPO, "budget", "cli.mjs"), ...args], { env: { ...env, SUPERSTABLES_HOME: home }, timeout: 30_000 }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

describe("budget/CLI.md against the help", () => {
  it("found the generated help for every command", () => {
    expect(commands.length).toBeGreaterThan(10);
    expect(rows.length).toBeGreaterThan(10);
  });

  it("lists exactly the commands the CLI has", () => {
    expect([...new Set(rows.map((r) => r.command))].sort()).toEqual([...commands].sort());
  });

  it("names in each command's usage only flags the parser accepts for that command", async () => {
    // Each flag goes to the dispatcher followed by a flag no command has. The parser reads the arguments in order and
    // stops at the first one it refuses, before anything runs: "unknown flag --<the flag>" means the documented flag is
    // not accepted; any other refusal (the unknown flag after it, or "needs a value") means it is.
    const pairs = rows.flatMap(({ command, line }) => [...flagsIn(line)].map((flag) => ({ command, flag })));
    expect(pairs.length).toBeGreaterThan(15);
    const refused: string[] = [];
    for (let i = 0; i < pairs.length; i += 8) {
      await Promise.all(
        pairs.slice(i, i + 8).map(async ({ command, flag }) => {
          const r = await budget([command, `--${flag}`, "--no-such-flag-anywhere"]);
          if (r.code !== 2) refused.push(`${command} --${flag}: exit ${r.code}, expected 2 (refused before running)`);
          else if (r.out.includes(`unknown flag --${flag} `)) refused.push(`${command} --${flag}`);
          else if (!/unknown flag --no-such-flag-anywhere|--[a-z-]+ needs a value/.test(r.out)) refused.push(`${command} --${flag}: ${r.out.trim().split("\n")[0]}`);
        }),
      );
    }
    expect(refused).toEqual([]);
  }, 120_000);

  it("names no flag that no budget command has", () => {
    const known = new Set([...help.values()].flatMap((h) => [...flagsIn(h)]));
    expect([...flagsIn(contract)].filter((f) => !known.has(f))).toEqual([]);
  });

  it("documents only environment variables the budget code reads", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(mjs|ts)$/.test(e.name)) sources.push(readFileSync(p, "utf8"));
      }
    };
    walk(join(REPO, "budget"));
    // comments out: a name that is only mentioned in a comment is not read
    const code = sources
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[\s;{}(),])\/\/.*$/gm, "$1");
    /** Read directly (process.env.X, env.X, env["X"]), or named as a string of its own ("X"), as the code does when it
     *  passes the name on (rpcFromEnv("B4_RPC", ...), process.env[ALLOW_SITE_ENV]) or reads a public file's key. */
    const isRead = (v: string) => new RegExp(`\\benv\\.${v}\\b|\\benv\\[\\s*["'\`]${v}["'\`]\\s*\\]|["'\`]${v}["'\`]`).test(code);
    const named = new Set([...contract.matchAll(/\b((?:SUPERSTABLES|B4)_[A-Z0-9_]+)\b/g)].map((m) => m[1]));
    expect(named.size).toBeGreaterThan(3);
    expect([...named].filter((v) => !isRead(v))).toEqual([]);
  });
});

describe("budget/CLI.md against the hosted proofs the client makes and checks", () => {
  /** The lines of the first fenced block after `heading`. */
  const blockAfter = (heading: string) => {
    const at = contract.indexOf(heading);
    expect(at).toBeGreaterThan(-1);
    const m = /```\n([\s\S]*?)\n```/.exec(contract.slice(at));
    expect(m).not.toBeNull();
    return m![1].split("\n");
  };
  /**
   * The documented template with each `<placeholder>` replaced by the value the client signs with for that name. The
   * names are the placeholders' full text as CLI.md writes them; one this test does not know, or one it expects that the
   * template no longer has, fails, so a reworded, moved or swapped placeholder is never filled by position.
   */
  const filled = (documented: string[], values: Record<string, string>) => {
    const text = documented.join("\n");
    const names = [...text.matchAll(/<([^>]*)>/g)].map((m) => m[1]);
    expect(names.filter((n) => !(n in values))).toEqual([]);
    expect(Object.keys(values).filter((n) => !names.includes(n))).toEqual([]);
    return text.replace(/<([^>]*)>/g, (_, n: string) => values[n]).split("\n");
  };
  it("the agent request proof v2 text", () => {
    const doc = blockAfter("### Agent request proof v2");
    expect(doc[0]).toBe(AGENT_PROOF_TITLE);
    const [origin, method, path, body, ts, nonce] = ["https://www.superstables.com", "POST", "/api/v1/budget/links", "{}", 1790000000, "0123456789abcdef".repeat(2)] as const;
    const real = agentProofText(origin, method, path, body, ts, nonce).split("\n");
    expect(real).toEqual(
      filled(doc, {
        "the site's origin, such as https://www.superstables.com": origin,
        METHOD: method,
        "path, without the query": path,
        "sha256 of the exact body bytes, lowercase hex": bodyHash(body),
        timestamp: String(ts),
        nonce,
      }),
    );
  });

  it("the agent request headers", async () => {
    const { headers } = await agentProof(`0x${"11".repeat(32)}`, "https://www.superstables.com", "POST", "/api/v1/budget/links", "{}");
    const section = contract.slice(contract.indexOf("### Agent request proof v2"), contract.indexOf("The signed text is"));
    const documented = [...section.matchAll(/^- `(Superstables-Agent[A-Za-z-]*)`/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual(Object.keys(headers).sort());
  });

  it("the owner proof text", () => {
    const doc = blockAfter("### Owner proof");
    expect(doc[0]).toBe(OWNER_PROOF_TITLE);
    const f = { site: "https://www.superstables.com", owner: "0x1111111111111111111111111111111111111111", agent: "0x2222222222222222222222222222222222222222", rail: "evm", chain: "base-sepolia", linkId: "bl_test1234", code: "AB-CD" } as const;
    const real = ownerProofText(f).split("\n");
    expect(real).toEqual(
      filled(doc, {
        "the site's origin, the same canonical origin as above": f.site,
        "the owner: checksummed 0x on evm and tempo, the base58 Solana address on solana": f.owner,
        "the agent, as in Superstables-Agent": f.agent,
        "evm, tempo or solana": f.rail,
        "the chain key, such as base-sepolia, moderato or devnet": f.chain,
        "the add-agent request ID the agent created": f.linkId,
        "the match code shown to the agent": f.code,
      }),
    );
  });
});
