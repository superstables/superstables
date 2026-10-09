import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(process.env.BUDGET_RACE_ROOT ?? join(import.meta.dirname, '../..'));
const { createIdentitySource, inspectProcess } = await import(join(root, 'src/core/process-identity.mjs'));
const epoch = Date.UTC(2026, 9, 7, 1);
const host = '11111111-2222-3333-4444-555555555555';
const boot = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const owner = { platform: 'darwin', pid: 44, hostId: host, bootId: null, pidStart: null, pidStartUtc: null, bootElapsedMs: null, selfStartedAt: epoch + 1100 };
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function source(ps: string = 'ok', platform = 'darwin') {
  return createIdentitySource({ platform, probe: () => true, bootElapsed: () => 1000,
    run: (cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      if (cmd === 'ioreg') return `"IOPlatformUUID" = "${host}"`;
      if (cmd === 'sysctl') return boot;
      expect(cmd).toBe('ps'); expect(args).toEqual(['-o', 'lstart=', '-p', expect.any(String)]);
      if (options.env?.TZ === 'UTC0') expect(options.env.LC_ALL).toBe('C');
      if (ps === 'fail') throw Object.assign(Error('denied'), { status: 2 });
      if (ps === 'missing') return '';
      return 'Wed Oct  7 01:00:00 2026';
    },
  });
}
for (const delta of [0, 0.001, 500, 1100, 2999.999]) {
  it(`host verifies sandbox holder at +${delta} ms`, () => expect(inspectProcess({ ...owner, selfStartedAt: epoch + delta }, source())).toEqual({ state: 'alive' }));
}
for (const value of [epoch - 0.001, epoch + 3000, epoch + 60_000, undefined, null, 'garbage', String(epoch), NaN, Infinity, -1]) {
  it(`invalid or outside-window startup ${value} preserves the old result`, () => {
    const legacy = { ...owner, selfStartedAt: undefined };
    expect(inspectProcess({ ...owner, selfStartedAt: value }, source())).toEqual(inspectProcess(legacy, source()));
  });
}
for (const ps of ['missing', 'fail']) it(`${ps} ps preserves the old result`, () => {
  expect(inspectProcess(owner, source(ps))).toEqual(inspectProcess({ ...owner, selfStartedAt: undefined }, source(ps)));
});
for (const change of [{ pid: undefined }, { pid: 0 }, { hostId: null }, { hostId: 'foreign' }, { platform: 'linux' }, { platform: undefined }, { bootId: '11111111-2222-3333-4444-555555555555' }]) {
  it(`location gates preserve the old result ${JSON.stringify(change)}`, () => {
    expect(inspectProcess({ ...owner, ...change }, source())).toEqual(inspectProcess({ ...owner, ...change, selfStartedAt: undefined }, source()));
  });
}
it('Linux ignores the startup field', () => {
  const linux = createIdentitySource();
  const record = { ...linux.record(), pid: 2147483646 };
  expect(inspectProcess({ ...record, selfStartedAt: epoch }, linux)).toEqual(inspectProcess(record, linux));
  expect(linux.record()).not.toHaveProperty('selfStartedAt');
});
function box(target: string, field: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'budget-macos-liveness-')); homes.push(home);
  const approvals = join(home, 'budget/approvals'), records = join(home, 'records'), ops = join(home, 'budget/ops/solana-devnet');
  for (const dir of [approvals, records, ops]) mkdirSync(dir, { recursive: true });
  const id = 'oa-20261007010000-01234567', record = { ...owner, selfStartedAt: field, id };
  writeFileSync(join(ops, 'paid-op.json'), '{"state":"submitted","transaction":"retained"}');
  writeFileSync(join(records, 'attempts.jsonl'), JSON.stringify({ id: 'att-1', state: 'submitting', transaction: 'retained', runner: { ...record, start: null } }) + '\n');
  writeFileSync(join(approvals, `${id}.json`), JSON.stringify({ ...record, command: 'grant', rail: 'solana', chain: 'devnet', state: 'running' }));
  const path = target === 'op' ? join(ops, 'paid-op.buy.lock') : target === 'cap' ? join(records, 'cap.lock') : target === 'attempt' ? null : join(approvals, target === 'approval' ? `${id}.json.lock` : target === 'buy-once' ? 'active-once-purchase' : 'active-solana-devnet');
  if (path) writeFileSync(path, JSON.stringify(record));
  const args = target === 'op' ? ['--rail', 'solana', '--op', 'paid-op'] : target === 'attempt' ? ['--attempt', 'att-1'] : target === 'approval' ? ['--rail', 'solana', '--approval', id] : target === 'approvals' ? ['--rail', 'solana', '--approvals'] : [`--${target}`];
  return { home, path, args, token: target === 'op' ? 'paid-op' : 'payment-lock', dirs: [approvals, records, ops] };
}
function bytes(dirs: string[]) {
  return dirs.flatMap(dir => readdirSync(dir).map(file => [join(dir, file), readFileSync(join(dir, file), 'utf8')]));
}
const preload = join(root, 'test/helpers/budget-darwin-live-identity.mjs');
for (const target of ['op', 'cap', 'approvals', 'approval', 'attempt', 'buy-once']) {
  for (const unverified of [false, true]) it(`${target} refuses live sandbox holder with${unverified ? '' : 'out'} override and changes no bytes`, () => {
    const b = box(target, epoch + 1100), before = bytes(b.dirs);
    const result = spawnSync(process.execPath, ['--import', preload, '--import', join(root, 'test/helpers/budget-owner-terminal.mjs'), join(root, 'budget/cli.mjs'), 'unlock', ...b.args, '--confirm', ...(unverified ? ['--unverified'] : [])], {
      env: { ...process.env, SUPERSTABLES_HOME: b.home }, input: `${b.token}${unverified ? ' unverified' : ''}\n`, encoding: 'utf8', timeout: 20_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(5);
    expect(result.stdout).toContain('"reason":"op_in_progress"');
    expect(result.stderr).not.toContain('Clearing the payment lock without proof');
    expect(result.stderr).not.toContain('Clearing the lock for operation');
    expect(bytes(b.dirs)).toEqual(before);
  });
  for (const [field, ps] of [[epoch + 3000, 'ok'], [undefined, 'ok'], ['garbage', 'ok'], [epoch + 1100, 'fail'], [epoch + 1100, 'missing']] satisfies [unknown, string][]) {
    it(`${target} preserves override recovery for ${field}, ps ${ps}`, () => {
      const b = box(target, field);
      const run = (unverified: boolean) => spawnSync(process.execPath, ['--import', preload, '--import', join(root, 'test/helpers/budget-owner-terminal.mjs'), join(root, 'budget/cli.mjs'), 'unlock', ...b.args, '--confirm', ...(unverified ? ['--unverified'] : [])], { env: { ...process.env, SUPERSTABLES_HOME: b.home, LIVENESS_PS: ps }, input: `${b.token}${unverified ? ' unverified' : ''}\n`, encoding: 'utf8', timeout: 20_000 });
      const before = bytes(b.dirs), plain = run(false);
      expect(plain.status, plain.stdout + plain.stderr).toBe(5); expect(bytes(b.dirs)).toEqual(before);
      const override = run(true); expect(override.status, override.stdout + override.stderr).toBe(0);
    });
  }
}
it('existing macOS death proofs take precedence over a matching self start', () => {
  expect(inspectProcess({ ...owner, bootId: boot, pidStartUtc: epoch / 1000 - 10 }, source())).toEqual({ state: 'dead' });
  expect(inspectProcess({ ...owner, bootId: boot }, { ...source(), probe: () => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); } })).toEqual({ state: 'dead' });
});
for (const target of ['op', 'cap', 'approvals', 'approval', 'attempt', 'buy-once']) {
  it(`${target} automatic contenders stay busy and preserve bytes`, () => {
    const b = box(target, epoch + 1100), before = bytes(b.dirs);
    const code = `import assert from 'node:assert/strict';const a=await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});const {lockFile}=await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))});const {withFileLock,processRunning}=await import(${JSON.stringify(join(root, 'src/core/lock.ts'))});
      ${target === 'op' ? `const l=lockFile(${JSON.stringify(b.path)});assert.equal(l.ok,false);assert.equal(l.possiblyAlive,false);`
        : target === 'cap' ? `await assert.rejects(withFileLock(${JSON.stringify(b.path)},()=>{throw Error('acquired')},0),/held by process/);`
        : target === 'attempt' ? `assert.equal(processRunning(${JSON.stringify({ ...owner, start: null })}),true);`
        : target === 'approval' ? `const l=a.claim('solana','devnet','oa-20261007010000-99999999');assert.equal(l.ok,false);`
        : target === 'approvals' ? `assert.equal(a.claim('solana','devnet','oa-20261007010000-99999999').ok,false);`
        : `const once=await import(${JSON.stringify(join(root, 'budget/once.mjs'))});let called=false;const r=await once.startOnce({fetchImpl:()=>{called=true;throw Error('unexpected fetch')}});assert.equal(r.code,3);assert.equal(called,false);`}`;
    if (target === 'approval') writeFileSync(join(b.home, 'budget/approvals/active-solana-devnet'), JSON.stringify({ ...owner, id: 'oa-20261007010000-01234567' }));
    const expected = target === 'approval' ? bytes(b.dirs) : before;
    const r = spawnSync(process.execPath, ['--import', preload, '--import', join(root, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', code], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, encoding: 'utf8', timeout: 20_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0); expect(bytes(b.dirs)).toEqual(expected);
  });
}
it('every own-process writer records Node timeOrigin in a denied macOS sandbox', () => {
  const b = box('op', undefined);
  const code = `import assert from 'node:assert/strict';import{performance}from'node:perf_hooks';import{readFileSync}from'node:fs';const {lockFile}=await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))});const a=await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});const {withFileLock,thisProcess}=await import(${JSON.stringify(join(root, 'src/core/lock.ts'))});const check=r=>{assert.equal(r.platform,'darwin');assert.equal(r.selfStartedAt,performance.timeOrigin);assert.equal(r.pidStart??r.start??null,null);assert.equal(r.bootId,null)};const l=lockFile(${JSON.stringify(join(b.home, 'own.lock'))});assert.equal(l.ok,true);check(JSON.parse(readFileSync(${JSON.stringify(join(b.home, 'own.lock'))},'utf8')));l.holdAlso(process.pid);const rail=JSON.parse(readFileSync(${JSON.stringify(join(b.home, 'own.lock'))},'utf8'));assert.equal(rail.railSelfStartedAt,performance.timeOrigin);l.release();await withFileLock(${JSON.stringify(join(b.home, 'own-cap.lock'))},()=>check(JSON.parse(readFileSync(${JSON.stringify(join(b.home, 'own-cap.lock'))},'utf8'))));check(thisProcess());a.startForeground({id:'oa-20261007010000-99999999',rail:'evm',chain:'base-sepolia',command:'grant'});check(a.readApproval('oa-20261007010000-99999999'));a.setRailGroup('oa-20261007010000-99999999',process.pid);assert.equal(a.readApproval('oa-20261007010000-99999999').railSelfStartedAt,performance.timeOrigin);assert.equal(a.claim('once','purchase','oa-20261007010000-99999999').ok,true);check(JSON.parse(readFileSync(${JSON.stringify(join(b.home, 'budget/approvals/active-once-purchase'))},'utf8')));a.release('once','purchase','oa-20261007010000-99999999');`;
  const r = spawnSync(process.execPath, ['--import', preload, '--import', join(root, 'test/helpers/budget-blocked-identity.mjs'), '--import', join(root, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', code], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, encoding: 'utf8', timeout: 20_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
});
it('rail children publish their own timeOrigin over the private pipe', () => {
  const b = box('op', undefined);
  const childCode = `import{performance}from'node:perf_hooks';console.log(performance.timeOrigin);setInterval(()=>{},1000);`;
  const code = `import assert from 'node:assert/strict';import{once}from'node:events';import{readFileSync}from'node:fs';const {spawnIdentified,childStartedAt}=await import(${JSON.stringify(join(root, 'budget/child-identity.mjs'))});const {lockFile}=await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))});const {stopHolder}=await import(${JSON.stringify(join(root, 'test/helpers/budget-holder-cleanup.mjs'))});const {performance}=await import('node:perf_hooks');const l=lockFile(${JSON.stringify(join(b.home, 'child.lock'))});assert.equal(l.ok,true);const child=spawnIdentified(process.execPath,['--input-type=module','-e',${JSON.stringify(childCode)}],{env:process.env,stdio:['ignore','pipe','pipe']});try{l.holdAlso(child);const [out]=await once(child.stdout,'data');if(!childStartedAt(child))await once(child,'identity');const rec=JSON.parse(readFileSync(${JSON.stringify(join(b.home, 'child.lock'))},'utf8'));assert.equal(rec.railSelfStartedAt,Number(String(out).trim()));assert.notEqual(rec.railSelfStartedAt,performance.timeOrigin);assert.equal(rec.railPid,child.pid);}finally{await stopHolder(child,child.pid);l.release();}`;
  const r = spawnSync(process.execPath, ['--import', preload, '--import', join(root, 'test/helpers/budget-blocked-identity.mjs'), '--input-type=module', '-e', code], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, encoding: 'utf8', timeout: 20_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
});
it('approval mutex and rail group use the existing verified busy paths', () => {
  const b = box('approval', epoch + 1100), before = bytes(b.dirs), id = 'oa-20261007010000-01234567';
  const code = `import assert from 'node:assert/strict';const a=await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});a.recordLockOptions.timeoutMs=0;assert.throws(()=>a.updateApproval(${JSON.stringify(id)},()=>({state:'changed'})),/held by process/);assert.equal(a.processesAlive({platform:'darwin',hostId:${JSON.stringify(host)},bootId:null,pid:null,railPgid:44,railPgidStart:null,railPgidStartUtc:null,railSelfStartedAt:${epoch + 1100}}),true);`;
  const r = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', code], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, encoding: 'utf8', timeout: 20_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0); expect(bytes(b.dirs)).toEqual(before);
});
it('detached workers replace parent observations with their own startup time', () => {
  const b = box('op', undefined), id = 'oa-20261007010000-99999999';
  const worker = `const a=await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});const{performance}=await import('node:perf_hooks');a.adoptWorker(${JSON.stringify(id)});a.updateApproval(${JSON.stringify(id)},()=>({url:'http://127.0.0.1/fixture',observedOrigin:performance.timeOrigin}));setInterval(()=>{},1000);`;
  const code = `import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{setTimeout as sleep}from'node:timers/promises';const a=await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});try{const r=await a.startDetached({id:${JSON.stringify(id)},command:'grant',rail:'evm',chain:'base-sepolia',cmd:process.execPath,args:['--import',${JSON.stringify(preload)},'--import',${JSON.stringify(join(root, 'test/helpers/budget-blocked-identity.mjs'))},'--input-type=module','-e',${JSON.stringify(worker)}],cwd:process.cwd(),linkWaitMs:5000});assert.equal(r.kind,'waiting');const saved=a.readApproval(${JSON.stringify(id)});assert.equal(saved.selfStartedAt,saved.observedOrigin);assert.equal(saved.pidStart,null);assert.equal(saved.bootId,null);}finally{const r=a.readApproval(${JSON.stringify(id)});if(r?.pid){try{process.kill(-r.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e;}for(let i=0;i<500;i++){try{process.kill(r.pid,0)}catch(e){if(e.code==='ESRCH')break;throw e;}await sleep(10);}assert.throws(()=>process.kill(r.pid,0),e=>e.code==='ESRCH');}}`;
  const r = spawnSync(process.execPath, ['--import', preload, '--import', join(root, 'test/helpers/budget-blocked-identity.mjs'), '--input-type=module', '-e', code], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, encoding: 'utf8', timeout: 20_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
});
it('a child cannot run its rail script when startup publication loses the parent pipe', () => {
  const b = box('op', undefined);
  const code = `import assert from 'node:assert/strict';import{once}from'node:events';const {spawnIdentified}=await import(${JSON.stringify(join(root, 'budget/child-identity.mjs'))});const child=spawnIdentified(process.execPath,['--input-type=module','-e','console.log("ran")'],{env:process.env,stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',d=>out+=d);const closed=once(child,'close');child.stdio[3].removeAllListeners('data');child.stdio[3].destroy();const [code]=await closed;assert.notEqual(code,0);assert.equal(out,'');`;
  const r = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', code], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, encoding: 'utf8', timeout: 20_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
});
for (const target of ['op', 'approvals', 'approval']) it(`${target} protects a live rail child after its dispatcher is gone`, () => {
  const b = box(target, undefined), id = 'oa-20261007010000-01234567';
  const rail = { ...owner, selfStartedAt: undefined, pid: 2147483646, id, railPid: 44, railPgid: 44, railPidStart: null, railPgidStart: null, railPidStartUtc: null, railPgidStartUtc: null, railSelfStartedAt: epoch + 1100 };
  if (b.path) writeFileSync(b.path, JSON.stringify(rail));
  writeFileSync(join(b.home, `budget/approvals/${id}.json`), JSON.stringify({ ...rail, command: 'grant', rail: 'solana', chain: 'devnet' }));
  const before = bytes(b.dirs);
  const r = spawnSync(process.execPath, ['--import', preload, '--import', join(root, 'test/helpers/budget-owner-terminal.mjs'), join(root, 'budget/cli.mjs'), 'unlock', ...b.args, '--confirm', '--unverified'], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, input: `${b.token} unverified\n`, encoding: 'utf8', timeout: 20_000 });
  expect(r.status, r.stdout + r.stderr).toBe(5); expect(bytes(b.dirs)).toEqual(before);
});
