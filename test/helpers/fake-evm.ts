// A minimal in-memory EVM chain with a Circle-style FiatToken USDC, served as JSON-RPC on loopback, and a configurable x402 seller.
// Enough for budget/evm/*.ts: balances, allowances, transferFrom, transfer, approve, EIP-3009 (transferWithAuthorization,
// cancelAuthorization), AuthorizationUsed / Transfer / Approval logs, receipts, blocks (each tx mines its own block).
// The mempool is strict: a transaction whose nonce is not the account's next one is refused ("nonce too low" / "too high").
// `gasIsToken` makes the native balance and the token balance one balance in two units (Arc: native 18 decimals, ERC-20 6).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import {
  decodeFunctionData, encodeFunctionResult, encodeAbiParameters, keccak256, toBytes, parseTransaction, recoverTransactionAddress, verifyTypedData,
  parseAbi, type Hex, type Address, concat, pad, toHex,
} from "viem";

export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
export const ARC_USDC = "0x3600000000000000000000000000000000000000" as Address;
const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
const T_TRANSFER = keccak256(toBytes("Transfer(address,address,uint256)"));
const T_APPROVAL = keccak256(toBytes("Approval(address,address,uint256)"));
const T_USED = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));
const T_CANCEL = keccak256(toBytes("AuthorizationCanceled(address,bytes32)"));
const topicAddr = (a: string) => pad(a.toLowerCase() as Hex, { size: 32 });
const lc = (s: string) => s.toLowerCase();
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

export type Log = { address: string; topics: Hex[]; data: Hex; blockNumber: string; blockHash: string; transactionHash: string; logIndex: string; transactionIndex: string; removed: boolean };
type State = {
  native: Map<string, bigint>; usdc: Map<string, bigint>; allow: Map<string, bigint>; nonces: Map<string, number>; used: Map<string, "used" | "canceled">;
};
const clone = (s: State): State => ({ native: new Map(s.native), usdc: new Map(s.usdc), allow: new Map(s.allow), nonces: new Map(s.nonces), used: new Map(s.used) });

export interface FakeEvm {
  url: string;
  port: number;
  usdcAddress: Address;
  domain: { name: string; version: string };
  st: State;
  txs: Map<string, any>;
  receipts: Map<string, any>;
  blocks: any[];
  logs: Log[];
  rpcLog: { method: string; params: any[] }[];
  sentRaw: { from: string; to: string; data: string; hash: string; nonce: number; status: string }[];
  /** approve(spender, v > 0) reverts while the allowance is above 0 (a USDT-style token) */
  approveReset?: boolean;
  /** hooks a test sets */
  hook?: (method: string, params: any[]) => { result?: unknown; error?: { code: number; message: string; data?: unknown } } | undefined;
  /** drop sendRawTransaction without mining (returns hash) */
  blackhole: boolean;
  /** when set, eth_sendRawTransaction mines only after this promise resolves */
  gate?: Promise<void>;
  setUsdc(a: string, v: bigint): void;
  setNative(a: string, v: bigint): void;
  setAllowance(o: string, s: string, v: bigint): void;
  usdcOf(a: string): bigint;
  allowanceOf(o: string, s: string): bigint;
  nativeOf(a: string): bigint;
  /** The facilitator: settle an EIP-3009 transferWithAuthorization (verifies the signature). Returns {hash} or throws. */
  settle(auth: { from: string; to: string; value: string | bigint; validAfter: string | bigint; validBefore: string | bigint; nonce: Hex }, sig: Hex): Promise<{ hash: string }>;
  advance(seconds: number): void;
  now(): number;
  /** Mine a block with no transaction: it keeps a copy of the state as it is now, which eth_call at that block reads later. */
  mineEmpty(): void;
  /** How many blocks the `finalized` tag trails the head (default 0). Settable at any time. */
  finalizedLag: number;
  /** A second server over this chain's state and blocks (another operator): its own `hook` can lie per method. */
  mirror(): Promise<FakeMirror>;
  close(): Promise<void>;
}
export interface FakeMirror {
  url: string;
  port: number;
  rpcLog: { method: string; params: any[] }[];
  hook?: FakeEvm["hook"];
  close(): Promise<void>;
}

