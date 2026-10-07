import { createClient, custom, type Hex } from 'viem';
import { Account, Transaction } from 'viem/tempo';
import { tempoModerato } from 'viem/chains';
import { Challenge, Credential } from 'mppx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedSignTransaction, pushValidityBound } from '../../budget/tempo/lib/validity.js';

function isHex(value: unknown): value is Hex { return typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value); }
const hash: Hex = `0x${'ab'.repeat(32)}`;
let signed: Hex | undefined;
const broadcast = vi.fn();
afterEach(() => { vi.restoreAllMocks(); broadcast.mockClear(); signed = undefined; });

describe('mppx local push validity', () => {
  it.each([undefined, '1970-01-01T00:16:50.000Z', '1970-01-01T00:20:00.000Z'])("journals and signs mppx's bounded lifetime with challenge expiry %s", async expires => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const limit = pushValidityBound(expires);
    expect(limit).toBe(expires === '1970-01-01T00:16:50.000Z' ? 1010 : 1025);
    const account = Account.fromSecp256k1(`0x${'01'.repeat(32)}`, { access: '0x1111111111111111111111111111111111111111' });
    const client = createClient({ chain: tempoModerato, transport: custom({ request: async ({ method, params }) => {
      switch (method) {
        case 'eth_chainId': return '0xa5bf';
        case 'eth_estimateGas': return '0xc350';
        case 'eth_maxPriorityFeePerGas': case 'eth_gasPrice': return '0x1';
        case 'eth_getTransactionCount': return '0x0';
        case 'eth_getBlockByNumber': return { number: '0x10', hash, timestamp: '0x410', baseFeePerGas: '0x1', gasLimit: '0x100000', gasUsed: '0x0' };
        case 'eth_sendRawTransactionSync': {
          const raw = Array.isArray(params) ? params[0] : undefined;
          if (!isHex(raw)) throw new Error('missing signed transaction');
          signed = raw; broadcast(Transaction.deserialize(raw));
          return { transactionHash: hash, blockHash: hash, blockNumber: '0x10', status: '0x1', logs: [], gasUsed: '0xc350', cumulativeGasUsed: '0xc350', effectiveGasPrice: '0x1', transactionIndex: '0x0', from: account.address, to: null };
        }
        default: throw new Error('unexpected RPC: ' + method);
      }
    }, retryCount: 0 }) });
    const { tempo } = await import('mppx/client');
    const method = tempo.charge({ account: { ...account, signTransaction: boundedSignTransaction(account.signTransaction, () => limit) }, getClient: () => client });
    const challenge = Challenge.from({ id: 'validity-test', realm: 'seller.example', method: 'tempo' as const, intent: 'charge' as const, ...(expires ? { expires } : {}), request: { amount: '1000', decimals: 6, currency: '0x20C0000000000000000000000000000000000000', recipient: '0x3333333333333333333333333333333333333333', methodDetails: { chainId: 42431, supportedModes: ['push'] } } });
    // mppx computes its lifetime after resolving the client/account. A stalled process must not extend it.
    vi.spyOn(Date, 'now').mockReturnValue(1_040_000);
    const credential = await method.createCredential({ context: {}, challenge: { ...challenge, method: 'tempo', intent: 'charge', request: { ...challenge.request, methodDetails: { chainId: 42431, supportedModes: ['push'] } } } });
    expect(Credential.deserialize(credential).payload).toEqual({ type: 'hash', hash });
    expect(broadcast).toHaveBeenCalledOnce();
    expect(Transaction.deserialize(signed!)).toMatchObject({ validBefore: limit, nonceKey: 2n ** 256n - 1n });
  });
  it('preserves the original pull signer when no push bound exists', async () => {
    const account = Account.fromSecp256k1(`0x${'01'.repeat(32)}`);
    const request = { chainId: 42431, type: 'tempo', calls: [{ to: '0x3333333333333333333333333333333333333333', data: '0x' }], nonceKey: 2n ** 256n - 1n, nonce: 0, gas: 50000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, validBefore: 1025 } as const;
    expect(await boundedSignTransaction(account.signTransaction, () => undefined)(request)).toBe(await account.signTransaction(request));
  });
});
