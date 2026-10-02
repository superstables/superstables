// The tempo rail's checks before an agent signs a payment: a budget that cannot cover the price, a seller the key may not pay,
// and a seller that asks for its own payment memo are refused before anything is signed. Pure: no chain, no key.

import { describe, expect, it } from "vitest";
import { budgetShortfall, precheckCharge, recipientsOutsideScope, TRANSFER_WITH_MEMO_SELECTOR } from "../../budget/tempo/lib/precheck.mjs";

const PATH_USD = "0x20C0000000000000000000000000000000000000";
const SELLER = "0xFD24114C3981Aba78aE2441991B1BdB89329c556";
const OTHER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const charge = (methodDetails: Record<string, unknown> = {}) => ({ amount: "1000", currency: PATH_USD, recipient: SELLER, methodDetails: { chainId: 42431, feePayer: true, ...methodDetails } });

describe("a tempo budget that cannot cover the price", () => {
  it("is refused before signing, with what is left and the price", () => {
    expect(budgetShortfall({ spendPolicy: "limited", remaining: 500n, periodEnd: 0 }, 1000n)).toBe("price 0.001 pathUSD exceeds the remaining budget 0.0005 pathUSD");
  });

  it("names the end of the current period when the limit refills before the key expires", () => {
    const now = Date.parse("2026-10-02T09:24:30Z");
    const end = Date.parse("2026-10-02T09:26:07Z") / 1000;
    expect(budgetShortfall({ spendPolicy: "limited", remaining: 0n, periodEnd: end, expiry: end + 3600 }, 1000n, now)).toBe("price 0.001 pathUSD exceeds the remaining budget 0 pathUSD; the current period ends at 2026-10-02T09:26:07.000Z, when the limit refills");
    expect(budgetShortfall({ spendPolicy: "limited", remaining: 500n, periodEnd: end, expiry: end + 3600 }, 1000n, now)).toMatch(/remaining budget 0.0005 pathUSD; the current period ends/);
  });

  it("promises no refill at or after the key's expiry", () => {
    const now = Date.parse("2026-10-02T09:24:30Z");
    const end = Date.parse("2026-10-02T09:26:07Z") / 1000;
    expect(budgetShortfall({ spendPolicy: "limited", remaining: 0n, periodEnd: end, expiry: end }, 1000n, now)).not.toMatch(/period|refill/);
  });

  it("says nothing of a refill time that has passed", () => {
    const now = Date.parse("2026-10-02T10:00:00Z");
    expect(budgetShortfall({ spendPolicy: "limited", remaining: 0n, periodEnd: now / 1000 - 60 }, 1000n, now)).not.toMatch(/refill/);
  });

  it("lets a budget that covers the price, or a key with no limit, through", () => {
    expect(budgetShortfall({ spendPolicy: "limited", remaining: 1000n, periodEnd: 0 }, 1000n)).toBeNull();
    expect(budgetShortfall({ spendPolicy: "unlimited", remaining: 0n, periodEnd: 0 }, 1000n)).toBeNull();
  });
});

describe("a seller that asks for its own payment memo", () => {
  it("is refused before signing: current MPP payments carry the challenge's memo, so it would not accept the payment", () => {
    const r = precheckCharge(charge({ memo: "0x06290f843a33bec051f566435f924d867f909e63065721e12664883c966336cb", supportedModes: ["pull"] }), { maxBase: 1_000_000n });
    expect(r).toMatchObject({ ok: false, code: "seller_memo" });
  });

  it("does not affect a seller that leaves the memo to the client", () => {
    expect(precheckCharge(charge(), { maxBase: 1000n, payTo: SELLER })).toMatchObject({ ok: true, amount: 1000n, recipient: SELLER });
  });
});

describe("a tempo key granted with a seller list", () => {
  const scoped = (recipients: string[]) => ({ scoped: true, scopes: [{ target: PATH_USD, selectorRules: [{ selector: "0xa9059cbb", recipients }, { selector: TRANSFER_WITH_MEMO_SELECTOR, recipients }] }] });

  it("may pay a listed seller", () => {
    expect(recipientsOutsideScope(scoped([SELLER]), [SELLER.toLowerCase()])).toEqual([]);
  });

  it("may not pay anyone else, including a split to another address", () => {
    expect(recipientsOutsideScope(scoped([SELLER]), [OTHER])).toEqual([OTHER]);
    expect(recipientsOutsideScope(scoped([SELLER]), [SELLER, OTHER])).toEqual([OTHER]);
  });

  it("may pay anyone when the key has no seller list", () => {
    expect(recipientsOutsideScope({ scoped: false, scopes: [] }, [OTHER])).toEqual([]);
  });

  it("may pay nobody when its calls do not include a memo transfer on pathUSD", () => {
    expect(recipientsOutsideScope({ scoped: true, scopes: [{ target: PATH_USD, selectorRules: [{ selector: "0xa9059cbb", recipients: [SELLER] }] }] }, [SELLER])).toEqual([SELLER]);
    expect(recipientsOutsideScope({ scoped: true, scopes: [] }, [SELLER])).toEqual([SELLER]);
  });
});
