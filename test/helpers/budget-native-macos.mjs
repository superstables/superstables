// Native macOS verification in isolated homes and a scratch Codex workspace. No wallets or payments.
// CODEX_BIN=/path/to/codex node test/helpers/budget-native-macos.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { stopHolder } from './budget-holder-cleanup.mjs';
assert.equal(process.platform, 'darwin', 'run this check on native macOS');
const root = resolve(import.meta.dirname, '../..');
const codex = process.env.CODEX_BIN ?? 'codex';
const scratch = mkdtempSync(join(tmpdir(), 'superstables-native-macos-'));
const tsx = join(root, 'node_modules/tsx/dist/loader.mjs');
const terminal = join(root, 'test/helpers/budget-owner-terminal.mjs');
const blocked = join(root, 'test/helpers/budget-blocked-identity.mjs');
const outside = join(homedir(), `sbx-probe-${scratch.split('/').at(-1)}`);
const children = new Map();
const imports = `const fs=await import('node:fs');const {lockFile}=await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))});const {withFileLock}=await import(${JSON.stringify(join(root, 'src/core/lock.ts'))});const a=await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});`;
const sandboxArgs = (home, args) => ['sandbox', '-c', 'sandbox_mode="workspace-write"', '--', 'env', `SUPERSTABLES_HOME=${home}`, process.execPath, ...args];
function run(home, args, sandbox = false, input) {
  return spawnSync(sandbox ? codex : process.execPath, sandbox ? sandboxArgs(home, args) : args, { cwd: scratch, env: { ...process.env, SUPERSTABLES_HOME: home }, encoding: 'utf8', input, timeout: 30_000 });
}
function evalNode(home, text, sandbox = false) {
  const result = run(home, ['--import', tsx, '--input-type=module', '-e', text], sandbox);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}
