// Tests that stand a mocked viem client in for the chain also stand it in for the agreeing endpoints: these answer the lib.ts
// agreement functions from the same mock, as one agreeing set whose every endpoint says what the mock says. It never models the
// bounds (`atLeast`, a block later than the agreed one) or a pending transaction as the real functions do: do not use it to test them.
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

export function agreedFromClient(rpc: any, token: string) {
  const at = async () => {
    const b = await rpc.getBlock({ blockTag: "finalized" });
    return { number: BigInt(b.number), hash: b.hash, timestamp: Number(b.timestamp), highest: BigInt(b.number) };
  };
  const agreed = async (value: unknown) => ({ agreed: true as const, value, block: await at(), agreement: "caller" as const, operators: ["test"] });
  return {
    receiptAgreed: async (hash: string) => {
      let r: any = null;
      try { r = await rpc.getTransactionReceipt({ hash }); } catch {}
      if (!r) return agreed(null);
      return agreed({
        status: r.status === "success" ? "0x1" : "0x0", blockNumber: hex(r.blockNumber), blockHash: r.blockHash,
        logs: (r.logs ?? []).filter((l: any) => String(l.address).toLowerCase() === token.toLowerCase()).map((l: any) => ({ topics: l.topics, data: l.data })),
      });
    },
    txAgreed: async (hash: string) => {
      let t: any = null;
      try { t = await rpc.getTransaction({ hash }); } catch {}
      return agreed(t ? { from: t.from, nonce: hex(t.nonce), blockNumber: hex(t.blockNumber ?? 0n), blockHash: t.blockHash } : null);
    },
    authorizationStateAgreed: async (authorizer: string, nonce: string) => agreed(await rpc.readContract({ address: token, functionName: "authorizationState", args: [authorizer, nonce], blockNumber: (await at()).number })),
  };
}
