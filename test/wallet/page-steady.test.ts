// The local wallet page keeps each request where it is while the owner reads it, and approving takes a confirmation
// that names what the wallet will sign. The wallet signs only the request that was confirmed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { usdcRequirement } from "../../src/core/chain.js";
import type { Policy } from "../../src/core/policy.js";
import type { WalletRequestView } from "../../src/core/types.js";
import { startWallet, type WalletHandle } from "../../src/wallet/daemon.js";
import { request, wallet } from "./page-browser.js";

describe("the request list", () => {
  it("keeps a card where it is while the pointer is on the list, and greys out one that ended", async () => {
    const page = wallet({ hash: "#s" });
    const [a, b, c] = [request("aaaa", 1), request("bbbb", 2), request("cccc", 3)];
    await page.show([a, b, c]);
    const [cardA, cardB, cardC] = page.pending.children;
    expect(page.pending.children).toHaveLength(3);

    page.pending.hover = true;
    // A runs out, D arrives
    await page.show([{ ...a, status: "expired" }, b, c, request("dddd", 4)]);
    expect(page.pending.children).toHaveLength(4);
    expect(page.pending.children[0]).toBe(cardA);
    expect(page.pending.children[1]).toBe(cardB);
    expect(page.pending.children[2]).toBe(cardC);
    expect(cardA.className).toContain("ended");
    expect(cardA.markup).toContain("Expired");
    expect(cardA.markup).not.toContain("data-act");
    expect(cardB.className).not.toContain("ended");
    expect(page.pending.children[3].markup).toContain("0xdddd");

    // the pointer leaves: the ended card goes, and the others do not move
    page.pending.hover = false;
    await page.show([{ ...a, status: "expired" }, b, c, request("dddd", 4)]);
    expect(page.pending.children[0]).toBe(cardB);
    expect(page.pending.children).toHaveLength(3);
  });

  it("appends a new request below the others and shows the empty line only when there are no cards", async () => {
    const page = wallet({ hash: "#s" });
    await page.show([]);
    expect(page.node("pending-empty").hidden).toBe(false);
    await page.show([request("aaaa", 1)]);
    expect(page.node("pending-empty").hidden).toBe(true);
    await page.show([request("aaaa", 1), request("bbbb", 2)]);
    expect(page.pending.children.map((c) => /0x(aaaa|bbbb)/.exec(c.markup)![1])).toEqual(["aaaa", "bbbb"]);
  });

  it("shows the raw value next to the amount and the policy the wallet applies", async () => {
    const page = wallet({ hash: "#s" });
    await page.show([request("aaaa", 1)]);
    expect(page.pending.children[0].markup).toContain("10000 = 0.01 USDC");
    const policy = page.node("policy");
    expect(policy.hidden).toBe(false);
    expect(policy.innerHTML).toContain("/home/o/.superstables/policy.yaml");
    expect(policy.innerHTML).toContain("0.05 USDC a payment, 1 USDC a day");
  });

  it("says when the policy comes from no file", async () => {
    const page = wallet({
      hash: "#s",
      answer: (call) => call.path === "/status" ? { status: 200, body: { policy: { perCall: "0.05 USDC", allow: [], deny: [], stablecoins: [], killSwitch: false } } } : undefined,
    });
    await page.show([]);
    expect(page.node("policy").innerHTML).toContain("built in, no policy file");
  });
});

describe("the policy line and the expiry row", () => {
  it("shows only that nothing is signed when the policy file cannot be used", async () => {
    const page = wallet({
      hash: "#s",
      answer: (call) => call.path === "/status" ? { status: 200, body: { policyProblem: "policy.yaml line 3 is not valid" } } : undefined,
    });
    await page.show([]);
    const html = page.node("policy").innerHTML;
    expect(html).toBe("Nothing is signed: policy.yaml line 3 is not valid");
    expect(html).not.toContain("built in");
  });

  it("keeps expiry as the last row of the card, updated in place, and hides it when the request ends", async () => {
    const page = wallet({ hash: "#s" });
    const a = request("aaaa", 1);
    await page.show([a]);
    const card = page.pending.children[0];
    const row = card.children.find((c) => c.className === "rows")!;
    const [dt, dd] = row.children;
    expect(dt.textContent).toBe("Expires in");
    expect(dd.textContent).toMatch(/^\d+ s$/);
    expect(row.children.slice(-2)).toEqual([dt, dd]);
    await page.show([{ ...a, expiresAt: a.expiresAt - 5000 }]);
    expect(row.children.slice(-2)).toEqual([dt, dd]);
    page.pending.hover = true;
    await page.show([{ ...a, status: "expired" }]);
    expect(dt.hidden).toBe(true);
    expect(dd.hidden).toBe(true);
  });
});

