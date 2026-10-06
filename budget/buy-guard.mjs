// The dispatcher holds an operation lock through its rail child's exit.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { lockFile } from './op-lock.mjs';
export { lockRecord } from './op-lock.mjs';

export const opLockFile = (dir, op) => join(dir, `${op}.buy.lock`);

export function lockOp(dir, op, options = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return lockFile(opLockFile(dir, op), options);
}

/**
 * The RESULT object a rail script printed, or null. With `last`, only the last non-empty line of stdout counts (purchases:
 * the rail prints its RESULT last, then exits); otherwise the last line that starts with `RESULT {`.
 */
export function railResult(stdout, { last = false } = {}) {
  const lines = String(stdout ?? "").split("\n").map((l) => l.replace(/\r$/, ""));
  const line = last ? [...lines].reverse().find((l) => l.trim() !== "") : [...lines].reverse().find((l) => /^RESULT \{/.test(l));
  if (!line || !/^RESULT \{/.test(line)) return null;
  try {
    const r = JSON.parse(line.slice(7));
    return r && typeof r === "object" && !Array.isArray(r) ? r : null;
  } catch {
    return null;
  }
}
