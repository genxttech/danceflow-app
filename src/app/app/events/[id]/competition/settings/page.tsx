import Link from "next/link";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import type { ProfileDefaults, JudgingKey } from "@/lib/competition/simple/types";

type ProgramRow = {
  id: string;
  name: string;
  status: string;
  rules_profile_key: string | null;
  rules_profile_version: number | null;
  profile_locked_at: string | null;
  configuration: { simple?: { judging?: JudgingKey; preset?: string } } | null;
};

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export default async function CompetitionSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, event } = await requireCompetitionWorkspace(id);

  const { data: programRows, error } = await supabase
    .from("event_competition_programs")
    .select("id, name, status, rules_profile_key, rules_profile_version, profile_locked_at, configuration")
    .eq("event_id", id)
    .order("sort_order")
    .order("created_at");
  if (error) throw new Error("Could not load competition settings.");
  const programs = (programRows ?? []) as ProgramRow[];

  const profileKeys = [...new Set(programs.filter((program) => program.rules_profile_key).map((program) => program.rules_profile_key as string))];
  const { data: profiles } = profileKeys.length
    ? await supabase.from("competition_rules_profiles").select("profile_key, version, name, defaults").in("profile_key", profileKeys)
    : { data: [] };
  const profileFor = (program: ProgramRow) =>
    ((profiles ?? []) as Array<{ profile_key: string; version: number; name: string; defaults: ProfileDefaults }>).find(
      (profile) => profile.profile_key === program.rules_profile_key && profile.version === program.rules_profile_version,
    );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-950">Settings</h2>
        <p className="mt-1 text-sm text-slate-600">{event.name}</p>
      </div>

      {programs.length === 0 ? <p className="text-sm text-slate-600">No competition has been set up for this event yet.</p> : null}

      {programs.map((program) => {
        const profile = profileFor(program);
        const judging = program.configuration?.simple?.judging;
        return (
          <section key={program.id} className="rounded-xl border border-slate-200 bg-white p-6">
            <h3 className="text-base font-semibold text-slate-950">{program.name}</h3>
            <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</dt>
                <dd className="mt-0.5 text-slate-900">{label(program.status)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rules</dt>
                <dd className="mt-0.5 text-slate-900">
                  {program.rules_profile_key ? `${profile?.name ?? label(program.rules_profile_key)} · version ${program.rules_profile_version}` : "Set up with Advanced settings (no rules profile)"}
                </dd>
              </div>
              {judging && profile?.defaults?.judging?.[judging] ? (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Judging</dt>
                  <dd className="mt-0.5 text-slate-900">{profile.defaults.judging[judging].label}</dd>
                </div>
              ) : null}
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sanctioning</dt>
                <dd className="mt-0.5 text-slate-900">None. Following a rules profile never means an organization sanctioned the event.</dd>
              </div>
              {program.rules_profile_key ? (
                <div className="sm:col-span-2">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Configuration lock</dt>
                  <dd className="mt-0.5 text-slate-900">
                    {program.profile_locked_at
                      ? `Locked when published on ${new Date(program.profile_locked_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}. The rules version and its defaults can no longer change for this competition.`
                      : "Not locked yet. Publishing locks the rules version and its defaults for this competition."}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>
        );
      })}

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h3 className="text-base font-semibold text-slate-950">Advanced settings</h3>
        <p className="mt-1 text-sm text-slate-600">Categories, dances, rounds, registration rules, templates and restarting the setup. Everything you configured in the simple workspace is there too.</p>
        <Link href={`/app/events/${id}/competition/advanced`} className="mt-4 inline-flex h-10 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50">
          Open Advanced settings
        </Link>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h3 className="text-base font-semibold text-slate-950">Registration</h3>
        <p className="mt-1 text-sm text-slate-600">Online competition registration and payment are not available yet. They arrive in the next Competition OS update; nothing is sold or shown publicly today.</p>
        <Link href={`/app/events/${id}/edit`} className="mt-3 inline-block text-sm font-semibold text-slate-700 underline">
          Edit event dates and registration window
        </Link>
      </section>
    </div>
  );
}
