// The MPP wire format this client reads and writes (src/core/mpp.ts), checked against mppx itself: a challenge mppx
// writes is read back field for field, a credential this client writes is one mppx reads, and the seller's request
// travels back byte for byte, because the seller's challenge id is an HMAC over it.

import { Challenge, Credential } from "mppx";
import { describe, expect, it } from "vitest";
import { hashCredential, parseMppChallenges, readMppReceipt } from "../../src/core/mpp.js";
import { readSellerChallenge } from "../../src/core/x402.js";

const PATH_USD = "0x20C0000000000000000000000000000000000000";
const RECIPIENT = `0x${"22".repeat(20)}`;
const PAYER = "0x1111111111111111111111111111111111111111";

const request = { amount: "10000", currency: PATH_USD, recipient: RECIPIENT, methodDetails: { chainId: 42431, supportedModes: ["push", "pull"] } };

function charge(over: Partial<Parameters<typeof Challenge.from>[0]> = {}) {
  return Challenge.from({
    id: "challenge-1",
    realm: "seller.example",
    method: "tempo",
    intent: "charge",
    request,
    expires: "2026-10-05T12:00:00.000Z",
    ...over,
  } as Parameters<typeof Challenge.from>[0]);
}

describe("parseMppChallenges", () => {
  it("reads a challenge mppx serialises, field for field, and keeps its request exactly as sent", () => {
    const issued = charge({ description: 'One "quoted" answer, — with a dash', opaque: "b3BhcXVl" } as never);
    const header = Challenge.serialize(issued);
    const [read] = parseMppChallenges(header);
    expect(read).toMatchObject({ id: issued.id, realm: issued.realm, method: "tempo", intent: "charge", expires: issued.expires, description: issued.description, opaque: "b3BhcXVl" });
    expect(read.request).toEqual(request);
    // The request goes back as the seller wrote it: the raw parameter of the header.
    expect(header).toContain(`request="${read.requestRaw}"`);
    expect(Challenge.deserialize(header).request).toEqual(read.request);
  });

  it("reads several challenges in one header and skips other schemes and malformed ones", () => {
    const tempo = Challenge.serialize(charge());
    const stripe = Challenge.serialize(charge({ id: "challenge-2", method: "stripe" }));
    const header = `Bearer realm="api", ${tempo}, Payment id="bad", realm="x", method="Tempo", intent="charge", request="e30", ${stripe}`;
    const read = parseMppChallenges(header);
    expect(read.map((c) => `${c.method}:${c.id}`)).toEqual(["tempo:challenge-1", "stripe:challenge-2"]);
    expect(Challenge.deserializeList(`${tempo}, ${stripe}`).map((c) => c.id)).toEqual(read.map((c) => c.id));
  });

  it("refuses a challenge with a request that is not a JSON object, a malformed expiry or a repeated parameter", () => {
    expect(parseMppChallenges('Payment id="a", realm="r", method="tempo", intent="charge", request="bm90IGpzb24"')).toEqual([]);
    expect(parseMppChallenges('Payment id="a", realm="r", method="tempo", intent="charge", request="W10"')).toEqual([]);
    const raw = Buffer.from(JSON.stringify(request)).toString("base64url");
    expect(parseMppChallenges(`Payment id="a", realm="r", method="tempo", intent="charge", request="${raw}", expires="tomorrow"`)).toEqual([]);
    expect(parseMppChallenges(`Payment id="a", id="b", realm="r", method="tempo", intent="charge", request="${raw}"`)).toEqual([]);
    expect(parseMppChallenges(`Payment id="a", realm="r", method="tempo", intent="charge", request="${raw}"`)).toHaveLength(1);
    expect(parseMppChallenges(null)).toEqual([]);
  });

  it("keeps a header the seller names for the credential, and drops the default one", () => {
    const raw = Buffer.from(JSON.stringify(request)).toString("base64url");
    expect(parseMppChallenges(`Payment id="a", realm="r", method="tempo", intent="charge", request="${raw}", header="X-Pay"`)[0].header).toBe("X-Pay");
    expect(parseMppChallenges(`Payment id="a", realm="r", method="tempo", intent="charge", request="${raw}", header="Authorization"`)[0].header).toBeUndefined();
  });
});

describe("readSellerChallenge", () => {
  it("reads an MPP-only 402, and refuses a 402 that carries neither protocol", () => {
    const read = readSellerChallenge({ wwwAuthenticate: Challenge.serialize(charge({ description: "One answer" } as never)), body: "{}" });
    expect(read.x402).toBeUndefined();
    expect(read.mpp).toHaveLength(1);
    expect(read.description).toBe("One answer");
    expect(() => readSellerChallenge({ body: "<html>402</html>" })).toThrow(/No payment challenge \(x402 or MPP\)/);
  });
});

describe("hashCredential", () => {
  it("writes the credential mppx's client writes for a payment it pushed, which mppx reads back", () => {
    const issued = charge({ opaque: "b3BhcXVl" } as never);
    const [read] = parseMppChallenges(Challenge.serialize(issued));
    const hash = `0x${"ab".repeat(32)}`;
    const header = hashCredential(read, hash, { address: PAYER, chainId: 42431 });
    expect(header.startsWith("Payment ")).toBe(true);
    const parsed = Credential.deserialize(header);
    expect(parsed.payload).toEqual({ hash, type: "hash" });
    expect(parsed.source).toBe(`did:pkh:eip155:42431:${PAYER}`);
    expect(parsed.challenge.id).toBe(issued.id);
    expect(parsed.challenge.realm).toBe(issued.realm);
    expect(parsed.challenge.expires).toBe(issued.expires);
    expect(parsed.challenge.opaque).toBe("b3BhcXVl");
    expect(parsed.challenge.request).toEqual(request);
    // The request travels as the seller sent it, so an HMAC-bound id still matches.
    const wire = JSON.parse(Buffer.from(header.slice("Payment ".length), "base64url").toString("utf8"));
    expect(wire.challenge.request).toBe(read.requestRaw);
  });
});

describe("readMppReceipt", () => {
  it("reads a seller's Payment-Receipt and ignores anything else", () => {
    const header = Buffer.from(JSON.stringify({ method: "tempo", reference: "0xabc", status: "success" })).toString("base64url");
    expect(readMppReceipt(header)).toMatchObject({ status: "success", reference: "0xabc" });
    expect(readMppReceipt("not base64 !")).toBeUndefined();
    expect(readMppReceipt(Buffer.from("[1]").toString("base64url"))).toBeUndefined();
    expect(readMppReceipt(undefined)).toBeUndefined();
  });
});
