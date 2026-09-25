export const treasury = {
  wallets: [
    {
      label: "Token contract (STBL)",
      address: "0x79a74fd91f8e1c4ab8e76253dec5c91f3094393f",
      role: "The token. Trades against tokenized NVDA on Robinhood Chain; every trade carries the 1% fee this page accounts for.",
      link: { href: "https://www.ponsfamily.com/launchpad/0x79a74fd91f8e1c4ab8e76253dec5c91f3094393f", label: "View the pair on pons" },
    },
    {
      label: "Dev wallet",
      address: "0x1328b3d4fb7db40e0e3e72f0bde0fc45dcd9f0d9",
      role: "Rebuys STBL with part of the fees. Locked; unlock terms are on the Contract page.",
    },
    {
      label: "Marketing wallet",
      address: "0x0bbe2de46dbc1344f11f02e2444088b313d3a87a",
      role: "Buys and holds STBL for later use: exchange listings, marketing actions and similar.",
    },
  ],

};
