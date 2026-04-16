import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext, requireStudioRole } from "@/lib/auth/studio";
import { savePublicProfileAction } from "./actions";

type SearchParams = Promise<{
  saved?: string;
}>;

const STYLE_OPTIONS = [
  { key: "country", label: "Country" },
  { key: "ballroom", label: "Ballroom" },
  { key: "latin", label: "Latin" },
  { key: "salsa", label: "Salsa" },
  { key: "bachata", label: "Bachata" },
  { key: "swing", label: "Swing" },
  { key: "west_coast_swing", label: "West Coast Swing" },
  { key: "hip_hop", label: "Hip Hop" },
  { key: "contemporary", label: "Contemporary" },
  { key: "ballet", label: "Ballet" },
] as const;

const OFFERING_OPTIONS = [
  { key: "private_lessons", label: "Private Lessons" },
  { key: "group_classes", label: "Group Classes" },
  { key: "wedding_dance", label: "Wedding Dance" },
  { key: "kids_classes", label: "Kids Classes" },
  { key: "socials", label: "Social Dancing" },
  { key: "competitive_coaching", label: "Competitive Coaching" },
  { key: "beginner_program", label: "Beginner Program" },
  { key: "floor_rental", label: "Floor Rental" },
] as const;

function buildDefaultSlug(name: string | null) {
  return (name ?? "studio")
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export default async function PublicProfileSettingsPage({
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
    { data: styles, error: stylesError },
    { data: offerings, error: offeringsError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select(
        `
          id,
          name,
          slug,
          public_directory_enabled,
          public_name,
          public_short_description,
          public_about,
          city,
          state,
          postal_code,
          public_phone,
          public_email,
          public_website_url,
          public_logo_url,
          public_hero_image_url,
          beginner_friendly
        `
      )
      .eq("id", context.studioId)
      .single(),

    supabase
      .from("studio_public_styles")
      .select("style_key")
      .eq("studio_id", context.studioId),

    supabase
      .from("studio_public_offerings")
      .select("offering_key")
      .eq("studio_id", context.studioId),
  ]);

  if (studioError || !studio) {
    throw new Error(
      `Failed to load studio public profile: ${
        studioError?.message ?? "Studio not found."
      }`
    );
  }

  if (stylesError) {
    throw new Error(`Failed to load styles: ${stylesError.message}`);
  }

  if (offeringsError) {
    throw new Error(`Failed to load offerings: ${offeringsError.message}`);
  }

  const selectedStyles = new Set((styles ?? []).map((item) => item.style_key));
  const selectedOfferings = new Set(
    (offerings ?? []).map((item) => item.offering_key)
  );

  const effectivePublicName = studio.public_name ?? studio.name;
  const effectiveSlug = studio.slug ?? buildDefaultSlug(effectivePublicName);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-col gap-4 rounded-3xl border bg-white p-6 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.14em] text-slate-500">
            Public Profile
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
            Discovery and public-facing studio profile
          </h1>
          <p className="mt-3 max-w-3xl text-sm text-slate-600">
            Control how your studio appears in public discovery, what people see
            on your studio page, and how they contact you.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/discover/studios"
            className="inline-flex items-center rounded-xl border px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            View directory
          </Link>

          {studio.slug ? (
            <Link
              href={`/studios/${studio.slug}`}
              className="inline-flex items-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              View public page
            </Link>
          ) : null}
        </div>
      </div>

      {query.saved === "1" ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Public profile saved successfully.
        </div>
      ) : null}

      <form action={savePublicProfileAction} className="space-y-8">
        <input type="hidden" name="studio_name_fallback" value={studio.name} />

        <section className="rounded-3xl border bg-white p-6 shadow-sm">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-slate-900">
              Discovery settings
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Control whether your studio appears in the public directory and how
              beginners find you.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex items-start gap-3 rounded-2xl border p-4">
              <input
                type="checkbox"
                name="public_directory_enabled"
                defaultChecked={Boolean(studio.public_directory_enabled)}
                className="mt-1 h-4 w-4 rounded border-slate-300"
              />
              <div>
                <div className="font-medium text-slate-900">
                  Show studio in public discovery
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  Lets dancers find your studio on the public directory and studio
                  discovery pages.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 rounded-2xl border p-4">
              <input
                type="checkbox"
                name="beginner_friendly"
                defaultChecked={Boolean(studio.beginner_friendly)}
                className="mt-1 h-4 w-4 rounded border-slate-300"
              />
              <div>
                <div className="font-medium text-slate-900">
                  Beginner-friendly studio
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  Helps new dancers quickly identify beginner-safe studios and
                  offers.
                </p>
              </div>
            </label>
          </div>
        </section>

        <section className="rounded-3xl border bg-white p-6 shadow-sm">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-slate-900">
              Public identity
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              These details appear in public discovery and on your studio page.
            </p>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700">
                Public studio name
              </label>
              <input
                name="public_name"
                defaultValue={studio.public_name ?? ""}
                placeholder={studio.name}
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none ring-0 transition focus:border-slate-400"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700">
                Public slug
              </label>
              <input
                name="slug"
                defaultValue={effectiveSlug}
                placeholder="my-studio"
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none ring-0 transition focus:border-slate-400"
              />
              <p className="mt-2 text-xs text-slate-500">
                Used in your public studio URL.
              </p>
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700">
                Short description
              </label>
              <input
                name="public_short_description"
                defaultValue={studio.public_short_description ?? ""}
                placeholder="Social, private lessons, wedding dance, and beginner-friendly classes."
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none ring-0 transition focus:border-slate-400"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700">
                About the studio
              </label>
              <textarea
                name="public_about"
                defaultValue={studio.public_about ?? ""}
                rows={6}
                placeholder="Tell dancers what makes your studio different."
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none ring-0 transition focus:border-slate-400"
              />
            </div>
          </div>
        </section>

        <section className="rounded-3xl border bg-white p-6 shadow-sm">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-slate-900">
              Location and contact
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              This is what dancers use to decide whether to visit, call, or
              contact the studio.
            </p>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-slate-700">
                City
              </label>
              <input
                name="city"
                defaultValue={studio.city ?? ""}
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none ring-0 transition focus:border-slate-400"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700">
                State
              </label>
              <input
                name="state"
                defaultValue={studio.state ?? ""}
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none ring-0 transition focus:border-slate-400"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700">
                Postal code
              </label>
              <input
                name="postal_code"
                defaultValue={studio.postal_code ?? ""}
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none ring-0 transition focus:border-slate-400"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700">
                Public phone
              </label>
              <input
                name="public_phone"
                defaultValue={studio.public_phone ?? ""}
                placeholder="(555) 555-5555"
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none ring-0 transition focus:border-slate-400"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700">
                Public email
              </label>
              <input
                type="email"
                name="public_email"
                defaultValue={studio.public_email ?? ""}
                placeholder="hello@yourstudio.com"
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none ring-0 transition focus:border-slate-400"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700">
                Website
              </label>
              <input
                name="public_website_url"
                defaultValue={studio.public_website_url ?? ""}
                placeholder="yourstudio.com"
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none ring-0 transition focus:border-slate-400"
              />
            </div>
          </div>
        </section>

        <section className="rounded-3xl border bg-white p-6 shadow-sm">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-slate-900">
              Branding assets
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Optional public-facing images for directory cards and studio pages.
            </p>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-slate-700">
                Logo URL
              </label>
              <input
                name="public_logo_url"
                defaultValue={studio.public_logo_url ?? ""}
                placeholder="https://..."
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none ring-0 transition focus:border-slate-400"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700">
                Hero image URL
              </label>
              <input
                name="public_hero_image_url"
                defaultValue={studio.public_hero_image_url ?? ""}
                placeholder="https://..."
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none ring-0 transition focus:border-slate-400"
              />
            </div>
          </div>
        </section>

        <section className="rounded-3xl border bg-white p-6 shadow-sm">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-slate-900">
              Dance styles
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Used for public search and discovery filters.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {STYLE_OPTIONS.map((option) => (
              <label
                key={option.key}
                className="flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm text-slate-700"
              >
                <input
                  type="checkbox"
                  name="styles"
                  value={option.key}
                  defaultChecked={selectedStyles.has(option.key)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border bg-white p-6 shadow-sm">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-slate-900">
              Public offerings
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Show what people can actually do with your studio.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {OFFERING_OPTIONS.map((option) => (
              <label
                key={option.key}
                className="flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm text-slate-700"
              >
                <input
                  type="checkbox"
                  name="offerings"
                  value={option.key}
                  defaultChecked={selectedOfferings.has(option.key)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </section>

        <div className="sticky bottom-4 flex justify-end">
          <div className="rounded-2xl border bg-white p-3 shadow-lg">
            <button
              type="submit"
              className="inline-flex items-center rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
            >
              Save public profile
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}