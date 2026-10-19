// A copy of the client whose endpoint table (src/core/rpc-endpoints.mjs) names loopback fakes, for tests that run the real
// dispatcher and rail scripts. The confirming endpoints of a verdict come from that table (or the owner's settings), never from
// an environment variable, so a test that needs one or two fake endpoints edits the table in a copy, as a later change to the
// table would. No production switch is involved.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export type Entry = string | { url: string; operator: string };

export interface EndpointTree {
  root: string;
  /** The table rows for these chain keys become these endpoints; a bare URL gets the operator fake-a, fake-b, ... by position. */
  set(table: Record<string, Entry[]>): void;
  close(): void;
}

/** A fresh scratch folder under ~/.cache (never /tmp); the caller removes it. */
export function scratchDir(prefix: string): string {
  const base = join(homedir(), ".cache", "superstables-endpoint-trees");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

export function endpointTree(): EndpointTree {
  const root = scratchDir("ss-endpoint-tree-");
  for (const dir of ["budget", "src"]) cpSync(join(ROOT, dir), join(root, dir), { recursive: true });
  for (const file of ["package.json", "tsconfig.json"]) cpSync(join(ROOT, file), join(root, file));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
  const original = readFileSync(join(ROOT, "src/core/rpc-endpoints.mjs"), "utf8");
  return {
    root,
    set(table) {
      let text = original;
      for (const [key, entries] of Object.entries(table)) {
        const rows = entries.map((e, i) => {
          const { url, operator } = typeof e === "string" ? { url: e, operator: `fake-${"abcdef"[i]}` } : e;
          return `{ url: ${JSON.stringify(url)}, operator: ${JSON.stringify(operator)} }`;
        });
        const row = new RegExp(`("${key}": )\\[[\\s\\S]*?\\],\\n`);
        if (!row.test(text)) throw new Error(`no table row for ${key}`);
        text = text.replace(row, `$1[${rows.join(", ")}],\n`);
      }
      writeFileSync(join(root, "src/core/rpc-endpoints.mjs"), text);
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
