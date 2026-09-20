import { demoApps, demoPage } from "@/content/demo";
import { SITE } from "@/lib/site";
export const dynamic = "force-static";

/**
 * Markdown twin of /demo, served when a client's Accept prefers text/markdown (proxy.ts).
 * Rendered from the same content as the page, so the two cannot drift.
 */
const p = demoPage;
const s = p.setup;

const fence = (lang: string | null, code: string) => `\`\`\`${lang ?? ""}\n${code}\n\`\`\``;

const appSections = demoApps
  .map((app) =>
    [
      `#### ${app.title}`,
      "",
      app.intro,
      "",
      ...(app.code !== null ? [fence(app.codeLang, app.code), ""] : []),
      app.after,
      "",
      `[${app.name} setup guide](${app.url})`,
    ].join("\n"),
  )
  .join("\n\n");

const BODY = `---
title: ${p.title}
description: ${p.description}
canonical: ${SITE}/demo
last-updated: 2026-09-20
---

# ${p.hero.headingLine1} ${p.hero.headingLine2}

${p.hero.lede}

## Video

[Demo recording](${SITE}${p.video.src}) (MP4, ${p.video.width}x${p.video.height}, ${Math.round(p.video.durationSeconds)} seconds, with voiceover; poster: ${SITE}${p.video.poster})

${p.video.description}

## The flow

${p.flow.map((f) => `### ${f.title}\n\n${f.body}`).join("\n\n")}

## ${p.harness.heading}

${p.harness.intro}

${p.harness.note}

## ${s.headingLine1} ${s.headingLine2}

${s.intro}

- [${s.guideLabel}](${s.guideUrl})
- [${s.releaseLabel}](${s.releaseUrl})

### 1. Install and connect the chosen app

${appSections}

#### ${s.build.summary}

${s.build.intro}

${fence("sh", s.build.code)}

${s.build.after}

### 2. ${s.wallet.title}

${s.wallet.before}[${s.wallet.linkLabel}](${s.guideUrl})${s.wallet.after}

### 3. ${s.quote.title}

${s.quote.before}your chosen app${s.quote.after}

> ${s.quote.prompt}

${s.help.next}

${s.help.developer} [${s.help.developerLink}](${s.guideUrl})

${s.help.stuck} [${s.help.stuckLink}](${SITE}${p.feedback.href})

## Questions

${p.questions.items.map((q) => `### ${q.q}\n\n${q.a}`).join("\n\n")}

## ${p.feedback.heading}

${p.feedback.body}

[${p.feedback.cta}](${SITE}${p.feedback.href})

Also available as HTML: ${SITE}/demo
`;

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", "Cache-Control": "s-maxage=3600" } });
}
