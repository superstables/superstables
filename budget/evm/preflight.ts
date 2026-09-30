import "./cli-guard.mjs";
// preflight (B4, any chain): read-only checks before anything is sent. No secret file.
//   1. eth_chainId from the RPC equals chains.ts.
//   2. The USDC contract answers name(), version(), decimals(); the EIP-712 domain separator recomputed from
//      (name, version, chainId, token) equals DOMAIN_SEPARATOR(); all equal chains.ts.
//   3. Native vs ERC-20 balance of owner and agent (Arc: native = ERC-20 * 1e12, one balance in two units).
//   4. With --url: fetch the seller's 402 (x402 v2: the payment-required header; v1: the JSON body), list every option with the
//      verdict of buy's precheck, and name the chosen one: price, token, payTo, network, scheme, x402 version. Its RESULT carries
//      the price (`price`) and the recipient (`payTo`) for buy's --max and --pay-to.
// npx tsx budget/evm/preflight.ts --chain <name> [--url <seller url>] [--max <usdc>] [--pay-to <address>]
import { domainSeparator, parseAbi, formatUnits, type Address } from "viem";
import { SYM, CFG, GAS, emit, oneLine, USDC, NETWORK, usdc, gasFmt, publicClient, nativeBalance, usdcBalance, arg, toUsdc, publicEnv, usageError, cmd } from "./lib.ts";
import { checkAccept } from "./purchase.ts";
import { EVM_CHAINS } from "./chains.mjs";
import { isAddress } from "viem";

let bad = 0, good = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"} -- ${oneLine(m, 2000)}`); if (c) good++; else bad++; };
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

// v1 names the price maxAmountRequired, v2 amount
const amountOf = (x: any): string => String(x.amount ?? x.maxAmountRequired ?? "");
const priceOf = (x: any): string => (/^\d+$/.test(amountOf(x)) ? usdc(BigInt(amountOf(x))) : `"${amountOf(x)}" (not base units)`);
// Our chain keys for the networks a seller offers (v2 eip155:<id>, v1 names), so a failed match can name the --chain to use.
const chainKeysFor = (networks: string[]) => Object.entries(EVM_CHAINS).filter(([, c]: [string, any]) => networks.some((n) => n === `eip155:${c.chainId}` || c.legacy.includes(n))).map(([k]) => k);

type Offer = { price: string; token: string; payTo: string; network: string; scheme: string; x402Version: number };
let offer: Offer | null = null;
let offered: string[] = [];
if (url) {
  let r: Response | null = null;
  try { r = await fetch(url, { signal: AbortSignal.timeout(20_000) }); } catch (e: any) { ok(false, `GET ${url}: ${String(e?.message ?? e).split("\n")[0]}`); }
  let pr: any = null;
  if (r) {
    console.log(`GET ${url} -> HTTP ${r.status}`);
    const h = r.headers.get("payment-required");
    if (h) {
      try { pr = JSON.parse(Buffer.from(h, "base64").toString()); } catch {}
    } else if (r.status === 402) {
      // x402 v1: the requirements are the JSON body. Read at most 64 KB of it.
      const text = (await r.text().catch(() => "")).slice(0, 65_536);
      try { const b = JSON.parse(text); if (b?.x402Version === 1) pr = b; } catch {}
    }
    ok(r.status === 402 && !!pr && Array.isArray(pr.accepts), "seller answers 402 with x402 payment requirements (v2: payment-required header, v1: JSON body)");
  }
  if (pr && Array.isArray(pr.accepts)) {
    const version = Number(pr.x402Version ?? (r?.headers.get("payment-required") ? 2 : 1));
    const all: any[] = pr.accepts;
    offered = [...new Set(all.map((x) => String(x.network)))];
    console.log(oneLine(`x402 v${version}; resource: ${pr.resource?.url ?? pr.accepts[0]?.resource ?? "?"}; ${all.length} option(s); networks: ${offered.join(", ")}`, 2000));
    // the same filter as buy: this chain's names, scheme exact
    const mine = all.filter((x) => (x.network === NETWORK || CFG.legacyNetworks.includes(x.network)) && x.scheme === "exact");
    console.log(`${mine.length} exact option(s) on ${CFG.label} (${[NETWORK, ...CFG.legacyNetworks].join(", ")}); the rest are other networks or schemes and are ignored`);
    let picked: any = null;
    for (const x of mine) {
      const why = checkAccept(x, { max: max ?? 10n ** 12n, payTo });
      console.log("  " + oneLine(`${x.scheme} price ${priceOf(x)} ${SYM} asset ${x.asset} payTo ${x.payTo} timeout ${x.maxTimeoutSeconds}s extra ${JSON.stringify(x.extra)} -> ${why ? `SKIP: ${why}` : "USABLE"}`, 2000));
      if (!why && !picked) picked = x;
    }
    ok(!!picked, `a usable ${CFG.label} ${SYM} exact option exists`);
    if (picked) {
      offer = { price: usdc(BigInt(amountOf(picked))), token: picked.asset, payTo: picked.payTo, network: picked.network, scheme: picked.scheme, x402Version: version };
      console.log(oneLine(`offer: ${offer.price} ${SYM} (token ${offer.token}) to ${offer.payTo}, network ${offer.network}, scheme ${offer.scheme}, x402 v${version}, EIP-712 domain ${picked.extra.name}/${picked.extra.version} (from the 402, checked against the token), method ${picked.extra.assetTransferMethod ?? "eip3009 (default)"}`, 2000));
      if (max !== undefined) ok(BigInt(amountOf(picked)) <= max, `price ${offer.price} <= --max ${usdc(max)}`);
      if (payTo) ok(picked.payTo.toLowerCase() === payTo.toLowerCase(), `payTo equals --pay-to ${payTo}`);
    }
  }
}
const elsewhere = url && !offer ? chainKeysFor(offered).filter((k) => k !== CFG.key) : [];
console.log(bad ? `\n${bad} check(s) FAILED` : "\nPREFLIGHT OK");
process.exit(emit("preflight", bad ? 1 : 0, {
  state: bad ? "failed" : "ok", checks: { passed: good, failed: bad },
  ...(url ? { url, price: offer?.price ?? null, payTo: offer?.payTo ?? null, offer, sellerChains: chainKeysFor(offered) } : {}),
  next: bad ? (elsewhere.length ? `the seller offers ${elsewhere.join(", ")}, not ${CFG.key}: use --chain ${elsewhere[0]}` : "fix the failed checks above") : "none",
}));
void formatUnits;
