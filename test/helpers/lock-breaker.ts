// A process that breaks a dead cap lock and holds the break mutex until told to go on, for test/core/lock.test.ts.
//   node --import tsx test/helpers/lock-breaker.ts <lock path> <dead lock text>
// Prints "mutex" once it holds the mutex, waits for a "go" line on stdin, then finishes the break and prints "done".
import { createInterface } from "node:readline";
import { breakTestHook, lockForTests } from "../../src/core/lock.js";

const [path, dead] = process.argv.slice(2);
const go = new Promise<void>((resolve) => createInterface({ input: process.stdin }).on("line", (l) => l.trim() === "go" && resolve()));
breakTestHook.afterMutex = async () => {
  console.log("mutex");
  await go;
};
await lockForTests.breakLock(path, dead, Date.now() + 60_000);
console.log("done");
process.exit(0);
