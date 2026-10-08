import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const project = fileURLToPath(new URL('../..', import.meta.url));
const root = resolve(process.env.BUDGET_DURABILITY_ROOT ?? project);
const homes: string[] = [];
beforeEach(() => new Promise<void>(resolve => setImmediate(resolve)));
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'budget-journal-')); homes.push(dir); return dir; };
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const run = (helper: string, dir: string, args: string[] = [], extra = {}) => spawnSync(process.execPath, ['--import', 'tsx', join(project, 'test/helpers', helper), ...args], {
  cwd: project, env: { ...process.env, SUPERSTABLES_HOME: dir, BUDGET_DURABILITY_ROOT: root, ...extra }, encoding: 'utf8', timeout: 15_000,
});
const checkpoints = [
  ['evm', 'quote'], ['evm', 'pull-intent'], ['evm', 'pull-hash'], ['evm', 'authorization'], ['evm', 'cancel-hash'], ['evm', 'return-hash'],
  ['tempo', 'quote'], ['tempo', 'push-intent'], ['tempo', 'pull-submitted'], ['tempo', 'push-submitted'],
  ['solana', 'intent'], ['solana', 'signature'],
];
const cuts = ['file-open', 'write', 'file-fsync', 'file-close', 'rename', 'directory-open', 'directory-fsync', 'directory-close', 'returned', 'none'];

describe('rail journal power loss', () => {
  for (const [rail, checkpoint] of checkpoints) {
    it.each(cuts)(`${rail} ${checkpoint}: power cut after %s`, cut => {
      const result = run('budget-journal-fault.mjs', home(), [rail, checkpoint, cut]);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? 'null');
      // Only a completed durable write may enable the next signing or sending step.
      if (report.mayPay || report.events.includes('directory-fsync') || cut === 'returned') {
        expect(report.recovered.checkpoint, JSON.stringify(report)).toBe(checkpoint);
      } else {
        expect(report.killed, JSON.stringify(report)).toBe(true);
        expect(report.recovered.checkpoint).toBeUndefined();
      }
      if (cut === 'none') expect(report.events).toEqual(['file-open', 'write', 'file-fsync', 'file-close', 'rename', 'directory-open', 'directory-fsync', 'directory-close', 'returned']);
    });
  }
  for (const [rail, checkpoint] of checkpoints) {
    it.each(['file-fsync', 'directory-fsync'])(`${rail} ${checkpoint}: %s failure blocks the next step`, failAt => {
      const result = run('budget-journal-fault.mjs', home(), [rail, checkpoint, 'none', failAt]);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? 'null');
      expect(report.error).toBe('EIO');
      expect(report.mayPay).toBe(false);
      expect(report.events).not.toContain('returned');
      expect(report.recovered.checkpoint).toBeUndefined();
    });
    if (process.env.BUDGET_DURABILITY_BASE) it(`${rail} ${checkpoint}: base loses the pre-send journal after return`, () => {
      const result = run('budget-journal-fault.mjs', home(), [rail, checkpoint, 'none'], { BUDGET_DURABILITY_ROOT: process.env.BUDGET_DURABILITY_BASE });
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? 'null');
      expect(report.mayPay).toBe(true);
      expect(report.recovered.checkpoint).toBeUndefined();
      expect(report.events).not.toContain('file-fsync');
      expect(report.events).not.toContain('directory-fsync');
    });
  }
  it.each(['journal', 'dispatcher', 'record'])('%s syncs every newly created directory into its parent', kind => {
    const result = run('budget-journal-directories.mjs', home(), [kind]);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim());
    expect(report.created).toHaveLength(4);
    for (const parent of report.parents) expect(report.synced).toContain(parent);
    expect(report.openedAncestors).toEqual([]);
  });
  it('persists newly created directory entries and writes private journals', async () => {
    const { writeJournalFile } = await import('../../budget/journal.mjs');
    const dir = home();
    const path = join(dir, 'new/budget/ops/test.json');
    writeJournalFile(path, '{"state":"submitted"}');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ state: 'submitted' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'new/budget/ops')).mode & 0o777).toBe(0o700);
  });
  it('does not open an existing traversable but unreadable ancestor', () => {
    const dir = home();
    const ancestor = join(dir, 'locked');
    const journal = join(ancestor, 'home/budget/ops/test.json');
    mkdirSync(join(ancestor, 'home'), { recursive: true });
    chmodSync(ancestor, 0o311);
    try {
      const result = run('budget-journal-permissions.mjs', dir);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(JSON.parse(readFileSync(journal, 'utf8'))).toEqual({ state: 'submitted' });
    } finally { chmodSync(ancestor, 0o700); }
  });
});
