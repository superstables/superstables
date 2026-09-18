import type { Metadata } from "next";
import TrustPage from "@/components/TrustPage";
import { CONTACT } from "@/content/trust";
import { SITE } from "@/lib/site";
import "../app.css";

export const metadata: Metadata = {
  title: CONTACT.title,
  description: CONTACT.description,
  alternates: { canonical: `${SITE}/contact`, types: { "text/markdown": `${SITE}/contact.md` } },
};

export default function ContactPage() {
  return <TrustPage doc={CONTACT} eyebrow="Contact" />;
}
