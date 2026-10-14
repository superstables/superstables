// An approval record is written through a temp file with a random name, opened exclusively and never through a symlink, then
// synced and renamed. A name an attacker can predict (<id>.json.<pid>.tmp) must not make the write follow a planted link.
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { guardedNode } from "../helpers/guarded-process.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

const CHILD = `
const { mkdirSync, symlinkSync } = await import("node:fs");
const { join } = await import("node:path");
const a = await import("./budget/approvals.mjs");
const dir = join(process.env.SUPERSTABLES_HOME, "budget/approvals");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const id = a.newApprovalId();
symlinkSync(process.env.VICTIM, join(dir, id + ".json." + process.pid + ".tmp"));
a.startForeground({ id, command: "grant", rail: "evm", chain: "base-sepolia" });
console.log("ID " + id + " " + a.readApproval(id).state);
`;

it("never follows a symlink planted at the record's old temp name", async () => {
  const home = mkdtempSync(join(tmpdir(), "approval-record-"));
  homes.push(home);
  const victim = join(home, "victim");
  writeFileSync(victim, "untouched\n");
  const child = await guardedNode(["--input-type=module", "-e", CHILD], { HOME: home, SUPERSTABLES_HOME: home, VICTIM: victim });
  expect(child.code, child.output).toBe(0);
  const id = /ID (\S+) running/.exec(child.output)?.[1];
  expect(id, child.output).toBeTruthy();
  const record = join(home, "budget/approvals", `${id}.json`);
  expect(readFileSync(victim, "utf8")).toBe("untouched\n");
  expect(lstatSync(record).isSymbolicLink()).toBe(false);
  expect(lstatSync(record).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({ id, state: "running" });
  // the planted link is left where it was, and no temp file of ours is left behind
  const temps = readdirSync(join(home, "budget/approvals")).filter((f) => f.endsWith(".tmp"));
  expect(temps.filter((f) => !lstatSync(join(home, "budget/approvals", f)).isSymbolicLink())).toEqual([]);
}, 60_000);
