// Native macOS verification in isolated homes and a scratch Codex workspace. No wallets or payments.
// CODEX_BIN=/path/to/codex node test/helpers/budget-native-macos.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { parseDarwinStart } from '../../src/core/process-identity.mjs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeExecutable, assertNoMatchingProcesses, stopMatchingProcesses } from './budget-native-cleanup.mjs';
assert.equal(process.platform, 'darwin', 'run this check on native macOS');
const root = resolve(import.meta.dirname, '../..');
const codex = nativeExecutable(process.env.CODEX_BIN ?? 'codex');
const srt = process.env.SRT_BIN ?? 'srt';
let sandboxKind = 'codex';
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'superstables-native-macos-')));
const srtSettings = join(scratch, 'srt-settings.json');
writeFileSync(srtSettings, JSON.stringify({ network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [scratch], denyWrite: [] } }));
const tsx = join(root, 'node_modules/tsx/dist/loader.mjs');
const terminal = join(root, 'test/helpers/budget-owner-terminal.mjs');
const blocked = join(root, 'test/helpers/budget-blocked-identity.mjs');
const outside = join(homedir(), `sbx-probe-${scratch.split('/').at(-1)}`);
const imports = `const fs=await import('node:fs');const {lockFile}=await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))});const {withFileLock,thisProcess}=await import(${JSON.stringify(join(root, 'src/core/lock.ts'))});const a=await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});`;
const sandboxBin = () => sandboxKind === 'srt' ? srt : codex;
const sandboxArgs = (home, args) => [...(sandboxKind === 'srt' ? ['--settings', srtSettings, '--'] : ['sandbox', '-c', 'sandbox_mode="workspace-write"', '--']), 'env', `SUPERSTABLES_HOME=${home}`, process.execPath, ...args];
function run(home, args, sandbox = false, input) {
  return spawnSync(sandbox ? sandboxBin() : process.execPath, sandbox ? sandboxArgs(home, args) : args, { cwd: scratch, env: { ...process.env, SUPERSTABLES_HOME: home }, encoding: 'utf8', input, timeout: 30_000 });
}
function evalNode(home, text, sandbox = false) {
  const result = run(home, ['--import', tsx, '--input-type=module', '-e', text], sandbox);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}
