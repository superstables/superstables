// Run released 0.3.0 readers against live and dead candidate holders, without wallets.
// BUDGET_RACE_ROOT selects another candidate export for regression reproduction.
import assert from 'node:assert/strict';
import { execFileSync, fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(import.meta.url);
const project = resolve(dirname(script), '../..');
const root = resolve(process.env.BUDGET_RACE_ROOT ?? project);
const preload = join(project, 'test/helpers/budget-macos-identity.mjs');
if (process.argv[2] === 'holder') {
  const [home, op] = process.argv.slice(3);
  const { lockOp } = await import(join(root, 'budget/buy-guard.mjs'));
  const approvals = await import(join(root, 'budget/approvals.mjs'));
  const lock = lockOp(join(home, 'ops'), op);
  assert.equal(lock.ok, true);
  lock.holdAlso(process.pid);
  const id = approvals.newApprovalId();
  approvals.startForeground({ id, command: 'test', rail: 'solana', chain: 'devnet' });
  approvals.setRailGroup(id, process.pid);
  assert.equal(approvals.claim('solana', 'devnet', id).ok, true);
  // Force the released reader to check identity rather than its startup grace.
  const active = join(home, 'budget/approvals/active-solana-devnet');
  const record = JSON.parse(readFileSync(active, 'utf8'));
  writeFileSync(active, JSON.stringify({ ...record, createdAt: 0 }));
  process.send({ id, pid: process.pid });
  setInterval(() => {}, 1000);
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'budget-mixed-version-'));
  const old = join(scratch, 'released'); mkdirSync(join(old, 'budget'), { recursive: true });
  // 46469a5 is the released v0.3.0 snapshot. Extract unchanged source, not a rewritten comparator.
  for (const file of ['procs.mjs', 'buy-guard.mjs', 'approvals.mjs', 'paths.mjs', 'site.mjs']) {
    writeFileSync(join(old, 'budget', file), execFileSync('git', ['show', `46469a5:budget/${file}`], { cwd: project }));
  }
  const children = new Set();
  const read = (candidate, home, tz, expression) => {
    const result = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      const { lockOp } = await import(${JSON.stringify(join(candidate, 'budget/buy-guard.mjs'))});
      const p = await import(${JSON.stringify(join(candidate, 'budget/procs.mjs'))});
      const a = await import(${JSON.stringify(join(candidate, 'budget/approvals.mjs'))});
      ${expression}
    `], { env: { ...process.env, TZ: tz, LC_ALL: 'C', SUPERSTABLES_HOME: home }, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
  };
  let cases = 0;
  try {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Kathmandu', 'Australia/Lord_Howe']) {
      const home = join(scratch, String(cases)); mkdirSync(home);
      const child = fork(script, ['holder', home, 'upgrade'], { execArgv: ['--import', preload], env: { ...process.env, TZ: tz, LC_ALL: 'C', SUPERSTABLES_HOME: home }, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.add(child);
      const error = []; child.stderr.on('data', chunk => error.push(String(chunk)));
      const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(error.join('')); })]);
      const [{ id, pid }] = ready;
      read(old, home, tz, `
        const lock = lockOp(${JSON.stringify(join(home, 'ops'))}, 'upgrade');
        assert.equal(lock.ok, false, '0.3.0 took a live candidate lock');
        const owner = JSON.parse(readFileSync(${JSON.stringify(join(home, 'ops/upgrade.buy.lock'))}, 'utf8'));
        assert.equal(owner.pidStart, p.processStart(${pid}));
        assert.equal(owner.railPidStart, p.processStart(${pid}));
        assert.equal(typeof owner.pidStartUtc, 'number');
        assert.equal(typeof owner.railPidStartUtc, 'number');
        assert.equal(a.findPending('solana', 'devnet')?.id, ${JSON.stringify(id)});
        const record = a.readApproval(${JSON.stringify(id)});
        assert.equal(record.pidStart, p.processStart(${pid}));
        assert.equal(record.railPgidStart, p.processStart(${pid}));
        assert.equal(typeof record.pidStartUtc, 'number');
        assert.equal(typeof record.railPgidStartUtc, 'number');
        assert.equal(a.alive(record.pid, record.pidStart), true);
        assert.equal(a.groupAlive(record.railPgid, record.railPgidStart), true);
        assert.equal((await a.waitFor(record.id, 0)).orphaned, false);
      `);
      cases++;
      const path = join(home, 'ops/upgrade.buy.lock');
      const owner = JSON.parse(readFileSync(path, 'utf8'));
      // The dispatcher is gone but its recorded rail PID remains live. Exercise the released OR branch.
      writeFileSync(path, JSON.stringify({ ...owner, pid: 2147483646, pidStart: null, pidStartUtc: null }));
      read(old, home, tz, `assert.equal(lockOp(${JSON.stringify(join(home, 'ops'))}, 'upgrade').ok, false);`);
      writeFileSync(path, JSON.stringify(owner));
      cases++;
      read(root, home, tz === 'UTC' ? 'Asia/Tokyo' : 'UTC', `
        assert.equal(lockOp(${JSON.stringify(join(home, 'ops'))}, 'upgrade').ok, false);
        assert.equal(a.findPending('solana', 'devnet')?.id, ${JSON.stringify(id)});
        assert.equal((await a.waitFor(${JSON.stringify(id)}, 0)).orphaned, false);
      `);
      cases++;
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; children.delete(child);
      read(old, home, tz, `
        const lock = lockOp(${JSON.stringify(join(home, 'ops'))}, 'upgrade');
        assert.equal(lock.ok, true, '0.3.0 cannot recover a dead candidate holder');
        lock.release();
        assert.equal(a.findPending('solana', 'devnet'), null);
        assert.equal(a.processesAlive(a.readApproval(${JSON.stringify(id)})), false);
      `);
      cases++;
    }
    console.log(JSON.stringify({ cases, result: 'pass', released: '46469a5', nativeMacOS: false }));
  } finally {
    await Promise.all([...children].map(async child => { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }));
    rmSync(scratch, { recursive: true, force: true });
  }
}
