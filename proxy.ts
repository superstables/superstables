import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE, gateToken, reviewPassword } from "@/lib/gate";
import { prefersMarkdown } from "@/lib/negotiate";

const NOINDEX = "noindex, nofollow, noarchive";

/** Public content pages and their markdown twins: the same URL serves either, chosen from Accept. */
const MARKDOWN_TWINS: Record<string, string> = {
  "/": "/index.md",
  "/docs": "/docs.md",
  "/pricing": "/pricing.md",
  "/about": "/about.md",
  "/privacy": "/privacy.md",
  "/discover": "/discover.md",
  "/submit": "/submit.md",
};

// Next replaces Vary on HTML, so negotiated HTML must not enter shared caches.
// Markdown handlers set Vary: Accept on their own responses; proxy headers alone
// do not survive static route handling. Direct .md routes keep their cache policy.
function negotiate(request: NextRequest, twin: string) {
  const agentMode = request.nextUrl.pathname === "/" && request.nextUrl.searchParams.get("mode") === "agent";
  if (agentMode || prefersMarkdown(request.headers.get("accept"))) {
    const url = request.nextUrl.clone();
    url.pathname = twin;
    const res = NextResponse.rewrite(url);
    res.headers.set("Vary", "Accept");
    return res;
  }
  const res = NextResponse.next();
  res.headers.set("Vary", "Accept");
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** /start is public (it is the door) but must never be indexed; everything behind it needs the review cookie. */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const twin = MARKDOWN_TWINS[path];
  if (twin) return negotiate(request, twin);
  if (path === "/start" || path.startsWith("/start/")) {
    const res = NextResponse.next();
    res.headers.set("X-Robots-Tag", NOINDEX);
    return res;
  }
  const cookie = request.cookies.get(GATE_COOKIE)?.value;
  if (reviewPassword() && cookie && cookie === (await gateToken(reviewPassword()))) {
    const res = NextResponse.next();
    res.headers.set("X-Robots-Tag", NOINDEX);
    return res;
  }
  const url = new URL("/start", request.url);
  url.searchParams.set("next", path);
  const res = NextResponse.redirect(url);
  res.headers.set("X-Robots-Tag", NOINDEX);
  return res;
}

export const config = {
  matcher: ["/", "/docs", "/pricing", "/about", "/privacy", "/discover", "/submit", "/start/:path*", "/app/:path*", "/onboarding/:path*"],
};
