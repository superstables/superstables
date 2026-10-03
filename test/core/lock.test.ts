// The cap lock (src/core/lock.ts) across processes. A lock is taken over only from a holder that is gone, never for its
// age; it is broken only if it is still the same lock; and it is released only by its owner.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lockForTests, processStart, withFileLock } from "../../src/core/lock.js";

const lockPath = () => join(mkdtempSync(join(tmpdir(), "superstables-lock-")), "cap.lock");

describe("withFileLock", () => {
  it("leaves a paused live holder its lock, however old the lock is", async () => {
    const path = lockPath();
    // Another process takes the lock the same way, then stops itself (SIGSTOP): alive, but doing nothing.
    const child = spawn(process.execPath, [
      "-e",
      `const fs=require("fs");const s=fs.readFileSync("/proc/"+process.pid+"/stat","utf8");` +
        `const st=s.slice(s.lastIndexOf(")")+2).split(" ")[19];const boot=fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim();` +
        `fs.writeFileSync(${JSON.stringify(path)},JSON.stringify({pid:process.pid,pidStart:"linux:"+boot+":"+st,owner:"paused"}),{flag:"wx"});` +
        `console.log("held");process.kill(process.pid,"SIGSTOP");setTimeout(()=>{},60000);`,
    ]);
    try {
      await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
      // Make the lock look ancient: age must not matter.
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(path, old, old);
      await expect(withFileLock(path, () => "mine", 300)).rejects.toThrow(/held by process/);
      expect(JSON.parse(readFileSync(path, "utf8")).owner).toBe("paused");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("takes over a lock whose holder is gone, or whose pid now names another process", async () => {
    const path = lockPath();
    const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
    writeFileSync(path, JSON.stringify({ pid: gone, pidStart: "linux:x:1", owner: "dead" }));
    expect(await withFileLock(path, () => "mine", 1_000)).toBe("mine");
    // This process's own pid, recorded with another start: a reused pid, so the holder is gone.
    writeFileSync(path, JSON.stringify({ pid: process.pid, pidStart: "linux:another-boot:1", owner: "reused" }));
    if (processStart(process.pid)) expect(await withFileLock(path, () => "mine", 1_000)).toBe("mine");
    expect(existsSync(path)).toBe(false);
  });

  it("never lets a reclaimer remove a lock that replaced the one it judged dead", async () => {
    const path = lockPath();
    const dead = JSON.stringify({ pid: 999_999_999, pidStart: null, owner: "dead" });
    const fresh = JSON.stringify({ pid: process.pid, pidStart: processStart(process.pid) ?? null, owner: "fresh" });
    // A waiter read the dead holder's lock; before it breaks it, another waiter has broken it and taken a fresh one.
    writeFileSync(path, fresh);
    await lockForTests.breakLock(path, dead, Date.now() + 1_000);
    expect(readFileSync(path, "utf8")).toBe(fresh);
    // And a release by anyone but the owner leaves it.
    lockForTests.release(path, dead);
    expect(readFileSync(path, "utf8")).toBe(fresh);
  });

  it("leaves a paused breaker its mutex, and the breaker, resumed, does not remove a lock that changed", async () => {
    const path = lockPath();
    const dead = JSON.stringify({ pid: spawnSync(process.execPath, ["-e", ""]).pid!, pidStart: null, owner: "dead" });
    writeFileSync(path, dead);
    const tsx = resolve(dirname(fileURLToPath(import.meta.url)), "../../node_modules/tsx/dist/cli.mjs");
    const script = resolve(dirname(fileURLToPath(import.meta.url)), "../helpers/lock-breaker.ts");
    const breaker = spawn(process.execPath, [tsx, script, path, dead]);
    const lines: string[] = [];
    const wait = (word: string) =>
      new Promise<void>((done) => {
        const check = () => (lines.includes(word) ? done() : setTimeout(check, 10));
        check();
      });
    createInterface({ input: breaker.stdout }).on("line", (l) => lines.push(l.trim()));
    try {
      await wait("mutex");
      breaker.kill("SIGSTOP"); // paused while it holds the break mutex
      // Another waiter sees the dead lock, but the mutex's holder is alive: it waits and gives up, stealing nothing.
      await expect(withFileLock(path, () => "stolen", 300)).rejects.toThrow(/held by process/);
      expect(readFileSync(path, "utf8")).toBe(dead);
      expect(existsSync(`${path}.break`)).toBe(true);
      // The lock changes while the breaker is paused (as it would if it had been broken some other way).
      const fresh = JSON.stringify({ pid: process.pid, pidStart: processStart(process.pid) ?? null, owner: "fresh" });
      writeFileSync(path, fresh);
      breaker.kill("SIGCONT");
      breaker.stdin.write("go\n");
      await wait("done");
      expect(readFileSync(path, "utf8")).toBe(fresh); // not removed
      expect(existsSync(`${path}.break`)).toBe(false); // and the breaker released its own mutex
    } finally {
      breaker.kill("SIGKILL");
    }
  }, 30_000);

  it("keeps to its deadline and yields between attempts", async () => {
    const path = lockPath();
    // A live holder (this process) keeps the lock for the whole test.
    writeFileSync(path, JSON.stringify({ pid: process.pid, pidStart: processStart(process.pid) ?? null, owner: "held" }));
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 5);
    const started = Date.now();
    await expect(withFileLock(path, () => "mine", 50)).rejects.toThrow(/held by process/);
    clearInterval(timer);
    expect(Date.now() - started).toBeLessThan(400);
    expect(ticks).toBeGreaterThan(3); // timers ran while it waited: it never spun
    // A dead holder's lock whose break keeps failing (its mutex held by a live process) is also bounded by the deadline.
    writeFileSync(path, JSON.stringify({ pid: spawnSync(process.execPath, ["-e", ""]).pid!, pidStart: null, owner: "dead" }));
    writeFileSync(`${path}.break`, JSON.stringify({ pid: process.pid, pidStart: processStart(process.pid) ?? null, owner: "breaker" }));
    const again = Date.now();
    await expect(withFileLock(path, () => "mine", 50)).rejects.toThrow();
    expect(Date.now() - again).toBeLessThan(400);
  });

  it("is never seen half written, and lets one holder in at a time", async () => {
    const path = lockPath();
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withFileLock(path, async () => {
          inside += 1;
          most = Math.max(most, inside);
          expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty("owner");
          await new Promise((r) => setTimeout(r, 20));
          inside -= 1;
        }),
      ),
    );
    expect(most).toBe(1);
    expect(existsSync(path)).toBe(false);
  });
});
