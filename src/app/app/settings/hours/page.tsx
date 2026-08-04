import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageSettings } from "@/lib/auth/permissions";
import { redirect } from "next/navigation";
import StudioOperatingHoursForm from "./StudioOperatingHoursForm";

type SearchParams = Promise<{ success?: string }>;

type HoursRow = {
  weekday: number;
  is_closed: boolean;
  opens_at: string | null;
  closes_at: string | null;
};

export default async function StudioHoursSettingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect("/app");
  }

  const query = await searchParams;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("studio_operating_hours")
    .select("weekday, is_closed, opens_at, closes_at")
    .eq("studio_id", context.studioId)
    .order("weekday", { ascending: true });

  if (error) {
    throw new Error(`Studio hours could not be loaded: ${error.message}`);
  }

  return (
    <div className="space-y-6 bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.08),transparent_28%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.09),transparent_26%)] p-1">
      <section className="overflow-hidden rounded-[30px] border border-violet-200 bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,#111827_0%,#4c1d95_52%,#f97316_145%)] px-6 py-7 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-orange-200">
            Studio Operations
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Hours &amp; Scheduling
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/80">
            Set the studio’s normal operating hours. The Day and Week calendars
            use these hours while still expanding for appointments outside the
            normal schedule.
          </p>
        </div>
      </section>

      {query.success === "hours_saved" ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          Studio operating hours saved.
        </div>
      ) : null}

      <section>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-slate-950">
              Weekly operating hours
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
              These hours define the normal calendar range. Instructor
              availability and self-service windows can be narrower.
            </p>
          </div>
          <Link
            href="/app/settings"
            className="text-sm font-semibold text-violet-700 hover:text-violet-900"
          >
            Back to settings
          </Link>
        </div>

        <StudioOperatingHoursForm hours={(data ?? []) as HoursRow[]} />
      </section>
    </div>
  );
}
