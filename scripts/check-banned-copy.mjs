#!/usr/bin/env node
// Fails when shipped copy uses a word the owner has banned. Today: "Recommended" (no option is labelled as the
// one to pick; the order of the options says it). This is the one place the ban is enforced. The same logic lives in
// the client and website repositories; keep them identical except the two path tables. Run it with `npm run copy:check`; its test runs the
// same function in CI.
//
// An exception goes on the offending line, as a comment or text on that line:
//   copy-ok(recommended): <reason>; expires <YYYY-MM-DD>; approved by a human, <YYYY-MM-DD>
// A line whose exception lacks any part, or is past its expiry, still fails.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const BANNED = [{ id: "recommended", pattern: /\brecommended\b/i, fix: 'Do not label an option "Recommended". Order the options instead (plugin, connector, skill) and describe each one plainly.' }];

/** Tracked files that people or agents read as product copy. */
const SHIPPED = /^(src|plugin|skills|docs|budget|\.claude-plugin)\/|^(README|SECURITY|policy)[^/]*$|\.md$/;
const NOT_SHIPPED = /^(test|tests|evals|node_modules|dist|scripts)\/|(^|\/)(CHANGELOG|LICENSE)[^/]*$|package-lock\.json$|npm-shrinkwrap\.json$|\.(png|jpe?g|webp|svg|ico|zip|woff2?|pdf)$/;
export const isShipped = (path) => SHIPPED.test(path) && !NOT_SHIPPED.test(path);

const OK = (id) => new RegExp(`copy-ok\\(${id}\\): (.+?); expires (\\d{4}-\\d{2}-\\d{2}); approved by a human, (\\d{4}-\\d{2}-\\d{2})`);

/** [{ file, line, id, message }] for every banned word in `files` ({ path, text }). */
export function findBanned(files, today = new Date().toISOString().slice(0, 10)) {
  const found = [];
  for (const { path, text } of files) {
    text.split("\n").forEach((line, i) => {
      for (const { id, pattern, fix } of BANNED) {
        if (!pattern.test(line)) continue;
        const ok = OK(id).exec(line);
        if (ok && ok[2] >= today) continue;
        found.push({ file: path, line: i + 1, id, message: `${path}:${i + 1} says "${pattern.exec(line)[0]}". ${fix}${ok ? ` Its copy-ok exception expired on ${ok[2]}.` : ` An exception needs a copy-ok(${id}) marker on that line: reason, expiry date, human approval.`}` });
      }
    });
  }
  return found;
}

export function trackedShippedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\0")
    .filter((p) => p && isShipped(p))
    .map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = findBanned(trackedShippedFiles());
  for (const f of found) console.error(f.message);
  if (found.length) process.exit(1);
  console.log("copy:check ok");
}
