"use client";

import { token } from "@/content/token";

/** The browser wallet (MetaMask, Rabby, Coinbase Wallet…) through EIP-1193. The site never signs. */
type Eip1193 = {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
};

export function browserWallet(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { ethereum?: Eip1193 }).ethereum) ?? null;
}

export const chainHex = `0x${token.chain.id.toString(16)}`;

/** Switches the wallet to Robinhood Chain, adding the network first if the wallet does not know it. */
export async function switchToRobinhood(wallet: Eip1193) {
  try {
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await wallet.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: chainHex,
        chainName: token.chain.name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [token.chain.rpcUrl],
        blockExplorerUrls: [token.chain.explorer],
      }],
    });
  }
}
