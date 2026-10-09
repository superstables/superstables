import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertNoMatchingProcesses, matchingProcesses, nativeExecutable, stopMatchingProcesses } from './budget-native-cleanup.mjs';

test('teardown removes a launcher, its caller and a detached worker, and closes inherited pipes', async () => {
  const marker = mkdtempSync(join(tmpdir(), 'superstables-native-cleanup-'));
  const caller = `const {spawn}=require('node:child_process');const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)',${JSON.stringify(marker)}],{detached:true,stdio:'inherit'});worker.unref();console.log('ready');setInterval(()=>{},1000);`;
  const launcher = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(caller)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', launcher], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  try {
    await once(child.stdout, 'data');
    assert.equal(matchingProcesses(marker).length, 3);
    assert.throws(() => assertNoMatchingProcesses(marker), /processes outlived fixture/);
    await stopMatchingProcesses(marker);
    await closed;
    assertNoMatchingProcesses(marker);
    await stopMatchingProcesses(marker);
  } finally {
    await stopMatchingProcesses(marker);
    rmSync(marker, { recursive: true, force: true });
  }
});

test('Codex launcher scripts are refused and native binaries accepted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superstables-native-executable-'));
  try {
    const script = join(dir, 'codex');
    writeFileSync(script, '#!/usr/bin/env node\n', { mode: 0o700 });
    assert.throws(() => nativeExecutable(script), /CODEX_BIN is a script launcher.*real vendor/);
    assert.equal(nativeExecutable(process.execPath), process.execPath);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
