import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { RACE_ROOT: root, RACE_DIR: dir, RACE_OP: op, RACE_ACTION: action, RACE_RAIL: rail, RACE_MARKER: marker } = process.env;
const pause = () => {
  fs.writeFileSync(marker, 'paused');
  // Force the marker-before-SIGSTOP interval so a premature SIGCONT loses the wakeup.
  if (process.env.RACE_PAUSE_GAP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.RACE_PAUSE_GAP_MS));
  process.kill(process.pid, 'SIGSTOP');
};
if (action === 'break') {
  const unlink = fs.unlinkSync;
  let stopped = false;
  const target = join(dir, rail === 'solana' ? `${op}.json.lock` : `${op}.buy.lock`);
  fs.unlinkSync = function (path) {
    if (!stopped && String(path) === target) { stopped = true; pause(); }
    return unlink.apply(this, arguments);
  };
  syncBuiltinESMExports();
}
if (action === 'reconcile') {
  process.argv = [process.execPath, join(root, `budget/${rail}/reconcile.${rail === 'solana' ? 'mjs' : 'ts'}`), '--op', op];
  const read = fs.readFileSync;
  let stopped = false;
  fs.readFileSync = function (path) {
    const value = read.apply(this, arguments);
    if (!stopped && String(path) === join(dir, `${op}.json`)) { stopped = true; pause(); }
    return value;
  };
  syncBuiltinESMExports();
  // Chain reads stay local and deterministic. No payment or key is needed.
  globalThis.fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    const result = {
      getGenesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      getEpochInfo: { absoluteSlot: 1000, blockHeight: 1000, epoch: 1, slotIndex: 0, slotsInEpoch: 432000, transactionCount: 1000 },
      getSignatureStatuses: { context: { slot: 1000 }, value: Array.isArray(req.params[0]) ? req.params[0].map(() => null) : [null] },
      getSignaturesForAddress: [], getBlockHeight: 1000,
      getFirstAvailableBlock: 0,
      eth_getTransactionReceipt: null, eth_getTransactionByHash: null,
      eth_getTransactionCount: '0x0', eth_getLogs: [], eth_blockNumber: '0x100',
      eth_getBlockByNumber: { number: '0x100', timestamp: '0xffffffff' },
    };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id,
      result: req.method in result ? result[req.method] : `0x${'00'.repeat(256)}` }), { headers: { 'content-type': 'application/json' } });
  };
  await import(pathToFileURL(join(root, `budget/${rail}/reconcile.${rail === 'solana' ? 'mjs' : 'ts'}`)).href);
} else {
  const guard = await import(pathToFileURL(join(root, 'budget/buy-guard.mjs')).href);
  const ops = rail === 'solana' ? await import(pathToFileURL(join(root, 'budget/solana/ops.mjs')).href) : null;
  const take = () => ops ? ops.acquireLock(op) : (guard.lockRecord ?? guard.lockOp)(dir, op);
  if (action === 'generation') {
    Date.now = () => 123456789;
    const first = rail === 'solana' ? take() : guard.lockOp(dir, op);
    first.release();
    const second = rail === 'solana' ? take() : guard.lockOp(dir, op);
    first.release();
    const third = rail === 'solana' ? take() : guard.lockOp(dir, op);
    process.stdout.write(JSON.stringify({ first: first.ok, second: second.ok, third: third.ok }));
    process.exit(0);
  }
  const lock = ops ? ops.acquireLock(op) : action === 'write'
    ? (guard.lockRecord ?? guard.lockOp)(dir, op) : guard.lockOp(dir, op);
  if (action === 'write') {
    if (lock.ok) {
      const path = join(dir, `${op}.json`);
      const rec = JSON.parse(fs.readFileSync(path, 'utf8'));
      rec.state = process.env.RACE_STATE ?? 'submitted';
      if (rail === 'solana') rec.agentSig = 'new-signature';
      else if (rail === 'evm') { rec.pullTx = `0x${'ab'.repeat(32)}`; rec.signed = true; }
      else rec.signedHash = `0x${'ab'.repeat(32)}`;
      fs.writeFileSync(path, JSON.stringify(rec));
      lock.release();
    }
    process.stdout.write(JSON.stringify({ ok: lock.ok }));
  } else {
    fs.writeFileSync(marker + '.result', JSON.stringify({ ok: lock.ok }));
    setInterval(() => {}, 1000);
  }
}
