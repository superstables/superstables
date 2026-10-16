// `wallet open` writes a fresh launcher for the running wallet and opens it, so a page that no longer keeps the owner
// secret can be reopened signed in.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { openWalletPage, startWallet, type WalletHandle } from "../../src/wallet/daemon.js";

const dirs: string[] = [];
const wallets: WalletHandle[] = [];
afterEach(async () => {
  while (wallets.length) await wallets.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function running() {
  const dir = mkdtempSync(join(tmpdir(), "superstables-open-"));
  dirs.push(dir);
  const wallet = await startWallet({
    port: 0, dir: join(dir, "wallet"), account: privateKeyToAccount(generatePrivateKey()), quiet: true, openBrowser: false, balance: false,
    launcherDir: join(dir, "wallet-launcher"),
  });
  wallets.push(wallet);
  return { dir, wallet };
}

describe("wallet open", () => {
  it("opens a fresh launcher that signs the page in, readable by this user only", async () => {
    const { dir, wallet } = await running();
    const opened: string[] = [];
    const launcher = await openWalletPage({ dir: join(dir, "wallet"), launcherDir: join(dir, "open"), opener: (t) => void opened.push(t) });
    expect(opened).toEqual([launcher]);
    expect(launcher.startsWith(join(dir, "open") + "/")).toBe(true);
    expect(statSync(launcher).mode & 0o777).toBe(0o600);
    expect(readFileSync(launcher, "utf8")).toContain(`location.replace("${wallet.url}/#${wallet.ownerSecret}")`);
    expect(statSync(join(dir, "wallet", "page-port")).mode & 0o777).toBe(0o600);
  });

  it("says to start the wallet when none is running, including one that crashed and left its port file", async () => {
    const { dir, wallet } = await running();
    const port = readFileSync(join(dir, "wallet", "page-port"), "utf8");
    await wallet.close();
    expect(existsSync(join(dir, "wallet", "page-port"))).toBe(false);
    const opened: string[] = [];
    const attempt = () => openWalletPage({ dir: join(dir, "wallet"), launcherDir: join(dir, "open"), opener: (t) => void opened.push(t) });
    await expect(attempt()).rejects.toThrow(/start it first/);
    // a stale file naming a port nothing answers on
    writeFileSync(join(dir, "wallet", "page-port"), `${port.trim()} ${process.pid}\n`);
    await expect(attempt()).rejects.toThrow(/start it first/);
    expect(opened).toEqual([]);
    expect(existsSync(join(dir, "open"))).toBe(false);
  });

  it("names its launchers after the wallet, so the wallet deletes them all when it stops", async () => {
    const { dir, wallet } = await running();
    const launcherDir = join(dir, "wallet-launcher");
    const attempt = () => openWalletPage({ dir: join(dir, "wallet"), launcherDir, opener: () => undefined });
    const first = await attempt();
    const second = await attempt();
    expect(first).not.toBe(second);
    expect(existsSync(first) && existsSync(second)).toBe(true);
    expect(readFileSync(join(dir, "wallet", "page-port"), "utf8").trim()).toBe(`${wallet.port} ${process.pid}`);
    await wallet.close();
    expect(existsSync(first) || existsSync(second)).toBe(false);
    expect(existsSync(launcherDir)).toBe(false);
  });

  it("refuses a page-port file without the wallet's pid", async () => {
    const { dir, wallet } = await running();
    writeFileSync(join(dir, "wallet", "page-port"), `${wallet.port}\n`);
    await expect(openWalletPage({ dir: join(dir, "wallet"), launcherDir: join(dir, "open"), opener: () => undefined })).rejects.toThrow(/start it first/);
    expect(readdirSync(dir)).not.toContain("open");
  });

  it("sends no secret to something that cannot prove it holds it", async () => {
    const { dir, wallet } = await running();
    const { createServer } = await import("node:http");
    // a stand-in on another port that serves a page like the wallet's, without knowing the owner secret
    const fake = createServer((_req, res) => res.end("<title>Local wallet</title>"));
    await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
    const port = (fake.address() as { port: number }).port;
    writeFileSync(join(dir, "wallet", "page-port"), `${port} ${process.pid}\n`);
    const opened: string[] = [];
    try {
      await expect(openWalletPage({ dir: join(dir, "wallet"), launcherDir: join(dir, "open"), opener: (t) => void opened.push(t) })).rejects.toThrow(/start it first/);
    } finally {
      fake.close();
    }
    expect(opened).toEqual([]);
    expect(existsSync(join(dir, "open"))).toBe(false);
    void wallet;
  });

  it("refuses a stand-in that redirects to the real wallet", async () => {
    const { dir, wallet } = await running();
    const { createServer } = await import("node:http");
    const fake = createServer((req, res) => {
      res.writeHead(302, { location: `${wallet.url}${req.url}` });
      res.end();
    });
    await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
    writeFileSync(join(dir, "wallet", "page-port"), `${(fake.address() as { port: number }).port} ${process.pid}\n`);
    const opened: string[] = [];
    try {
      await expect(openWalletPage({ dir: join(dir, "wallet"), launcherDir: join(dir, "open"), opener: (t) => void opened.push(t) })).rejects.toThrow(/start it first/);
    } finally {
      fake.close();
    }
    expect(opened).toEqual([]);
    expect(existsSync(join(dir, "open"))).toBe(false);
  });

  it("refuses a stand-in that forwards to the real wallet with its real Host header", async () => {
    const { dir, wallet } = await running();
    const { createServer } = await import("node:http");
    const fake = createServer((req, res) => {
      void fetch(`${wallet.url}${req.url}`, { headers: { host: `127.0.0.1:${wallet.port}` } }).then(async (upstream) => {
        const headers: Record<string, string> = {};
        upstream.headers.forEach((value, key) => {
          if (key !== "content-encoding" && key !== "content-length" && key !== "transfer-encoding") headers[key] = value;
        });
        res.writeHead(upstream.status, headers);
        res.end(await upstream.text());
      });
    });
    await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
    writeFileSync(join(dir, "wallet", "page-port"), `${(fake.address() as { port: number }).port} ${process.pid}\n`);
    const opened: string[] = [];
    try {
      await expect(openWalletPage({ dir: join(dir, "wallet"), launcherDir: join(dir, "open"), opener: (t) => void opened.push(t) })).rejects.toThrow(/start it first/);
    } finally {
      fake.close();
    }
    expect(opened).toEqual([]);
    expect(existsSync(join(dir, "open"))).toBe(false);
  });
});
