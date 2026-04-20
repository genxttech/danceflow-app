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

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "profile_updated") {
    return {
      kind: "success" as const,
      message: "Profile updated successfully.",
    };
  }

  if (search.error === "profile_update_failed") {
    return {
      kind: "error" as const,
      message: "Could not update profile.",
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
    .select("id, slug, name")
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

  const fullName = `${client.first_name} ${client.last_name}`.trim();

  return (
    <div className="space-y-8">
      {banner ? (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            banner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {banner.message}
        </div>
      ) : null}

      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">{studio.name}</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">
              My Profile
            </h1>
            <p className="mt-2 text-slate-600">
              Review and update your portal contact information.
            </p>
            <p className="mt-2 text-sm text-slate-500">Signed in as {fullName}</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href={`/portal/${encodeURIComponent(studio.slug)}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Back to Portal
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">
            Contact Information
          </h2>

          <form action={updateInstructorPortalProfileAction} className="mt-5 space-y-5">
            <input type="hidden" name="studioSlug" value={studio.slug} />
            <input
              type="hidden"
              name="returnTo"
              value={`/portal/${encodeURIComponent(studio.slug)}/profile`}
            />

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium">First Name</label>
                <input
                  value={client.first_name}
                  disabled
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-slate-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium">Last Name</label>
                <input
                  value={client.last_name}
                  disabled
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-slate-500"
                />
              </div>

              <div>
                <label htmlFor="email" className="mb-1 block text-sm font-medium">
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  defaultValue={client.email ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label htmlFor="phone" className="mb-1 block text-sm font-medium">
                  Phone
                </label>
                <input
                  id="phone"
                  name="phone"
                  defaultValue={client.phone ?? ""}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>
            </div>

            <button
              type="submit"
              className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
            >
              Save Profile
            </button>
          </form>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold">Portal Status</h2>

            <div className="mt-5 space-y-3">
              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Portal Access</p>
                <p className="mt-1 font-medium text-slate-900">Active</p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Access Type</p>
                <p className="mt-1 font-medium text-slate-900">
                  Independent Instructor
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold">Quick Links</h2>

            <div className="mt-5 grid gap-3">
              <Link
                href={`/portal/${encodeURIComponent(studio.slug)}/floor-space`}
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Book Floor Space
              </Link>

              <Link
                href={`/portal/${encodeURIComponent(studio.slug)}/floor-space/my-rentals`}
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                My Rentals
              </Link>

              <Link
                href={`/portal/${encodeURIComponent(studio.slug)}`}
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Portal Home
              </Link>
            </div>

            <form action="/auth/logout" method="post" className="mt-6">
              <button
                type="submit"
                className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
              >
                Log Out
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}