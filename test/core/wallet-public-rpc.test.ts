import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { accountHomeWith } from "../helpers/owner-settings.js";

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

const execFileAsync = promisify(execFile);
// Async, so the Vitest worker can answer its runner between helper processes.
// `pinned`: the owner has set this URL as the RPC of every chain. Owner actions read only the owner's RPCs, so a configured URL
// that is not pinned is refused before an owner page opens; the pages that do open must still carry only the public RPC.
async function run(mode: string, value: string, chain = "base-sepolia", pinned = false) {
  const account = !pinned ? undefined : accountHomeWith({ version: 1, rpc: Object.fromEntries(Object.keys(publicRpcs).map(key => [key, { urls: [value] }])) });
  const home = mkdtempSync(join(tmpdir(), "wallet-public-rpc-"));
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx", helper, mode, value, chain], {
      env: { ...process.env, HOME: home, SUPERSTABLES_HOME: home, SUPERSTABLES_SITE: "", SUPERSTABLES_APPROVE_PORT: "0", ...(account ? { SUPERSTABLES_TEST_ACCOUNT_HOME: account } : {}) },
      encoding: "utf8", timeout: 15_000, maxBuffer: 8_000_000,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof failed.code !== "number") throw error;
    return { status: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
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
  it.each(evmChains)("renders all pay rails and %s budget owner with configured keys kept private", async chain => {
    const result = await run("pages", "https://rpc.example.test/v1/SECRET-KEY-123", chain, true);
    expect(result.status, result.stderr).toBe(0);
    checkPages(result.stdout, [...payNames, `owner-${chain}`, "owner-tempo-moderato", "owner-solana-devnet"]);
  });
  it("renders every pay approval with non-http overrides kept out of HTML and JS", async () => {
    const result = await run("pay", "ftp://x");
    expect(result.status, result.stderr).toBe(0);
    checkPages(result.stdout, payNames);
  });
  it("renders Tempo and Solana owners with an RPC the owner set, and keeps it out of the page", async () => {
    const result = await run("other-owners", "https://rpc.example.test/v1/SECRET-KEY-123", "base-sepolia", true);
    expect(result.status, result.stderr).toBe(0);
    checkPages(result.stdout, [...payNames, "owner-tempo-moderato", "owner-solana-devnet"]);
  });
  it("refuses non-http overrides for the Tempo and Solana owners before any page opens", async () => {
    const result = await run("other-owners", "ftp://x");
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("REFUSED:");
    expect(result.stdout).not.toContain("ftp://x/");
    expect(result.stdout).not.toContain('"pages"');
  });
  it("refuses a budget RPC the owner has not set before any owner page opens", async () => {
    const result = await run("pages", "https://rpc.example.test/v1/SECRET-KEY-123");
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("is not an RPC the owner set");
    expect(result.stdout).not.toMatch(/SECRET-KEY-123|"pages"/);
  });
  it.each(evmChains)("refuses an invalid %s budget RPC before an owner page can open", async chain => {
    const result = await run("pages", "ftp://x", chain);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("B4_RPC is refused");
    expect(result.stdout).toBe("");
  });
  it.each(evmChains)("keeps %s client reads on the configured local RPC", async chain => {
    const result = await run("reads", "", chain);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    checkPages(result.stdout, [...payNames, `owner-${chain}`, "owner-tempo-moderato", "owner-solana-devnet"]);
    expect(output.viemRpc).toEqual([output.configuredRpc]);
    expect(output.configuredRpc).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/configured\/SECRET-KEY-123$/);
    expect(output.reads.map((read: { method: string }) => read.method)).toEqual([
      "eth_blockNumber", "eth_blockNumber", "getBalance", "eth_blockNumber", "eth_blockNumber", "getBlockHeight", "eth_chainId", "eth_call",
    ]);
    expect(output.reads.map((read: { path: string }) => read.path)).toEqual(Array(8).fill("/configured/SECRET-KEY-123"));
  });
});
