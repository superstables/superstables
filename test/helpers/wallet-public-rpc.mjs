// Render the real local approval servers in a fresh process, without a wallet or a payment.
import { createServer } from 'node:http';

const source = path => import(new URL(path, import.meta.url).href);
const mode = process.argv[2];
const value = process.argv[3];
const chain = process.argv[4] || 'base-sepolia';
const vars = ['B4_RPC', 'SUPERSTABLES_TEMPO_RPC', 'SUPERSTABLES_SOLANA_RPC', 'SUPERSTABLES_RPC_URL'];
process.env.B4_CHAIN = chain;
let stub;
const reads = [];
if (mode === 'reads') {
  stub = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const call = JSON.parse(body);
    reads.push({ path: req.url, method: call.method });
    res.setHeader('content-type', 'application/json');
    const result = call.method === 'getBalance' ? { context: { slot: 1 }, value: 123 }
      : call.method === 'getBlockHeight' ? 123 : call.method === 'eth_call' ? `0x${'7b'.padStart(64, '0')}` : '0x7b';
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const rpc = `http://127.0.0.1:${stub.address().port}/configured/SECRET-KEY-123`;
  for (const name of vars) process.env[name] = rpc;
} else {
  for (const name of vars) process.env[name] = value;
}

const { KNOWN_NETWORKS, usdcBalance } = await source('../../src/core/chain.ts');
const { ApprovalServer } = await source('../../src/core/signer/approval-server.ts');
const { OwnerApprovalServer } = await source('../../src/core/signer/owner-approval-server.ts');
const { chainRpc, rpcCall } = await source('../../src/core/rpc.ts');
const pages = [];
const pay = new ApprovalServer({ port: 0 });
const owner = new OwnerApprovalServer({ port: 0 });
try {
  await pay.start();
  await owner.start();
  for (const network of KNOWN_NETWORKS) {
    const kind = network.rail === 'evm' ? 'eip3009' : network.rail === 'tempo' ? 'tempo-transfer' : 'solana-transaction';
    const recipient = network.rail === 'solana' ? '11111111111111111111111111111111' : '0x1111111111111111111111111111111111111111';
    const verified = {
      amountDecimal: 0.01, amountAtomic: '10000', asset: network.token.symbol, assetAddress: network.token.address,
      network: network.caip2, networkLabel: network.label, recipient, payer: '', scheme: network.rail === 'tempo' ? 'charge' : 'exact',
    };
    const requirement = network.rail === 'tempo' ? {
      id: 'test-challenge', realm: 'local-test', method: 'tempo', intent: 'charge', requestRaw: '', request: {},
      expires: new Date(Date.now() + 600_000).toISOString(),
    } : { scheme: 'exact', network: network.caip2, asset: network.token.address, amount: '10000', payTo: recipient, maxTimeoutSeconds: 300 };
    const handle = pay.request({ kind, verified, requirement, x402Version: 2, timeoutMs: 300_000 });
    const response = await fetch(handle.url);
    if (response.status !== 200) throw new Error(`pay page returned ${response.status}`);
    pages.push({ name: `pay-${network.key}`, publicRpc: network.defaultRpc, html: await response.text() });
  }
  if (mode !== 'pay') {
    const [evm, { TEMPO_OWNER_CHAIN }, { SOLANA_OWNER_CHAIN }] = await Promise.all([
      mode === 'other-owners' ? undefined : source('../../budget/evm/owner.ts'), source('../../budget/tempo/owner.ts'), source('../../budget/solana/owner.ts'),
    ]);
    for (const [key, ownerChain] of [...(evm ? [[chain, evm.OWNER_CHAIN]] : []), ['tempo-moderato', TEMPO_OWNER_CHAIN], ['solana-devnet', SOLANA_OWNER_CHAIN]]) {
      const handle = owner.request({ kind: 'connect', chain: ownerChain, signIn: 'Connect your wallet to set up a budget.', timeoutMs: 300_000,
        terms: { title: 'Connect your wallet', summary: 'Prove this wallet is yours. This signature grants no spending permission.', rows: [], enforced: [], notEnforced: [], notes: [] },
      });
      const response = await fetch(handle.url);
      if (response.status !== 200) throw new Error(`owner page returned ${response.status}`);
      pages.push({ name: `owner-${key}`, html: await response.text() });
    }
  }
  if (mode === 'reads') {
    const { publicClient, CFG } = await source('../../budget/evm/lib.ts');
    const { rpcRead } = await source('../../budget/tempo/lib/chain.ts');
    const { connection } = await import('../../budget/solana/lib.mjs');
    await publicClient.getBlockNumber();
    await rpcRead('eth_blockNumber', []);
    await connection().getBalance(new (await import('@solana/web3.js')).PublicKey('11111111111111111111111111111111'));
    for (const network of KNOWN_NETWORKS.filter(n => n.rpcEnv)) {
      const rpc = chainRpc(network);
      if ('error' in rpc) throw new Error(rpc.error);
      await rpcCall(rpc.url, network.rail === 'solana' ? 'getBlockHeight' : 'eth_blockNumber', []);
    }
    await usdcBalance('0x1111111111111111111111111111111111111111');
    process.stdout.write(JSON.stringify({ pages, reads, configuredRpc: CFG.rpc, viemRpc: CFG.chain.rpcUrls.default.http }));
  } else process.stdout.write(JSON.stringify({ pages }));
} finally {
  await pay.close();
  await owner.close();
  if (stub) { stub.closeAllConnections(); await new Promise(resolve => stub.close(resolve)); }
}