async function hold(sandbox, partial = false) {
  const home = mkdtempSync(join(scratch, 'holder-'));
  const dir = join(home, 'budget/ops/solana-devnet'), cap = join(home, 'records/cap.lock');
  mkdirSync(dir, { recursive: true }); mkdirSync(join(home, 'records'));
  writeFileSync(join(dir, 'paid-op.json'), '{"state":"submitted","transaction":"retained-evidence"}');
  const pidFile = join(home, 'pid'), readyFile = join(home, 'ready.json');
  const code = `const output=await import('node:fs');output.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));${imports}
    setInterval(()=>{},1000);for(const suffix of ['buy.lock','json.lock']){const l=lockFile(${JSON.stringify(dir)}+'/paid-op.'+suffix);if(!l.ok)throw Error('busy');}
    const id=a.newApprovalId();const claim=a.claim('solana','devnet',id);if(!claim.ok)throw Error('approval busy');a.startForeground({id,command:'grant',rail:'solana',chain:'devnet'});a.updateApproval(id,()=>({deadline:Date.now()-1000}));
    await withFileLock(${JSON.stringify(cap)},()=>{const ready=JSON.stringify({pid:process.pid,id});output.writeFileSync(${JSON.stringify(readyFile)}+'.tmp',ready);output.renameSync(${JSON.stringify(readyFile)}+'.tmp',${JSON.stringify(readyFile)});return new Promise(()=>{});});`;
  const args = [...(partial ? ['--import', blocked] : []), '--import', tsx, '--input-type=module', '-e', code];
  const child = spawn(sandbox ? codex : process.execPath, sandbox ? sandboxArgs(home, args) : args, { cwd: scratch, env: { ...process.env, SUPERSTABLES_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.set(child, pidFile);
  let error = ''; child.stderr.on('data', data => { error += data; }); child.stdout.resume();
  const until = Date.now() + 15_000;
  while (!existsSync(readyFile)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > until) throw Error('holder startup failed: ' + error);
    await sleep(20);
  }
  const ready = JSON.parse(readFileSync(readyFile, 'utf8'));
  if (partial) assert.equal(JSON.parse(readFileSync(cap, 'utf8')).bootId, null, 'partial sandbox identity was not written');
  return { child, ...ready, home, dir, cap, approval: join(home, `budget/approvals/${ready.id}.json`) };
}
async function stop(holder) {
  await stopHolder(holder.child, holder.pid); children.delete(holder.child);
}
function unlock(holder, target, sandbox, unverified = false) {
  const token = target.includes('--op') ? 'paid-op' : 'payment-lock';
  return run(holder.home, ['--import', terminal, join(root, 'budget/cli.mjs'), 'unlock', ...target, '--confirm', ...(unverified ? ['--unverified'] : [])], sandbox, `${token}${unverified ? ' unverified' : ''}\n`);
}
const targets = [['--rail', 'solana', '--op', 'paid-op'], ['--cap'], ['--rail', 'solana', '--approvals']];
function bytes(holder) {
  return ['paid-op.buy.lock', 'paid-op.json.lock', 'paid-op.json'].map(file => join(holder.dir, file)).concat(holder.cap, holder.approval, join(holder.home, 'budget/approvals/active-solana-devnet')).map(path => readFileSync(path, 'utf8'));
}
function identity(home, sandbox) {
  return JSON.parse(evalNode(home, `const{execFileSync}=await import('node:child_process');const read=(c,a)=>{try{return execFileSync(c,a,{encoding:'utf8'}).trim();}catch{return null;}};const platform=read('ioreg',['-rd1','-c','IOPlatformExpertDevice'])?.match(/"IOPlatformUUID"\\s*=\\s*"([^"]+)"/)?.[1]?.toLowerCase()??null;console.log(JSON.stringify({platform,boot:read('sysctl',['-n','kern.bootsessionuuid'])?.toLowerCase()??null}));`, sandbox).stdout);
}
try {
  const host = await hold(false);
  const hostIdentity = identity(host.home, false), sandboxIdentity = identity(host.home, true);
  for (const key of ['platform', 'boot']) {
    if (hostIdentity[key] && sandboxIdentity[key]) assert.equal(sandboxIdentity[key], hostIdentity[key], `${key} identity differs inside the native sandbox`);
  }
  console.log(JSON.stringify({ hostIdentity, sandboxIdentity, readableIdentitiesMatch: true }));
  const primitives = evalNode(host.home, `const fs=await import('node:fs');let denied=false;try{fs.writeFileSync(${JSON.stringify(outside)},'probe',{flag:'wx'});}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e;denied=true;console.log('outside workspace write:',e.code);}if(!denied)throw Error('sandbox write restriction inactive');const{execFileSync}=await import('node:child_process');try{console.log('ps',execFileSync('ps',['-o','lstart=','-p','${host.pid}'],{encoding:'utf8'}));}catch(e){console.log('ps unreadable',e.status??e.code);}for(const pid of [${host.pid},-${host.pid}]){try{process.kill(pid,0);console.log(pid,'ok');}catch(e){if(e.code!=='EPERM')throw e;console.log(pid,e.code);}}`, true);
  console.log(primitives.stdout);
  const before = bytes(host);
  for (const target of targets) {
    const refused = unlock(host, target, true);
    console.log('sandbox unlock vs live host:', target, refused.status, refused.stdout, refused.stderr); assert.equal(refused.status, 5);
  }
  const cap = evalNode(host.home, `${imports}let acquired=false;try{await withFileLock(${JSON.stringify(host.cap)},()=>{acquired=true},5000);}catch(e){console.log(e.message);}if(acquired)throw Error('sandbox stole live host cap');`, true);
  console.log(cap.stdout);
  const waited = evalNode(host.home, `${imports}const w=await a.waitFor(${JSON.stringify(host.id)},0);if(w.final||w.orphaned)throw Error('sandbox abandoned a live host worker past its deadline');console.log(JSON.stringify({final:w.final,orphaned:w.orphaned}));`, true);
  console.log('sandbox wait past host deadline:', waited.stdout);
  assert.deepEqual(bytes(host), before); process.kill(host.pid, 0);

  // Deny identity reads inside the real sandbox to prove the partial-record direction as well.
  const nested = await hold(true, true), nestedBefore = bytes(nested);
  for (const target of targets) {
    const refused = unlock(nested, target, false);
    console.log('host unlock vs live partial sandbox holder:', target, refused.status, refused.stdout, refused.stderr); assert.equal(refused.status, 5);
  }
  evalNode(nested.home, `${imports}const l=lockFile(${JSON.stringify(join(nested.dir, 'paid-op.buy.lock'))});if(l.ok){l.release();throw Error('host stole live sandbox operation');}try{await withFileLock(${JSON.stringify(nested.cap)},()=>{throw Error('host stole live sandbox cap');},5000);throw Error('unexpected acquisition');}catch(e){if(!e.message.includes('held by process'))throw e;}`);
  assert.deepEqual(bytes(nested), nestedBefore); process.kill(nested.pid, 0);
  const journal = readFileSync(join(nested.dir, 'paid-op.json'), 'utf8'), approval = readFileSync(nested.approval, 'utf8');
  await stop(nested);
  for (const target of targets) {
    let result = unlock(nested, target, false);
    console.log('dead sandbox recovery:', target, result.status, result.stdout, result.stderr);
    if (result.status === 5) { result = unlock(nested, target, false, true); console.log('explicit owner recovery:', result.status, result.stdout, result.stderr); }
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  for (const path of [nested.cap, join(nested.dir, 'paid-op.buy.lock'), join(nested.dir, 'paid-op.json.lock'), join(nested.home, 'budget/approvals/active-solana-devnet')]) assert.equal(existsSync(path), false);
  assert.equal(readFileSync(join(nested.dir, 'paid-op.json'), 'utf8'), journal); assert.equal(readFileSync(nested.approval, 'utf8'), approval);
  await stop(host);
  console.log(JSON.stringify({ result: 'pass', nativeMacOS: true, sandboxWriteDenied: true, readableIdentitiesMatch: true, liveHostProtected: true, livePartialSandboxProtected: true, liveApprovalWaitPreserved: true, deadSandboxOperationCapApprovalsRecovered: true, holderTeardown: true, payments: 0 }));
} finally {
  for (const [child, pidFile] of children) {
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : child.pid;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    await stopHolder(child, pid);
  }
  rmSync(outside, { force: true }); rmSync(scratch, { recursive: true, force: true });
}
