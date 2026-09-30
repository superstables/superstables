import "./cli-guard.mjs";
// preflight (B4, any chain): read-only checks before anything is sent. No secret file.
//   1. eth_chainId from the RPC equals chains.ts.
//   2. The USDC contract answers name(), version(), decimals(); the EIP-712 domain separator recomputed from
//      (name, version, chainId, token) equals DOMAIN_SEPARATOR(); all equal chains.ts.
//   3. Native vs ERC-20 balance of owner and agent (Arc: native = ERC-20 * 1e12, one balance in two units).
//   4. With --url: fetch the seller's 402, decode it, list every option with the verdict of buy's precheck, and name the chosen one.
// npx tsx budget/evm/preflight.ts --chain <name> [--url <seller url>] [--max <usdc>] [--pay-to <address>]
import { domainSeparator, parseAbi, formatUnits, type Address } from "viem";
import { SYM, CFG, GAS, emit, USDC, NETWORK, usdc, gasFmt, publicClient, nativeBalance, usdcBalance, arg, toUsdc, publicEnv, usageError, cmd } from "./lib.ts";
import { checkAccept } from "./purchase.ts";
import { isAddress } from "viem";

let bad = 0, good = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"} -- ${m}`); if (c) good++; else bad++; };
const abi = parseAbi(["function name() view returns (string)", "function version() view returns (string)", "function decimals() view returns (uint8)", "function DOMAIN_SEPARATOR() view returns (bytes32)"]);
const max = arg("max") ? toUsdc(arg("max")!) : undefined;
const payTo = arg("pay-to");
if (payTo && !isAddress(payTo)) usageError(`--pay-to "${payTo}" is not an address`);
const url = arg("url");

console.log(`chain ${CFG.key}: ${CFG.label}, rpc ${CFG.rpc}, ${SYM} ${USDC}`);
const id = await publicClient.request({ method: "eth_chainId" });
ok(Number(id) === CFG.chainId, `eth_chainId ${id} = ${Number(id)} (expected ${CFG.chainId}); block ${await publicClient.getBlockNumber()}`);
const rd = (fn: string) => publicClient.readContract({ address: USDC, abi, functionName: fn as any }) as Promise<any>;
// Some EIP-3009 tokens have no version() (the call reverts). Then the table's version is checked through DOMAIN_SEPARATOR() alone.
const [name, onchainVersion, decimals, ds] = await Promise.all([rd("name"), rd("version").catch(() => null), rd("decimals"), rd("DOMAIN_SEPARATOR")]);
const version: string = onchainVersion ?? CFG.domain.version;
ok(name === CFG.domain.name && version === CFG.domain.version, `token name()/version() = ${name}/${onchainVersion ?? "(no version(): reverts)"}; chains.mjs says ${CFG.domain.name}/${CFG.domain.version}`);
ok(Number(decimals) === CFG.decimals, `token decimals() = ${decimals}`);
const calc = domainSeparator({ domain: { name, version, chainId: CFG.chainId, verifyingContract: USDC } });
ok(calc === ds, `DOMAIN_SEPARATOR() ${ds.slice(0, 18)}... equals the one recomputed from (${name}, ${version}${onchainVersion === null ? " from chains.mjs" : ""}, ${CFG.chainId}, token)`);
const fees = await publicClient.estimateFeesPerGas().catch(() => null);
console.log(`gas: token ${GAS.symbol}${GAS.isUsdc ? " (native, 18 decimals; the same balance the ERC-20 shows in 6)" : ""}, gasPrice ${await publicClient.getGasPrice()} wei${fees?.maxFeePerGas ? `, maxFeePerGas ${fees.maxFeePerGas}` : ""}`);

const p = publicEnv();
for (const [who, addr] of [["owner", p.B4_OWNER_ADDRESS], ["agent", p.B4_AGENT_ADDRESS]] as const) {
  if (!addr || !isAddress(addr)) { console.log(`note: no ${who} address in the public file (run superstables budget setup --rail evm${CFG.key === "base-sepolia" ? "" : ` --chain ${CFG.key}`})`); continue; }
  const [n, e] = [await nativeBalance(addr as Address), await usdcBalance(addr as Address)];
  console.log(`${who} ${addr}: native ${gasFmt(n)} ${GAS.symbol}, ERC-20 ${SYM} ${usdc(e)}`);
  if (GAS.isUsdc) ok(n / 10n ** 12n === e, `${who}: native balance ${n} / 1e12 (rounded down) = ERC-20 balance ${e} (one balance, two units; the native one also holds sub-micro dust of 18-decimal fees: ${n % 10n ** 12n} wei)`);
}

if (url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  console.log(`GET ${url} -> HTTP ${r.status}`);
  const h = r.headers.get("payment-required");
  ok(r.status === 402 && !!h, "seller answers 402 with a payment-required header");
  if (h) {
    const pr = JSON.parse(Buffer.from(h, "base64").toString());
    const all: any[] = pr.accepts ?? [];
    console.log(`resource: ${pr.resource?.url ?? "?"}; ${all.length} option(s); networks: ${[...new Set(all.map((x) => x.network))].join(", ")}`);
    const mine = all.filter((x) => x.network === NETWORK || CFG.legacyNetworks.includes(x.network));
    console.log(`${mine.length} option(s) on ${NETWORK}; the rest are other networks and are ignored`);
    let picked: any = null;
    for (const x of mine) {
      const why = checkAccept(x, { max: max ?? 10n ** 12n, payTo });
      console.log(`  ${x.scheme} amount ${x.amount} asset ${x.asset} payTo ${x.payTo} timeout ${x.maxTimeoutSeconds}s extra ${JSON.stringify(x.extra)} -> ${why ? `SKIP: ${why}` : "USABLE"}`);
      if (!why && !picked) picked = x;
    }
    ok(!!picked, `a usable ${CFG.label} ${SYM} exact option exists`);
    if (picked) {
      console.log(`chosen: ${usdc(BigInt(picked.amount))} ${SYM} to ${picked.payTo}, EIP-712 domain ${picked.extra.name}/${picked.extra.version} (from the 402, checked against the token), method ${picked.extra.assetTransferMethod ?? "eip3009 (default)"}`);
      if (max !== undefined) ok(BigInt(picked.amount) <= max, `price ${usdc(BigInt(picked.amount))} <= --max ${usdc(max)}`);
      if (payTo) ok(picked.payTo.toLowerCase() === payTo.toLowerCase(), `payTo equals --pay-to ${payTo}`);
    }
  }
}
console.log(bad ? `\n${bad} check(s) FAILED` : "\nPREFLIGHT OK");
process.exit(emit("preflight", bad ? 1 : 0, { state: bad ? "failed" : "ok", checks: { passed: good, failed: bad }, next: bad ? "fix the failed checks above" : "none" }));
void formatUnits;
