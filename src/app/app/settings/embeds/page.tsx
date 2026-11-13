import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext, requireStudioRole } from "@/lib/auth/studio";
import { fetchPublicGroupClasses, formatClassWhen } from "@/lib/public/groupClasses";
import EmbedBuilder from "./EmbedBuilder";

export const metadata = { title: "Website embeds" };
export const dynamic = "force-dynamic";

const SITE_ORIGIN = "https://www.idanceflow.com";

type StudioRow = {
  slug: string | null;
  name: string;
  public_name: string | null;
  public_directory_enabled: boolean | null;
  subscription_status: string | null;
  public_primary_color: string | null;
};

export default async function WebsiteEmbedsPage() {
  await requireStudioRole(["studio_owner", "studio_admin"]);
  const context = await getCurrentStudioContext();
  const supabase = await createClient();

  const { data: studio } = await supabase
    .from("studios")
    .select("slug, name, public_name, public_directory_enabled, subscription_status, public_primary_color")
    .eq("id", context.studioId)
    .maybeSingle<StudioRow>();

  const status = (studio?.subscription_status ?? "").trim().toLowerCase();
  const isPublic = !!studio?.slug && studio.public_directory_enabled === true && (status === "active" || status === "trialing");

  // The same public read model the embeds use: what the picker lists is exactly what an embed can show.
  const classes = isPublic && studio?.slug ? await fetchPublicGroupClasses(supabase, { studioSlug: studio.slug, limit: 100 }) : [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      <div>
        <Link href="/app/settings" className="text-sm font-semibold text-fuchsia-700 underline">
          Settings
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Website embeds</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Show your DanceFlow classes on your own website. Paste one snippet and it stays up to date: when you change a class in DanceFlow,
          your website changes with it. Dancers register through DanceFlow, so there is nothing to maintain twice.
        </p>
      </div>

      {!isPublic ? (
        <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">
          <h2 className="font-semibold">Your studio is not public yet</h2>
          <p className="mt-1">
            Embeds only show classes of studios that are listed publicly with an active subscription. Turn on your public profile first.
          </p>
          <Link href="/app/settings/public-profile" className="mt-3 inline-flex rounded-xl bg-amber-900 px-4 py-2 font-semibold text-white">
            Open public presence
          </Link>
        </section>
      ) : (
        <EmbedBuilder
          origin={SITE_ORIGIN}
          studioSlug={studio!.slug!}
          studioName={studio!.public_name?.trim() || studio!.name}
          defaultAccent={/^#[0-9a-fA-F]{6}$/.test(studio!.public_primary_color ?? "") ? studio!.public_primary_color! : null}
          classes={classes.map((c) => ({
            id: c.appointmentId,
            label: `${c.title} · ${formatClassWhen(c.startsAt, c.endsAt, c.timeZone)}`,
          }))}
          instructors={[...new Set(classes.map((c) => c.instructorName).filter((n): n is string => !!n))].sort()}
        />
      )}

      <section className="rounded-3xl border border-slate-200 bg-white p-5 text-sm text-slate-700 shadow-sm">
        <h2 className="text-base font-semibold text-slate-950">What shows on your website</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Only classes you have made publicly discoverable. Private lessons, client names and staff notes are never included.</li>
          <li>Cancelled and full classes are labelled as such; classes that have passed disappear.</li>
          <li>Registration and payment always happen on DanceFlow, in a new tab, never inside your website.</li>
          <li>A class that is not listed in the picker is not public. Make it public in the class&apos;s enrollment settings.</li>
        </ul>
      </section>
    </div>
  );
}
