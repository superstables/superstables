// The agent reaches the local wallet over a socket in the wallet's private folder, and sends its token only after
// checking that the socket and its folder belong to this user. On TCP the wallet answers the page and the owner, and the
// agent's routes only when it was started with --tcp.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Policy } from "../../src/core/policy.js";
import { walletStatus } from "../../src/core/signer/wallet.js";
import { startWallet, type StartWalletOptions, type WalletHandle } from "../../src/wallet/daemon.js";

const posix = process.platform !== "win32";
const POLICY: Policy = { perCall: { amount: 1, asset: "USDC" }, perDay: { amount: 10, asset: "USDC" }, allow: [], deny: [], stablecoins: ["USDC"], killSwitch: false, approval: "ask-every-payment" };
const ENV = ["SUPERSTABLES_HOME", "SUPERSTABLES_WALLET_URL", "SUPERSTABLES_WALLET_AGENT_TOKEN"];

let tmp: string;
let home: string;
let walletFolder: string;
let saved: Record<string, string | undefined>;
const closers: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ss-socket-"));
  home = join(tmp, "home");
  walletFolder = join(home, "wallet");
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  process.env.SUPERSTABLES_HOME = home;
});
afterEach(async () => {
  vi.restoreAllMocks();
  while (closers.length > 0) await closers.pop()!();
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function start(overrides: Partial<StartWalletOptions> = {}): Promise<WalletHandle> {
  const wallet = await startWallet({
    port: 0,
    dir: walletFolder,
    account: privateKeyToAccount(generatePrivateKey()),
    policy: POLICY,
    quiet: true,
    openBrowser: false,
    balance: false,
    launcherDir: join(tmp, "open"),
    ...overrides,
  });
  closers.push(() => wallet.close());
  return wallet;
}

const socketPath = () => join(walletFolder, "agent.sock");
const overTcp = (wallet: WalletHandle, path: string, token: string) =>
  fetch(`${wallet.url}${path}`, { headers: { authorization: `Bearer ${token}` } });

/** An HTTP server on loopback that writes down every Authorization header it is sent. */
async function squatter(port = 0): Promise<{ server: HttpServer; heard: string[] } | undefined> {
  const heard: string[] = [];
  const server = createHttpServer((req, res) => {
    heard.push(String(req.headers.authorization ?? ""));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ address: "0x0000000000000000000000000000000000000001", pending: 0 }));
  });
  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (!bound) return undefined;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { server, heard };
}

