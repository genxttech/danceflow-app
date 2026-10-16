import type { Metadata } from "next";
import SmsLegalPage, { loadSmsLegalDocument } from "../SmsLegalPage";

export const dynamic = "force-dynamic";

type Params = Promise<{ studioSlug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { studioSlug } = await params;
  const { document } = await loadSmsLegalDocument(studioSlug, "privacy");
  return { title: document.title, description: "How this studio and DanceFlow handle information connected to text messages." };
}

export default async function StudioSmsPrivacyPage({ params }: { params: Params }) {
  const { studioSlug } = await params;
  const { document, version, effectiveDate } = await loadSmsLegalDocument(studioSlug, "privacy");
  return <SmsLegalPage studioSlug={studioSlug} kind="privacy" document={document} version={version} effectiveDate={effectiveDate} />;
}
