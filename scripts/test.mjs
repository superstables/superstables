// Runs vitest, then fails the run if any process it started is still running (Linux only).
// Every child inherits a marker unique to this run, which survives reparenting and detached
// process groups. After vitest exits, /proc is scanned for that exact marker under this user:
// survivors are listed with their command lines, killed, and the run fails. Other runs carry other
// markers and are left alone. A child spawned with an environment that drops the marker is not seen.
// Calling vitest directly skips this check.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const runId = randomUUID();
const marker = `SS_TEST_RUN_ID=${runId}`;
const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const child = spawn(process.execPath, [vitest, "run", ...process.argv.slice(2)], {
  stdio: "inherit", env: { ...process.env, SS_TEST_RUN_ID: runId },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});

function survivors() {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    const dir = `/proc/${name}`;
    try {
      if (statSync(dir).uid !== process.getuid()) return [];
      if (!readFileSync(`${dir}/environ`, "utf8").split("\0").includes(marker)) return [];
      const command = readFileSync(`${dir}/cmdline`, "utf8").replaceAll("\0", " ").trim();
      return command ? [{ pid: Number(name), command }] : [];
    } catch (error) {
      if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) return [];
      throw error;
    }
  });
}

if (process.platform === "linux") {
  // Give exiting workers and esbuild services up to two seconds to finish.
  let leaked = survivors();
  for (let i = 0; leaked.length && i < 20; i++) {
    await delay(100);
    leaked = survivors();
  }
  if (leaked.length) {
    console.error(`Test run left ${leaked.length} process(es) running:\n${leaked.map(p => `  PID ${p.pid}: ${p.command}`).join("\n")}`);
    // Re-read before each kill so a PID reused by an unrelated process is never signalled.
    for (const p of leaked) {
      try {
        if (survivors().some(current => current.pid === p.pid)) process.kill(p.pid, "SIGKILL");
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    process.exitCode = 1;
  } else process.exitCode = code;
} else {
  console.error("The check for test processes left running needs Linux /proc; skipped on this platform.");
  process.exitCode = code;
}
