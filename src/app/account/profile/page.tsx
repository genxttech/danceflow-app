import Link from "next/link";
import { redirect } from "next/navigation";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import { createClient } from "@/lib/supabase/server";
import { getDancerProfile } from "@/lib/student-identity/profile";
import { updateAccountDancerProfileAction } from "./actions";

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

const skillLevels = [
  ["", "Not set"],
  ["newcomer", "Newcomer"],
  ["beginner", "Beginner"],
  ["social", "Social dancer"],
  ["intermediate", "Intermediate"],
  ["advanced", "Advanced"],
  ["competitive", "Competitive"],
  ["professional", "Professional"],
] as const;

export default async function AccountProfilePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const search = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?intent=public&next=/account/profile");
  }

  const profile = await getDancerProfile(user);

  return (
    <>
      <PublicSiteHeader />
      <main className="min-h-screen bg-[linear-gradient(180deg,#faf5ff_0%,#ffffff_24%,#f8fafc_100%)] px-4 py-8 sm:px-6">
        <div className="mx-auto max-w-5xl space-y-7">
          <section className="overflow-hidden rounded-[32px] border border-violet-200 bg-white shadow-sm">
            <div className="bg-[linear-gradient(135deg,#2e1065_0%,#5b21b6_60%,#7c3aed_100%)] px-6 py-9 text-white sm:px-8">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Account
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                My DanceFlow Profile
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-white/85 sm:text-base">
                This profile belongs to you and follows you across studios, events,
                discovery, partner search, and future DanceFlow experiences.
              </p>
            </div>
          </section>

          {search.success === "profile_updated" ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">
              Your DanceFlow profile was updated.
            </div>
          ) : null}

          {search.error === "profile_update_failed" ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">
              We could not update your profile. Review the fields and try again.
            </div>
          ) : null}

          <div className="grid gap-7 lg:grid-cols-[1fr_320px]">
            <form
              action={updateAccountDancerProfileAction}
              className="space-y-6 rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm sm:p-7"
            >
              <section>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
                  Identity
                </p>
                <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                  Your dancer information
                </h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Studios cannot change your DanceFlow login email from their client records.
                </p>

                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <label className="text-sm font-medium text-slate-700">
                    First name
                    <input name="firstName" defaultValue={profile.firstName} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    Last name
                    <input name="lastName" defaultValue={profile.lastName} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    Preferred name
                    <input name="preferredName" defaultValue={profile.preferredName} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    Login email
                    <input value={profile.email} disabled className="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-3 text-slate-500" />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    Phone
                    <input name="phone" defaultValue={profile.phone} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    Birthday
                    <input name="birthday" type="date" defaultValue={profile.birthday} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                  </label>
                </div>
              </section>

              <section className="border-t border-slate-200 pt-6">
                <h2 className="text-xl font-semibold text-slate-950">Location</h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                    Address line 1
                    <input name="addressLine1" defaultValue={profile.addressLine1} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                  </label>
                  <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                    Address line 2
                    <input name="addressLine2" defaultValue={profile.addressLine2} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    City
                    <input name="city" defaultValue={profile.city} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    State / region
                    <input name="state" defaultValue={profile.state} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    ZIP / postal code
                    <input name="postalCode" defaultValue={profile.postalCode} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                  </label>
                  <label className="text-sm font-medium text-slate-700">
                    Country
                    <input name="country" defaultValue={profile.country} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                  </label>
                </div>
              </section>

              <section className="border-t border-slate-200 pt-6">
                <h2 className="text-xl font-semibold text-slate-950">Dance journey</h2>
                <div className="mt-4 space-y-4">
                  <label className="block text-sm font-medium text-slate-700">
                    Dance interests
                    <textarea name="danceInterests" defaultValue={profile.danceInterests} rows={4} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                  </label>
                  <label className="block text-sm font-medium text-slate-700">
                    Dance goals
                    <input name="danceGoals" defaultValue={profile.danceGoals.join(", ")} placeholder="Social dancing, competition, confidence..." className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                    <span className="mt-2 block text-xs text-slate-500">Separate multiple goals with commas.</span>
                  </label>
                  <label className="block text-sm font-medium text-slate-700">
                    Skill level
                    <select name="skillLevel" defaultValue={profile.skillLevel} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3">
                      {skillLevels.map(([value, label]) => <option key={value || "unset"} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label className="block text-sm font-medium text-slate-700">
                    About your dance journey
                    <textarea name="bio" defaultValue={profile.bio} rows={5} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3" />
                  </label>
                  <label className="block text-sm font-medium text-slate-700">
                    Profile visibility
                    <select name="profileVisibility" defaultValue={profile.profileVisibility} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3">
                      <option value="private">Private</option>
                      <option value="connected_studios">Connected studios</option>
                      <option value="public">Public features</option>
                    </select>
                  </label>
                </div>
              </section>

              <button className="rounded-xl bg-violet-700 px-5 py-3 text-sm font-semibold text-white hover:bg-violet-800">
                Save DanceFlow Profile
              </button>
            </form>

            <aside className="space-y-5">
              <section className="rounded-[28px] border border-violet-200 bg-violet-50 p-5">
                <h2 className="text-lg font-semibold text-violet-950">You own this profile</h2>
                <p className="mt-2 text-sm leading-7 text-violet-900">
                  Studios keep separate client records for billing, attendance, notes,
                  packages, and studio communication.
                </p>
              </section>

              <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="text-lg font-semibold text-slate-950">Account links</h2>
                <div className="mt-4 grid gap-3">
                  <Link href="/account" className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                    Back to My Account
                  </Link>
                  <Link href="/discover" className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                    Discover DanceFlow
                  </Link>
                </div>
              </section>
            </aside>
          </div>
        </div>
      </main>
    </>
  );
}
