import type { Metadata } from "next";
import TrustPage from "@/components/TrustPage";
import { PRIVACY } from "@/content/trust";
import "../app.css";

export const metadata: Metadata = {
  title: PRIVACY.title,
  description: PRIVACY.description,
  alternates: { canonical: "https://www.superstables.com/privacy", types: { "text/markdown": "https://www.superstables.com/privacy.md" } },
};

export default function PrivacyPage() {
  return <TrustPage doc={PRIVACY} eyebrow="Privacy" />;
}
