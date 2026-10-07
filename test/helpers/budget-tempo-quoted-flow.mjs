// Run the real rail entry points with an isolated key, local seller, and deterministic chain.
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Challenge } from 'mppx';
import { keccak256, toBytes } from 'viem';
const root = process.env.BUDGET_DURABILITY_ROOT;
const home = process.env.SUPERSTABLES_HOME;
const step = process.env.TEMPO_STEP;
if (!home?.startsWith(tmpdir() + '/')) throw new Error('isolated home required');
const entry = step === 'reconcile' ? 'reconcile' : 'buy';
const compiled = join(home, `${entry}.mjs`);
await build({ entryPoints: [join(root, `budget/tempo/${entry}.ts`)], outfile: compiled, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  plugins: [{ name: 'key-reads', setup(b) {
    b.onResolve({ filter: /lib\/chain\.ts$/ }, a => a.namespace === 'stub' ? undefined : { path: a.path, namespace: 'stub' });
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export * from ${JSON.stringify(join(root, 'budget/tempo/lib/chain.ts'))}; export async function readKey() { return { exists: true, revoked: false, expiry: 0, remaining: 1000000n }; } export async function readScope() { return { scoped: false, scopes: [] }; }`, loader: 'ts', resolveDir: root }));
  } }] });
const owner = '0x1111111111111111111111111111111111111111';
const agent = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1';
const recipient = '0x3333333333333333333333333333333333333333';
const token = '0x20C0000000000000000000000000000000000000';
const keys = join(home, 'keys/budget'); fs.mkdirSync(keys, { recursive: true });
fs.writeFileSync(join(keys, 'tempo-agent.env'), `OWNER_ADDRESS=${owner}\nAGENT_PRIVATE_KEY=0x${'01'.repeat(32)}\nAGENT_ADDRESS=${agent}\n`, { mode: 0o600 });
const challenge = Challenge.from({ id: 'quoted-flow', realm: 'seller.example', method: 'tempo', intent: 'charge', request: { amount: '1000', decimals: 6, currency: token, recipient, methodDetails: { chainId: 42431, supportedModes: ['pull'] } } });
const journal = join(home, 'budget/ops/tempo-moderato/durability-test.json');
const hash = `0x${'ab'.repeat(32)}`, blockHash = `0x${'cd'.repeat(32)}`;
const topic = a => '0x' + a.slice(2).padStart(64, '0');
const transferTopic = keccak256(toBytes('Transfer(address,address,uint256)'));
const memoTopic = keccak256(toBytes('TransferWithMemo(address,address,uint256,bytes32)'));
let paid = false;
const logs = () => {
  const memo = JSON.parse(fs.readFileSync(journal, 'utf8')).memo;
  const base = { address: token, transactionHash: hash, blockHash, blockNumber: '0x20', removed: false, data: '0x' + (1000n).toString(16).padStart(64, '0') };
  return [{ ...base, topics: [transferTopic, topic(owner), topic(recipient)] }, { ...base, topics: [memoTopic, topic(owner), topic(recipient), memo] }];
};
globalThis.fetch = async (url, init) => {
  if ((url instanceof Request ? url.url : String(url)) === 'http://127.0.0.1/seller') {
    if (new Headers(init?.headers).get('authorization')) {
      paid = true; fs.writeFileSync(join(home, 'paid-request.json'), JSON.stringify({ journal: JSON.parse(fs.readFileSync(journal, 'utf8')) }));
      return new Response('delivered', { status: 200 });
    }
    return new Response('', { status: 402, headers: { 'WWW-Authenticate': Challenge.serialize(challenge) } });
  }
  const q = JSON.parse(init.body);
  if (step === 'interrupt' && q.method === 'eth_estimateGas') process.kill(process.pid, 'SIGKILL');
  let result;
  switch (q.method) {
    case 'eth_chainId': result = '0xa5bf'; break;
    case 'eth_estimateGas': result = '0xc350'; break;
    case 'eth_maxPriorityFeePerGas': case 'eth_gasPrice': result = '0x1'; break;
    case 'eth_getTransactionCount': result = '0x0'; break;
    case 'eth_getBlockByNumber': result = { number: q.params[0] === 'latest' ? '0x20' : q.params[0], hash: blockHash, timestamp: '0x' + (Math.floor(Date.now() / 1000) + 100).toString(16), baseFeePerGas: '0x1', gasLimit: '0x100000', gasUsed: '0x0', transactions: paid ? [hash] : [] }; break;
    case 'eth_getLogs': result = paid ? [logs()[1]] : []; break;
    case 'eth_getTransactionReceipt': result = paid ? { transactionHash: hash, blockHash, blockNumber: '0x20', status: '0x1', logs: logs() } : null; break;
    case 'eth_getTransactionByHash': result = paid ? { from: owner, signature: { keyId: agent } } : null; break;
    default: throw new Error('unexpected stubbed RPC: ' + q.method);
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }), { headers: { 'content-type': 'application/json' } });
};
process.argv = [process.execPath, compiled, '--op', 'durability-test', ...(step === 'reconcile' ? [] : ['--url', 'http://127.0.0.1/seller', '--max', '0.01', ...(step === 'quote' ? ['--quote'] : [])])];
await import(pathToFileURL(compiled).href);