describe("approving takes a confirmation", () => {
  it("makes no decision on the first click, and posts what the card showed on the second", async () => {
    const page = wallet({ hash: "#s" });
    const [a, b] = [request("aaaa", 1), request("bbbb", 2)];
    await page.show([a, b]);
    const cardB = page.pending.children[1];
    await page.click(cardB, "approve");
    expect(page.decisions()).toEqual([]);
    const sentence = cardB.markup;
    expect(sentence).toContain("Sign 0.01 USDC to ");
    expect(sentence).toContain("0xbbbb");
    expect(sentence).toContain("on Base Sepolia (testnet)?");
    expect(sentence).toContain("10000");
    expect(sentence).toContain("5 minutes");
    expect(sentence).toContain("Yes, sign");

    // the list refreshes with other terms under the same id; back repaints the buttons, and approving again
    // must still name what the card showed the first time and what it will post
    await page.show([a, { ...b, verified: { ...b.verified, recipient: a.verified.recipient } }]);
    await page.click(cardB, "back");
    await page.click(cardB, "approve");
    expect(cardB.markup).toContain("0xbbbb");
    expect(cardB.markup).not.toContain("0xaaaa");
    await page.click(cardB, "confirm");
    const [post] = page.decisions();
    expect(decodeURIComponent(post.path)).toBe("/owner/requests/bbbb/approve");
    expect(post.init.headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(post.init.body!)).toEqual({ amountAtomic: "10000", recipient: b.verified.recipient, network: "eip155:84532" });
  });

  it("goes back without a decision", async () => {
    const page = wallet({ hash: "#s" });
    await page.show([request("aaaa", 1)]);
    const card = page.pending.children[0];
    await page.click(card, "approve");
    await page.click(card, "back");
    expect(page.decisions()).toEqual([]);
    expect(card.markup).toContain("Approve and sign");
    expect(card.markup).not.toContain("Yes, sign");
  });

  it("keeps an ended card in place while a confirmation is open elsewhere", async () => {
    const page = wallet({ hash: "#s" });
    const [a, b] = [request("aaaa", 1), request("bbbb", 2)];
    await page.show([a, b]);
    const [cardA, cardB] = page.pending.children;
    await page.click(cardB, "approve");
    await page.show([{ ...a, status: "denied" }, b]);
    expect(page.pending.children).toEqual([cardA, cardB]);
    await page.click(cardB, "back");
    await page.show([{ ...a, status: "denied" }, b]);
    expect(page.pending.children).toEqual([cardB]);
  });

  it("shows the wallet's refusal and leaves the card on its plain buttons", async () => {
    const page = wallet({
      hash: "#s",
      answer: (call) => call.init.method === "POST"
        ? { status: 409, body: { error: "the request changed or is not the one you confirmed; nothing was signed" } }
        : undefined,
    });
    await page.show([request("aaaa", 1)]);
    const card = page.pending.children[0];
    await page.click(card, "approve");
    await page.click(card, "confirm");
    await page.settle();
    await page.show([request("aaaa", 1)]);
    expect(page.node("notice").textContent).toBe("Not done: the request changed or is not the one you confirmed; nothing was signed.");
    // the refresh that follows must not wipe it
    expect(page.node("notice").hidden).toBe(false);
    expect(card.markup).toContain("Approve and sign");
  });

  it("builds the confirmation from the data it will post", async () => {
    const page = wallet({ hash: "#s" });
    const a = request("aaaa", 1);
    await page.show([a]);
    const card = page.pending.children[0];
    await page.click(card, "approve");
    // the wallet lists the request differently on the next tick: the sentence and the post stay what the owner was shown
    await page.show([{ ...a, verified: { ...(a.verified as object), recipient: "0x" + "9".repeat(40), amountAtomic: "99" } }]);
    expect(card.markup).toContain("0x" + "a".repeat(4));
    expect(card.markup).not.toContain("9".repeat(40));
    await page.click(card, "confirm");
    const posted = JSON.parse(page.decisions()[0].init.body!);
    expect(card.markup).not.toContain("99");
    expect(posted.recipient).toBe(`0x${"aaaa".padEnd(40, "2").slice(0, 40)}`);
    expect(posted.amountAtomic).toBe("10000");
  });

  it("rejects without a confirmation", async () => {
    const page = wallet({ hash: "#s" });
    await page.show([request("aaaa", 1)]);
    await page.click(page.pending.children[0], "deny");
    expect(page.decisions().map((c) => c.path)).toEqual(["/owner/requests/aaaa/deny"]);
  });
});

