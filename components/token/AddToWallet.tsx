"use client";

import { useState } from "react";
import { token } from "@/content/token";
import { browserWallet, switchToRobinhood } from "./wallet";

/** Asks the browser wallet to show STBL (EIP-747). Nothing is signed or sent. */
export default function AddToWallet({ address }: { address: string }) {
  const [note, setNote] = useState<string | null>(null);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      {note && <span style={{ fontSize: 13, color: "var(--ink-2)" }}>{note}</span>}
      <button
        type="button"
        className="btn sm"
        onClick={async () => {
          const wallet = browserWallet();
          if (!wallet) return setNote("No browser wallet found.");
          try {
            await switchToRobinhood(wallet);
            const added = await wallet.request({
              method: "wallet_watchAsset",
              params: { type: "ERC20", options: { address, symbol: token.symbol, decimals: token.decimals } },
            });
            setNote(added ? "STBL added to your wallet’s token list." : null);
          } catch {
            setNote(null);
          }
        }}
      >
        Add STBL to wallet
      </button>
    </span>
  );
}
