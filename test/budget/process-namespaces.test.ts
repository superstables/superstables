import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentitySource, inspectProcess } from '../../src/core/process-identity.mjs';
import { lockFile } from '../../budget/op-lock.mjs';
const boot = 'b0aaaeab-5578-4a8d-bb24-2fa546301f7a';
const initial = 'pid:[4026531836]';
const foreign = 'pid:[4026532600]';
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
function source(namespace: string, entries: string[] = []) {
  return createIdentitySource({ platform: 'linux', host: 'host',
    readlink: (path: string) => path.includes('/self/') || path.includes(`/${process.pid}/`) ? namespace : foreign,
    readFile: (path: string) => path.endsWith('boot_id') ? boot : path.includes('/self/') || path.includes(`/${process.pid}/`) ? `NSpid:\t${process.pid}\n` : 'NSpid:\t7000\t2\nNSpgid:\t7000\t2\n',
    readdir: () => entries, start: () => `linux:${boot}:100`,
    probe: () => { throw Object.assign(new Error('absent in this namespace'), { code: 'ESRCH' }); },
  });
}
const owner = { platform: 'linux', hostname: 'host', bootId: boot, namespace: foreign, pid: 2, pidStart: `linux:${boot}:100` };
it('recognizes a remounted nested proc with just one NSpid entry', () => {
  const nested = createIdentitySource({ platform: 'linux', readlink: () => foreign, readFile: () => 'NSpid:\t2\n' });
  expect(nested.nested()).toBe(true);
  expect(inspectProcess({ ...owner, namespace: initial }, nested)).toMatchObject({ state: 'alive', possiblyAlive: true });
});
it('resolves foreign inner PIDs from the host and protects a matching start', () => {
  const host = source(initial, ['7000']);
  host.probe = () => true;
  expect(inspectProcess(owner, host).state).toBe('alive');
  host.start = () => `linux:${boot}:101`;
  expect(inspectProcess(owner, host).state).toBe('dead');
});
it('proves a foreign holder dead when no process in its namespace remains', () => {
  expect(inspectProcess(owner, source(initial)).state).toBe('dead');
});
it('protects foreign owners when the host scan cannot read a candidate namespace', () => {
  const host = source(initial, ['7000']);
  host.readlink = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  expect(inspectProcess(owner, host)).toMatchObject({ state: 'alive', possiblyAlive: true });
});
for (const kind of ['dispatcher', 'rail child', 'breaker']) {
  it(`refuses automatic and confirmed takeover of an invisible ${kind} even after local ESRCH`, () => {
    const home = mkdtempSync(join(tmpdir(), 'budget-ns-injected-')); homes.push(home);
    const path = join(home, 'op.lock'), target = kind === 'breaker' ? join(path + '.break', 'generation.owner') : path;
    if (kind === 'breaker') mkdirSync(path + '.break');
    const record = kind === 'rail child' ? { ...owner, namespace: initial, pid: 9999, railPid: 2, railPidStart: owner.pidStart } : { ...owner, namespace: initial };
    if (kind === 'breaker') writeFileSync(path, '{');
    writeFileSync(target, JSON.stringify(record));
    const text = readFileSync(target, 'utf8');
    // Both records are outside the nested reader. A local PID probe cannot prove either one's death.
    const nested = source(foreign);
    for (const confirmUnverifiable of [false, true]) {
      const result = lockFile(path, { identitySource: nested, confirmUnverifiable });
      expect(result.ok).toBe(false); expect(readFileSync(target, 'utf8')).toBe(text);
      if (!result.ok && (kind !== 'breaker' || confirmUnverifiable)) expect(result.details).toContain('run unlock on the host');
    }
  });
}

it('recovers a zombie dispatcher only after its rail child also stops', () => {
  const home = mkdtempSync(join(tmpdir(), 'budget-ns-zombie-')); homes.push(home);
  const path = join(home, 'op.lock');
  const host = source(initial); host.probe = () => true;
  host.record();
  const read = host.readFile;
  let childStopped = false;
  host.readFile = (path, encoding) => path === '/proc/42/stat' || (childStopped && path === '/proc/43/stat') ? '42 (dead) Z 1 42 42' : read(path, encoding);
  const text = JSON.stringify({ ...owner, namespace: initial, pid: 42, railPid: 43, railPidStart: owner.pidStart });
  writeFileSync(path, text);
  expect(lockFile(path, { identitySource: host }).ok).toBe(false);
  expect(readFileSync(path, 'utf8')).toBe(text);
  childStopped = true;
  const recovered = lockFile(path, { identitySource: host });
  expect(recovered.ok).toBe(true); if (recovered.ok) recovered.release();
});

it('finds a live legacy holder without a namespace before judging a local PID collision reused', () => {
  const host = source(initial, ['7000']);
  host.start = pid => `linux:${boot}:${pid === 7000 ? 100 : 99}`;
  host.probe = pid => { expect(pid).toBe(7000); return true; };
  const legacy = { pid: 2, pidStart: owner.pidStart };
  expect(inspectProcess(legacy, host)).toMatchObject({ state: 'alive', possiblyAlive: true });
  host.readdir = () => [];
  expect(inspectProcess(legacy, host).state).toBe('dead');
});

it('records the visible host PID and refuses unsafe local checks with an ancestor proc mount', () => {
  const nested = createIdentitySource({ platform: 'linux', host: 'host',
    readlink: () => foreign,
    readFile: path => String(path).endsWith('boot_id') ? boot : `NSpid:\t7000\t${process.pid}\n`,
    start: () => owner.pidStart,
    probe: () => { throw Object.assign(new Error('local PID absent'), { code: 'ESRCH' }); },
  });
  expect(nested.record().hostPid).toBe(7000);
  expect(nested.fields(42).pidStart).toBeNull();
  expect(inspectProcess({ ...owner, namespace: foreign }, nested)).toMatchObject({ state: 'alive', possiblyAlive: true, why: 'process identity is unverifiable from this PID namespace proc view' });
});
