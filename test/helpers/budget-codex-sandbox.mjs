// Real Codex PID namespace regression checks. No wallets or payments.
// Run: CODEX_BIN=/path/to/codex node test/helpers/budget-codex-sandbox.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const project = resolve(import.meta.dirname, '../..');
const root = resolve(process.env.BUDGET_RACE_ROOT ?? project);
const codex = process.env.CODEX_BIN ?? 'codex';
const coreOnly = process.argv.includes('--core-only');
const approvalOnly = process.argv.includes('--approval-only');
const tsx = join(project, 'node_modules/tsx/dist/loader.mjs');
const identityImport = `const { createIdentitySource } = await import(${JSON.stringify(join(root, 'budget/lock-identity.mjs'))});`;
const imports = `const fs = await import('node:fs'); const { lockFile, lockRecord } = await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))}); const { lockOp } = await import(${JSON.stringify(join(root, 'budget/buy-guard.mjs'))}); ${identityImport}`;
const coreImport = `const { withFileLock, thisProcess, processRunning } = await import(${JSON.stringify(join(root, 'src/core/lock.ts'))});`;
const children = new Set();
const homes = new Set();
const namespaceFds = new Set();
let cases = 0;
function box() {
  const home = fs.mkdtempSync(join(tmpdir(), 'budget-codex-')); homes.add(home);
  const dir = join(home, 'budget/ops/solana-devnet'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'paid-op.json'), '{"op":"paid-op","state":"submitted"}');
  return { home, dir, path: join(dir, 'paid-op.buy.lock'), core: join(home, 'cap.lock') };
}
function args(code) { return ['--import', tsx, '--input-type=module', '-e', code]; }
function options(b) { return { cwd: b.home, env: { ...process.env, TMPDIR: b.home, SUPERSTABLES_HOME: b.home }, encoding: 'utf8' }; }
function sandboxArgs(nodeArgs) { return ['sandbox', '-c', 'sandbox_mode="workspace-write"', '--', process.execPath, ...nodeArgs]; }
function run(b, code, sandbox = false) {
  const resultPath = join(b.home, 'result.json');
  fs.rmSync(resultPath, { force: true });
  const wrapped = `const output = await import('node:fs'); console.log = text => output.writeFileSync(${JSON.stringify(resultPath)}, text); ${code}`;
  const r = spawnSync(sandbox ? codex : process.execPath, sandbox ? sandboxArgs(args(wrapped)) : args(wrapped), { ...options(b), timeout: 15000 });
  assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
}
async function hold(b, sandbox = false, core = false, approval = false) {
  const holderRoot = process.env.BUDGET_HOLDER_ROOT ?? root;
  const approvalCode = approval ? `const approvals = await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))}); const id = approvals.newApprovalId(); approvals.startForeground({ id, command: 'grant', rail: 'solana', chain: 'devnet' }); fs.writeFileSync(${JSON.stringify(join(b.home, 'approval-id'))}, id);` : '';
  const code = (core ? `${imports} ${coreImport} await withFileLock(${JSON.stringify(b.core)}, async () => { ${approvalCode} fs.writeFileSync(${JSON.stringify(join(b.home, 'ready.json'))}, JSON.stringify({ ...createIdentitySource().record(), ...thisProcess() })); console.log(JSON.stringify(thisProcess())); setInterval(()=>{},1000); await new Promise(()=>{}); });` : `${imports}
    const a = lockOp(${JSON.stringify(b.dir)}, 'paid-op'), c = lockRecord(${JSON.stringify(b.dir)}, 'paid-op');
    if (!a.ok || !c.ok) throw new Error('holder could not acquire'); fs.writeFileSync(${JSON.stringify(join(b.home, 'ready.json'))}, JSON.stringify(createIdentitySource().record())); console.log(JSON.stringify(createIdentitySource().record())); setInterval(()=>{},1000);`).replaceAll(root, holderRoot);
  const p = spawn(sandbox ? codex : process.execPath, sandbox ? sandboxArgs(args(code)) : args(code), { ...options(b), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(p); let stderr = ''; p.stderr.on('data', c => { stderr += c; });
  const until = Date.now() + 10000;
  while (!fs.existsSync(join(b.home, 'ready.json'))) {
    if (p.exitCode !== null || Date.now() > until) throw new Error('holder startup failed: ' + stderr);
    await sleep(10);
  }
  const info = JSON.parse(fs.readFileSync(join(b.home, 'ready.json'), 'utf8'));
  // The sandbox's local PID is not the signal target. Resolve it from the host, using its namespace and NSpid.
  let hostPid = p.pid;
  if (sandbox) {
    hostPid = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)).map(p => {
      try { return fs.readlinkSync(`/proc/${p}/ns/pid`) === info.namespace && Number(fs.readFileSync(`/proc/${p}/status`, 'utf8').match(/^NSpid:\s+(.+)$/m)[1].trim().split(/\s+/).at(-1)) === info.pid ? Number(p) : null; } catch { return null; }
    }).find(Boolean);
    assert.ok(hostPid, 'host could not find sandbox holder');
  }
  // Keep the dead namespace allocated until its recovery check, so a fresh reader cannot reuse its inode.
  if (sandbox) namespaceFds.add(fs.openSync(`/proc/${hostPid}/ns/pid`, 'r'));
  p.holderHostPid = hostPid;
  return { p, hostPid, info };
}
async function stop(holder) {
  const done = holder.p.exitCode === null ? once(holder.p, 'exit') : Promise.resolve();
  try { process.kill(holder.hostPid, 'SIGKILL'); } catch {}
  await done; children.delete(holder.p);
  for (let i = 0; i < 100 && fs.existsSync(`/proc/${holder.hostPid}`); i++) await sleep(10);
}
function unlock(b, sandbox) {
  const a = ['--import', join(root, 'test/helpers/budget-owner-terminal.mjs'), join(root, 'budget/cli.mjs'), 'unlock', '--rail', 'solana', '--op', 'paid-op', '--confirm'];
  const inside = ['sandbox', '-c', 'sandbox_mode="workspace-write"', '--', 'sh', '-c', `"$1" -e 'require("node:fs").writeFileSync(process.argv[1], require("node:fs").readlinkSync("/proc/self/ns/pid"))' ${JSON.stringify(join(b.home, 'reader-namespace'))}; printf "paid-op\\n" | "$@"`, 'sh', process.execPath, ...a];
  return spawnSync(sandbox ? codex : process.execPath, sandbox ? inside : a, { ...options(b), input: 'paid-op\n', timeout: 15000 });
}
function bytes(b) { return fs.readdirSync(b.dir).sort().map(f => [f, fs.readFileSync(join(b.dir, f), 'utf8')]); }
try {
  if (!coreOnly && !approvalOnly) for (const nestedHolder of [false, true]) {
    const b = box(), holder = await hold(b, nestedHolder);
    const original = bytes(b);
    for (const nestedReader of [false, true]) {
      const u = unlock(b, nestedReader); assert.equal(u.status, 5, u.stderr + u.stdout);
      assert.deepEqual(bytes(b), original); assert.ok(!u.stderr.includes('overriding unverifiable lock')); cases++;
    }
    await stop(holder);
    const nested = unlock(b, true);
    const readerNamespace = fs.readFileSync(join(b.home, 'reader-namespace'), 'utf8');
    assert.ok(readerNamespace, nested.stderr + nested.stdout);
    if (nestedHolder) assert.notEqual(readerNamespace, holder.info.namespace, 'pinned namespace inode was reused');
    assert.equal(nested.status, 5, nested.stderr + nested.stdout);
    assert.deepEqual(bytes(b), original);
    cases++;
    const host = unlock(b, false); assert.equal(host.status, 0, host.stderr + host.stdout);
    assert.ok(!fs.existsSync(b.path)); assert.equal(fs.readFileSync(join(b.dir, 'paid-op.json'), 'utf8'), original.find(([f])=>f==='paid-op.json')[1]); cases++;
  }
  if (!approvalOnly) for (const nestedHolder of [false, true]) {
    const b = box(), holder = await hold(b, nestedHolder, true);
    const original = fs.readFileSync(b.core, 'utf8');
    const result = run(b, `${coreImport} let acquired = false; try { await withFileLock(${JSON.stringify(b.core)},()=>{acquired=true},100); } catch {} console.log(JSON.stringify({ acquired }));`, !nestedHolder);
    assert.equal(result.acquired, false); assert.equal(fs.readFileSync(b.core, 'utf8'), original); cases++;
    await stop(holder);
    assert.equal(run(b, `${coreImport} await withFileLock(${JSON.stringify(b.core)},()=>{}); console.log('true');`), true); cases++;
  }
  if (!coreOnly && !approvalOnly) {
    const b = box(), holder = await hold(b);
    const values = run(b, `${coreImport} const { sameProcess, groupAlive } = await import(${JSON.stringify(join(root, 'budget/procs.mjs'))}); const { alive, processesAlive } = await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))}); const r=${JSON.stringify(holder.info)}; console.log(JSON.stringify([sameProcess(r.pid,r.pidStart),alive(r.pid,r.pidStart),groupAlive(r.pid,r.pidStart),processesAlive(r),processRunning({...r,start:r.pidStart})]));`, true);
    assert.deepEqual(values, [true,true,true,true,true]); cases++; await stop(holder);
  }
  if (!coreOnly) {
    const b = box(), holder = await hold(b, false, true, true);
    try {
      const id = fs.readFileSync(join(b.home, 'approval-id'), 'utf8');
      const originalApproval = run(b, `const { readApproval } = await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))}); console.log(JSON.stringify(readApproval(${JSON.stringify(id)})));`);
      const originalLock = fs.readFileSync(b.core, 'utf8');
      const result = run(b, `${coreImport}
        const { waitFor, readApproval } = await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});
        const waited = await waitFor(${JSON.stringify(id)}, 0);
        let acquired = false, guidance = '';
        try { await withFileLock(${JSON.stringify(b.core)}, () => { acquired = true; }, 100); } catch (err) { guidance = err.message; }
        console.log(JSON.stringify({ final: waited.final, orphaned: waited.orphaned, record: readApproval(${JSON.stringify(id)}), acquired, guidance }));`, true);
      assert.equal(result.final, false, 'sandbox abandoned a live host approval');
      assert.equal(result.orphaned, false);
      assert.deepEqual(result.record, originalApproval, 'wait changed the approval'); cases++;
      assert.equal(result.acquired, false); assert.match(result.guidance, /outside the sandbox/);
      assert.equal(fs.readFileSync(b.core, 'utf8'), originalLock); cases++;
    } finally { await stop(holder); }
  }
  if (!coreOnly && !approvalOnly) {
    const b = box();
    const result = run(b, `${imports} const { spawn } = await import('node:child_process'); const a=lockOp(${JSON.stringify(b.dir)},'paid-op'); const c=spawn('sleep',['0.2']); a.holdAlso(c); await new Promise(r=>c.once('exit',r)); a.release(); console.log(JSON.stringify(fs.existsSync(${JSON.stringify(b.path)})));`, true);
    assert.equal(result, false); cases++;
  }
  console.log(JSON.stringify({ result: 'pass', cases, realCodexSandbox: true, payments: 0 }));
} finally {
  for (const p of children) { try { process.kill(-(p.pid), 'SIGKILL'); } catch {} try { process.kill(p.holderHostPid ?? p.pid, 'SIGKILL'); } catch {} }
  for (const fd of namespaceFds) fs.closeSync(fd);
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
}
