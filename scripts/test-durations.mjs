// Writes test/durations.json, the seconds each test file took, from one or more vitest JSON reports (the median when there are
// several). vitest.config.ts runs the longest files first from it, so the workers finish together even without vitest's own
// cache of the last run's times (a fresh install, CI). Refresh it when files are added or their times change a lot:
//   npm test -- --reporter=default --reporter=json --outputFile.json=report.json && node scripts/test-durations.mjs report.json
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";

const reports = process.argv.slice(2);
if (!reports.length) {
  console.error("usage: node scripts/test-durations.mjs <vitest-json-report>...");
  process.exit(2);
}
const root = fileURLToPath(new URL("..", import.meta.url));
const times = new Map();
for (const report of reports) {
  for (const file of JSON.parse(readFileSync(report, "utf8")).testResults) {
    const name = file.name.startsWith("/") ? relative(root, file.name) : file.name;
    const key = name.slice(name.indexOf("test/"));
    times.set(key, [...(times.get(key) ?? []), (file.endTime - file.startTime) / 1000]);
  }
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const out = Object.fromEntries([...times].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, Math.round(median(v) * 10) / 10]));
writeFileSync(fileURLToPath(new URL("../test/durations.json", import.meta.url)), JSON.stringify(out, null, 1) + "\n");
console.log(`test/durations.json: ${Object.keys(out).length} files from ${reports.length} report(s)`);
