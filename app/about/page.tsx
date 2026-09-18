import type { Metadata } from "next";
import TrustPage from "@/components/TrustPage";
import { ABOUT } from "@/content/trust";
import "../app.css";

export const metadata: Metadata = {
  title: ABOUT.title,
  description: ABOUT.description,
  alternates: { canonical: "https://www.superstables.com/about", types: { "text/markdown": "https://www.superstables.com/about.md" } },
};

export default function AboutPage() {
  return <TrustPage doc={ABOUT} eyebrow="About" />;
}
