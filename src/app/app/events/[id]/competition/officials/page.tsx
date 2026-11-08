import { randomUUID } from "crypto";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import {
  OFFICIAL_ERROR_COPY,
  OFFICIAL_ROLE_LABELS,
  OFFICIAL_SAVED_COPY,
  OFFICIAL_ROLES,
  panelEditable,
  panelStatusLabel,
  type OfficialRole,
  type PanelStatus,
} from "@/lib/competition/officials/contract";
import {
  addOfficialAction,
  assignPanelMemberAction,
  clearChairAction,
  deactivateOfficialAction,
  setChairAction,
  unassignPanelMemberAction,
} from "./actions";

type Official = { id: string; user_id: string; role: OfficialRole; status: "active" | "inactive"; deactivation_reason: string | null };
type Candidate = { user_id: string; display_name: string; email: string; team: string; account_verified: boolean };
type Round = { id: string; name: string; round_type: string; status: string; sequence_number: number; division_id: string };
type Division = { id: string; name: string };
type Assignment = { id: string; round_id: string; official_id: string; judge_letter: string | null };

const inputClass = "h-10 min-w-0 rounded border border-slate-300 bg-white px-3 text-sm text-slate-950";
const buttonClass = "h-10 rounded bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800";
const quietButtonClass = "h-8 rounded border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 hover:bg-slate-50";

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export default async function CompetitionOfficialsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { supabase } = await requireCompetitionWorkspace(id);

  const [officialResult, roundResult, divisionResult, assignmentResult, candidateResult] = await Promise.all([
    supabase.from("event_competition_officials").select("id, user_id, role, status, deactivation_reason").eq("event_id", id).order("created_at"),
    supabase.from("event_competition_rounds").select("id, name, round_type, status, sequence_number, division_id").eq("event_id", id).neq("status", "cancelled").order("sequence_number"),
    supabase.from("event_competition_divisions").select("id, name").eq("event_id", id),
    supabase.from("event_competition_panel_assignments").select("id, round_id, official_id, judge_letter").eq("event_id", id),
    supabase.rpc("list_competition_official_candidates", { p_event_id: id }),
  ]);
  const loadError = officialResult.error || roundResult.error || divisionResult.error || assignmentResult.error || candidateResult.error;
  if (loadError) throw new Error(`Could not load officials: ${loadError.message}`);

  const officials = (officialResult.data ?? []) as Official[];
  const rounds = (roundResult.data ?? []) as Round[];
  const divisions = new Map(((divisionResult.data ?? []) as Division[]).map((division) => [division.id, division.name]));
  const assignments = (assignmentResult.data ?? []) as Assignment[];
  const candidates = (candidateResult.data ?? []) as Candidate[];
  const person = new Map(candidates.map((candidate) => [candidate.user_id, candidate]));
  const activeOfficials = officials.filter((official) => official.status === "active");
  const officialUserIds = new Set(officials.map((official) => official.user_id));
  const addable = candidates.filter((candidate) => !officialUserIds.has(candidate.user_id) || officials.some((o) => o.user_id === candidate.user_id && o.status === "inactive"));

  const panelStatuses = await Promise.all(
    rounds.map(async (round) => {
      const { data } = await supabase.rpc("competition_round_panel_status", { p_round_id: round.id });
      return [round.id, (data ?? null) as PanelStatus | null] as const;
    }),
  );
  const statusByRound = new Map(panelStatuses);
  const name = (official: Official) => person.get(official.user_id)?.display_name ?? "Team member";

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold text-slate-950">Officials and panels</h2>
        <p className="mt-1 text-sm text-slate-600">
          Choose who judges and scores this competition, then build each round&apos;s panel. Panels lock when a round starts. Officials sign in with their own
          DanceFlow account and see only their own assignments.
        </p>
      </header>

      {query.saved && OFFICIAL_SAVED_COPY[query.saved] ? <p role="status" className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{OFFICIAL_SAVED_COPY[query.saved]}</p> : null}
      {query.error ? <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{OFFICIAL_ERROR_COPY[query.error] ?? "The change could not be saved. Try again."}</p> : null}

      <section aria-labelledby="officials-heading" className="rounded border border-slate-200 bg-white p-4">
        <h3 id="officials-heading" className="text-base font-semibold text-slate-950">Officials</h3>
        <form action={addOfficialAction} className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="eventId" value={id} />
          <input type="hidden" name="requestId" value={randomUUID()} />
          <label className="grid gap-1 text-xs font-semibold text-slate-700">
            Person
            <select name="userId" required className={inputClass} defaultValue="">
              <option value="" disabled>Select a team member</option>
              {addable.map((candidate) => (
                <option key={candidate.user_id} value={candidate.user_id} disabled={!candidate.account_verified}>
                  {candidate.display_name} ({label(candidate.team)}){candidate.account_verified ? "" : " - email not verified"}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold text-slate-700">
            Role
            <select name="role" className={inputClass} defaultValue="judge">
              {OFFICIAL_ROLES.map((role) => <option key={role} value={role}>{OFFICIAL_ROLE_LABELS[role]}</option>)}
            </select>
          </label>
          <button type="submit" className={buttonClass}>Add official</button>
        </form>
        <p className="mt-2 text-xs text-slate-500">
          Officials must be active members of this studio or organizer team with a verified email and password. Inviting an outside judge who has no team
          account is not available yet.
        </p>

        {officials.length === 0 ? (
          <p className="mt-4 text-sm text-slate-600">No officials yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-200">
            {officials.map((official) => (
              <li key={official.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-950">{name(official)}</p>
                  <p className="text-xs text-slate-600">
                    {OFFICIAL_ROLE_LABELS[official.role]}
                    {official.status === "inactive" ? ` - inactive${official.deactivation_reason ? ` (${official.deactivation_reason})` : ""}` : ""}
                  </p>
                </div>
                {official.status === "active" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {official.role === "chair" ? (
                      <form action={clearChairAction}>
                        <input type="hidden" name="eventId" value={id} />
                        <input type="hidden" name="requestId" value={randomUUID()} />
                        <button type="submit" className={quietButtonClass}>Clear chair</button>
                      </form>
                    ) : official.role === "judge" ? (
                      <form action={setChairAction}>
                        <input type="hidden" name="eventId" value={id} />
                        <input type="hidden" name="officialId" value={official.id} />
                        <input type="hidden" name="requestId" value={randomUUID()} />
                        <button type="submit" className={quietButtonClass}>Make chair</button>
                      </form>
                    ) : null}
                    <form action={deactivateOfficialAction} className="flex items-center gap-2">
                      <input type="hidden" name="eventId" value={id} />
                      <input type="hidden" name="officialId" value={official.id} />
                      <input type="hidden" name="requestId" value={randomUUID()} />
                      <input name="reason" required maxLength={200} placeholder="Reason" aria-label={`Reason to deactivate ${name(official)}`} className="h-8 rounded border border-slate-300 px-2 text-xs" />
                      <button type="submit" className={quietButtonClass}>Deactivate</button>
                    </form>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="panels-heading" className="rounded border border-slate-200 bg-white p-4">
        <h3 id="panels-heading" className="text-base font-semibold text-slate-950">Round panels</h3>
        {rounds.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">Add divisions and rounds first; panels are built per round.</p>
        ) : (
          <div className="mt-3 space-y-4">
            {rounds.map((round) => {
              const roundAssignments = assignments.filter((assignment) => assignment.round_id === round.id);
              const editable = panelEditable(round.status);
              const assignedIds = new Set(roundAssignments.map((assignment) => assignment.official_id));
              const available = activeOfficials.filter((official) => !assignedIds.has(official.id));
              const status = statusByRound.get(round.id) ?? null;
              return (
                <article key={round.id} className="rounded border border-slate-200 p-3" aria-label={`${divisions.get(round.division_id) ?? "Division"} ${round.name}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">{divisions.get(round.division_id) ?? "Division"} - {round.name}</p>
                      <p className="text-xs text-slate-600">{label(round.round_type)} - round is {label(round.status)}{editable ? "" : " (panel locked)"}</p>
                    </div>
                    <span className={`rounded px-2 py-1 text-xs font-semibold ${status?.ready ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{panelStatusLabel(status)}</span>
                  </div>
                  {roundAssignments.length > 0 ? (
                    <ul className="mt-3 divide-y divide-slate-100">
                      {roundAssignments
                        .map((assignment) => ({ assignment, official: officials.find((official) => official.id === assignment.official_id) }))
                        .sort((a, b) => (a.assignment.judge_letter ?? "~").localeCompare(b.assignment.judge_letter ?? "~"))
                        .map(({ assignment, official }) => (
                          <li key={assignment.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                            <span>
                              <span className="mr-2 inline-block min-w-6 rounded bg-slate-100 px-1.5 py-0.5 text-center text-xs font-bold text-slate-800">{assignment.judge_letter ?? "-"}</span>
                              {official ? name(official) : "Official"}
                              <span className="ml-2 text-xs text-slate-500">{official ? OFFICIAL_ROLE_LABELS[official.role] : ""}</span>
                            </span>
                            {editable ? (
                              <form action={unassignPanelMemberAction}>
                                <input type="hidden" name="eventId" value={id} />
                                <input type="hidden" name="roundId" value={round.id} />
                                <input type="hidden" name="officialId" value={assignment.official_id} />
                                <input type="hidden" name="requestId" value={randomUUID()} />
                                <button type="submit" className={quietButtonClass}>Remove</button>
                              </form>
                            ) : null}
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-sm text-slate-600">No one assigned yet.</p>
                  )}
                  {editable && available.length > 0 ? (
                    <form action={assignPanelMemberAction} className="mt-3 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="eventId" value={id} />
                      <input type="hidden" name="roundId" value={round.id} />
                      <input type="hidden" name="requestId" value={randomUUID()} />
                      <label className="grid gap-1 text-xs font-semibold text-slate-700">
                        Official
                        <select name="officialId" required defaultValue="" className="h-9 rounded border border-slate-300 px-2 text-sm">
                          <option value="" disabled>Select</option>
                          {available.map((official) => <option key={official.id} value={official.id}>{name(official)} ({OFFICIAL_ROLE_LABELS[official.role]})</option>)}
                        </select>
                      </label>
                      <label className="grid gap-1 text-xs font-semibold text-slate-700">
                        Letter (optional)
                        <input name="judgeLetter" maxLength={2} placeholder="Auto" className="h-9 w-20 rounded border border-slate-300 px-2 text-sm uppercase" />
                      </label>
                      <button type="submit" className={quietButtonClass}>Add to panel</button>
                    </form>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
