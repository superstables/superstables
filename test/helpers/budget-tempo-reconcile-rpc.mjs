// Run the real reconcile entry point with deterministic RPC answers, never a wallet.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { keccak256, toBytes } from 'viem';
const root = process.env.BUDGET_DURABILITY_ROOT;
const dir = join(process.env.SUPERSTABLES_HOME, 'budget/ops/tempo-moderato');
const record = JSON.parse(readFileSync(join(dir, 'durability-test.json'), 'utf8'));
const hash = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'cd'.repeat(32)}`;
const topic = a => '0x' + a.slice(2).padStart(64, '0');
const memoTopic = keccak256(toBytes('TransferWithMemo(address,address,uint256,bytes32)'));
const transferTopic = keccak256(toBytes('Transfer(address,address,uint256)'));
const base = { address: record.intent.token, transactionHash: hash, blockHash, blockNumber: '0x10', removed: false, data: '0x' + BigInt(record.intent.amount).toString(16).padStart(64, '0') };
const logs = [{ ...base, topics: [transferTopic, topic(record.intent.owner), topic(record.intent.recipient)] }, { ...base, topics: [memoTopic, topic(record.intent.owner), topic(record.intent.recipient), record.memo] }];
const calls = [];
Date.now = () => 1_000_000;
const scenario = process.env.TEMPO_SCENARIO;
let headReads = 0;
let lastBlock;
globalThis.fetch = async (_url, init) => {
  const q = JSON.parse(init.body); calls.push(q.method); writeFileSync(join(dir, 'calls.json'), JSON.stringify(calls));
  const found = ['found', 'omitted-index'].includes(scenario);
  let result;
  switch (q.method) {
    case 'eth_chainId': result = '0xa5bf'; break;
    case 'eth_getBlockByNumber': {
      const latest = q.params[0] === 'latest';
      if (latest) headReads++;
      if (!latest && scenario === 'missing-block' && q.params[0] === '0x15') { result = null; break; }
      result = { number: latest ? (['range-fails', 'multi-range'].includes(scenario) ? '0x30d40' : scenario === 'lagging-head' && headReads > 1 ? '0x12' : '0x20') : q.params[0], timestamp: scenario === 'recent' ? '0x3fc' : '0x4b0', hash: blockHash, transactions: found && q.params[0] === '0x10' ? [hash] : [] };
      if (latest && scenario === 'invalid-head') result.timestamp = 'not-a-time';
      if (latest && scenario === 'alternating-heads') {
        result.number = headReads % 2 ? '0xc' : '0x20';
        result.timestamp = '0x' + ((record.validBefore ?? 1100) + (headReads % 2 ? -30 : 60)).toString(16);
      }
      if (!latest && scenario === 'short-block' && q.params[0] === '0x15') result.number = '0x14';
      lastBlock = result;
      break;
    }
    case 'eth_getBlockTransactionCountByHash': result = scenario === 'short-transactions' ? '0x1' : '0x' + lastBlock.transactions.length.toString(16); break;
    case 'eth_getLogs':
      if (scenario === 'unreadable' || (scenario === 'range-fails' && calls.filter(x => x === 'eth_getLogs').length >= 2)) return new Response(JSON.stringify({ id: q.id, jsonrpc: '2.0', error: { code: -32000, message: 'history unavailable' } }));
      result = scenario === 'short-range' ? null : ['found', 'missing-receipt'].includes(scenario) || (scenario === 'alternating-heads' && BigInt(q.params[0].toBlock) >= 16n) ? [logs[1]] : []; break;
    case 'eth_getTransactionReceipt': result = found ? { transactionHash: hash, blockHash, blockNumber: '0x10', status: '0x1', logs } : null; break;
    case 'eth_getTransactionByHash': result = found ? { from: record.intent.owner, signature: { keyId: record.intent.agent } } : null; break;
    default: result = '0x' + '00'.repeat(256);
  }
  return new Response(JSON.stringify({ id: q.id, jsonrpc: '2.0', result }), { headers: { 'content-type': 'application/json' } });
};
process.argv = [process.execPath, join(root, 'budget/tempo/reconcile.ts'), '--op', 'durability-test'];
await import(pathToFileURL(join(root, 'budget/tempo/reconcile.ts')).href);
