import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type StudioRow = {
  id: string;
  name: string;
};

type OrganizerRow = {
  id: string;
  name: string;
  slug: string;
  studio_id: string;
  studios:
    | { name: string }
    | { name: string }[]
    | null;
};

function getStudioName(
  value: { name: string } | { name: string }[] | null
) {
  const studio = Array.isArray(value) ? value[0] : value;
  return studio?.name ?? "Unknown studio";
}

export default async function PlatformSearch({
  query,
}: {
  query?: string;
}) {
  const q = (query ?? "").trim();

  if (!q) {
    return (
      <div className="rounded-2xl border bg-white p-4 shadow-sm">
        <form action="/platform" className="grid gap-3 md:grid-cols-[1fr_auto]">
          <input
            type="text"
            name="q"
            defaultValue=""
            placeholder="Search studios or organizers"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
          <button
            type="submit"
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
          >
            Search
          </button>
        </form>
      </div>
    );
  }

  const supabase = await createClient();

  const [{ data: studios, error: studiosError }, { data: organizers, error: organizersError }] =
    await Promise.all([
      supabase
        .from("studios")
        .select("id, name")
        .ilike("name", `%${q}%`)
        .order("name", { ascending: true })
        .limit(6),

      supabase
        .from("organizers")
        .select(`
          id,
          name,
          slug,
          studio_id,
          studios (
            name
          )
        `)
        .or(`name.ilike.%${q}%,slug.ilike.%${q}%`)
        .order("name", { ascending: true })
        .limit(6),
    ]);

  if (studiosError) {
    throw new Error(`Failed to search studios: ${studiosError.message}`);
  }

  if (organizersError) {
    throw new Error(`Failed to search organizers: ${organizersError.message}`);
  }

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];

  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <form action="/platform" className="grid gap-3 md:grid-cols-[1fr_auto]">
        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder="Search studios or organizers"
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        />
        <button
          type="submit"
          className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
        >
          Search
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-3">
        <Link
          href={`/platform/studios?q=${encodeURIComponent(q)}`}
          className="rounded-xl border px-3 py-2 text-sm hover:bg-slate-50"
        >
          Open Studios results
        </Link>
        <Link
          href={`/platform/organizers?q=${encodeURIComponent(q)}`}
          className="rounded-xl border px-3 py-2 text-sm hover:bg-slate-50"
        >
          Open Organizers results
        </Link>
      </div>

      <div className="mt-4 grid gap-5 lg:grid-cols-2">
        <div>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">Studios</h2>
            <Link
              href={`/platform/studios?q=${encodeURIComponent(q)}`}
              className="text-xs underline"
            >
              View all
            </Link>
          </div>

          {typedStudios.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No studio matches.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {typedStudios.map((studio) => (
                <div
                  key={studio.id}
                  className="rounded-xl border bg-slate-50 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">{studio.name}</p>
                    </div>

                    <div className="flex shrink-0 gap-2">
                      <Link
                        href={`/platform/studios?q=${encodeURIComponent(studio.name)}`}
                        className="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-white"
                      >
                        Filter
                      </Link>
                      <Link
                        href={`/platform/studios/${studio.id}`}
                        className="rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs text-white hover:bg-slate-800"
                      >
                        Open
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">Organizers</h2>
            <Link
              href={`/platform/organizers?q=${encodeURIComponent(q)}`}
              className="text-xs underline"
            >
              View all
            </Link>
          </div>

          {typedOrganizers.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No organizer matches.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {typedOrganizers.map((organizer) => (
                <div
                  key={organizer.id}
                  className="rounded-xl border bg-slate-50 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">{organizer.name}</p>
                      <p className="mt-1 text-sm text-slate-500">
                        {organizer.slug} • {getStudioName(organizer.studios)}
                      </p>
                    </div>

                    <div className="flex shrink-0 gap-2">
                      <Link
                        href={`/platform/organizers?q=${encodeURIComponent(organizer.name)}`}
                        className="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-white"
                      >
                        Filter
                      </Link>
                      <Link
                        href={`/platform/organizers/${organizer.id}`}
                        className="rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs text-white hover:bg-slate-800"
                      >
                        Open
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}