async function hold(sandbox, partial = false, mode = 'own') {
  const home = mkdtempSync(join(scratch, 'holder-'));
  const dir = join(home, 'budget/ops/solana-devnet'), cap = join(home, 'records/cap.lock');
  mkdirSync(dir, { recursive: true }); mkdirSync(join(home, 'records'));
  writeFileSync(join(dir, 'paid-op.json'), '{"state":"submitted","transaction":"retained-evidence"}');
  const pidFile = join(home, 'pid'), readyFile = join(home, 'ready.json'), railPidFile = join(home, 'rail-pid');
  const railCode = mode === 'rail' ? `
    const {spawnIdentified}=await import(${JSON.stringify(join(root, 'budget/child-identity.mjs'))});
    const {once}=await import('node:events');
    const rail=spawnIdentified(process.execPath,['-e','console.log("ready");setInterval(()=>{},1000)',${JSON.stringify(home)}],{env:process.env,stdio:['ignore','pipe','pipe'],detached:true});
    output.writeFileSync(${JSON.stringify(railPidFile)},String(rail.pid));
    for(const lock of locks)lock.holdAlso(rail);
    a.setRailGroup(id,rail.pid);a.setRailGroup(onceId,rail.pid);
    rail.once('identity',started=>{a.setRailGroup(id,rail.pid,started);a.setRailGroup(onceId,rail.pid,started);});
    const ready=once(rail.stdout,'data'),failed=once(rail,'error').then(([e])=>{throw e;});await Promise.race([ready,failed]);
    ` : '';
  const code = `const output=await import('node:fs');output.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));${imports}
    setInterval(()=>{},1000);const locks=[];for(const suffix of ['buy.lock','json.lock']){const l=lockFile(${JSON.stringify(dir)}+'/paid-op.'+suffix);if(!l.ok)throw Error('busy');locks.push(l);}
    const id=process.env[a.WORKER_ENV]??a.newApprovalId();const claim=a.claim('solana','devnet',id);if(!claim.ok)throw Error('approval busy');if(process.env[a.WORKER_ENV]){const {performance}=await import('node:perf_hooks');if(a.readApproval(id).selfStartedAt!==performance.timeOrigin)throw Error('detached worker pipe did not publish startup time');a.adoptWorker(id);}else a.startForeground({id,command:'grant',rail:'solana',chain:'devnet'});a.updateApproval(id,()=>({deadline:Date.now()-1000,...(process.env[a.WORKER_ENV]?{url:'http://127.0.0.1/fixture'}:{})}));
    const onceId=a.newApprovalId();if(!a.claim('once','purchase',onceId).ok)throw Error('once busy');a.saveApproval({id:onceId,command:'buy-once',rail:'evm',chain:'base-sepolia',state:'waiting_owner',pid:null,createdAt:new Date().toISOString()});
    ${railCode}
    const recordLock=lockFile(${JSON.stringify(home)}+'/budget/approvals/'+id+'.json.lock');if(!recordLock.ok)throw Error('record busy');if(typeof rail!=='undefined')recordLock.holdAlso(rail);
    const attemptLock=lockFile(${JSON.stringify(home)}+'/records/reconcile.lock');if(!attemptLock.ok)throw Error('attempt busy');output.writeFileSync(${JSON.stringify(home)}+'/records/attempts.jsonl',JSON.stringify({id:'att-native',state:'submitting',transaction:'retained-evidence',runner:thisProcess()})+'\\n');
    await withFileLock(${JSON.stringify(cap)},()=>{const ready=JSON.stringify({pid:process.pid,id,onceId,railPid:typeof rail==='undefined'?null:rail.pid});output.writeFileSync(${JSON.stringify(readyFile)}+'.tmp',ready);output.renameSync(${JSON.stringify(readyFile)}+'.tmp',${JSON.stringify(readyFile)});return new Promise(()=>{});});`;
  const holderArgs = [...(partial ? ['--import', blocked] : []), '--import', tsx, '--input-type=module', '-e', code];
  const detachedCode = `${imports}const r=await a.startDetached({id:a.newApprovalId(),command:'grant',rail:'solana',chain:'devnet',cmd:process.execPath,args:${JSON.stringify(holderArgs)},cwd:process.cwd(),linkWaitMs:15000});if(r.kind!=='waiting')throw Error(r.reason);setInterval(()=>{},1000);`;
  const args = mode === 'detached' ? ['--import',tsx,'--input-type=module','-e',detachedCode] : holderArgs;
  const child = spawn(sandbox ? sandboxBin() : process.execPath, sandbox ? sandboxArgs(home, args) : args, { cwd: scratch, env: { ...process.env, SUPERSTABLES_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let error = ''; child.stderr.on('data', data => { error += data; }); child.stdout.resume();
  const until = Date.now() + 30_000;
  while (!existsSync(readyFile)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > until) throw Error('holder startup failed: ' + error);
    await sleep(20);
  }
  const ready = JSON.parse(readFileSync(readyFile, 'utf8'));
  if (partial) assert.equal(JSON.parse(readFileSync(cap, 'utf8')).bootId, null, 'partial sandbox identity was not written');
  return { child, ...ready, mode, home, dir, cap, railPidFile, approval: join(home, `budget/approvals/${ready.id}.json`) };
}
async function stop(holder) {
  await stopMatchingProcesses(holder.home);
}
function unlock(holder, target, sandbox, unverified = false) {
  const token = target.includes('--op') ? 'paid-op' : 'payment-lock';
  return run(holder.home, ['--import', terminal, join(root, 'budget/cli.mjs'), 'unlock', ...target, '--confirm', ...(unverified ? ['--unverified'] : [])], sandbox, `${token}${unverified ? ' unverified' : ''}\n`);
}
const targets = holder => [['--rail', 'solana', '--op', 'paid-op'], ['--cap'], ['--rail', 'solana', '--approvals'], ['--rail', 'solana', '--approval', holder.id], ['--attempt', 'att-native'], ['--buy-once']];
function bytes(holder) {
  return ['paid-op.buy.lock', 'paid-op.json.lock', 'paid-op.json'].map(file => join(holder.dir, file)).concat(holder.cap, holder.approval, join(holder.home, 'budget/approvals/active-solana-devnet'), join(holder.home, `budget/approvals/${holder.id}.json.lock`), join(holder.home, `budget/approvals/${holder.onceId}.json`), join(holder.home, 'budget/approvals/active-once-purchase'), join(holder.home, 'records/reconcile.lock'), join(holder.home, 'records/attempts.jsonl')).map(path => readFileSync(path, 'utf8'));
}
function assertWindows(holder) {
  for (const text of bytes(holder)) {
    let savedRecords;
    try { savedRecords = [JSON.parse(text)]; } catch { savedRecords = text.trim().split('\n').map(line => JSON.parse(line)); }
    for (const saved of savedRecords) {
      const record = saved.runner ?? saved;
      for (const [pid, startedAt, field] of [[record.pid, record.selfStartedAt, 'selfStartedAt'], [record.railPid ?? record.railPgid, record.railSelfStartedAt, 'railSelfStartedAt']]) {
        if (!pid) continue;
        assert.equal(typeof startedAt, 'number', `${field} missing for ${pid}`);
        const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, SUPERSTABLES_HOME: holder.home, LC_ALL: 'C', TZ: 'UTC0' }, timeout: 5000 });
        assert.equal(result.status, 0, result.stderr);
        const start = parseDarwinStart(result.stdout);
        assert.ok(start, result.stdout);
        const psStartMs = Number(start.slice(11)) * 1000, deltaMs = startedAt - psStartMs;
        assert.ok(Number.isFinite(deltaMs) && deltaMs >= 0 && deltaMs < 3000, `${field} outside startup window for ${pid}: ${deltaMs}`);
        console.log(JSON.stringify({ sandbox: sandboxKind, mode: holder.mode, pid, field, selfStartedAt: startedAt, psStartMs, deltaMs, hostPsStart: result.stdout.trim(), windowAsserted: true }));
      }
    }
  }
}
function assertRailOnly(holder) {
  // Operation and approval readers track rails. Cap, attempt and buy-once locks track their own holder.
  const paths = [join(holder.home,'budget/approvals/active-solana-devnet'), join(holder.home,'budget/approvals/active-once-purchase'), join(holder.dir, 'paid-op.buy.lock'), join(holder.dir, 'paid-op.json.lock'), holder.approval, join(holder.home, `budget/approvals/${holder.id}.json.lock`), join(holder.home, `budget/approvals/${holder.onceId}.json`)];
  const originals = paths.map(path => readFileSync(path, 'utf8'));
  try {
    for (let i = 0; i < paths.length; i++) writeFileSync(paths[i], JSON.stringify({ ...JSON.parse(originals[i]), pid: 2147483646, pidStart: null, pidStartUtc: null, selfStartedAt: null }));
    const before = bytes(holder);
    for (const target of targets(holder).filter(target => !target.includes('--cap') && !target.includes('--attempt') && !target.includes('--buy-once'))) {
      for (const unverified of [false, true]) {
        const refused = unlock(holder, target, false, unverified);
        console.log('host unlock vs rail identity alone:', { sandbox: sandboxKind, target, unverified }, refused.status, refused.stdout, refused.stderr);
        assert.equal(refused.status, 5, refused.stdout + refused.stderr);
        assert.deepEqual(bytes(holder), before);
      }
    }
  } finally { for (let i = 0; i < paths.length; i++) writeFileSync(paths[i], originals[i]); }
}
function identity(home, sandbox) {
  return JSON.parse(evalNode(home, `const{execFileSync}=await import('node:child_process');const read=(c,a)=>{try{return execFileSync(c,a,{encoding:'utf8'}).trim();}catch{return null;}};const platform=read('ioreg',['-rd1','-c','IOPlatformExpertDevice'])?.match(/"IOPlatformUUID"\\s*=\\s*"([^"]+)"/)?.[1]?.toLowerCase()??null;console.log(JSON.stringify({platform,boot:read('sysctl',['-n','kern.bootsessionuuid'])?.toLowerCase()??null}));`, sandbox).stdout);
}
function compareIdentities(hostIdentity, sandboxIdentity) {
  // Report which identities were readable on both sides, so a match never implies an unread boot session.
  const compared = [];
  for (const key of ['platform', 'boot']) {
    if (hostIdentity[key] && sandboxIdentity[key]) {
      assert.equal(sandboxIdentity[key], hostIdentity[key], `${key} identity differs inside ${sandboxKind}`);
      compared.push(key);
    }
  }
  return { compared, match: compared.length ? true : 'unreadable' };
}
async function recover(holder, native = false) {
  const journal = readFileSync(join(holder.dir, 'paid-op.json'), 'utf8'), approval = readFileSync(holder.approval, 'utf8'), purchase = readFileSync(join(holder.home, `budget/approvals/${holder.onceId}.json`), 'utf8');
  const record = JSON.parse(readFileSync(holder.cap, 'utf8')), hostIdentity = identity(holder.home, false);
  const bootReadable = Boolean(record.bootId);
  const locationVerified = Boolean(record.bootId && record.hostId && record.bootId === hostIdentity.boot && record.hostId === hostIdentity.platform);
  await stop(holder);
  for (const target of targets(holder)) {
    let result = unlock(holder, target, false);
    console.log('plain dead sandbox recovery:', sandboxKind, { native, bootReadable, locationVerified, target, status: result.status }, result.stdout, result.stderr);
    if (native && locationVerified) assert.equal(result.status, 0, 'readable native holder must permit plain recovery: ' + result.stdout + result.stderr);
    if (result.status === 0) deadRecovery.byPlainUnlock++;
    if (result.status === 5) {
      deadRecovery.byOwnerOverride++;
      result = unlock(holder, target, false, true);
      console.log('explicit owner recovery:', result.status, result.stdout, result.stderr);
    }
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  for (const path of [holder.cap, join(holder.dir, 'paid-op.buy.lock'), join(holder.dir, 'paid-op.json.lock'), join(holder.home, 'budget/approvals/active-solana-devnet'), join(holder.home, 'budget/approvals/active-once-purchase'), join(holder.home, `budget/approvals/${holder.id}.json.lock`), join(holder.home, 'records/reconcile.lock')]) assert.equal(existsSync(path), false);
  assert.equal(readFileSync(join(holder.dir, 'paid-op.json'), 'utf8'), journal); assert.equal(readFileSync(holder.approval, 'utf8'), approval); assert.equal(readFileSync(join(holder.home, `budget/approvals/${holder.onceId}.json`), 'utf8'), purchase);const rows=readFileSync(join(holder.home,'records/attempts.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.at(-1).transaction,'retained-evidence');assert.equal(rows.at(-1).runner,undefined);
}
let deadRecovery;
const sandboxes = ['codex'];
const srtProbe = spawnSync(srt, ['--help'], { cwd: scratch, env: { ...process.env, SUPERSTABLES_HOME: scratch }, encoding: 'utf8', timeout: 5000 });
if (srtProbe.error?.code === 'ENOENT') console.log('SKIP srt: executable is missing; native srt verification was not run.');
else sandboxes.push('srt');
try {
  for (const kind of sandboxes) {
    sandboxKind = kind;
    deadRecovery = { byPlainUnlock: 0, byOwnerOverride: 0 };
    const host = await hold(false);
    assertWindows(host);
    const hostIdentity = identity(host.home, false), sandboxIdentity = identity(host.home, true);
    const identityComparison = compareIdentities(hostIdentity, sandboxIdentity);
    console.log(JSON.stringify({ sandbox: sandboxKind, hostIdentity, sandboxIdentity, identityComparison, bootSessionUUIDReadable: Boolean(sandboxIdentity.boot) }));
    const bootClock = evalNode(host.home, `${imports}const os=await import('node:os');let bootClockReadable=true;try{os.uptime();}catch{bootClockReadable=false;}const path=${JSON.stringify(join(scratch, 'clock.buy.lock'))};const l=lockFile(path);if(!l.ok)throw Error('boot-clock lockFile refused');const record=JSON.parse(fs.readFileSync(path,'utf8'));if(!bootClockReadable&&Number.isFinite(record.bootElapsedMs))throw Error('denied boot clock was recorded as readable');l.release();if(fs.existsSync(path))throw Error('boot-clock lockFile release failed');console.log(JSON.stringify({sandbox:${JSON.stringify(sandboxKind)},bootClockReadable,bootElapsedMs:record.bootElapsedMs??null,lockFile:true,released:true}));`, true);
    console.log('native sandbox boot clock:', bootClock.stdout);
    const primitives = evalNode(host.home, `const fs=await import('node:fs');let denied=false;try{fs.writeFileSync(${JSON.stringify(outside)},'probe',{flag:'wx'});}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e;denied=true;console.log('outside workspace write:',e.code);}if(!denied)throw Error('sandbox write restriction inactive');const{execFileSync}=await import('node:child_process');try{console.log('ps',execFileSync('ps',['-o','lstart=','-p','${host.pid}'],{encoding:'utf8'}));}catch(e){console.log('ps unreadable',e.status??e.code);}for(const pid of [${host.pid},-${host.pid}]){try{process.kill(pid,0);console.log(pid,'ok');}catch(e){if(e.code!=='EPERM')throw e;console.log(pid,e.code);}}`, true);
    console.log(primitives.stdout);
    const before = bytes(host);
    for (const target of targets(host)) {
      const refused = unlock(host, target, true);
      console.log('sandbox unlock vs live host:', target, refused.status, refused.stdout, refused.stderr); assert.equal(refused.status, 5);
    }
    const cap = evalNode(host.home, `${imports}let acquired=false;try{await withFileLock(${JSON.stringify(host.cap)},()=>{acquired=true},5000);}catch(e){console.log(e.message);}if(acquired)throw Error('sandbox stole live host cap');`, true);
    console.log(cap.stdout);
    const waited = evalNode(host.home, `${imports}const w=await a.waitFor(${JSON.stringify(host.id)},0);if(w.final||w.orphaned)throw Error('sandbox abandoned a live host worker past its deadline');console.log(JSON.stringify({final:w.final,orphaned:w.orphaned}));`, true);
    console.log('sandbox wait past host deadline:', waited.stdout);
    assert.deepEqual(bytes(host), before); process.kill(host.pid, 0);

    const native = await hold(true), nativeBefore = bytes(native);
    console.log('native sandbox own record:', sandboxKind, JSON.parse(readFileSync(native.cap, 'utf8')));
    assertWindows(native);
    for (const target of targets(native)) {
      for (const unverified of [false, true]) {
        const refused = unlock(native, target, false, unverified);
        console.log('host unlock vs live native sandbox holder:', {target,unverified}, refused.status, refused.stdout, refused.stderr);
        assert.equal(refused.status, 5);
        assert.deepEqual(bytes(native), nativeBefore);
      }
    }
    evalNode(native.home, `${imports}const l=lockFile(${JSON.stringify(join(native.dir, 'paid-op.buy.lock'))});if(l.ok){l.release();throw Error('host stole native sandbox operation');}try{await withFileLock(${JSON.stringify(native.cap)},()=>{throw Error('host stole native sandbox cap');},5000);throw Error('unexpected acquisition');}catch(e){if(!e.message.includes('held by process'))throw e;}`);
    assert.deepEqual(bytes(native), nativeBefore); process.kill(native.pid, 0);
    await recover(native, true);

    // Deny identity reads inside the real sandbox to prove the partial-record direction as well.
    const nested = await hold(true, true), nestedBefore = bytes(nested);
    assertWindows(nested);
    for (const target of targets(nested)) {
      for (const unverified of [false,true]) {const refused = unlock(nested, target, false, unverified);
      console.log('host unlock vs live partial sandbox holder:', {target,unverified}, refused.status, refused.stdout, refused.stderr); assert.equal(refused.status, 5);assert.deepEqual(bytes(nested),nestedBefore);}
    }
    evalNode(nested.home, `${imports}const l=lockFile(${JSON.stringify(join(nested.dir, 'paid-op.buy.lock'))});if(l.ok){l.release();throw Error('host stole live sandbox operation');}try{await withFileLock(${JSON.stringify(nested.cap)},()=>{throw Error('host stole live sandbox cap');},5000);throw Error('unexpected acquisition');}catch(e){if(!e.message.includes('held by process'))throw e;}`);
    assert.deepEqual(bytes(nested), nestedBefore); process.kill(nested.pid, 0);
    await recover(nested);
    for (const mode of ['rail', 'detached']) {
      const piped = await hold(true, mode === 'detached', mode), pipedBefore = bytes(piped);
      assertWindows(piped);
      for (const target of targets(piped)) {
        for (const unverified of [false, true]) {
          const refused = unlock(piped, target, false, unverified);
          console.log('host unlock vs live sandbox pipe holder:', { sandbox: sandboxKind, mode, target, unverified }, refused.status, refused.stdout, refused.stderr);
          assert.equal(refused.status, 5, refused.stdout + refused.stderr);
          assert.deepEqual(bytes(piped), pipedBefore);
        }
      }
      if (mode === 'rail') assertRailOnly(piped);
      if (mode === 'detached') {
        // The worker owns its group and has an expired deadline. A host wait must not signal it.
        const waited = evalNode(piped.home, `${imports}const w=await a.waitFor(${JSON.stringify(piped.id)},50);if(w.final||w.orphaned)throw Error('host abandoned live sandbox worker');console.log(JSON.stringify({final:w.final,orphaned:w.orphaned}));`);
        console.log('host wait past sandbox worker deadline:', sandboxKind, waited.stdout);
        assert.deepEqual(bytes(piped), pipedBefore);
        process.kill(piped.pid, 0);
      }
      await recover(piped, true);
    }
    await stop(host);
    assertNoMatchingProcesses(scratch);
    console.log(JSON.stringify({ result: 'pass', sandbox: sandboxKind, nativeMacOS: true, sandboxWriteDenied: true, identityComparison, bootSessionUUIDReadable: Boolean(sandboxIdentity.boot), liveNativeSandboxProtected: true, nativeRecordRecoveryChecked: true, liveHostProtected: true, livePartialSandboxProtected: true, liveApprovalWaitPreserved: true, hostWaitPreserved: true, railPipeProtected: true, detachedWorkerPipeProtected: true, startupWindowsAsserted: true, deadSandboxOperationCapApprovalsRecovered: deadRecovery, holderTeardown: true, payments: 0 }));
  }
} finally {
  await stopMatchingProcesses(scratch);
  assertNoMatchingProcesses(scratch);
  rmSync(outside, { force: true }); rmSync(scratch, { recursive: true, force: true });
}
