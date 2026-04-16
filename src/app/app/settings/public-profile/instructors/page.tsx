import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext, requireStudioRole } from "@/lib/auth/studio";
import { savePublicInstructorAction } from "./actions";

type SearchParams = Promise<{
  saved?: string;
}>;

type InstructorRow = {
  id: string;
  first_name: string;
  last_name: string;
  specialties: string | null;
  public_profile_enabled: boolean;
  public_bio: string | null;
  public_photo_url: string | null;
  years_experience: number | null;
  display_order: number;
};

type StudioRow = {
  id: string;
  slug: string | null;
  public_name: string | null;
  name: string;
};

function fullName(instructor: InstructorRow) {
  return `${instructor.first_name} ${instructor.last_name}`.trim();
}

function studioTitle(studio: StudioRow) {
  return studio.public_name?.trim() || studio.name;
}

export default async function PublicInstructorSettingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireStudioRole(["studio_owner", "studio_admin"]);

  const query = await searchParams;
  const context = await getCurrentStudioContext();
  const supabase = await createClient();

  const [
    { data: studio, error: studioError },
    { data: instructors, error: instructorsError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, slug, public_name, name")
      .eq("id", context.studioId)
      .single(),

    supabase
      .from("instructors")
      .select(`
        id,
        first_name,
        last_name,
        specialties,
        public_profile_enabled,
        public_bio,
        public_photo_url,
        years_experience,
        display_order
      `)
      .eq("studio_id", context.studioId)
      .order("display_order", { ascending: true })
      .order("first_name", { ascending: true }),
  ]);

  if (studioError || !studio) {
    throw new Error(`Failed to load studio: ${studioError?.message ?? "Studio not found"}`);
  }

  if (instructorsError) {
    throw new Error(`Failed to load instructors: ${instructorsError.message}`);
  }

  const typedStudio = studio as StudioRow;
  const typedInstructors = (instructors ?? []) as InstructorRow[];

  return (
    <div className="space-y-8">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
              Public Instructors
            </h1>
            <p className="mt-2 max-w-3xl text-slate-600">
              Choose which instructors appear on your public studio page and control their bios,
              photos, specialties, and display order.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/app/settings/public-profile"
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Back to Public Profile
            </Link>

            {typedStudio.slug ? (
              <Link
                href={`/studios/${typedStudio.slug}`}
                className="rounded-xl border px-4 py-2 hover:bg-slate-50"
              >
                Preview Public Page
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      {query.saved === "1" ? (
        <div className="rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Public instructor settings saved.
        </div>
      ) : null}

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">
          {studioTitle(typedStudio)} Instructor Directory
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Enabled instructors will appear on your public studio homepage.
        </p>

        {typedInstructors.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed bg-slate-50 px-4 py-10 text-center text-slate-500">
            No instructors found yet.
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            {typedInstructors.map((instructor) => (
              <form
                key={instructor.id}
                action={savePublicInstructorAction}
                className="rounded-2xl border bg-slate-50 p-5"
              >
                <input type="hidden" name="instructor_id" value={instructor.id} />

                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">
                      {fullName(instructor)}
                    </h3>
                    <p className="mt-1 text-sm text-slate-500">
                      Public profile controls for this instructor.
                    </p>
                  </div>

                  <label className="inline-flex items-center gap-3 rounded-xl border bg-white px-4 py-3">
                    <input
                      type="checkbox"
                      name="public_profile_enabled"
                      defaultChecked={Boolean(instructor.public_profile_enabled)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm font-medium text-slate-800">
                      Show on public page
                    </span>
                  </label>
                </div>

                <div className="mt-5 grid gap-5 md:grid-cols-2">
                  <div>
                    <label
                      htmlFor={`specialties-${instructor.id}`}
                      className="mb-1 block text-sm font-medium"
                    >
                      Specialties
                    </label>
                    <input
                      id={`specialties-${instructor.id}`}
                      name="specialties"
                      defaultValue={instructor.specialties ?? ""}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      placeholder="Country, ballroom, wedding dance"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`public_photo_url-${instructor.id}`}
                      className="mb-1 block text-sm font-medium"
                    >
                      Public photo URL
                    </label>
                    <input
                      id={`public_photo_url-${instructor.id}`}
                      name="public_photo_url"
                      defaultValue={instructor.public_photo_url ?? ""}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      placeholder="https://..."
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`years_experience-${instructor.id}`}
                      className="mb-1 block text-sm font-medium"
                    >
                      Years of experience
                    </label>
                    <input
                      id={`years_experience-${instructor.id}`}
                      name="years_experience"
                      type="number"
                      min={0}
                      defaultValue={instructor.years_experience ?? ""}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`display_order-${instructor.id}`}
                      className="mb-1 block text-sm font-medium"
                    >
                      Display order
                    </label>
                    <input
                      id={`display_order-${instructor.id}`}
                      name="display_order"
                      type="number"
                      min={0}
                      defaultValue={instructor.display_order ?? 0}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label
                      htmlFor={`public_bio-${instructor.id}`}
                      className="mb-1 block text-sm font-medium"
                    >
                      Public bio
                    </label>
                    <textarea
                      id={`public_bio-${instructor.id}`}
                      name="public_bio"
                      defaultValue={instructor.public_bio ?? ""}
                      rows={5}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      placeholder="Tell new dancers about this instructor’s background, teaching style, and specialties."
                    />
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-3">
                  <button
                    type="submit"
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    Save Instructor
                  </button>

                  {instructor.public_profile_enabled ? (
                    <span className="inline-flex items-center rounded-xl bg-green-50 px-3 py-2 text-sm font-medium text-green-700">
                      Public profile enabled
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-xl bg-slate-200 px-3 py-2 text-sm font-medium text-slate-600">
                      Hidden from public page
                    </span>
                  )}
                </div>
              </form>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}