export type FakeEvmOpts = { port?: number; chainId?: number; usdc?: Address; domain?: { name: string; version: string }; gasIsToken?: boolean; finalizedLag?: number };

export async function startFakeEvm(opts: FakeEvmOpts = {}): Promise<FakeEvm> {
  const CHAIN_ID = opts.chainId ?? 84532;
  const USDC_ADDR = opts.usdc ?? BASE_SEPOLIA_USDC;
  const DOMAIN = opts.domain ?? { name: "USDC", version: "2" };
  const gasIsToken = opts.gasIsToken ?? false;
  const UNIT = 10n ** 12n; // native (18 decimals) per token unit (6 decimals) when they are one balance
  const st: State = { native: new Map(), usdc: new Map(), allow: new Map(), nonces: new Map(), used: new Map() };
  let clockSkew = 0;
  const now = () => Math.floor(Date.now() / 1000) + clockSkew;
  const genesis = { number: 20_000_000n, hash: keccak256(toBytes("genesis")), timestamp: now() - 100, txs: [] as string[] };
  const blocks: any[] = [genesis];
  const logs: Log[] = [];
  const txs = new Map<string, any>();
  const receipts = new Map<string, any>();
  const sentRaw: FakeEvm["sentRaw"] = [];
  const rpcLog: FakeEvm["rpcLog"] = [];
  const key = (...p: string[]) => p.map(lc).join(":");
  const bal = (s: State, a: string) => (gasIsToken ? (s.native.get(lc(a)) ?? 0n) / UNIT : (s.usdc.get(lc(a)) ?? 0n));
  const setBal = (s: State, a: string, v: bigint) => {
    if (gasIsToken) s.native.set(lc(a), (s.native.get(lc(a)) ?? 0n) - bal(s, a) * UNIT + v * UNIT); // keeps the sub-unit dust
    else s.usdc.set(lc(a), v);
  };
  const GAS_PRICE = 1_000_000_000n; // 1 gwei
  const GAS_USED = 60_000n;

  const domain = { name: DOMAIN.name, version: DOMAIN.version, chainId: CHAIN_ID, verifyingContract: USDC_ADDR };
  const DOMAIN_SEPARATOR = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak256(toBytes(DOMAIN.name)), keccak256(toBytes(DOMAIN.version)), BigInt(CHAIN_ID), USDC_ADDR]));

  /** Execute a call to USDC on state `s`; returns {ret, logs} or throws Error("revert: ...") */
  async function execUsdc(s: State, from: string, data: Hex, emit: (topics: Hex[], data: Hex) => void, value = 0n): Promise<Hex> {
    if (value !== 0n) throw new Error("revert: not payable");
    const call = decodeFunctionData({ abi, data });
    const a = call.args as unknown as any[];
    const enc = (fn: any, result: any) => encodeFunctionResult({ abi, functionName: fn, result } as any);
    const move = (f: string, t: string, v: bigint) => {
      if (bal(s, f) < v) throw new Error("revert: ERC20: transfer amount exceeds balance");
      setBal(s, f, bal(s, f) - v); setBal(s, t, bal(s, t) + v);
      emit([T_TRANSFER, topicAddr(f), topicAddr(t)], pad(toHex(v), { size: 32 }));
    };
    switch (call.functionName) {
      case "balanceOf": return enc("balanceOf", bal(s, a[0]));
      case "allowance": return enc("allowance", s.allow.get(key(a[0], a[1])) ?? 0n);
      case "decimals": return enc("decimals", 6);
      case "name": return enc("name", DOMAIN.name);
      case "version": return enc("version", DOMAIN.version);
      case "DOMAIN_SEPARATOR": return enc("DOMAIN_SEPARATOR", DOMAIN_SEPARATOR);
      case "authorizationState": return enc("authorizationState", s.used.has(key(a[0], a[1])));
      case "approve":
        if ((fake as FakeEvm).approveReset && a[1] > 0n && (s.allow.get(key(from, a[0])) ?? 0n) > 0n) throw new Error("revert: approve from a live allowance");
        s.allow.set(key(from, a[0]), a[1]); emit([T_APPROVAL, topicAddr(from), topicAddr(a[0])], pad(toHex(a[1]), { size: 32 })); return enc("approve", true);
      case "transfer": move(from, a[0], a[1]); return enc("transfer", true);
      case "transferFrom": {
        const k = key(a[0], from);
        const al = s.allow.get(k) ?? 0n;
        if (al < a[2]) throw new Error("revert: ERC20: transfer amount exceeds allowance");
        // FiatToken: allowance is decremented even if max? (Circle: no infinite special-casing) - decrement always
        s.allow.set(k, al - a[2]);
        move(a[0], a[1], a[2]);
        return enc("transferFrom", true);
      }
      case "cancelAuthorization": {
        const [authorizer, nonce, v, r, sg] = a;
        if (s.used.has(key(authorizer, nonce))) throw new Error("revert: FiatTokenV2: authorization is used or canceled");
        const sig = concat([r, sg, toHex(v, { size: 1 })]);
        const ok = await verifyTypedData({ address: authorizer, domain, types: { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] }, primaryType: "CancelAuthorization", message: { authorizer, nonce }, signature: sig });
        if (!ok) throw new Error("revert: FiatTokenV2: invalid signature");
        s.used.set(key(authorizer, nonce), "canceled");
        emit([T_CANCEL, topicAddr(authorizer), nonce], "0x");
        return "0x";
      }
      default: throw new Error("revert: unknown function " + (call as any).functionName);
    }
  }

  function mine(txHash: string, from: string, to: string | null, data: Hex, nonce: number, ok: boolean, txLogs: { topics: Hex[]; data: Hex }[]) {
    const prev = blocks[blocks.length - 1];
    const n = prev.number + 1n;
    const ts = Math.max(now(), prev.timestamp + 1);
    const blockHash = keccak256(toBytes(`block:${n}:${txHash}:${Math.random()}`));
    const b: any = { number: n, hash: blockHash, timestamp: ts, txs: txHash ? [txHash] : [], parent: prev.hash };
    blocks.push(b);
    b.state = clone(st);
    const lgs: Log[] = txLogs.map((l, i) => ({ address: USDC_ADDR, topics: l.topics, data: l.data, blockNumber: hex(n), blockHash, transactionHash: txHash, logIndex: hex(i), transactionIndex: "0x0", removed: false }));
    logs.push(...(ok ? lgs : []));
    if (txHash) {
      receipts.set(lc(txHash), {
        transactionHash: txHash, transactionIndex: "0x0", blockHash, blockNumber: hex(n), from, to, cumulativeGasUsed: hex(GAS_USED), gasUsed: hex(GAS_USED),
        effectiveGasPrice: hex(GAS_PRICE), contractAddress: null, logs: ok ? lgs : [], logsBloom: "0x" + "00".repeat(256), status: ok ? "0x1" : "0x0", type: "0x2",
      });
      txs.set(lc(txHash), { hash: txHash, from, to, input: data, nonce: hex(nonce), blockHash, blockNumber: hex(n), transactionIndex: "0x0", value: "0x0", gas: hex(200000), gasPrice: hex(GAS_PRICE), type: "0x2" });
    }
    return b;
  }

  async function runTx(from: string, to: string | null, data: Hex, value: bigint, commit: boolean, nonce?: number, base?: State): Promise<{ ok: boolean; ret: Hex; err?: string; logs: { topics: Hex[]; data: Hex }[]; s: State }> {
    const s = commit ? st : clone(base ?? st);
    const work = clone(s);
    const out: { topics: Hex[]; data: Hex }[] = [];
    try {
      if (value > 0n) {
        if ((work.native.get(lc(from)) ?? 0n) < value) throw new Error("revert: insufficient native balance");
        work.native.set(lc(from), (work.native.get(lc(from)) ?? 0n) - value);
        if (to) work.native.set(lc(to), (work.native.get(lc(to)) ?? 0n) + value);
      }
      let ret: Hex = "0x";
      if (to && lc(to) === lc(USDC_ADDR) && data !== "0x") ret = await execUsdc(work, from, data, (topics, d) => out.push({ topics, data: d }));
      // commit state
      s.native = work.native; s.usdc = work.usdc; s.allow = work.allow; s.used = work.used;
      return { ok: true, ret, logs: out, s };
    } catch (e: any) {
      return { ok: false, ret: "0x", err: String(e.message), logs: [], s };
    }
  }

  async function handle(method: string, params: any[], log: FakeEvm["rpcLog"] = rpcLog, hookOf: () => FakeEvm["hook"] = () => (fake as FakeEvm).hook): Promise<unknown> {
    log.push({ method, params });
    const hk = hookOf()?.(method, params);
    if (hk) { if (hk.error) throw Object.assign(new Error(hk.error.message), { rpc: hk.error }); return hk.result; }
    const head = () => blocks[blocks.length - 1];
    const blockView = (b: any, full = false) => ({
      number: hex(b.number), hash: b.hash, parentHash: b.parent ?? keccak256(toBytes("p")), timestamp: hex(b.timestamp), baseFeePerGas: hex(GAS_PRICE),
      gasLimit: hex(30_000_000), gasUsed: hex(0), miner: "0x" + "00".repeat(20), nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x",
      logsBloom: "0x" + "00".repeat(256), receiptsRoot: keccak256(toBytes("r")), sha3Uncles: keccak256(toBytes("u")), stateRoot: keccak256(toBytes("s")), transactionsRoot: keccak256(toBytes("t")),
      size: "0x1", uncles: [], transactions: full ? b.txs.map((h: string) => txs.get(lc(h))) : b.txs,
    });
    const blockByTag = (tag: any) => {
      if (tag === "finalized") return blocks[Math.max(0, blocks.length - 1 - Math.max(0, fake.finalizedLag))];
      if (tag === "latest" || tag === "pending" || tag === "safe" || tag === undefined) return head();
      const n = BigInt(tag);
      return blocks.find((b) => b.number === n) ?? null;
    };
    switch (method) {
      case "eth_chainId": return hex(CHAIN_ID);
      case "net_version": return String(CHAIN_ID);
      case "eth_blockNumber": return hex(head().number);
      case "eth_getBlockByNumber": { const b = blockByTag(params[0]); return b ? blockView(b, params[1]) : null; }
      case "eth_getBlockByHash": { const b = blocks.find((x) => lc(x.hash) === lc(params[0])); return b ? blockView(b, params[1]) : null; }
      case "eth_gasPrice": return hex(GAS_PRICE);
      case "eth_maxPriorityFeePerGas": return hex(GAS_PRICE / 10n);
      case "eth_feeHistory": return { oldestBlock: hex(head().number), baseFeePerGas: [hex(GAS_PRICE), hex(GAS_PRICE)], gasUsedRatio: [0.1], reward: [[hex(GAS_PRICE / 10n)]] };
      case "eth_getBalance": return hex(st.native.get(lc(params[0])) ?? 0n);
      case "eth_getTransactionCount": return hex(st.nonces.get(lc(params[0])) ?? 0);
      case "eth_getCode": return lc(params[0]) === lc(USDC_ADDR) ? "0x60806040" : "0x";
      case "eth_estimateGas": {
        const c = params[0];
        const r = await runTx(c.from ?? "0x" + "00".repeat(20), c.to, (c.data ?? c.input ?? "0x") as Hex, BigInt(c.value ?? 0), false);
        if (!r.ok) throw Object.assign(new Error(r.err!), { rpc: { code: 3, message: "execution reverted: " + r.err, data: "0x" } });
        return hex(55_000);
      }
      case "eth_call": {
        const c = params[0];
        // the state as of the block named by params[1] (a tag, a number, or { blockHash } / { blockNumber }): the head reads the live state
        const at = params[1];
        const b = at && typeof at === "object" ? (at.blockHash ? blocks.find((x) => lc(x.hash) === lc(at.blockHash)) : blockByTag(at.blockNumber)) : blockByTag(at);
        if (!b) throw Object.assign(new Error("header not found"), { rpc: { code: -32000, message: "header not found" } });
        const r = await runTx(c.from ?? "0x" + "00".repeat(20), c.to, (c.data ?? c.input ?? "0x") as Hex, BigInt(c.value ?? 0), false, undefined, b === head() ? undefined : b.state);
        if (!r.ok) throw Object.assign(new Error(r.err!), { rpc: { code: 3, message: "execution reverted: " + r.err, data: "0x" } });
        return r.ret;
      }
      case "eth_sendRawTransaction": {
        const raw = params[0] as Hex;
        const hash = keccak256(raw);
        const parsed: any = parseTransaction(raw);
        const from = await recoverTransactionAddress({ serializedTransaction: raw as any });
        const expected = st.nonces.get(lc(from)) ?? 0;
        const nonce = Number(parsed.nonce ?? 0);
        if (nonce < expected) throw Object.assign(new Error("nonce too low"), { rpc: { code: -32000, message: "nonce too low" } });
        if (nonce > expected) throw Object.assign(new Error("nonce too high"), { rpc: { code: -32000, message: "nonce too high" } });
        if (lc(hash) in Object.fromEntries([...receipts.keys()].map((k) => [k, 1]))) throw Object.assign(new Error("already known"), { rpc: { code: -32000, message: "already known" } });
        const fee = GAS_USED * GAS_PRICE;
        if ((st.native.get(lc(from)) ?? 0n) < fee) throw Object.assign(new Error("insufficient funds for gas"), { rpc: { code: -32000, message: "insufficient funds for gas * price + value" } });
        if (fake.blackhole) { sentRaw.push({ from, to: parsed.to, data: parsed.data ?? "0x", hash, nonce, status: "dropped" }); return hash; }
        if (fake.gate) { await fake.gate; const now = st.nonces.get(lc(from)) ?? 0; if (nonce !== now) throw Object.assign(new Error(nonce < now ? "nonce too low" : "nonce too high"), { rpc: { code: -32000, message: nonce < now ? "nonce too low" : "nonce too high" } }); }
        st.native.set(lc(from), (st.native.get(lc(from)) ?? 0n) - fee);
        st.nonces.set(lc(from), nonce + 1);
        const r = await runTx(from, parsed.to ?? null, (parsed.data ?? "0x") as Hex, BigInt(parsed.value ?? 0), true, nonce);
        mine(hash, from, parsed.to ?? null, (parsed.data ?? "0x") as Hex, nonce, r.ok, r.logs);
        sentRaw.push({ from, to: parsed.to, data: parsed.data ?? "0x", hash, nonce, status: r.ok ? "success" : "reverted:" + r.err });
        return hash;
      }
      case "eth_getTransactionReceipt": return receipts.get(lc(params[0])) ?? null;
      case "eth_getTransactionByHash": return txs.get(lc(params[0])) ?? null;
      case "eth_getLogs": {
        const q = params[0];
        const from = q.fromBlock === "latest" || q.fromBlock === undefined ? head().number : BigInt(q.fromBlock);
        const to = q.toBlock === "latest" || q.toBlock === undefined ? head().number : BigInt(q.toBlock);
        return logs.filter((l) => {
          const n = BigInt(l.blockNumber);
          if (n < from || n > to) return false;
          if (q.address && lc(l.address) !== lc(Array.isArray(q.address) ? q.address[0] : q.address)) return false;
          return (q.topics ?? []).every((want: any, i: number) => want === null || (Array.isArray(want) ? want.map(lc) : [lc(want)]).includes(lc(l.topics[i] ?? "")));
        });
      }
      default: throw Object.assign(new Error("method not supported: " + method), { rpc: { code: -32601, message: "method not found: " + method } });
    }
  }

  const serve = (log: FakeEvm["rpcLog"], hookOf: () => FakeEvm["hook"]) => createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    for await (const c of req) body += c;
    let msg: any;
    try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
    const one = async (m: any) => {
      try { return { jsonrpc: "2.0", id: m.id, result: await handle(m.method, m.params ?? [], log, hookOf) }; }
      catch (e: any) { return { jsonrpc: "2.0", id: m.id, error: e.rpc ?? { code: -32000, message: String(e.message) } }; }
    };
    const out = Array.isArray(msg) ? await Promise.all(msg.map(one)) : await one(msg);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? hex(v) : v)));
  });
  const server = serve(rpcLog, () => (fake as FakeEvm).hook);
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const mirrors: ReturnType<typeof createServer>[] = [];
  const fake: FakeEvm = {
    url: `http://127.0.0.1:${port}`, port, usdcAddress: USDC_ADDR, domain: DOMAIN, st, txs, receipts, blocks, logs, rpcLog, sentRaw, blackhole: false,
    setUsdc: (a, v) => setBal(st, a, v), setNative: (a, v) => st.native.set(lc(a), v),
    setAllowance: (o, s, v) => st.allow.set(key(o, s), v),
    usdcOf: (a) => bal(st, a), allowanceOf: (o, s) => st.allow.get(key(o, s)) ?? 0n, nativeOf: (a) => st.native.get(lc(a)) ?? 0n,
    advance: (s) => { clockSkew += s; },
    now,
    async settle(auth, sig) {
      const t = (await import("viem")).hexToBytes; void t;
      const types = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
      const message = { from: auth.from as Address, to: auth.to as Address, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce };
      if (!(await verifyTypedData({ address: auth.from as Address, domain, types, primaryType: "TransferWithAuthorization", message, signature: sig }))) throw new Error("invalid signature");
      if (BigInt(now()) <= message.validAfter) throw new Error("authorization is not yet valid");
      if (BigInt(now()) >= message.validBefore) throw new Error("authorization is expired");
      if (st.used.has(key(auth.from, auth.nonce))) throw new Error("authorization is used or canceled");
      if (bal(st, auth.from) < message.value) throw new Error("transfer amount exceeds balance");
      const facilitator = "0x" + "fa".repeat(20);
      const hash = keccak256(toBytes(`settle:${auth.nonce}:${Math.random()}`));
      st.used.set(key(auth.from, auth.nonce), "used");
      setBal(st, auth.from, bal(st, auth.from) - message.value);
      setBal(st, auth.to, bal(st, auth.to) + message.value);
      mine(hash, facilitator, USDC_ADDR, "0x" as Hex, 0, true, [
        { topics: [T_USED, topicAddr(auth.from), auth.nonce], data: "0x" },
        { topics: [T_TRANSFER, topicAddr(auth.from), topicAddr(auth.to)], data: pad(toHex(message.value), { size: 32 }) },
      ]);
      return { hash };
    },
    finalizedLag: opts.finalizedLag ?? 0,
    mineEmpty: () => { mine("", "0x" + "00".repeat(20), null, "0x", 0, true, []); },
    async mirror() {
      const log: FakeEvm["rpcLog"] = [];
      const m: FakeMirror = { url: "", port: 0, rpcLog: log, close: () => new Promise<void>((r) => srv.close(() => r())) };
      const srv = serve(log, () => m.hook);
      mirrors.push(srv);
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      m.port = (srv.address() as any).port;
      m.url = `http://127.0.0.1:${m.port}`;
      return m;
    },
    close: () => Promise.all([server, ...mirrors].map((x) => new Promise<void>((r) => { x.closeAllConnections?.(); x.close(() => r()); }))).then(() => undefined),
  };
  return fake;
}

