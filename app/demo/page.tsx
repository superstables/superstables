import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import DemoVideo from "@/components/demo/DemoVideo";
import { AppPicker, AppPanel, ChosenAppName, HarnessProvider } from "@/components/demo/Harness";
import CopyPrompt from "@/components/demo/CopyPrompt";
import { demoPage } from "@/content/demo";
import { SITE } from "@/lib/site";
import "./demo.css";

const p = demoPage;

export const metadata: Metadata = {
  title: p.title,
  description: p.description,
  alternates: { canonical: `${SITE}/demo`, types: { "text/markdown": `${SITE}/demo.md` } },
  openGraph: {
    title: p.title,
    description: p.description,
    url: `${SITE}/demo`,
    type: "website",
    images: [{ url: `${SITE}${p.video.poster}`, width: p.video.width, height: p.video.height, alt: p.video.label }],
    videos: [{ url: `${SITE}${p.video.src}`, type: p.video.type, width: p.video.width, height: p.video.height }],
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "VideoObject",
      name: p.video.label,
      description: p.video.description,
      thumbnailUrl: `${SITE}${p.video.poster}`,
      contentUrl: `${SITE}${p.video.src}`,
      encodingFormat: p.video.type,
      width: p.video.width,
      height: p.video.height,
      duration: `PT${p.video.durationSeconds.toFixed(1)}S`,
      uploadDate: "2026-09-19",
      isAccessibleForFree: true,
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE}/demo#faq`,
      mainEntity: p.questions.items.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
        { "@type": "ListItem", position: 2, name: "Demo", item: `${SITE}/demo` },
      ],
    },
  ],
};

const VIDEO_DESCRIPTION_ID = "video-description";

export default function DemoPage() {
  const s = p.setup;
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Nav current="/demo" />
      <main className="wrap demo" id="top">
        <section className="demo-hero" aria-labelledby="hero-heading">
          <h1 id="hero-heading">
            {p.hero.headingLine1}
            <br />
            <span className="accent">{p.hero.headingLine2}</span>
          </h1>
          <div className="hero-bottom">
            <p className="hero-description">{p.hero.lede}</p>
            <div className="actions">
              <a className="button primary" href="#watch">
                <span aria-hidden="true">▶</span> {p.hero.primary}
              </a>
              <a className="button" href="#setup">
                {p.hero.secondary} <span aria-hidden="true">↓</span>
              </a>
            </div>
          </div>
        </section>

        <section className="film" id="watch" aria-label="Superstables demo recording">
          <DemoVideo descriptionId={VIDEO_DESCRIPTION_ID} />
          <details className="film-description">
            <summary>{p.video.disclosure}</summary>
            <p id={VIDEO_DESCRIPTION_ID}>{p.video.description}</p>
          </details>
        </section>

        <section aria-label="How the demo works">
          <h2 className="sr-only">How the demo works</h2>
          <div className="flow">
            {p.flow.map((item) => (
              <div key={item.title} className="flow-item">
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        <HarnessProvider>
          <section className="app-choice" id="setup" aria-labelledby="app-heading">
            <div>
              <h2 id="app-heading">{p.harness.heading}</h2>
            </div>
            <div>
              <p>{p.harness.intro}</p>
              <AppPicker />
            </div>
          </section>

          <section className="setup" id="setup-steps" aria-labelledby="setup-heading">
            <div>
              <h2 id="setup-heading">
                {s.headingLine1}
                <br />
                {s.headingLine2}
              </h2>
              <p className="setup-intro">{s.intro}</p>
              <div className="actions">
                <a className="button primary" href={s.guideUrl}>
                  {s.guideLabel} <span aria-hidden="true">↗</span>
                </a>
                <a className="button" href={s.releaseUrl}>
                  {s.releaseLabel} <span aria-hidden="true">↗</span>
                </a>
              </div>
            </div>
            <div className="setup-content">
              <ol>
                <li>
                  <AppPanel />
                </li>
                <li>
                  <h3>{s.wallet.title}</h3>
                  <p>
                    {s.wallet.before}
                    <a className="text-link" href={s.guideUrl}>
                      {s.wallet.linkLabel}
                    </a>
                    {s.wallet.after}
                  </p>
                </li>
                <li>
                  <h3>{s.quote.title}</h3>
                  <p>
                    {s.quote.before}
                    <ChosenAppName />
                    {s.quote.after}
                  </p>
                </li>
              </ol>
              <CopyPrompt />
              <div className="setup-help">
                <p>{s.help.next}</p>
                <p>
                  {s.help.developer}{" "}
                  <a className="text-link" href={s.guideUrl}>
                    {s.help.developerLink}
                  </a>
                </p>
                <p>
                  {s.help.stuck}{" "}
                  <Link className="text-link" href={p.feedback.href}>
                    {s.help.stuckLink}
                  </Link>
                </p>
              </div>
            </div>
          </section>
        </HarnessProvider>

        <section className="questions" aria-labelledby="questions-heading">
          <div>
            <h2 id="questions-heading">{p.questions.heading}</h2>
          </div>
          <div>
            {p.questions.items.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="feedback" aria-labelledby="feedback-heading">
          <div>
            <h2 id="feedback-heading">{p.feedback.heading}</h2>
            <p>{p.feedback.body}</p>
          </div>
          <Link className="button primary" href={p.feedback.href}>
            {p.feedback.cta} <span aria-hidden="true">↗</span>
          </Link>
        </section>
      </main>
      <Footer />
    </>
  );
}
