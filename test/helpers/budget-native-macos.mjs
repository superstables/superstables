// Native macOS verification, from an isolated scratch workspace. No wallets or payments.
// node --import ./node_modules/tsx/dist/loader.mjs test/helpers/budget-native-macos.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
assert.equal(process.platform, 'darwin', 'run this check on native macOS');
const root = resolve(import.meta.dirname, '../..');
const codex = process.env.CODEX_BIN ?? 'codex';
const scratch = mkdtempSync(join(tmpdir(), 'superstables-native-macos-'));
const tsx = join(root, 'node_modules/tsx/dist/loader.mjs');
const terminal = join(root, 'test/helpers/budget-owner-terminal.mjs');
const outside = join(homedir(), `sbx-probe-${scratch.split('/').at(-1)}`);
const children = new Set();
const holdingPids = new Set();
const imports = `const {lockFile}=await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))});const {withFileLock}=await import(${JSON.stringify(join(root, 'src/core/lock.ts'))});`;
function run(home, args, sandbox = false, input) {
  const command = sandbox ? codex : process.execPath;
  const argv = sandbox ? ['sandbox', '-c', 'sandbox_mode="workspace-write"', '--', 'env', `SUPERSTABLES_HOME=${home}`, process.execPath, ...args] : args;
  return spawnSync(command, argv, { cwd: scratch, env: { ...process.env, SUPERSTABLES_HOME: home }, encoding: 'utf8', input, timeout: 30_000 });
}
function evalNode(home, text, sandbox = false) {
  return run(home, ['--import', tsx, '--input-type=module', '-e', text], sandbox);
}
async function hold(home, sandbox) {
  const dir = join(home, 'budget/ops/solana-devnet'); mkdirSync(dir, { recursive: true }); mkdirSync(join(home, 'records'));
  writeFileSync(join(dir, 'paid-op.json'), '{"state":"submitted","transaction":"retained-evidence"}');
  const code = `${imports}setInterval(()=>{},1000);for(const suffix of ['buy.lock','json.lock']){const l=lockFile(${JSON.stringify(dir)}+'/paid-op.'+suffix);if(!l.ok)throw Error('busy');}await withFileLock(${JSON.stringify(join(home, 'records/cap.lock'))},()=>{console.log(JSON.stringify({pid:process.pid}));return new Promise(()=>{});});`;
  const args = ['--import', tsx, '--input-type=module', '-e', code];
  const child = spawn(sandbox ? codex : process.execPath, sandbox ? ['sandbox', '-c', 'sandbox_mode="workspace-write"', '--', 'env', `SUPERSTABLES_HOME=${home}`, process.execPath, ...args] : args, { cwd: scratch, env: { ...process.env, SUPERSTABLES_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.add(child);
  let output = '', error = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
  for (let i = 0; i < 100 && !output.includes('"pid"'); i++) { if (child.exitCode !== null) throw Error(error); await sleep(100); }
  const pid = JSON.parse(output.trim()).pid; holdingPids.add(pid);
  return { child, pid, dir, home, cap: join(home, 'records/cap.lock') };
}
function unlock(holder, target, sandbox, unverified = false) {
  const answer = target.includes('--op') ? `paid-op${unverified ? ' unverified' : ''}\n` : `payment-lock${unverified ? ' unverified' : ''}\n`;
  return run(holder.home, ['--import', terminal, join(root, 'budget/cli.mjs'), 'unlock', ...target, '--confirm', ...(unverified ? ['--unverified'] : [])], sandbox, answer);
}
try {
  const hostHome = join(scratch, 'host'); mkdirSync(hostHome);
  const host = await hold(hostHome, false);
  const hostUuid = evalNode(hostHome, `console.log((await import('node:child_process')).execFileSync('ioreg',['-rd1','-c','IOPlatformExpertDevice'],{encoding:'utf8'}));`);
  console.log('Host platform UUID:', hostUuid.stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? 'unreadable');
  const primitives = evalNode(hostHome, `const fs=await import('node:fs');let denied=false;try{fs.writeFileSync(${JSON.stringify(outside)},'probe',{flag:'wx'});}catch(e){denied=true;console.log('outside workspace write:',e.code);}if(!denied)throw Error('sandbox write restriction inactive');const{execFileSync}=await import('node:child_process');for(const [c,a]of [['ioreg',['-rd1','-c','IOPlatformExpertDevice']],['sysctl',['-n','kern.bootsessionuuid']],['sysctl',['-n','kern.boottime']],['ps',['-o','lstart=','-p','${host.pid}']]]){try{console.log(c,a.join(' '),execFileSync(c,a,{encoding:'utf8'}));}catch(e){console.log(c,'unreadable',e.status??e.code);}}for(const pid of [${host.pid},-${host.pid}]){try{process.kill(pid,0);console.log(pid,'ok');}catch(e){console.log(pid,e.code);if(e.code==='ESRCH')throw Error('live external PID/group returned ESRCH');}}`, true);
  console.log(primitives.stdout); console.error(primitives.stderr); assert.equal(primitives.status, 0, 'native primitive check failed');
  const files = ['paid-op.buy.lock', 'paid-op.json.lock', 'paid-op.json'].map(file => join(host.dir, file)).concat(host.cap);
  const before = files.map(path => readFileSync(path, 'utf8'));
  const refused = unlock(host, ['--rail', 'solana', '--op', 'paid-op'], true);
  console.log('Sandbox unlock:', refused.status, refused.stdout, refused.stderr); assert.equal(refused.status, 5);
  const cap = evalNode(hostHome, `${imports}let acquired=false;try{await withFileLock(${JSON.stringify(host.cap)},()=>{acquired=true},100);}catch(e){console.log(e.message);}if(acquired)throw Error('sandbox stole live host cap lock');console.log('live host cap lock preserved');`, true);
  console.log(cap.stdout); console.error(cap.stderr); assert.equal(cap.status, 0);
  assert.deepEqual(files.map(path => readFileSync(path, 'utf8')), before);
  process.kill(host.pid, 0);
  const deadHome = join(scratch, 'dead'); mkdirSync(deadHome);
  const dead = await hold(deadHome, true);
  const journal = readFileSync(join(dead.dir, 'paid-op.json'), 'utf8');
  process.kill(dead.pid, 'SIGKILL'); holdingPids.delete(dead.pid);
  if (dead.child.exitCode === null && dead.child.signalCode === null) await once(dead.child, 'exit');
  for (const target of [['--rail', 'solana', '--op', 'paid-op'], ['--cap']]) {
    let result = unlock(dead, target, false);
    console.log('Host dead-holder recovery:', target.join(' '), result.status, result.stdout, result.stderr);
    if (result.status === 5) {
      result = unlock(dead, target, false, true);
      console.log('Host explicit owner recovery:', result.status, result.stdout, result.stderr);
    }
    assert.equal(result.status, 0);
  }
  assert.equal(existsSync(dead.cap), false); assert.equal(existsSync(join(dead.dir, 'paid-op.buy.lock')), false);
  assert.equal(readFileSync(join(dead.dir, 'paid-op.json'), 'utf8'), journal);
  console.log(JSON.stringify({ result: 'pass', nativeMacOS: true, sandboxWriteDenied: true, liveHostUnlockRefused: true, liveHostCapPreserved: true, deadSandboxHolderRecovered: true, payments: 0 }));
} finally {
  for (const pid of holdingPids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
  // The outside probe is a unique scratch file and is removed even if the sandbox was inactive.
  rmSync(outside, { force: true }); rmSync(scratch, { recursive: true, force: true });
}
