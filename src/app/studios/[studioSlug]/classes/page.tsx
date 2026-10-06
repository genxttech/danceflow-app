import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import PublicShell from "@/components/public/PublicShell";
import PublicClassCard from "@/components/public/PublicClassCard";
import { createClient } from "@/lib/supabase/server";
import { fetchPublicGroupClasses, studioLocationLabel } from "@/lib/public/groupClasses";

type PageProps = { params: Promise<{ studioSlug: string }> };

export const metadata: Metadata = { title: "Classes" };

// Public and signed-out friendly; availability is read live from the database.
export const dynamic = "force-dynamic";

type StudioRow = {
  slug: string;
  name: string;
  public_name: string | null;
  city: string | null;
  state: string | null;
  subscription_status: string | null;
};

export default async function StudioClassesPage({ params }: PageProps) {
  const { studioSlug } = await params;
  const supabase = await createClient();

  // Same public-studio rule as the studio profile page (listed in the directory, active or trialing).
  const { data: studio } = await supabase
    .from("studios")
    .select("slug, name, public_name, city, state, subscription_status")
    .eq("slug", studioSlug)
    .eq("public_directory_enabled", true)
    .maybeSingle<StudioRow>();

  const status = (studio?.subscription_status ?? "").trim().toLowerCase();
  if (!studio || (status !== "active" && status !== "trialing")) notFound();

  const classes = await fetchPublicGroupClasses(supabase, { studioSlug: studio.slug, limit: 100 });
  const studioName = studio.public_name?.trim() || studio.name;
  const place = studioLocationLabel(studio.city, studio.state);

  return (
    <PublicShell currentPath="discover">
      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)] text-slate-900">
        <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
          <Link href={`/studios/${encodeURIComponent(studio.slug)}`} className="text-sm font-semibold text-[var(--brand-primary)] underline">
            {studioName}
          </Link>
          {place ? <span className="text-sm text-slate-500"> · {place}</span> : null}
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Classes at {studioName}</h1>

          {classes.length === 0 ? (
            <div className="mt-8 rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
              <h2 className="text-lg font-semibold text-slate-950">No upcoming classes are listed right now</h2>
              <p className="mt-2 text-sm text-slate-600">Check back soon, or visit the studio page to get in touch.</p>
              <Link
                href={`/studios/${encodeURIComponent(studio.slug)}`}
                className="mt-5 inline-flex rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
              >
                View studio
              </Link>
            </div>
          ) : (
            <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {classes.map((item) => (
                <PublicClassCard key={item.appointmentId} item={item} showStudio={false} />
              ))}
            </div>
          )}
        </section>
      </main>
    </PublicShell>
  );
}
