// Test-only: an approval worker that stops itself (SIGSTOP) right after it spawns its detached rail script, as an OS
// scheduling pause would, and writes what it started to PAUSE_TRACE first. Only the worker's own rail spawn, and only once.
import cp from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const original = cp.spawn;
cp.spawn = function (cmd, args, options) {
  const child = original.apply(this, arguments);
  const id = process.env.SUPERSTABLES_BUDGET_APPROVAL_ID;
  const trace = process.env.PAUSE_TRACE;
  if (id && trace && !existsSync(trace) && options?.detached && options?.env?.SUPERSTABLES_BUDGET_HOLDER === id) {
    writeFileSync(trace, JSON.stringify({ worker: process.pid, rail: child.pid, id }));
    process.kill(process.pid, "SIGSTOP");
  }
  return child;
};
syncBuiltinESMExports();
