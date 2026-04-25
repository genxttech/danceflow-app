import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateInstructorPortalProfileAction } from "./actions";

type Params = Promise<{
  studioSlug: string;
}>;

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

type WorkspaceRoleRow = {
  role: string;
  active: boolean;
};

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "profile_updated") {
    return {
      kind: "success" as const,
      message: "Your profile was updated.",
    };
  }

  if (search.error === "profile_update_failed") {
    return {
      kind: "error" as const,
      message: "We could not update your profile.",
    };
  }

  return null;
}

export default async function PortalProfilePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { studioSlug } = await params;
  const query = await searchParams;
  const banner = getBanner(query);

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, slug, name, public_name")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    redirect("/login");
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select(`
      id,
      first_name,
      last_name,
      email,
      phone,
      is_independent_instructor,
      portal_user_id
    `)
    .eq("studio_id", studio.id)
    .eq("portal_user_id", user.id)
    .single();

  if (clientError || !client) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: workspaceRole } = await supabase
    .from("user_studio_roles")
    .select("role, active")
    .eq("studio_id", studio.id)
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle<WorkspaceRoleRow>();

  const canReturnToWorkspace = Boolean(workspaceRole);

  const fullName = `${client.first_name} ${client.last_name}`.trim();
  const studioLabel = studio.public_name?.trim() || studio.name;
  const accessType = client.is_independent_instructor
    ? "Independent Instructor"
    : "Portal Member";

  return (
    <div className="space-y-8">
      {banner ? (
        <section
          className={`rounded-[28px] border p-5 shadow-sm ${
            banner.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          <p className="text-sm font-semibold uppercase tracking-[0.16em]">
            {banner.kind === "success" ? "Profile Updated" : "Update Problem"}
          </p>
          <p className="mt-2 text-sm leading-7">{banner.message}</p>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Portal
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                My Profile
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Keep your contact details up to date so the studio can reach you when needed.
              </p>
              <div className="mt-4 flex flex-wrap gap-3 text-sm text-white/80">
                <span>
                  Studio: <span className="font-medium text-white">{studioLabel}</span>
                </span>
                <span>
                  Signed in as: <span className="font-medium text-white">{fullName}</span>
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              {canReturnToWorkspace ? (
                <Link
                  href={`/app?studio=${encodeURIComponent(studio.id)}`}
                  className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                >
                  Back to Workspace
                </Link>
              ) : null}

              <Link
                href={`/portal/${encodeURIComponent(studio.slug)}`}
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Back to Portal
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">
                Check your contact details
              </h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                Make sure your email and phone number are current so updates and reminders reach you.
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">
                Your name stays locked
              </h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                Name changes are managed by the studio so your portal and studio records stay in sync.
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">
                Need more help?
              </h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Use the Help area in the workspace if something looks wrong or you cannot access the page you need.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-8 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              Contact Details
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              Update your portal information
            </h2>
            <p className="mt-2 text-sm leading-7 text-slate-600">
              Save your email and phone number here so the studio has the best way to contact you.
            </p>
          </div>

          <form action={updateInstructorPortalProfileAction} className="mt-6 space-y-5">
            <input type="hidden" name="studioSlug" value={studio.slug} />
            <input
              type="hidden"
              name="returnTo"
              value={`/portal/${encodeURIComponent(studio.slug)}/profile`}
            />

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  First Name
                </label>
                <input
                  value={client.first_name}
                  disabled
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-3 text-slate-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Last Name
                </label>
                <input
                  value={client.last_name}
                  disabled
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-3 text-slate-500"
                />
              </div>

              <div>
                <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-700">
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  defaultValue={client.email ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-slate-900 outline-none focus:border-violet-500"
                />
              </div>

              <div>
                <label htmlFor="phone" className="mb-1 block text-sm font-medium text-slate-700">
                  Phone
                </label>
                <input
                  id="phone"
                  name="phone"
                  defaultValue={client.phone ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-slate-900 outline-none focus:border-violet-500"
                />
              </div>
            </div>

            <button
              type="submit"
              className="rounded-xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-medium text-white hover:opacity-95"
            >
              Save Profile
            </button>
          </form>
        </section>

        <div className="space-y-6">
          <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-slate-950">Portal Status</h2>

            <div className="mt-5 space-y-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Portal Access</p>
                <p className="mt-1 font-medium text-slate-900">Active</p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Access Type</p>
                <p className="mt-1 font-medium text-slate-900">{accessType}</p>
              </div>
            </div>
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-slate-950">Quick Links</h2>

            <div className="mt-5 grid gap-3">
              <Link
                href={`/portal/${encodeURIComponent(studio.slug)}/floor-space`}
                className="rounded-xl border border-slate-200 px-4 py-3 text-slate-700 hover:bg-slate-50"
              >
                Book Floor Space
              </Link>

              <Link
                href={`/portal/${encodeURIComponent(studio.slug)}/floor-space/my-rentals`}
                className="rounded-xl border border-slate-200 px-4 py-3 text-slate-700 hover:bg-slate-50"
              >
                My Rentals
              </Link>

              <Link
                href={`/portal/${encodeURIComponent(studio.slug)}`}
                className="rounded-xl border border-slate-200 px-4 py-3 text-slate-700 hover:bg-slate-50"
              >
                Portal Home
              </Link>
            </div>

            <form action="/auth/logout" method="post" className="mt-6">
              <button
                type="submit"
                className="rounded-xl border border-slate-300 px-4 py-2 text-slate-700 hover:bg-slate-50"
              >
                Log Out
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}