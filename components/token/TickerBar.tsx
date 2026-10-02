"use client";

import { useEffect, useState } from "react";
import CopyValue from "@/components/CopyValue";
import { uniswapSwapUrl } from "@/content/token";
import VerifiedMark from "./VerifiedMark";

const NAV_HEIGHT = 64; // the sticky top bar

/**
 * $STBL and the contract address, shown once the contract line under the heading (#buy-contract)
 * has scrolled under the top bar, so the address stays in sight while reading. On wide screens it
 * sits at the top of the side panel; on narrow screens (`compact`) it is pinned under the top bar,
 * with Buy on Uniswap, since the heading's buttons have scrolled away.
 *
 * Visibility is measured from the line's position on every scroll frame rather than from
 * intersection events, which a fast scroll or a jump past the line can skip.
 */
export default function TickerBar({ address, compact = false }: { address: string; compact?: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const target = document.getElementById("buy-contract");
    if (!target) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setShown(target.getBoundingClientRect().bottom <= NAV_HEIGHT);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div className={`ticker-bar${compact ? " compact" : ""}${shown ? " shown" : ""}`} aria-hidden={!shown} inert={!shown}>
      {compact ? (
        <div className="ticker-top">
          <b>$STBL</b>
          <a className="btn sm primary" href={uniswapSwapUrl(address)} target="_blank" rel="noopener noreferrer">Buy on Uniswap</a>
        </div>
      ) : (
        <b>$STBL</b>
      )}
      <CopyValue value={address} label="Copy contract address" before={<VerifiedMark />} className="ticker-address" />
    </div>
  );
}
