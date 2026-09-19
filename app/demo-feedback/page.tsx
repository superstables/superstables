import type { Metadata } from "next";
import Link from "next/link";
import Logo from "@/components/Logo";
import Footer from "@/components/Footer";
import DemoFeedbackForm from "@/components/DemoFeedbackForm";
import { demoFeedback } from "@/content/demoFeedback";
import { SITE } from "@/lib/site";
import "../app.css";

export const metadata: Metadata = {
  title: "Demo feedback | Superstables",
  description: "Found a snag in the Superstables testnet payment demo? Say what happened in a sentence or two; a screenshot or log and a way to reach you are optional.",
  alternates: { canonical: `${SITE}/demo-feedback` },
};

export default function DemoFeedbackPage() {
  return (
    <>
      <header className="feedback-head">
        <Logo />
        <Link className="feedback-back" href="/">
          <span aria-hidden="true">&larr;</span> <span className="long">Back to Superstables</span><span className="short">Back</span>
        </Link>
      </header>
      <main className="wrap" style={{ paddingTop: 56, paddingBottom: 96, maxWidth: 760 }}>
        <span className="eyebrow plain">Demo</span>
        <h1 style={{ fontSize: "clamp(32px, 4vw, 44px)", marginTop: 10 }}>Demo feedback</h1>
        <DemoFeedbackForm formId={demoFeedback.formId} context={demoFeedback.context} title="Demo feedback form" />
      </main>
      <Footer />
    </>
  );
}