// ---- the seller, the owner and agent keys, and the home the budget CLI reads --------------------------------------------------

export const OWNER = privateKeyToAccount(generatePrivateKey());
const AGENT_KEY = generatePrivateKey();
export const AGENT = privateKeyToAccount(AGENT_KEY);
export const SELLER_ADDR = "0x00000000000000000000000000000000000a11ce";
export const usdc = (s: string) => BigInt(Math.round(Number(s) * 1e6));

/** A home like `setup` leaves it: an agent key (0600) and a public file with the owner and agent, for one chain. */
export function makeHome(chainKey = "base-sepolia", label = "Base Sepolia") {
  const home = mkdtempSync(join(tmpdir(), "evm-checks-home-"));
  const keys = join(home, "keys", "budget");
  const pub = join(home, "budget", "public");
  mkdirSync(keys, { recursive: true, mode: 0o700 });
  mkdirSync(pub, { recursive: true, mode: 0o700 });
  writeFileSync(join(keys, "evm-agent.env"), `B4_AGENT_KEY=${AGENT_KEY}\n`, { mode: 0o600 });
  writeFileSync(join(pub, `evm-${chainKey}.env`), `# ${label} public state\nB4_OWNER_ADDRESS=${OWNER.address}\nB4_AGENT_ADDRESS=${AGENT.address}\n`);
  return { home, opsDir: join(home, "budget", "ops", `evm-${chainKey}`), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** A chain where the owner holds 100 USDC and has granted `allow` to the agent, and the agent has gas. */
export async function makeChain(opts: FakeEvmOpts & { allow?: string } = {}) {
  const chain = await startFakeEvm(opts);
  chain.setUsdc(OWNER.address, usdc("100"));
  chain.setNative(OWNER.address, 10n ** 20n);
  if (!opts.gasIsToken) chain.setNative(AGENT.address, 10n ** 17n);
  chain.setAllowance(OWNER.address, AGENT.address, usdc(opts.allow ?? "1"));
  return chain;
}

export type SellerOpts = {
  price?: string; // base units
  /** change the 402 option each time it is served */
  mutate?: (req: any, n: number) => any;
  /** tokens credited to the payer after a payment settles (a seller refund) */
  refund?: bigint;
  /** serve this many bytes of 402 body instead of the requirement (an endless answer) */
  hugeBody?: number;
};
export type Seller = { url: string; creds: any[]; settled: string[]; errors: string[]; sent: { bytes: number }; close(): Promise<void> };

export async function startSeller(chain: FakeEvm, chainId: number, opts: SellerOpts = {}): Promise<Seller> {
  const creds: any[] = [];
  const settled: string[] = [];
  const errors: string[] = [];
  const sent = { bytes: 0 };
  let challenges = 0;
  const network = `eip155:${chainId}`;
  const option = (n: number) => {
    let r: any = { scheme: "exact", network, asset: chain.usdcAddress, amount: opts.price ?? "10000", payTo: SELLER_ADDR, maxTimeoutSeconds: 300, extra: { name: chain.domain.name, version: chain.domain.version } };
    if (opts.mutate) r = opts.mutate(r, n) ?? r;
    return r;
  };
  const server = createServer(async (rq, rs) => {
    const raw = rq.headers["payment-signature"] as string | undefined;
    const challenge = () => {
      challenges++;
      const body = { x402Version: 2, error: "Payment required", resource: { url: `http://${rq.headers.host}${rq.url}`, description: "test", mimeType: "application/json" }, accepts: [option(challenges)] };
      if (opts.hugeBody) {
        // a 402 whose body never ends: the answer is written until the client hangs up
        rs.writeHead(402, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(16_384, 0x20);
        const timer = setInterval(() => {
          if (rs.destroyed || sent.bytes >= opts.hugeBody!) { clearInterval(timer); rs.end(); return; }
          for (let i = 0; i < 8 && sent.bytes < opts.hugeBody!; i++) { rs.write(chunk); sent.bytes += chunk.length; }
        }, 1);
        rs.on("close", () => clearInterval(timer));
        return;
      }
      rs.writeHead(402, { "content-type": "application/json", "payment-required": encodePaymentRequiredHeader(body as any) });
      rs.end(JSON.stringify(body));
    };
    if (!raw) return challenge();
    let cred: any;
    try { cred = decodePaymentSignatureHeader(raw); } catch (e: any) { errors.push(String(e)); return challenge(); }
    creds.push(cred);
    try {
      const { hash } = await chain.settle(cred.payload.authorization, cred.payload.signature);
      settled.push(hash);
      if (opts.refund) chain.setUsdc(cred.payload.authorization.from, chain.usdcOf(cred.payload.authorization.from) + opts.refund);
      const hdr = encodePaymentResponseHeader({ success: true, transaction: hash, network, payer: cred.payload.authorization.from } as any);
      rs.writeHead(200, { "content-type": "application/json", "payment-response": hdr });
      rs.end(JSON.stringify({ ok: true, tx: hash }));
    } catch (e: any) {
      errors.push("settle: " + e.message);
      rs.writeHead(402, { "content-type": "application/json" });
      rs.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/paid`, creds, settled, errors, sent, close: () => { server.closeAllConnections(); return new Promise<void>((r) => server.close(() => r())); } };
}
