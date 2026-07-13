import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getDancerProfile } from "@/lib/student-identity/profile";
import { updatePortalStudioContactAction } from "./actions";
import { resolvePortalRelationship, portalClientPath } from "@/lib/student-identity/portal-context";

type Params = Promise<{ studioSlug: string }>;
type SearchParams = Promise<{ client?: string; success?: string; error?: string }>;

export default async function PortalProfilePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { studioSlug } = await params;
  const search = await searchParams;
  const requestedClientId = search.client ?? null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?intent=public&next=/portal/${encodeURIComponent(studioSlug)}/profile`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, slug, name, public_name")
    .eq("slug", studioSlug)
    .maybeSingle();

  if (studioError || !studio) redirect("/account");

  const relationship = await resolvePortalRelationship({
    userId: user.id,
    studioId: studio.id,
    requestedClientId,
    permission: "can_view_schedule",
  });

  if (!relationship) {
    redirect(`/portal/${encodeURIComponent(studioSlug)}`);
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, phone, is_independent_instructor")
    .eq("studio_id", studio.id)
    .eq("id", relationship.clientId)
    .maybeSingle();

  if (clientError || !client) {
    redirect(`/login?intent=public&next=/portal/${encodeURIComponent(studioSlug)}`);
  }

  const dancerProfile = await getDancerProfile(user);
  const studioLabel = studio.public_name?.trim() || studio.name;
  const clientName = `${client.first_name} ${client.last_name}`.trim();

  return (
    <div className="space-y-7">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
            {studioLabel} Portal
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            Profile & Contact Details
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-white/85 md:text-base">
            Your DanceFlow profile belongs to you. This studio also keeps a separate
            contact record for reminders, billing, attendance, and studio communication.
          </p>
        </div>
      </section>

      {search.success === "contact_updated" ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">
          Your contact details for {studioLabel} were updated.
        </div>
      ) : null}

      {search.error === "contact_update_failed" ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">
          We could not update this studio contact record.
        </div>
      ) : null}

      <div className="grid gap-7 lg:grid-cols-2">
        <section className="rounded-[30px] border border-violet-200 bg-violet-50 p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
            Dancer owned
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-violet-950">
            My DanceFlow Profile
          </h2>
          <p className="mt-2 text-sm leading-7 text-violet-900">
            This identity follows you across DanceFlow and is not controlled by one studio.
          </p>

          <dl className="mt-5 space-y-3 rounded-2xl bg-white p-5">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Name</dt>
              <dd className="mt-1 font-medium text-slate-950">
                {[dancerProfile.preferredName || dancerProfile.firstName, dancerProfile.lastName].filter(Boolean).join(" ") || "Not completed"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Login email</dt>
              <dd className="mt-1 font-medium text-slate-950">{dancerProfile.email}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Dance interests</dt>
              <dd className="mt-1 text-sm leading-6 text-slate-700">{dancerProfile.danceInterests || "Not completed"}</dd>
            </div>
          </dl>

          <Link
            href="/account/profile"
            className="mt-5 inline-flex rounded-xl bg-violet-700 px-5 py-3 text-sm font-semibold text-white hover:bg-violet-800"
          >
            Edit My DanceFlow Profile
          </Link>
        </section>

        <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Studio owned
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            {studioLabel} contact record
          </h2>
          <p className="mt-2 text-sm leading-7 text-slate-600">
            These values tell this studio how to contact you. They do not change your
            DanceFlow login email or global dancer identity.
          </p>

          <form action={updatePortalStudioContactAction} className="mt-5 space-y-4">
            <input type="hidden" name="studioSlug" value={studio.slug} />
            <input type="hidden" name="clientId" value={client.id} />

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium text-slate-700">
                Studio record name
                <input value={client.first_name} disabled className="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-3 text-slate-500" />
              </label>
              <label className="text-sm font-medium text-slate-700">
                Last name
                <input value={client.last_name} disabled className="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-3 text-slate-500" />
              </label>
              <label className="text-sm font-medium text-slate-700">
                Studio contact email
                <input name="email" type="email" defaultValue={client.email ?? ""} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
              </label>
              <label className="text-sm font-medium text-slate-700">
                Studio contact phone
                <input name="phone" defaultValue={client.phone ?? ""} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
              </label>
            </div>

            <button className="rounded-xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white">
              Save Studio Contact Details
            </button>
          </form>
        </section>
      </div>

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap gap-3">
          <Link href={portalClientPath(studio.slug, client.id)} className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            Back to Portal
          </Link>
          <Link href={portalClientPath(studio.slug, client.id, "/schedule")} className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            My Schedule
          </Link>
          <span className="rounded-xl bg-slate-100 px-4 py-3 text-sm text-slate-600">
            Studio record: {clientName || "Client"} · {client.is_independent_instructor ? "Independent Instructor" : "Portal Member"}
          </span>
        </div>
      </section>
    </div>
  );
}
