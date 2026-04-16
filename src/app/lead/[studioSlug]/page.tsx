import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import PublicLeadForm from "./PublicLeadForm";

type StudioBranding = {
  id: string;
  name: string;
  slug: string;
  public_lead_enabled: boolean;
  public_lead_headline: string | null;
  public_lead_description: string | null;
  public_logo_url: string | null;
  public_primary_color: string | null;
  public_lead_cta_text: string | null;
};

export default async function PublicLeadPage({
  params,
}: {
  params: Promise<{ studioSlug: string }>;
}) {
  const { studioSlug } = await params;
  const supabase = await createClient();

  const { data: studio, error } = await supabase
    .from("studios")
    .select(`
      id,
      name,
      slug,
      public_lead_enabled,
      public_lead_headline,
      public_lead_description,
      public_logo_url,
      public_primary_color,
      public_lead_cta_text
    `)
    .eq("slug", studioSlug)
    .single();

  if (error || !studio) {
    notFound();
  }

  const typedStudio = studio as StudioBranding;

  if (!typedStudio.public_lead_enabled) {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-16">
        <div className="mx-auto max-w-2xl rounded-2xl border bg-white p-8 text-center shadow-sm">
          <h1 className="text-3xl font-semibold tracking-tight">Booking Unavailable</h1>
          <p className="mt-3 text-slate-600">
            Public booking is currently disabled for this studio.
          </p>
        </div>
      </div>
    );
  }

  return <PublicLeadForm studio={typedStudio} />;
}