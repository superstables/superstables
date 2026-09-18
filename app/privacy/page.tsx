import type { Metadata } from "next";
import TrustPage from "@/components/TrustPage";
import { PRIVACY } from "@/content/trust";
import "../app.css";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: PRIVACY.title,
  description: PRIVACY.description,
  alternates: { canonical: `${SITE}/privacy`, types: { "text/markdown": `${SITE}/privacy.md` } },
};

export default function PrivacyPage() {
  return <TrustPage doc={PRIVACY} eyebrow="Privacy" />;
}
