import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { processStart } from './procs.mjs';

// Inject the OS reads together so tests can exercise the macOS path on Linux.
export function createIdentitySource({ platform = process.platform, host = hostname(), readFile = readFileSync, readlink = readlinkSync, run = (command, args, options) => execFileSync(command, args, options), start = pid => processStart(pid, platform, run), probe = pid => process.kill(pid, 0) } = {}) {
  let bootId = null, namespace = null;
  if (platform === 'linux') {
    try { bootId = readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch {}
    try { namespace = readlink('/proc/self/ns/pid'); } catch {}
  } else if (platform === 'darwin') {
    try {
      const out = run('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      const match = out.match(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/);
      if (match) bootId = `darwin:${match[1]}:${match[2]}`;
    } catch {}
  }
  return { record: () => ({ platform, hostname: host, bootId, namespace, pid: process.pid, pidStart: start(process.pid) ?? null }), start, probe };
}
