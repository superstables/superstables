import { SITE } from "@/lib/site";
export const dynamic = "force-static";

/** Markdown twin of /submit: how to list a service, for people and for agents. */
const BODY = `---
title: List your service
description: Add a service that accepts agent payments over x402, MPP or ACP to the Superstables index. We probe before listing.
canonical: ${SITE}/submit
last-updated: 2026-09-18
---

# List your service

Tell us the endpoint that answers a payment challenge (x402, MPP or ACP). We probe before listing;
if it answers, it appears in the index and stays there as long as it keeps answering. Listing is free.

## Submit with the form

${SITE}/submit

## Submit with the API

    curl -X POST ${SITE}/api/v1/submit \\
      -H "Content-Type: application/json" \\
      -d '{"endpoint":"https://api.example.com/v1/priced","name":"Example API","contact":"ops@example.com"}'

- endpoint (required): the http(s) URL that answers the payment challenge.
- name (optional): how the service should be shown.
- contact (optional): how we can reach you about the listing; used for nothing else.
- Idempotency-Key header (optional): repeated submissions of the same endpoint within 24 hours are deduplicated.

Responses: 200 { ok: true } (or { ok: true, deduplicated: true }); 400 with { error: { code, message } } for
invalid_json or invalid_endpoint. Spec: ${SITE}/openapi.json

## What happens next

The endpoint is probed once immediately and joins the moderation queue. A service is listed when it answers
a valid payment challenge: HTTP 402, a payment-challenge response header, or an x402/MPP challenge body.
After listing it is re-probed on a rolling schedule and its probe history is public on its service page.

Already listed and want a change? Submit the same endpoint again with the corrected details.
`;

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", "Cache-Control": "s-maxage=3600" } });
}
