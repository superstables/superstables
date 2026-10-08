import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startFakeBaseSepolia } from "../helpers/fake-base-sepolia.js";
import { EVM_NETWORKS } from "../../src/core/chain.js";
import { guardedNode } from "../helpers/guarded-process.js";
import { readBody, sendJson, startServer } from "../helpers/servers.js";

const NETWORKS = ["base-sepolia", "arc-testnet", "arbitrum-sepolia", "polygon-amoy", "skale-base-sepolia", "ethereum-sepolia", "tempo-moderato"];

describe("client RPC overrides", () => {
  it("reads every EVM and Tempo balance through the configured RPC in a guarded process", async () => {
    const home = mkdtempSync(join(tmpdir(), "client-rpc-"));
    const guardLog = join(home, "network.log");
    writeFileSync(guardLog, "");
    const calls: string[] = [];
    const rpc = await startServer(async (req, res) => {
      const request = JSON.parse(await readBody(req));
      calls.push(request.method);
      sendJson(res, 200, { jsonrpc: "2.0", id: request.id, result: `0x${1_000_000n.toString(16).padStart(64, "0")}` });
    });
    try {
      const child = await guardedNode(["--import=tsx", "--input-type=module", "-e", `
        import { usdcBalance, KNOWN_NETWORKS } from "./src/core/chain.ts";
        const balances = [];
        for (const key of ${JSON.stringify(NETWORKS)}) {
          try { balances.push(await usdcBalance("0x1111111111111111111111111111111111111111", KNOWN_NETWORKS.find((network) => network.key === key))); }
          catch (error) { balances.push(error.shortMessage || error.message); }
        }
        console.log(JSON.stringify(balances));
      `], { HOME: home, SUPERSTABLES_HOME: home, B4_RPC: rpc.url, SUPERSTABLES_RPC_URL: "http://127.0.0.1:9", SUPERSTABLES_TEMPO_RPC: rpc.url, SUPERSTABLES_NETWORK_GUARD_LOG: guardLog });
      expect({ ...child, guard: readFileSync(guardLog, "utf8") }).toEqual({ code: 0, output: "[1,1,1,1,1,1,1]\n", guard: "" });
      expect(calls).toEqual(Array(7).fill("eth_call"));
    } finally { await rpc.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it("checks EVM payment settlement through B4_RPC on all six chains", async () => {
    const home = mkdtempSync(join(tmpdir(), "settlement-rpc-"));
    const guardLog = join(home, "network.log");
    writeFileSync(guardLog, "");
    const chain = await startFakeBaseSepolia();
    const payer = "0x1111111111111111111111111111111111111111";
    const recipient = "0x2222222222222222222222222222222222222222";
    const inputs = EVM_NETWORKS.map((network, index) => {
      const nonce = `0x${(index + 1).toString(16).padStart(64, "0")}`;
      const transaction = chain.settle({ from: payer, to: recipient, value: "10000", nonce, token: network.usdc.address });
      return { network: network.caip2, transaction, payer, recipient, amountAtomic: "10000", nonce };
    });
    try {
      const child = await guardedNode(["--import=tsx", "--input-type=module", "-e", `
        import { checkSettlement } from "./src/core/settlement.ts";
        const results = [];
        for (const input of ${JSON.stringify(inputs)}) results.push(await checkSettlement(input));
        console.log(JSON.stringify(results));
      `], { HOME: home, SUPERSTABLES_HOME: home, B4_RPC: chain.url, SUPERSTABLES_RPC_URL: "http://127.0.0.1:9", SUPERSTABLES_NETWORK_GUARD_LOG: guardLog });
      expect(child.code, child.output).toBe(0);
      expect(JSON.parse(child.output), readFileSync(guardLog, "utf8")).toEqual(Array.from({ length: 6 }, () => ({ chain: "verified" })));
      expect(chain.calls).toBe(18);
      expect(readFileSync(guardLog, "utf8")).toBe("");
    } finally { await chain.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it("offers the configured RPC in every rail's wallet facts and uses it for chain reads", async () => {
    const rpc = "http://127.0.0.1:8545";
    const child = await guardedNode(["--import=tsx", "--input-type=module", "-e", `
      import { KNOWN_NETWORKS } from "./src/core/chain.ts";
      import { chainRpc } from "./src/core/rpc.ts";
      import { eip3009Step } from "./src/core/signer/steps/eip3009.ts";
      import { tempoStep } from "./src/core/signer/steps/tempo.ts";
      import { solanaStep } from "./src/core/signer/steps/solana.ts";
      const urls = [];
      for (const key of ${JSON.stringify([...NETWORKS, "solana-devnet"])}) {
        const network = KNOWN_NETWORKS.find((network) => network.key === key);
        const step = network.rail === "tempo" ? tempoStep : network.rail === "solana" ? solanaStep : eip3009Step;
        urls.push([step.pageFacts({ network }).rpcUrl, chainRpc(network).url]);
      }
      console.log(JSON.stringify(urls));
    `], { B4_RPC: rpc, SUPERSTABLES_RPC_URL: "http://127.0.0.1:9", SUPERSTABLES_TEMPO_RPC: rpc, SUPERSTABLES_SOLANA_RPC: rpc });
    expect(child.code, child.output).toBe(0);
    expect(JSON.parse(child.output)).toEqual(Array.from({ length: 8 }, () => [rpc, rpc]));
  });

  it("retains the Base Sepolia legacy override when B4_RPC is unset", async () => {
    const rpc = "http://127.0.0.1:8546";
    const child = await guardedNode(["--import=tsx", "--input-type=module", "-e", `
      import { BASE_SEPOLIA } from "./src/core/chain.ts";
      import { chainRpc } from "./src/core/rpc.ts";
      console.log(JSON.stringify(chainRpc(BASE_SEPOLIA)));
    `], { B4_RPC: "", SUPERSTABLES_RPC_URL: rpc });
    expect(child).toEqual({ code: 0, output: JSON.stringify({ url: rpc }) + "\n" });
  });

  it("refuses invalid Tempo RPCs before balance reads or wallet facts, using the existing error", async () => {
    const child = await guardedNode(["--import=tsx", "--input-type=module", "-e", `
      import { TEMPO_MODERATO, usdcBalance } from "./src/core/chain.ts";
      import { tempoStep } from "./src/core/signer/steps/tempo.ts";
      for (const run of [() => usdcBalance("0x1111111111111111111111111111111111111111", TEMPO_MODERATO), () => tempoStep.pageFacts({})]) {
        try { await run(); console.log("accepted"); } catch (error) { console.log(error.message); }
      }
    `], { SUPERSTABLES_TEMPO_RPC: "http://rpc.example.com" });
    expect(child).toEqual({ code: 0, output: "SUPERSTABLES_TEMPO_RPC must use HTTPS, or HTTP on this machine\n".repeat(2) });
  });
});
