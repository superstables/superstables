// What this host says about itself, read without the client's own identity code (src/core/process-identity.mjs): a test that
// compares the client's record with it fails when the client stops reading what the host plainly gives, instead of skipping.
// Each value is read on its own and left out when the host does not give it (a sandbox hides them).
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

export type HostIdentity = { bootId?: string; namespace?: string; startTime?: string };

const attempt = <T>(read: () => T): T | undefined => {
  try { return read(); } catch { return undefined; }
};

/** The boot id, the PID namespace (Linux) and the start time of this process, as the operating system gives them. */
export function hostIdentity(): HostIdentity {
  if (process.platform === "linux") {
    return {
      bootId: attempt(() => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase()) || undefined,
      namespace: attempt(() => readlinkSync("/proc/self/ns/pid")),
      // field 22 of /proc/self/stat; the command name (field 2) sits in parentheses and may hold spaces, so count after the last ')'
      startTime: attempt(() => {
        const stat = readFileSync("/proc/self/stat", "utf8");
        const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
        return /^\d+$/.test(start ?? "") ? start : undefined;
      }),
    };
  }
  if (process.platform === "darwin") {
    const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    return {
      bootId: attempt(() => run("sysctl", ["-n", "kern.bootsessionuuid"]).toLowerCase()) || undefined,
      startTime: attempt(() => run("ps", ["-o", "lstart=", "-p", String(process.pid)])) || undefined,
    };
  }
  return {};
}
