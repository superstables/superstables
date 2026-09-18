import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import type { TrustDoc } from "@/content/trust";
import { SITE } from "@/lib/site";

/** Renders every markdown link `[text](url)` inside a bullet as an anchor; the rest stays plain text. */
function Bullet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\]\([^)]+\))/g);
  return (
    <li>
      {parts.map((part, i) => {
        const m = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        return m ? <a key={i} className="link" href={m[2]}>{m[1]}</a> : <span key={i}>{part}</span>;
      })}
    </li>
  );
}

/** Shared layout for the About and Privacy pages: server-rendered prose, sequential headings, no JavaScript needed. */
export default function TrustPage({ doc, eyebrow }: { doc: TrustDoc; eyebrow: string }) {
  return (
    <>
      <Nav />
      <main className="wrap" style={{ padding: "56px 0 96px", maxWidth: 760 }}>
        <span className="eyebrow plain">{eyebrow}</span>
        <h1 style={{ fontSize: "clamp(32px, 4vw, 44px)", marginTop: 10 }}>{doc.title}</h1>
        <p className="lede" style={{ marginTop: 12 }}>{doc.lede}</p>
        {doc.sections.map((s) => (
          <section key={s.heading} style={{ marginTop: 36, padding: 0, border: 0 }}>
            <div className="sub-head"><h2>{s.heading}</h2></div>
            {s.paragraphs.map((p) => (
              <p key={p.slice(0, 40)} style={{ color: "var(--ink-2)", marginTop: 12, lineHeight: 1.6 }}>{p}</p>
            ))}
            {s.bullets && (
              <ul style={{ color: "var(--ink-2)", marginTop: 12, paddingLeft: 22, lineHeight: 1.8 }}>
                {s.bullets.map((b) => <Bullet key={b} text={b} />)}
              </ul>
            )}
          </section>
        ))}
        <p style={{ marginTop: 32, fontSize: 14, color: "var(--ink-2)" }}>
          Last updated {doc.updated}. Also available as <a className="link" href={`${SITE}/${doc.slug}.md`}>markdown</a>.
        </p>
      </main>
      <Footer />
    </>
  );
}
