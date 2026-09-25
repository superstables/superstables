"use client";

import { GoogleAnalytics, sendGAEvent } from "@next/third-parties/google";
import { usePathname } from "next/navigation";
import Script from "next/script";

const GA_ID = process.env.NEXT_PUBLIC_GA_ID;
/** X (Twitter) conversion tracking pixel, used to build website audiences. */
const X_PIXEL_ID = process.env.NEXT_PUBLIC_X_PIXEL_ID ?? "rfvy9";
/** Public pages only. Nothing behind the review gate is measured. */
const PRIVATE = ["/app", "/onboarding", "/start"];

export default function Analytics() {
  const path = usePathname();
  if (PRIVATE.some((p) => path === p || path.startsWith(p + "/"))) return null;
  return (
    <>
      {GA_ID && <GoogleAnalytics gaId={GA_ID} />}
      {X_PIXEL_ID && <XPixel id={X_PIXEL_ID} />}
    </>
  );
}

/** X conversion tracking base code, as given by X Ads Manager's manual setup. */
function XPixel({ id }: { id: string }) {
  return (
    <Script id="x-pixel" strategy="afterInteractive">
      {`!function(e,t,n,s,u,a){e.twq||(s=e.twq=function(){s.exe?s.exe.apply(s,arguments):s.queue.push(arguments);
},s.version='1.1',s.queue=[],u=t.createElement(n),u.async=!0,u.src='https://static.ads-twitter.com/uwt.js',
a=t.getElementsByTagName(n)[0],a.parentNode.insertBefore(u,a))}(window,document,'script');
twq('config',${JSON.stringify(id)});`}
    </Script>
  );
}

/** Fire a GA4 event. Safe to call when GA is not configured. */
export function track(name: string, params: Record<string, string | number | boolean> = {}) {
  if (!GA_ID) return;
  try {
    sendGAEvent("event", name, params);
  } catch {
    /* ignore */
  }
}
