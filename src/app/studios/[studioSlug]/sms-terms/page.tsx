import type { Metadata } from "next";
import SmsLegalPage, { loadSmsLegalDocument } from "../SmsLegalPage";

// Rendered per request: availability follows the studio's pilot switch, which can change at any time.
export const dynamic = "force-dynamic";

type Params = Promise<{ studioSlug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { studioSlug } = await params;
  const { document } = await loadSmsLegalDocument(studioSlug, "terms");
  return { title: document.title, description: "How this studio sends service text messages through DanceFlow, and how to opt out." };
}

export default async function StudioSmsTermsPage({ params }: { params: Params }) {
  const { studioSlug } = await params;
  const { document, version, effectiveDate } = await loadSmsLegalDocument(studioSlug, "terms");
  return <SmsLegalPage studioSlug={studioSlug} kind="terms" document={document} version={version} effectiveDate={effectiveDate} />;
}
