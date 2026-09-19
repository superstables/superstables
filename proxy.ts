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
  "/contact": "/contact.md",
  "/discover": "/discover.md",
  "/submit": "/submit.md",
  "/demo": "/demo.md",
  "/demo-feedback": "/demo-feedback.md",
};

// A client that prefers text/markdown is redirected (303) to the twin URL rather than
// served markdown in place: the HTML answer for a page URL then never varies, so it keeps
// its normal CDN caching (Next replaces Vary on HTML, which would make an in-place
// rewrite unsafe in shared caches). The redirect itself is never cached. /?mode=agent is
// a distinct URL and is rewritten to the markdown homepage directly.
function negotiate(request: NextRequest, twin: string) {
  const url = request.nextUrl.clone();
  url.pathname = twin;
  url.search = "";
  if (request.nextUrl.pathname === "/" && request.nextUrl.searchParams.get("mode") === "agent") {
    const res = NextResponse.rewrite(url);
    res.headers.set("Vary", "Accept");
    return res;
  }
  if (prefersMarkdown(request.headers.get("accept"))) {
    const res = NextResponse.redirect(url, 303);
    res.headers.set("Vary", "Accept");
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  return NextResponse.next();
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
  matcher: ["/", "/docs", "/pricing", "/about", "/privacy", "/contact", "/discover", "/submit", "/demo", "/demo-feedback", "/start/:path*", "/app/:path*", "/onboarding/:path*"],
};
