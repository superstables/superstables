"use client";

import { useEffect, useState } from "react";
import { CopyBtn } from "@/components/app/ui";
import VerifiedMark from "./VerifiedMark";

/**
 * $STBL and the contract address at the top of the side panel, shown once the contract line under
 * the heading (#buy-contract) has scrolled out of view, so the address stays in sight while reading.
 */
export default function TickerBar({ address }: { address: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const target = document.getElementById("buy-contract");
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => setShown(!entry.isIntersecting && entry.boundingClientRect.top < 0), {
      rootMargin: "-64px 0px 0px 0px", // below the sticky top bar
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={`ticker-bar${shown ? " shown" : ""}`} aria-hidden={!shown}>
      <div className="ticker-top">
        <b>$STBL</b>
        <CopyBtn text={address} className="btn sm" />
      </div>
      <span className="ticker-address mono"><VerifiedMark />{address}</span>
    </div>
  );
}
