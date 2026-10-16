import Link from "next/link";
import { notFound } from "next/navigation";
import PublicShell from "@/components/public/PublicShell";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSmsLegalContext } from "@/lib/sms/onboarding/client";
import { buildStudioSmsLegalDocuments, type LegalDocument } from "@/lib/sms/onboarding/legalPages";

/**
 * TW-4A: renders a studio's generated SMS Terms or SMS Privacy page. The studio must have the pilot switch ON (the database
 * returns nothing otherwise, so the page is a 404 for every other studio). The page shows only names and the DanceFlow template
 * text: no identifiers, no EIN, no contact details of the studio's people.
 */
export type SmsLegalKind = "terms" | "privacy";

export async function loadSmsLegalDocument(studioSlug: string, kind: SmsLegalKind): Promise<{ document: LegalDocument; displayName: string; version: string; effectiveDate: string }> {
  let context = null;
  try {
    context = await getSmsLegalContext(createAdminClient(), studioSlug);
  } catch {
    context = null;
  }
  if (!context) notFound();
  const documents = buildStudioSmsLegalDocuments({ displayName: context.displayName, legalName: context.legalName });
  return {
    document: kind === "terms" ? documents.terms : documents.privacy,
    displayName: context.displayName,
    version: documents.version,
    effectiveDate: documents.effectiveDate,
  };
}

export default function SmsLegalPage({
  studioSlug,
  kind,
  document,
  version,
  effectiveDate,
}: {
  studioSlug: string;
  kind: SmsLegalKind;
  document: LegalDocument;
  version: string;
  effectiveDate: string;
}) {
  const other = kind === "terms" ? { href: `/studios/${studioSlug}/sms-privacy`, label: "SMS Privacy Policy" } : { href: `/studios/${studioSlug}/sms-terms`, label: "SMS Terms" };
  return (
    <PublicShell>
      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)] text-slate-900">
        <div className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
          <article className="rounded-[2rem] border border-orange-100 bg-white/90 p-8 shadow-sm">
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950">{document.title}</h1>
            <p className="mt-4 text-base leading-7 text-slate-700">{document.intro}</p>
            {document.sections.map((section) => (
              <section key={section.heading} className="mt-8">
                <h2 className="text-xl font-semibold text-slate-950">{section.heading}</h2>
                {section.paragraphs.map((paragraph, index) => (
                  <p key={index} className="mt-3 text-sm leading-7 text-slate-700">{paragraph}</p>
                ))}
              </section>
            ))}
            <p className="mt-8 text-xs text-slate-500">
              Template {version}, effective {effectiveDate}. See also the{" "}
              <Link href={other.href} className="font-semibold text-violet-700 underline">{other.label}</Link> and the{" "}
              <Link href="/sms-consent" className="font-semibold text-violet-700 underline">DanceFlow SMS consent page</Link>.
            </p>
          </article>
        </div>
      </main>
    </PublicShell>
  );
}
