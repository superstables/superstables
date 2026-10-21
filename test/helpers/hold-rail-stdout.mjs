// Test-only: a rail script (a process an approval worker started: it carries SUPERSTABLES_BUDGET_HOLDER) starts a process of its own
// that keeps the rail's stdout pipe open for HOLD_RAIL_STDOUT_MS after the rail script is gone. The dispatcher's close handler for
// the rail script waits for that pipe, so what ends the worker after its backstop kills the rail script is the backstop's own
// code, not the dispatcher noticing the rail script left. Only the first process of the rail carries it on.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const ms = Number(process.env.HOLD_RAIL_STDOUT_MS ?? 0);
if (ms > 0 && process.env.SUPERSTABLES_BUDGET_HOLDER) {
  process.env.HOLD_RAIL_STDOUT_MS = "0";
  const holder = spawn("sleep", [String(ms / 1000)], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
  holder.unref();
  // the test that asked for this stops the holder when it is done: a process left running fails the test run
  if (process.env.HOLD_RAIL_STDOUT_PIDFILE) appendFileSync(process.env.HOLD_RAIL_STDOUT_PIDFILE, `${holder.pid}\n`);
}
