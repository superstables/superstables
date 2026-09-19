"use client";

import Script from "next/script";
import { TALLY_ORIGIN, tallyEmbedUrl, type TallyContext } from "@/lib/tally";

declare global {
  interface Window {
    Tally?: { loadEmbeds: () => void };
  }
}

const WIDGET_SRC = `${TALLY_ORIGIN}/widgets/embed.js`;

/**
 * The Tally form in an iframe with an explicit `src`. Tally's widget script resizes it to
 * the form's height (its documented dynamicHeight support) but only rewrites the URL of
 * iframes it loads itself, so the host page's query string never reaches the form.
 * Without the widget the form still renders at its initial height and scrolls inside.
 */
export default function DemoFeedbackForm({ formId, context, title }: { formId: string; context: TallyContext; title: string }) {
  return (
    <div className="feedback-form">
      <iframe
        src={tallyEmbedUrl(formId, context)}
        title={title}
        loading="lazy"
        width="100%"
        height="640"
        referrerPolicy="strict-origin-when-cross-origin"
      />
      <Script src={WIDGET_SRC} onReady={() => window.Tally?.loadEmbeds()} />
    </div>
  );
}
