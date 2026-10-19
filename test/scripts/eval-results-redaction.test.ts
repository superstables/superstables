// Saved eval results go public with the client: they must hold no approval capability and no name of a host tool.
// Every text file under evals/ is scanned, and every .tar.gz is read member by member without extracting it to disk.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const evals = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "evals");

/** Patterns that must not appear. Matches are never printed: only the file and the rule. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["budget approval token", /ssba_(?!REDACTED)[A-Za-z0-9_-]{4,}/],
  ["purchase approval token", /sspa_(?!REDACTED)[A-Za-z0-9_-]{8,}/],
  ["approval id", /\/approve\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/],
  ["host tool name", /agent-vault|agent-env|op-work|agent-work/],
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function violations(label: string, text: string): string[] {
  return FORBIDDEN.filter(([, re]) => re.test(text)).map(([rule]) => `${label}: ${rule}`);
}

describe("saved eval results", () => {
  it("hold no approval token, approval id or host tool name, archives included", () => {
    const found: string[] = [];
    let archives = 0;
    for (const path of files(evals)) {
      const label = path.slice(evals.length + 1);
      if (/\.(tar\.gz|tgz)$/.test(path)) {
        archives++;
        const members = execFileSync("tar", ["-tzf", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter((m) => m && !m.endsWith("/"));
        for (const member of members) {
          const body = execFileSync("tar", ["-xzOf", path, member], { encoding: "latin1", maxBuffer: 256 * 1024 * 1024 });
          found.push(...violations(`${label}!${member}`, body));
        }
      } else {
        found.push(...violations(label, readFileSync(path, "latin1")));
      }
    }
    expect(archives).toBeGreaterThan(0);
    expect(found).toEqual([]);
  }, 120_000);
});
