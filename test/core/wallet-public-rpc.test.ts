import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const helper = fileURLToPath(new URL("../helpers/wallet-public-rpc.mjs", import.meta.url));
const publicRpcs: Record<string, string> = {
  "base-sepolia": "https://sepolia.base.org",
  "arc-testnet": "https://rpc.testnet.arc.network",
  "arbitrum-sepolia": "https://sepolia-rollup.arbitrum.io/rpc",
  "polygon-amoy": "https://polygon-amoy-bor-rpc.publicnode.com",
  "skale-base-sepolia": "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha",
  "ethereum-sepolia": "https://ethereum-sepolia-rpc.publicnode.com",
  "robinhood-testnet": "https://rpc.testnet.chain.robinhood.com",
  "tempo-moderato": "https://rpc.moderato.tempo.xyz",
  "solana-devnet": "https://api.devnet.solana.com",
};
const evmChains = Object.keys(publicRpcs).slice(0, 7);

function run(mode: string, value: string, chain = "base-sepolia") {
  const home = mkdtempSync(join(tmpdir(), "wallet-public-rpc-"));
  try {
    return spawnSync(process.execPath, ["--import", "tsx", helper, mode, value, chain], {
      env: { ...process.env, HOME: home, SUPERSTABLES_HOME: home, SUPERSTABLES_SITE: "", SUPERSTABLES_APPROVE_PORT: "0" },
      encoding: "utf8", timeout: 15_000, maxBuffer: 8_000_000,
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

function checkPages(stdout: string, names: string[]) {
  const { pages } = JSON.parse(stdout);
  expect(pages.map((page: { name: string }) => page.name)).toEqual(names);
  for (const page of pages) {
    expect(page.html).not.toMatch(/SECRET-KEY-123|rpc\.example\.test|ftp:\/\/x|\/configured\//);
    const owner = page.name.startsWith("owner-");
    const match = page.html.match(new RegExp(`<script id="${owner ? "owner" : "approval"}-facts" type="application/json">(.*?)</script>`, "s"));
    expect(match).not.toBeNull();
    const facts = JSON.parse(match[1]);
    const key = page.name.replace(/^(owner|pay)-/, "");
    expect(owner ? facts.chain.rpcUrl : facts.rpcUrl).toBe(publicRpcs[key]);
    if (!owner || facts.chain.family !== "solana") {
      const addChain = page.html.match(/method: "wallet_addEthereumChain",\s+params: (\[\{[\s\S]*?\}\])/);
      expect(addChain).not.toBeNull();
      const params = runInNewContext(addChain[1], { facts });
      expect(params[0].rpcUrls).toEqual([publicRpcs[key]]);
    }
  }
}
const payNames = Object.keys(publicRpcs).map(key => `pay-${key}`);

describe("browser wallets receive only public RPCs", () => {
  it.each(evmChains)("renders all pay rails and %s budget owner with configured keys kept private", chain => {
    const result = run("pages", "https://rpc.example.test/v1/SECRET-KEY-123", chain);
    expect(result.status, result.stderr).toBe(0);
    checkPages(result.stdout, [...payNames, `owner-${chain}`, "owner-tempo-moderato", "owner-solana-devnet"]);
  });
  it("renders every pay approval with non-http overrides kept out of HTML and JS", () => {
    const result = run("pay", "ftp://x");
    expect(result.status, result.stderr).toBe(0);
    checkPages(result.stdout, payNames);
  });
  it("renders Tempo and Solana owners with non-http overrides kept out of the page", () => {
    const result = run("other-owners", "ftp://x");
    expect(result.status, result.stderr).toBe(0);
    checkPages(result.stdout, [...payNames, "owner-tempo-moderato", "owner-solana-devnet"]);
  });
  it.each(evmChains)("refuses an invalid %s budget RPC before an owner page can open", chain => {
    const result = run("pages", "ftp://x", chain);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("B4_RPC is refused");
    expect(result.stdout).toBe("");
  });
  it.each(evmChains)("keeps %s client reads on the configured local RPC", chain => {
    const result = run("reads", "", chain);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    checkPages(result.stdout, [...payNames, `owner-${chain}`, "owner-tempo-moderato", "owner-solana-devnet"]);
    expect(output.viemRpc).toEqual([output.configuredRpc]);
    expect(output.configuredRpc).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/configured\/SECRET-KEY-123$/);
    expect(output.reads.map((read: { method: string }) => read.method)).toEqual([
      "eth_blockNumber", "eth_blockNumber", "getBalance", "eth_blockNumber", "eth_blockNumber", "getBlockHeight", "eth_call",
    ]);
    expect(output.reads.map((read: { path: string }) => read.path)).toEqual(Array(7).fill("/configured/SECRET-KEY-123"));
  });
});
