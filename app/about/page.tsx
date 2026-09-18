import type { Metadata } from "next";
import TrustPage from "@/components/TrustPage";
import { ABOUT } from "@/content/trust";
import "../app.css";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: ABOUT.title,
  description: ABOUT.description,
  alternates: { canonical: `${SITE}/about`, types: { "text/markdown": `${SITE}/about.md` } },
};

export default function AboutPage() {
  return <TrustPage doc={ABOUT} eyebrow="About" />;
}
