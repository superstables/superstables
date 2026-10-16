// Read-only checks that every chain table's token facts are the chain's own. No wallet, no key, no transaction:
// eth_chainId, decimals(), name(), version() where the token has one, and DOMAIN_SEPARATOR() through the same read `pay`
// uses (src/core/token-domain.ts); Tempo's pathUSD decimals(); the Solana devnet mint's decimals. Runs only with
// SUPERSTABLES_LIVE=1 (npm run test:live), against each chain's public RPC (or the variable its table names).
// approveReset cannot be read without a transaction; it is stated by hand for each entry and reviewed when one is added.
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import type { NetworkInfo } from "../../src/core/chain.js";
import { EVM_NETWORKS, SOLANA_DEVNET, TEMPO_MODERATO } from "../../src/core/chain.js";
import { chainRpc, rpcCall } from "../../src/core/rpc.js";
import { believedDomainSeparator, expectedDomainSeparator, tokenDomainProblem } from "../../src/core/token-domain.js";

const live = process.env.SUPERSTABLES_LIVE === "1";
const ERC20 = parseAbi(["function decimals() view returns (uint8)", "function name() view returns (string)", "function version() view returns (string)"]);
const urlOf = (n: Pick<NetworkInfo, "key" | "defaultRpc" | "rpcEnv">) => { const r = chainRpc(n); if ("error" in r) throw new Error(r.error); return r.url; };
async function view(url: string, to: string, fn: "decimals" | "name" | "version"): Promise<unknown> {
  const data = encodeFunctionData({ abi: ERC20, functionName: fn });
  return decodeFunctionResult({ abi: ERC20, functionName: fn, data: await rpcCall<`0x${string}`>(url, "eth_call", [{ to, data }, "latest"], { timeoutMs: 20_000 }) });
}

describe.skipIf(!live)("token facts on the public testnets (read-only)", () => {
  for (const n of EVM_NETWORKS) {
    it(`${n.key}: decimals, name, version and DOMAIN_SEPARATOR() are the table's`, async () => {
      const url = urlOf(n);
      expect(Number(await view(url, n.token.address, "decimals"))).toBe(n.token.decimals);
      expect(await view(url, n.token.address, "name")).toBe(n.token.domain.name);
      const version = await view(url, n.token.address, "version").catch(() => null); // USDG has no version()
      if (version !== null) expect(version).toBe(n.token.domain.version);
      const believed = await believedDomainSeparator(n, {});
      expect(believed).toHaveProperty("word");
      expect(String((believed as { word: unknown }).word).toLowerCase()).toBe(expectedDomainSeparator(n.chainId, n.token).toLowerCase());
      expect(await tokenDomainProblem(n, {})).toBe("");
    }, 60_000);
  }

  it("tempo-moderato: pathUSD's decimals() is the table's", async () => {
    const url = urlOf(TEMPO_MODERATO);
    expect(await rpcCall<string>(url, "eth_chainId", [], { timeoutMs: 20_000 })).toBe(`0x${TEMPO_MODERATO.chainId.toString(16)}`);
    expect(Number(await view(url, TEMPO_MODERATO.token.address, "decimals"))).toBe(TEMPO_MODERATO.token.decimals);
  }, 60_000);

  it("solana-devnet: the USDC mint's decimals are the table's", async () => {
    const url = urlOf(SOLANA_DEVNET);
    expect(await rpcCall<string>(url, "getGenesisHash", [], { timeoutMs: 20_000 })).toBe(SOLANA_DEVNET.genesisHash);
    const info = await rpcCall<any>(url, "getAccountInfo", [SOLANA_DEVNET.token.address, { encoding: "jsonParsed", commitment: "finalized" }], { timeoutMs: 20_000 });
    expect(info?.value?.data?.parsed?.info?.decimals).toBe(SOLANA_DEVNET.token.decimals);
  }, 60_000);
});
