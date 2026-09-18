import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import type { TrustDoc } from "@/content/trust";

/** Renders a markdown link `[text](url)` inside a bullet as an anchor; plain text otherwise. */
function Bullet({ text }: { text: string }) {
  const m = text.match(/^\[([^\]]+)\]\(([^)]+)\)(.*)$/);
  if (!m) return <li>{text}</li>;
  return (
    <li>
      <a className="link" href={m[2]}>{m[1]}</a>
      {m[3]}
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
          <section key={s.heading} style={{ marginTop: 36 }}>
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
          Last updated {doc.updated}. Also available as <a className="link" href={`https://www.superstables.com/${doc.slug}.md`}>markdown</a>.
        </p>
      </main>
      <Footer />
    </>
  );
}
