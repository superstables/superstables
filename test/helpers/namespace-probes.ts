// What the lock tests need from this machine, probed without the client's own code: a skip must never hide a
// regression in the code under test. On the CI runner (GitHub Actions) nothing is skipped: there, a missing
// precondition is a failure to look at, not a reason to test less.
import { spawnSync } from "node:child_process";
import { readlinkSync } from "node:fs";

/** Linux's inode for the initial PID namespace (PROC_PID_INIT_INO, include/linux/proc_ns.h). */
const INITIAL_PID_NAMESPACE = "pid:[4026531836]";
const onCi = process.env.GITHUB_ACTIONS === "true";

/** Whether this process runs in the host's own PID namespace, where a lock holder's liveness can be proven. */
export const hostPidNamespace = (() => {
  if (process.platform !== "linux") return false;
  try { return readlinkSync("/proc/self/ns/pid") === INITIAL_PID_NAMESPACE; } catch { return false; }
})();

/** The sandbox the no-proc tests start: new user and PID namespaces, and an empty /proc. */
export const NO_PROC_SANDBOX = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-user", "--dev-bind", "/", "/", "--tmpfs", "/proc"];

/** Whether bwrap can start that sandbox here (it cannot inside another sandbox, or where user namespaces are off). */
export const canNestNoProcSandbox = process.platform === "linux"
  && spawnSync("bwrap", [...NO_PROC_SANDBOX, "true"], { stdio: "ignore", timeout: 10_000 }).status === 0;

/** Run a host-namespace test here: on the CI runner always, elsewhere only in the host's PID namespace. */
export const runsInHostNamespace = process.platform === "linux" && (hostPidNamespace || onCi);
/** Run a nested no-proc sandbox test here: on the CI runner always, elsewhere only where bwrap can start it. */
export const runsNoProcSandbox = process.platform === "linux" && (canNestNoProcSandbox || onCi);
