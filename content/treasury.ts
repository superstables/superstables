type Wallet = { label: string; address: string; role: string; link?: { href: string; label: string } };

/** The token contract itself is shown in the contract details panel (content/token.ts). */
export const treasury: { wallets: Wallet[] } = {
  wallets: [
    {
      label: "Dev wallet",
      address: "0x1328b3d4fb7db40e0e3e72f0bde0fc45dcd9f0d9",
      role: "Rebuys STBL with part of the fees. Locked; unlock terms are on the Buy $STBL page.",
    },
    {
      label: "Marketing wallet",
      address: "0x0bbe2de46dbc1344f11f02e2444088b313d3a87a",
      role: "Buys and holds STBL for later use: exchange listings, marketing actions and similar.",
    },
  ],
};
