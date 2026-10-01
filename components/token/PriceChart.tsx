"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/** "dark" or "light" as the page shows it; null on the server, where the chart is not rendered. */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", onChange);
  return () => { observer.disconnect(); media.removeEventListener("change", onChange); };
}
const scheme = () => (getComputedStyle(document.documentElement).colorScheme === "light" ? "light" : "dark");

// The widget script runs in a sandboxed frame without allow-same-origin, so it cannot read or
// change this page (which shows the contract address). It expects Web Storage, which an opaque
// origin does not have, so the frame provides an in-memory stand-in before loading it.
const frame = (coinId: string, dark: boolean) => `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:transparent;color-scheme:${dark ? "dark" : "light"}}</style>
<script>(function(){function M(){var d={};return{getItem:function(k){return k in d?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}
["sessionStorage","localStorage"].forEach(function(n){try{window[n]}catch(e){Object.defineProperty(window,n,{value:M(),configurable:true})}})})();</script>
<script src="https://widgets.coingecko.com/gecko-coin-price-chart-widget.js"></script></head><body>
<gecko-coin-price-chart-widget locale="en" dark-mode="${dark}" outlined="false" transparent-background="true" initial-currency="usd" coin-id="${coinId}" width="0" height="300"></gecko-coin-price-chart-widget>
<script>(function(){var w=document.querySelector("gecko-coin-price-chart-widget");new ResizeObserver(function(){var h=w.getBoundingClientRect().height;if(h>100)parent.postMessage({ stblChartHeight: h }, "*")}).observe(w)})();</script>
</body></html>`;

/** CoinGecko's price chart for a coin, following the site's light and dark mode. */
export default function PriceChart({ coinId }: { coinId: string }) {
  const mode = useSyncExternalStore(subscribe, scheme, () => null);
  const ref = useRef<HTMLIFrameElement>(null);
  // The frame reports the widget's rendered height, so the whole chart and its credit stay visible.
  const [height, setHeight] = useState<number | null>(null);
  // A content blocker can stop CoinGecko's script; after a while, offer a link instead of an empty box.
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (height) return;
    const timer = setTimeout(() => setBlocked(true), 8000);
    return () => clearTimeout(timer);
  }, [height, mode]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const h = (e.data as { stblChartHeight?: unknown } | null)?.stblChartHeight;
      if (e.source === ref.current?.contentWindow && typeof h === "number" && h > 100 && h < 1200) setHeight(Math.ceil(h));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <div className="price-chart" style={height ? { height } : blocked ? { height: 96 } : undefined}>
      {blocked && !height && (
        <div className="chart-fallback">
          <a className="link" href={`https://www.coingecko.com/en/coins/${coinId}`} target="_blank" rel="noopener noreferrer">View the STBL price chart on CoinGecko</a>
        </div>
      )}
      {mode && !(blocked && !height) && (
        <iframe
          key={mode}
          ref={ref}
          title="STBL price chart from CoinGecko"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          srcDoc={frame(coinId, mode === "dark")}
          style={{ colorScheme: mode }}
        />
      )}
    </div>
  );
}
