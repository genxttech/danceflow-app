import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type Params = Promise<{
  studioSlug: string;
}>;

type StudioRow = {
  name: string;
  public_name: string | null;
  slug: string | null;
  public_directory_enabled: boolean;
  public_logo_url: string | null;
};

function studioTitle(studio: StudioRow) {
  return studio.public_name?.trim() || studio.name || "Studio";
}

export default async function StudioInquirySuccessPage({
  params,
}: {
  params: Params;
}) {
  const { studioSlug } = await params;
  const supabase = await createClient();

  const { data: studio, error } = await supabase
    .from("studios")
    .select("name, public_name, slug, public_directory_enabled, public_logo_url")
    .eq("slug", studioSlug)
    .eq("public_directory_enabled", true)
    .maybeSingle<StudioRow>();

  if (error) {
    throw new Error(`Failed to load studio: ${error.message}`);
  }

  if (!studio) {
    return (
      <main className="min-h-screen bg-slate-50">
        <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
          <div className="rounded-3xl border border-rose-200 bg-rose-50 px-6 py-5 text-rose-800">
            Missing studio.
          </div>
        </div>
      </main>
    );
  }

  const title = studioTitle(studio);

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto flex min-h-screen max-w-3xl items-center px-4 py-16 sm:px-6 lg:px-8">
        <div className="w-full rounded-[2rem] border border-slate-200/80 bg-white p-8 text-center shadow-sm sm:p-10">
          {studio.public_logo_url ? (
            <img
              src={studio.public_logo_url}
              alt={`${title} logo`}
              className="mx-auto mb-6 h-16 w-auto object-contain"
            />
          ) : null}

          <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl">
            ✓
          </div>

          <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
            Inquiry sent
          </h1>

          <p className="mt-4 text-base leading-7 text-slate-600">
            Thanks for reaching out to {title}. Your inquiry was submitted
            successfully, and someone should follow up soon.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={`/studios/${encodeURIComponent(studio.slug ?? studioSlug)}`}
              className="inline-flex rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
            >
              Back to Studio Page
            </Link>

            <Link
              href="/discover/studios"
              className="inline-flex rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Browse More Studios
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}