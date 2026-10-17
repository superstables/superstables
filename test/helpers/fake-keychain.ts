// A fake `secret-tool` (Linux) and a fake `security` (macOS) as executable scripts, put first on PATH in a temporary folder.
// They keep a store in a file and log every call's argv and stdin, so a test can prove the secret never reached argv.
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = (kind: "secret-tool" | "security") => `#!${process.execPath}
const fs = require("node:fs");
const dir = process.env.FAKE_KEYCHAIN_DIR;
const args = process.argv.slice(2);
const storeFile = dir + "/store.json";
const load = () => { try { return JSON.parse(fs.readFileSync(storeFile, "utf8")); } catch { return {}; } };
const save = (s) => fs.writeFileSync(storeFile, JSON.stringify(s));
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(dir + "/calls.log", JSON.stringify({ tool: ${JSON.stringify(kind)}, argv: args, stdin }) + "\\n");
if (process.env.FAKE_KEYCHAIN_FAIL) { process.stderr.write("keychain is locked\\n"); process.exit(1); }
const pick = (list, flag) => { const i = list.indexOf(flag); return i >= 0 ? list[i + 1] : undefined; };
const store = load();
${
  kind === "secret-tool"
    ? `
if (args[0] === "store") { store[pick(args, "account")] = stdin; save(store); process.exit(0); }
if (args[0] === "lookup") { const v = store[pick(args, "account")]; if (v === undefined) process.exit(1); process.stdout.write(v); process.exit(0); }
if (args[0] === "clear") { delete store[pick(args, "account")]; save(store); process.exit(0); }
process.exit(2);`
    : `
if (args[0] === "-i") {
  const t = stdin.trim().split(/\\s+/);
  if (t[0] === "add-generic-password") { store[pick(t, "-a")] = pick(t, "-w"); save(store); process.exit(0); }
  process.exit(2);
}
if (args[0] === "find-generic-password") { const v = store[pick(args, "-a")]; if (v === undefined) { process.stderr.write("could not be found\\n"); process.exit(44); } process.stdout.write(v + "\\n"); process.exit(0); }
if (args[0] === "delete-generic-password") { if (!(pick(args, "-a") in store)) process.exit(44); delete store[pick(args, "-a")]; save(store); process.exit(0); }
process.exit(2);`
}
`;

export type FakeKeychain = {
  /** The folder to put first on PATH. */
  bin: string;
  /** Set on a child's environment with PATH. */
  env: (base?: Record<string, string | undefined>) => Record<string, string>;
  calls: () => { tool: string; argv: string[]; stdin: string }[];
  store: () => Record<string, string>;
  setStore: (s: Record<string, string>) => void;
};

/** Installs the fake tools under `dir` (a fresh folder). `kinds` limits which exist. */
export function fakeKeychain(dir: string, kinds: ("secret-tool" | "security")[] = ["secret-tool", "security"]): FakeKeychain {
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  for (const k of kinds) {
    writeFileSync(join(bin, k), SCRIPT(k));
    chmodSync(join(bin, k), 0o755);
  }
  writeFileSync(join(state, "calls.log"), "");
  return {
    bin,
    env: (base = {}) => ({ ...(base as Record<string, string>), PATH: `${bin}:${base.PATH ?? process.env.PATH ?? ""}`, FAKE_KEYCHAIN_DIR: state }),
    calls: () => readFileSync(join(state, "calls.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    store: () => (existsSync(join(state, "store.json")) ? JSON.parse(readFileSync(join(state, "store.json"), "utf8")) : {}),
    setStore: (s) => writeFileSync(join(state, "store.json"), JSON.stringify(s)),
  };
}
