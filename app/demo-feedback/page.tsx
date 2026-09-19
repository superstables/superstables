import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import DemoFeedbackForm from "@/components/DemoFeedbackForm";
import { demoFeedback } from "@/content/demoFeedback";
import { SITE } from "@/lib/site";
import "../app.css";

export const metadata: Metadata = {
  title: "Demo feedback | Superstables",
  description: "Try the Superstables demo and share your feedback. Tell us what happened. Screenshots and contact details are optional.",
  alternates: { canonical: `${SITE}/demo-feedback` },
};

export default function DemoFeedbackPage() {
  return (
    <>
      <Nav current="/demo-feedback" />
      <main className="wrap" style={{ paddingTop: 56, paddingBottom: 96, maxWidth: 760 }}>
        <h1 style={{ fontSize: "clamp(32px, 4vw, 44px)" }}>Demo feedback</h1>
        <DemoFeedbackForm formId={demoFeedback.formId} context={demoFeedback.context} title="Demo feedback form" />
      </main>
      <Footer />
    </>
  );
}
