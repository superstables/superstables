import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '../..');
const root = resolve(process.env.BUDGET_RACE_ROOT ?? project);
const preload = join(project, 'test/helpers/budget-darwin-live-identity.mjs');
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'budget-macos-side-effects-'));
  homes.push(dir);
  return dir;
}
function run(dir: string, code: string) {
  return spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', code], {
    env: { ...process.env, SUPERSTABLES_HOME: dir }, encoding: 'utf8', timeout: 30_000,
  });
}
const workerSetup = `import assert from 'node:assert/strict';import{spawn,execFileSync}from'node:child_process';import cp from'node:child_process';import{syncBuiltinESMExports}from'node:module';import{once}from'node:events';import{mkdirSync,writeFileSync,readFileSync}from'node:fs';import{join}from'node:path';const worker=spawn('sleep',['900'],{detached:true,stdio:'ignore'});const stopped=once(worker,'exit');const original=cp.execFileSync;cp.execFileSync=(cmd,args,options)=>{if(cmd==='ps'){try{process.kill(Number(args.at(-1)),0)}catch(e){if(e.code==='ESRCH')throw Object.assign(Error('missing'),{status:1});throw e;}}return original(cmd,args,options);};syncBuiltinESMExports();const a=await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});const record={pid:worker.pid,platform:'darwin',hostId:'11111111-2222-3333-4444-555555555555',bootId:null,pidStart:null,pidStartUtc:null,selfStartedAt:Date.UTC(2026,9,7,1)+1100};`;
const cleanup = `finally{try{process.kill(-worker.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e;}await stopped;}`;
it('host wait past the deadline preserves a live sandbox worker, approval and chain lock', () => {
  const dir = home();
  const r = run(dir, `${workerSetup}try{const id='oa-20261007010000-01234567';const approvals=join(process.env.SUPERSTABLES_HOME,'budget/approvals');mkdirSync(approvals,{recursive:true});const path=join(approvals,id+'.json'),active=join(approvals,'active-solana-devnet');const approval={...record,id,command:'grant',rail:'solana',chain:'devnet',state:'waiting_owner',createdAt:new Date(Date.now()-600000).toISOString(),deadline:Date.now()-1000};writeFileSync(path,JSON.stringify(approval));writeFileSync(active,JSON.stringify({...approval,createdAt:Date.now()-600000}));const before=readFileSync(path,'utf8'),chain=readFileSync(active,'utf8');const result=await a.waitFor(id,50);assert.equal(result.final,false);assert.equal(result.orphaned,false);assert.equal(readFileSync(path,'utf8'),before);assert.equal(readFileSync(active,'utf8'),chain);assert.equal(worker.exitCode,null);assert.equal(worker.signalCode,null);process.kill(worker.pid,0);}${cleanup}`);
  expect(r.status, r.stdout + r.stderr).toBe(0);
});
for (const rail of [false, true]) it(`stopGroup cannot signal a ${rail ? 'rail child' : 'worker'} verified only by its startup window`, () => {
  const dir = home();
  const location = rail ? '{...record,pid:2147483646,selfStartedAt:undefined,railSelfStartedAt:record.selfStartedAt}' : 'record';
  const r = run(dir, `${workerSetup}try{const location=${location};const stopped=await a.stopGroup(worker.pid,{start:null,startUtc:null,location:${rail ? '{...location,selfStartedAt:location.railSelfStartedAt}' : 'location'},graceMs:0});assert.equal(stopped,false);assert.equal(worker.exitCode,null);assert.equal(worker.signalCode,null);process.kill(worker.pid,0);}${cleanup}`);
  expect(r.status, r.stdout + r.stderr).toBe(0);
});
it('stopGroup keeps signalling groups verified by existing host, boot and start proofs', () => {
  const dir = home();
  const r = run(dir, `${workerSetup}try{const verified={...record,bootId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',pidStartUtc:Date.UTC(2026,9,7,1)/1000};assert.equal(await a.stopGroup(worker.pid,{startUtc:verified.pidStartUtc,location:verified,graceMs:0}),true);await stopped;assert.equal(worker.signalCode,'SIGTERM');}${cleanup}`);
  expect(r.status, r.stdout + r.stderr).toBe(0);
});
it('a failed identity listener reaches the error handler and keeps the rail script gated', () => {
  const dir = home();
  const r = run(dir, `import assert from'node:assert/strict';const {spawnIdentified,childStartedAt}=await import(${JSON.stringify(join(root, 'budget/child-identity.mjs'))});const child=spawnIdentified(process.execPath,['-e','console.log("rail script ran")'],{env:process.env,stdio:['ignore','pipe','pipe']});let output='',errors=0;child.stdout.on('data',d=>output+=d);const problem=Error('the lock .../oa-x.json.lock is held by process 123');child.once('identity',()=>{throw problem});child.on('error',e=>{assert.equal(e,problem);errors++;});await new Promise(resolve=>child.once('close',resolve));assert.equal(errors,1);assert.equal(output,'');assert.notEqual(child.exitCode,0);assert.equal(childStartedAt(child),undefined);`);
  expect(r.status, r.stdout + r.stderr).toBe(0);
});
it('the CLI prints its existing error and RESULT when identity publication throws', () => {
  const dir = home(), injection = join(dir, 'identity-listener.mjs');
  writeFileSync(injection, `import cp from'node:child_process';import{syncBuiltinESMExports}from'node:module';const spawn=cp.spawn;cp.spawn=(command,args,options)=>{const child=spawn(process.execPath,['-e','console.log("rail script ran")'],options);child.once('identity',()=>{throw Error('the lock .../oa-x.json.lock is held by process 123');});return child;};syncBuiltinESMExports();`);
  const r = spawnSync(process.execPath, ['--import', preload, '--import', injection, join(root, 'budget/cli.mjs'), 'preflight', '--rail', 'solana', '--url', 'https://example.com'], {
    env: { ...process.env, SUPERSTABLES_HOME: dir }, encoding: 'utf8', timeout: 30_000,
  });
  expect(r.status, r.stdout + r.stderr).toBe(1);
  expect(r.stderr).toContain('could not start');
  expect(r.stderr).toContain('the lock .../oa-x.json.lock is held by process 123');
  expect(r.stderr).not.toContain('rail script ran');
  expect(r.stdout.trim().split('\n')).toHaveLength(1);
  expect(r.stdout).toContain('RESULT ');
  expect(JSON.parse(r.stdout.slice(7))).toMatchObject({ command: 'preflight', state: 'failed', reason: 'the preflight script exited 1 without a RESULT line' });
});
it('replacement cannot signal a sandbox worker or change its approval after its fixture page cancels', () => {
  const dir = home();
  const r = run(dir, `${workerSetup}const {createServer}=await import('node:http');const timers=await import('node:timers/promises');const originalSleep=timers.default.setTimeout;timers.default.setTimeout=(ms,...args)=>originalSleep(ms===100?0:ms,...args);syncBuiltinESMExports();const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({cancelled:true}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{const id='oa-20261007010000-01234567',approvals=join(process.env.SUPERSTABLES_HOME,'budget/approvals');mkdirSync(approvals,{recursive:true});const path=join(approvals,id+'.json'),active=join(approvals,'active-solana-devnet');const saved={...record,id,command:'grant',rail:'solana',chain:'devnet',url:'http://127.0.0.1:'+server.address().port+'/fixture'};writeFileSync(path,JSON.stringify(saved));writeFileSync(active,JSON.stringify(saved));const before=readFileSync(path,'utf8'),chain=readFileSync(active,'utf8');const result=await a.replacePending(saved,'oa-20261007010000-99999999');assert.equal(result.ok,false);assert.equal(readFileSync(path,'utf8'),before);assert.equal(readFileSync(active,'utf8'),chain);assert.equal(worker.signalCode,null);process.kill(worker.pid,0);}finally{server.close();try{process.kill(-worker.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e;}await stopped;}`);
  expect(r.status, r.stdout + r.stderr).toBe(0);
});
it('reconcile releases its operation lock when publishing the rail start time fails', () => {
  const dir = home(), ops = join(dir, 'budget/ops/solana-devnet'), injection = join(dir, 'publication.mjs');
  mkdirSync(ops, { recursive: true });
  writeFileSync(join(ops, 'paid-op.json'), '{"state":"submitted","transaction":"retained"}');
  writeFileSync(injection, `import cp from'node:child_process';import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';const spawn=cp.spawn;cp.spawn=(command,args,options)=>spawn(process.execPath,['-e','console.log("rail script ran");setTimeout(()=>{},300)'],options);const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(String(to).endsWith('.lock')&&typeof JSON.parse(fs.readFileSync(from,'utf8')).railSelfStartedAt==='number')throw Object.assign(Error('publication failed'),{code:'EIO'});return rename(from,to);};syncBuiltinESMExports();`);
  const r = spawnSync(process.execPath, ['--import', preload, '--import', injection, join(root, 'budget/cli.mjs'), 'reconcile', '--rail', 'solana', '--chain', 'devnet', '--op', 'paid-op'], {
    env: { ...process.env, SUPERSTABLES_HOME: dir }, encoding: 'utf8', timeout: 30_000,
  });
  expect(r.status, r.stdout + r.stderr).toBe(5);
  expect(r.stderr).not.toContain('rail script ran');
  expect(JSON.parse(r.stdout.trim().split('\n').at(-1)!.slice(7))).toMatchObject({ command: 'reconcile', state: 'unknown' });
  expect(readdirSync(ops).filter(name => name.includes('.lock'))).toEqual([]);
});
it('failed rail lock publication reaches the child error handler before the script can run', () => {
  const dir = home(), path = join(dir, 'child.lock');
  const r = run(dir, `import assert from'node:assert/strict';import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';const {spawnIdentified}=await import(${JSON.stringify(join(root, 'budget/child-identity.mjs'))});const {lockFile}=await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))});const lock=lockFile(${JSON.stringify(path)});assert.equal(lock.ok,true);const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(to===${JSON.stringify(path)}&&JSON.parse(fs.readFileSync(from,'utf8')).railSelfStartedAt)throw Error('publication failed');return rename(from,to);};syncBuiltinESMExports();const child=spawnIdentified(process.execPath,['-e','console.log("rail script ran")'],{env:process.env,stdio:['ignore','pipe','pipe']});let errors=0,output='',exitedFirst=false;child.on('error',e=>{assert.equal(e.message,'publication failed');exitedFirst=child.exitCode!==null||child.signalCode!==null;errors++;});child.stdout.on('data',d=>output+=d);lock.holdAlso(child);await new Promise(resolve=>child.once('close',resolve));assert.equal(errors,1);assert.equal(exitedFirst,true);assert.equal(output,'');assert.notEqual(child.exitCode,0);lock.release();assert.equal(fs.existsSync(${JSON.stringify(path)}),false);`);
  expect(r.status, r.stdout + r.stderr).toBe(0);
});
