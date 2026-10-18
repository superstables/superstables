// The eval runner starts the loopback stub site once per matrix: a job that ends early must not take it from the others.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let rig: typeof import("../../evals/hostile/run-evals.mjs");
let root: string;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  process.env.EVAL_RIG_PORT = String(await freePort());
  root = mkdtempSync(join(tmpdir(), "eval-rig-"));
  rig = await import("../../evals/hostile/run-evals.mjs");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the loopback stub in a matrix", () => {
  it("stays up for the other jobs when the first job to finish is done, and stops after all of them", async () => {
    expect(await rig.rigUp()).toBe(false);
    await rig.withSharedRig(root, "loopback", async () => {
      expect(await rig.rigUp()).toBe(true);
      // two overlapping jobs, both told the matrix owns the stub: neither starts it nor stops it
      const stopFirst = await rig.rigFor(root, "loopback", true);
      const stopSecond = await rig.rigFor(root, "loopback", true);
      stopFirst(); // the first job ends first
      expect(await rig.rigUp()).toBe(true); // the second still reaches the stub
      stopSecond();
      expect(await rig.rigUp()).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(await rig.rigUp()).toBe(false);
  });

  it("a standalone run starts its own stub and stops it when done; other modes start none", async () => {
    const stop = await rig.rigFor(root, "loopback", false);
    expect(await rig.rigUp()).toBe(true);
    stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(await rig.rigUp()).toBe(false);
    await rig.rigFor(root, "staging", false);
    expect(await rig.rigUp()).toBe(false);
  });
});
