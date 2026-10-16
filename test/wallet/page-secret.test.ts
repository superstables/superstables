// The local wallet page never stores the owner secret: it takes it from the launcher's fragment, keeps it in the script's
// memory, and asks for it again after a reload.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { startWallet, type WalletHandle } from "../../src/wallet/daemon.js";
import { walletPage } from "../../src/wallet/page.js";
import { STORAGE_KEY, request, wallet } from "./page-browser.js";

describe("the page and the owner secret", () => {
  it("takes the secret out of the address bar, keeps it in no storage, and sends it as the bearer", async () => {
    const page = wallet({ hash: "#sekrit" });
    await page.settle();
    expect(page.location.hash).toBe("");
    expect(page.store.size).toBe(0);
    const listed = page.calls.find((c) => c.path === "/owner/requests");
    expect(listed?.init.headers?.Authorization).toBe("Bearer sekrit");
  });

  it("does not sign a reload in: a secret an older page left in sessionStorage is not used, and the page asks", async () => {
    const page = wallet({ hash: "", stored: { [STORAGE_KEY]: "left-by-an-older-page" } });
    await page.settle();
    expect(page.calls.filter((c) => c.path === "/owner/requests")).toEqual([]);
    expect(page.node("unlock").hidden).toBe(false);
    const say = page.node("notice").innerHTML;
    expect(say).toContain("This page does not keep the owner secret");
    expect(say).toContain("<code>superstables --wallet local wallet open</code>");
    expect(say).toContain("owner-secret");
  });

  it("keeps a pasted secret out of storage too, and shows the requests once it is accepted", async () => {
    const page = wallet({});
    await page.settle();
    const input = page.node("secret-input");
    input.value = "http://127.0.0.1:4411/#pasted";
    page.node("unlock").fire("submit", { preventDefault: () => undefined });
    await page.show([request("aaaa", 1)]);
    expect(page.store.size).toBe(0);
    expect(page.calls.find((c) => c.path === "/owner/requests")?.init.headers?.Authorization).toBe("Bearer pasted");
    expect(page.pending.children).toHaveLength(1);
  });

  it("asks again when the wallet does not accept the secret", async () => {
    const page = wallet({ hash: "#wrong", answer: (call) => (call.path === "/owner/requests" ? { status: 401, body: {} } : undefined) });
    await page.settle();
    expect(page.node("unlock").hidden).toBe(false);
    expect(page.node("notice").textContent).toContain("not right");
    expect(page.store.size).toBe(0);
  });

  it("names no browser storage anywhere in the page", () => {
    const html = walletPage("plain", "n0nce");
    expect(html).not.toMatch(/sessionStorage|localStorage|document\.cookie/);
  });
});

describe("the page's content security policy", () => {
  const started: WalletHandle[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    while (started.length) await started.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("puts a fresh nonce in the header and on the page's one executable script", () => {
    const html = walletPage("plain", "abc123");
    expect(html).toContain('<script nonce="abc123">');
    // the other script is a data block, which the policy does not run
    const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.filter((attrs) => !/type="application\/json"/.test(attrs))).toEqual([' nonce="abc123"']);
  });

  it("is served with script-src for that nonce only, and a different nonce for each load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "superstables-page-csp-"));
    dirs.push(dir);
    const wallet = await startWallet({
      port: 0, dir, account: privateKeyToAccount(generatePrivateKey()), quiet: true, openBrowser: false, balance: false,
      launcherDir: join(dir, "open"),
    });
    started.push(wallet);
    const nonces: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${wallet.url}/`);
      const csp = res.headers.get("content-security-policy") ?? "";
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(await res.text()).toContain(`<script nonce="${nonce}">`);
      nonces.push(nonce!);
    }
    expect(nonces[0]).not.toBe(nonces[1]);
  });
});