describe("the wallet signs only the request that was confirmed", () => {
  const POLICY: Policy = { perCall: { amount: 1, asset: "USDC" }, perDay: { amount: 10, asset: "USDC" }, allow: [], deny: [], stablecoins: ["USDC"], killSwitch: false, approval: "ask-every-payment" };
  const PAYEE = "0x2222222222222222222222222222222222222222";
  const OTHER = "0x3333333333333333333333333333333333333333";
  const started: { wallet: WalletHandle; dir: string }[] = [];
  afterEach(async () => {
    while (started.length) {
      const { wallet: w, dir } = started.pop()!;
      await w.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function pending() {
    const dir = mkdtempSync(join(tmpdir(), "superstables-confirm-"));
    const w = await startWallet({
      port: 0, tcp: true, dir, account: privateKeyToAccount(generatePrivateKey()), policy: POLICY, quiet: true, openBrowser: false,
      balance: false, launcherDir: join(dir, "open"),
    });
    started.push({ wallet: w, dir });
    const made = await fetch(`${w.url}/requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${w.agentToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sign: { kind: "eip3009", x402Version: 2, requirements: usdcRequirement(0.01, PAYEE), context: { target: "https://seller.example/x" } } }),
    });
    const view = (await made.json()) as WalletRequestView;
    const approve = (body?: unknown, contentType = "application/json") =>
      fetch(`${w.url}/owner/requests/${view.id}/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${w.ownerSecret}`, ...(body === undefined ? {} : { "content-type": contentType }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const status = async () =>
      ((await (await fetch(`${w.url}/requests/${view.id}`, { headers: { authorization: `Bearer ${w.agentToken}` } })).json()) as WalletRequestView).status;
    return { w, view, approve, status };
  }

  it("refuses an approval that names another recipient, amount or chain, and the request stays pending", async () => {
    const { view, approve, status } = await pending();
    const { amountAtomic, recipient, network } = view.verified;
    for (const body of [
      { amountAtomic, recipient: OTHER, network },
      { amountAtomic: "10001", recipient, network },
      { amountAtomic, recipient, network: "eip155:8453" },
      { amountAtomic, recipient },
    ]) {
      const res = await approve(body);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("the request changed or is not the one you confirmed; nothing was signed");
      expect(await status()).toBe("pending");
    }
  });

  it("refuses an approval with no body, or a body that is not JSON, and signs nothing", async () => {
    const { approve, status } = await pending();
    expect((await approve()).status).toBe(409);
    expect((await approve({ a: 1 }, "text/plain")).status).toBe(409);
    expect(await status()).toBe("pending");
  });

  it("signs when the confirmation matches, whatever the case of the address", async () => {
    const { view, approve, status } = await pending();
    const { amountAtomic, recipient, network } = view.verified;
    const res = await approve({ amountAtomic, recipient: recipient.toUpperCase().replace("0X", "0x"), network });
    expect(res.status).toBe(200);
    expect(await status()).toBe("signed");
  });
});
