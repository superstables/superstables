/**
 * STBL token facts shown on /buy and /treasury. Name, symbol, decimals and supply were read
 * from the contract on Robinhood Chain (1 October 2026); they cannot change for a deployed token.
 * The contract address itself comes from the token_contract setting (see lib/settings.ts), so
 * these pages and the admin page never disagree about it.
 */

export const token = {
  name: "Superstables",
  symbol: "STBL",
  decimals: 18,
  totalSupply: "1,000,000,000",
  /** CoinGecko coin id; checked to map to the contract on Robinhood Chain. */
  coingeckoId: "superstables",
  chain: {
    name: "Robinhood Chain",
    logo: "/logos/robinhood.png",
    id: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
  },
  /** Tokenized NVDA, the other side of the main pool and the currency the trading fee is paid in. */
  nvda: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  /** The deepest STBL pool: STBL/NVDA on Uniswap v4, created through pons. */
  mainPool: {
    id: "0xc76cc63b4adceab331d583db9d0a4eb33e70064101e7ce9effd1aa16f65b27d6",
    pair: "STBL / NVDA",
    dex: "Uniswap v4",
  },
  bridge: "https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain",
  /** Another Robinhood Chain token also named Superstables (STBL). Never link it; tests check this. */
  lookalike: "0x0d75f601bff00faa0062f28375986c8a86481816",
};

/** Uniswap's swap page with Robinhood Chain selected, paying in ETH and receiving STBL. */
export const uniswapSwapUrl = (address: string) =>
  `https://app.uniswap.org/swap?chain=robinhood&inputCurrency=ETH&outputCurrency=${address}`;

export const uniswapPoolUrl = `https://app.uniswap.org/explore/pools/robinhood/${token.mainPool.id}`;

export const explorerTokenUrl = (address: string) => `${token.chain.explorer}/token/${address}`;

type Listing = { name: string; logo: string; note: string; href: (address: string) => string };

/**
 * Where to buy or follow STBL. Before a listing is added, check it against the contract address in
 * the site's own data, never by name or ticker: a look-alike token uses both. Checked 1 October 2026:
 *   Uniswap: quote API routes ETH to 0x79a7… through the STBL/NVDA pool (pons hook 0xe5e7…) and STBL/USDG.
 *   pons: page data names 0x79a7…, paired with NVDA, creator 0x1328… (the dev wallet).
 *   KyberSwap, Relay: token APIs return Superstables at 0x79a7… on chain 4663.
 *   Dexscreener, GeckoTerminal: pool 0xc76c… has base token 0x79a7… and quote NVDA 0xd060….
 *   CoinGecko (superstables), Coinbase, CoinMarketCap DexScan: list 0x79a7… on Robinhood Chain.
 * Links open on the STBL/NVDA pair, the deepest pool, wherever the site lets a link choose it.
 * Uniswap opens ETH to STBL: its page does not load tokenized NVDA as the input, and its router
 * already sends part of an ETH buy through the STBL/NVDA pool.
 */
export const listings: { buy: Listing[]; track: Listing[] } = {
  buy: [
    { name: "Uniswap", logo: "/logos/uniswap.png", note: "Pay with ETH", href: uniswapSwapUrl },
    { name: "pons", logo: "/logos/pons.png", note: "STBL / NVDA", href: (a) => `https://www.ponsfamily.com/launchpad/${a}` },
    { name: "KyberSwap", logo: "/logos/kyberswap.png", note: "STBL / NVDA", href: (a) => `https://kyberswap.com/swap/robinhood/${token.nvda}-to-${a}` },
    // Relay quotes ETH to STBL but rejects tokenized NVDA ("Unsupported currency"), checked 1 October 2026.
    { name: "Relay", logo: "/logos/relay.png", note: "Pay with ETH", href: (a) => `https://relay.link/bridge/robinhood?fromChainId=${token.chain.id}&toCurrency=${a}` },
  ],
  track: [
    { name: "Dexscreener", logo: "/logos/dexscreener.png", note: "STBL / NVDA", href: () => `https://dexscreener.com/robinhood/${token.mainPool.id}` },
    { name: "GeckoTerminal", logo: "/logos/geckoterminal.jpg", note: "STBL / NVDA", href: () => `https://www.geckoterminal.com/robinhood/pools/${token.mainPool.id}` },
    { name: "CoinGecko", logo: "/logos/coingecko.png", note: "Token page", href: () => "https://www.coingecko.com/en/coins/superstables" },
    { name: "Coinbase", logo: "/logos/coinbase.png", note: "Price page", href: () => "https://www.coinbase.com/price/superstables" },
    { name: "CoinMarketCap", logo: "/logos/coinmarketcap.png", note: "Token page", href: (a) => `https://dex.coinmarketcap.com/token/robinhood/${a}` },
  ],
};
