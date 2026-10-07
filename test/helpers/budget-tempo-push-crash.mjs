// Kill the real buyer at its stubbed RPC broadcast, retaining the last fsynced journal.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Challenge } from 'mppx';
import { Transaction } from 'viem/tempo';
const root = process.env.BUDGET_DURABILITY_ROOT;
const home = process.env.SUPERSTABLES_HOME;
const compiled = join(home, 'buy.mjs');
await build({ entryPoints: [join(root, 'budget/tempo/buy.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'esm', target: 'node20', banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }, plugins: [{ name: 'stub-budget-reads', setup(b) {
  b.onResolve({ filter: /lib\/chain\.ts$/ }, a => a.namespace === 'budget-stub' ? undefined : { path: a.path, namespace: 'budget-stub' });
  b.onLoad({ filter: /.*/, namespace: 'budget-stub' }, () => ({ contents: `export * from ${JSON.stringify(join(root, 'budget/tempo/lib/chain.ts'))}; export async function readKey() { return { exists: true, revoked: false, expiry: 0, remaining: 1000000n }; } export async function readScope() { return { scoped: false, scopes: [] }; }`, loader: 'ts', resolveDir: root }));
} }] });
const keys = join(home, 'keys/budget'); fs.mkdirSync(keys, { recursive: true });
fs.writeFileSync(join(keys, 'tempo-agent.env'), `OWNER_ADDRESS=0x1111111111111111111111111111111111111111\nAGENT_PRIVATE_KEY=0x${'01'.repeat(32)}\nAGENT_ADDRESS=0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1\n`, { mode: 0o600 });
const now = Date.now();
Date.now = () => now;
const expires = process.env.PUSH_EXPIRES ? new Date(now + Number(process.env.PUSH_EXPIRES) * 1000).toISOString() : undefined;
const challenge = Challenge.from({ id: 'push-crash', realm: 'seller.example', method: 'tempo', intent: 'charge', ...(expires ? { expires } : {}), request: { amount: '1000', decimals: 6, currency: '0x20C0000000000000000000000000000000000000', recipient: '0x3333333333333333333333333333333333333333', methodDetails: { chainId: 42431, supportedModes: ['push'] } } });
const journal = join(home, 'budget/ops/tempo-moderato/durability-test.json');
const fdPaths = new Map(); const synced = new Set(); let durable;
const originals = { ...fs };
fs.openSync = function (p, ...args) { const fd = originals.openSync(p, ...args); fdPaths.set(fd, String(p)); return fd; };
fs.fsyncSync = function (fd) {
  originals.fsyncSync(fd); const p = fdPaths.get(fd);
  if (p?.startsWith(journal + '.')) synced.add(p);
  if (p === dirname(journal) && fs.existsSync(journal) && synced.has(journal)) durable = originals.readFileSync(journal, 'utf8');
};
fs.renameSync = function (from, to) { const value = originals.renameSync(from, to); if (String(to) === journal && synced.has(String(from))) synced.add(journal); return value; };
fs.closeSync = function (fd) { fdPaths.delete(fd); return originals.closeSync(fd); };
syncBuiltinESMExports();
const hash = `0x${'ab'.repeat(32)}`;
globalThis.fetch = async (url, init) => {
  if ((url instanceof Request ? url.url : String(url)) === 'http://127.0.0.1/seller') return new Response('', { status: 402, headers: { 'WWW-Authenticate': Challenge.serialize(challenge) } });
  const q = JSON.parse(init.body);
  let result;
  switch (q.method) {
    case 'eth_chainId': result = '0xa5bf'; break;
    case 'eth_estimateGas': result = '0xc350'; break;
    case 'eth_maxPriorityFeePerGas': case 'eth_gasPrice': result = '0x1'; break;
    case 'eth_getTransactionCount': result = '0x0'; break;
    case 'eth_getBlockByNumber': result = { number: '0x10', hash, timestamp: '0x3e8', baseFeePerGas: '0x1', gasLimit: '0x100000', gasUsed: '0x0' }; break;
    case 'eth_sendRawTransactionSync': {
      const actual = Transaction.deserialize(q.params[0]);
      originals.writeFileSync(join(home, 'broadcast.json'), JSON.stringify({ recorded: JSON.parse(originals.readFileSync(journal, 'utf8')), durable: durable ? JSON.parse(durable) : null, validBefore: actual.validBefore, now }));
      process.kill(process.pid, 'SIGKILL'); return new Response();
    }
    default: throw new Error('unexpected stubbed RPC: ' + q.method);
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }), { headers: { 'content-type': 'application/json' } });
};
process.argv = [process.execPath, compiled, '--url', 'http://127.0.0.1/seller', '--max', '0.01', '--op', 'durability-test'];
await import(pathToFileURL(compiled).href);
