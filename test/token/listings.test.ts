// Every link on /buy must lead to the official STBL contract or its main pool, and never to the
// look-alike token that copies the name and ticker. See content/token.ts for how each was checked.

import { describe, expect, it } from "vitest";
import { tokenContract } from "@/content/site";
import { listings, token, uniswapPoolUrl, uniswapSwapUrl } from "@/content/token";

const address = tokenContract!;
// Sites whose link names the coin by an id instead of the address; the id was checked to map to it.
const ID_LINKS = new Set(["CoinGecko", "Coinbase"]);

describe("STBL listings", () => {
  const all = [...listings.buy, ...listings.track];

  it("start with Uniswap, then pons", () => {
    expect(listings.buy.map((l) => l.name).slice(0, 2)).toEqual(["Uniswap", "pons"]);
  });

  it.each(all.map((l) => [l.name, l.href(address)]))("%s links to the contract or the main pool", (name, href) => {
    const lower = href.toLowerCase();
    if (!ID_LINKS.has(name)) expect(lower.includes(address.toLowerCase()) || lower.includes(token.mainPool.id)).toBe(true);
    expect(lower).not.toContain(token.lookalike);
  });

  it("never point the swap or pool links at the look-alike", () => {
    for (const href of [uniswapSwapUrl(address), uniswapPoolUrl]) expect(href.toLowerCase()).not.toContain(token.lookalike);
    expect(uniswapSwapUrl(address)).toContain(`outputCurrency=${address}`);
  });
});
