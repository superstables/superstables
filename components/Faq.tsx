import Reveal from "./Reveal";
import { ABOUT } from "@/content/trust";

/** Short questions and answers about the index; the same items the About page shows, so both stay in step. */
export default function Faq() {
  const faq = ABOUT.faq ?? [];
  return (
    <section id="faq">
      <div className="wrap">
        <Reveal className="section-head">
          <span className="eyebrow plain">Questions</span>
          <h2>Short answers to the questions we get most.</h2>
        </Reveal>
        <Reveal className="faq-list">
          {faq.map((f) => (
            <div key={f.q} className="faq-item">
              <h3>{f.q}</h3>
              <p>{f.a}</p>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
