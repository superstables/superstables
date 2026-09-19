import { demoFeedback } from "@/content/demoFeedback";
import { TALLY_ORIGIN } from "@/lib/tally";
import { SITE } from "@/lib/site";
export const dynamic = "force-static";

/**
 * Markdown twin of /demo-feedback, served when a client's Accept prefers text/markdown
 * (proxy.ts). The form itself is an embed; the twin points at its direct URL.
 */
const BODY = `---
title: Demo feedback
description: Try the Superstables demo and share your feedback. Tell us what happened. Screenshots and contact details are optional.
canonical: ${SITE}/demo-feedback
last-updated: 2026-09-19
---

# Demo feedback

Tried the [Superstables demo](${SITE}/demo)? Tell us what worked, what got in the way, or
where you stopped. Setup feedback is useful too.

- [Open the feedback form](${TALLY_ORIGIN}/r/${encodeURIComponent(demoFeedback.formId)}): one free-text report; a screenshot and a contact are optional.
- The form is hosted by Tally and the report is copied into our issue tracker. What is stored and how to have it removed: [Privacy](${SITE}/privacy).

Back to the [demo](${SITE}/demo) or the [documentation](${SITE}/docs.md).
`;

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "s-maxage=3600" } });
}