/** A token the client would send, in the place it reads it from. */
function plantToken(): void {
  mkdirSync(walletFolder, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  chmodSync(walletFolder, 0o700);
  writeFileSync(join(walletFolder, "agent-token"), "planted-agent-token\n", { mode: 0o600 });
}

describe.runIf(posix)("the agent's routes are on the wallet's private socket", () => {
  it("1. walletStatus() goes over the socket; a TCP call with the agent token gets 403", async () => {
    const wallet = await start();
    const status = await walletStatus();
    expect(status.address).toBe(wallet.address);
    const tcp = await overTcp(wallet, "/status", wallet.agentToken);
    expect(tcp.status).toBe(403);
    expect(((await tcp.json()) as { error: string }).error).toMatch(/private socket.*--tcp/);
    // the owner's page and routes stay on TCP
    expect((await fetch(`${wallet.url}/`)).status).toBe(200);
    expect((await overTcp(wallet, "/owner/requests", wallet.ownerSecret)).status).toBe(200);
  });

  it("1b. SUPERSTABLES_WALLET_URL against a wallet without --tcp says the wallet answers on its socket only", async () => {
    const wallet = await start();
    process.env.SUPERSTABLES_WALLET_URL = wallet.url;
    await expect(walletStatus()).rejects.toThrow(/private socket only.*--tcp/);
    await expect(walletStatus()).rejects.not.toThrow(/not running/);
  });

  it("2. sends nothing to a squatter on the wallet's old port when no wallet is running", async (ctx) => {
    plantToken();
    const fake = await squatter(4411);
    if (!fake) return ctx.skip(); // 4411 is taken on this machine: the case cannot be set up
    await expect(walletStatus()).rejects.toThrow(/no socket at/);
    expect(fake.heard).toEqual([]);
  });

  it("2b. sends nothing to a squatter on any port", async () => {
    plantToken();
    const fake = (await squatter())!;
    await expect(walletStatus()).rejects.toThrow(/no socket at/);
    expect(fake.heard).toEqual([]);
  });

  describe("3. a socket that is not this user's wallet's gets no token", () => {
    it("a regular file in its place", async () => {
      plantToken();
      writeFileSync(socketPath(), "", { mode: 0o600 });
      await expect(walletStatus()).rejects.toThrow(/is not this user's wallet socket.*the token was not sent/);
    });

    it("a symlink to another socket", async () => {
      plantToken();
      const heard: string[] = [];
      const other: NetServer = createNetServer((socket) => {
        socket.on("data", (chunk) => heard.push(chunk.toString()));
        socket.end();
      });
      const elsewhere = join(tmp, "other.sock");
      await new Promise<void>((resolve) => other.listen(elsewhere, resolve));
      closers.push(() => new Promise<void>((resolve) => other.close(() => resolve())));
      symlinkSync(elsewhere, socketPath());
      await expect(walletStatus()).rejects.toThrow(/is not this user's wallet socket.*the token was not sent/);
      expect(heard).toEqual([]);
    });

    it("a folder other users can write to", async () => {
      await start();
      chmodSync(walletFolder, 0o777);
      try {
        await expect(walletStatus()).rejects.toThrow(/is not this user's wallet socket.*the token was not sent/);
      } finally {
        chmodSync(walletFolder, 0o700);
      }
    });

    it("a socket that belongs to another user", async () => {
      await start();
      vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(process.getuid!() + 1);
      await expect(walletStatus()).rejects.toThrow(/is not this user's wallet socket.*the token was not sent/);
    });
  });

  it("4. the socket is 0600 in a 0700 folder; a stale one is replaced, a live one refuses a second wallet", async () => {
    // a socket left behind by a wallet that was killed
    mkdirSync(walletFolder, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    chmodSync(walletFolder, 0o700);
    const killed = spawnSync(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(socketPath())}, () => process.kill(process.pid, "SIGKILL"))`,
    ]);
    expect(killed.signal).toBe("SIGKILL");
    expect(statSync(socketPath()).isSocket()).toBe(true);

    const wallet = await start();
    expect(statSync(socketPath()).isSocket()).toBe(true);
    expect(statSync(socketPath()).mode & 0o777).toBe(0o600);
    expect(statSync(walletFolder).mode & 0o777).toBe(0o700);
    expect((await walletStatus()).address).toBe(wallet.address);

    await expect(start()).rejects.toThrow(/another wallet is already running/);
    // the first one still answers
    expect((await walletStatus()).address).toBe(wallet.address);
    await wallet.close();
    expect(existsSync(socketPath())).toBe(false);
  });

  it("4b. the socket answers only the agent: no page, no owner routes", async () => {
    const wallet = await start();
    const viaSocket = (path: string, token?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ socketPath: socketPath(), path, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await viaSocket("/")).toBe(404);
    expect(await viaSocket("/owner/requests", wallet.ownerSecret)).toBe(404);
    expect(await viaSocket("/status", wallet.ownerSecret)).toBe(401);
    expect(await viaSocket("/status", wallet.agentToken)).toBe(200);
  });

  it("5. with --tcp the agent's routes answer on TCP too", async () => {
    const wallet = await start({ tcp: true });
    expect((await overTcp(wallet, "/status", wallet.agentToken)).status).toBe(200);
    expect((await walletStatus()).address).toBe(wallet.address);
  });

  it("keeps SUPERSTABLES_WALLET_URL as an opt-in TCP route", async () => {
    const wallet = await start({ tcp: true });
    process.env.SUPERSTABLES_WALLET_URL = wallet.url;
    expect((await walletStatus()).address).toBe(wallet.address);
  });
});
