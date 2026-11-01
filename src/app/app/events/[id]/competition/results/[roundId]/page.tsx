import { randomUUID } from "node:crypto";
import { shouldNotFound } from "@/lib/competition/pageLoadError";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import { parseAdvancementPreview, parseExclusionRows, parseWithdrawalState, withdrawalControlsBlocked } from "@/lib/competition/results/advancement";
import { parseReviewExcluded } from "@/lib/competition/results/reviewTypes";
import { correctionCosignPanel, parseCorrectionState } from "@/lib/competition/results/correction";
import { approveRoundResultAction, cosignCorrectionAction, calculateRoundResultAction, completeRoundAction, openRoundCorrectionAction } from "../actions";
import { deriveUnresolvedTie, type UnresolvedTie } from "@/lib/competition/results/unresolvedTie";
import { AdvancementSection, UnresolvedTiePanel, ExcludedSection, ExclusionPanel, WithdrawalPanel, type Candidate } from "./CallbackPanels";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ReviewRow = {
  entry_id: string;
  entry_number: string | null;
  display_name: string | null;
  placement: number | null;
  tie_group: string | null;
  advanced: boolean | null;
  rating_band: string | null;
};
type ReviewVersion = {
  id: string;
  version: number;
  status: string;
  engine_key: string;
  engine_version: string;
  input_hash: string;
  trace_hash: string;
  warnings: string[];
  calculated_by: string;
  calculated_by_name: string | null;
  calculated_at: string;
  stale: boolean;
  approval: { approved_by: string; approved_at: string; override_reason: string | null } | null;
  rows: ReviewRow[];
};
type Review = {
  viewer_role: "manager" | "scorer";
  viewer_id: string;
  round: { id: string; name: string; status: string; scoring_method: string; correction_open: boolean };
  versions: ReviewVersion[];
};

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Manager review / approve page for one round (F2). The database decides every transition; this page only shows state
 * and posts to the server actions. Approve is offered to managers only, and the calculator is told up front that an
 * override reason is needed.
 */
export default async function CompetitionRoundResultsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; roundId: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id, roundId } = await params;
  const query = await searchParams;
  if (!UUID.test(roundId)) notFound();
  const { supabase } = await requireCompetitionWorkspace(id);

  // The round must belong to this event: the RPC alone is not told which event the URL named.
  const { data: round } = await supabase
    .from("event_competition_rounds")
    .select("id, round_type, scoring_method, division_id, sequence_number")
    .eq("id", roundId)
    .eq("event_id", id)
    .maybeSingle();
  if (!round) notFound();
  const { data, error } = await supabase.rpc("competition_round_results_review", { p_round_id: roundId });
  if (shouldNotFound(error, data)) notFound();
  const review = data as Review;
  const returnTo = `/app/events/${id}/competition/results/${roundId}`;
  const isManager = review.viewer_role === "manager";
  const status = review.round.status;
  const latest = review.versions[0];
  const excluded = parseReviewExcluded(review);

  // CF1 (manager only; every read below is also refused by the database for anyone else, and an unreadable answer shows nothing).
  const isCallbackPreliminary = round.scoring_method === "callback_tally" && round.round_type !== "final";
  let isCallbackFinal = false;
  let sourceRound: { id: string; status: string } | null = null;
  if (isManager && round.round_type === "final") {
    const { data: previous } = await supabase
      .from("event_competition_rounds")
      .select("id, scoring_method, status")
      .eq("event_id", id)
      .eq("division_id", round.division_id)
      .eq("sequence_number", round.sequence_number - 1)
      .maybeSingle();
    isCallbackFinal = previous?.scoring_method === "callback_tally";
    if (isCallbackFinal && previous) sourceRound = { id: previous.id as string, status: previous.status as string };
  }
  const [previewResult, exclusionResult, withdrawalResult, boardResult, correctionResult] = isManager
    ? await Promise.all([
        isCallbackPreliminary ? supabase.rpc("competition_round_advancement_preview", { p_round_id: roundId }) : Promise.resolve({ data: null }),
        supabase.rpc("competition_round_exclusions", { p_round_id: roundId }),
        isCallbackFinal ? supabase.rpc("competition_final_withdrawal_state", { p_round_id: roundId }) : Promise.resolve({ data: null }),
        supabase.rpc("competition_round_ballot_status", { p_round_id: roundId }),
        review.round.correction_open ? supabase.rpc("competition_round_correction", { p_round_id: roundId }) : Promise.resolve({ data: null }),
      ])
    : [{ data: null }, { data: null }, { data: null }, { data: null }, { data: null }];
  const correctionPanel = correctionCosignPanel(parseCorrectionState(correctionResult.data), review.viewer_id);
  const preview = parseAdvancementPreview(previewResult.data);
  const sourcePreview = sourceRound ? parseAdvancementPreview((await supabase.rpc("competition_round_advancement_preview", { p_round_id: sourceRound.id })).data) : null;
  const withdrawalBlocked = sourceRound && sourcePreview ? withdrawalControlsBlocked({ advancementState: sourcePreview.state, sourceStatus: sourceRound.status }) : false;
  const exclusionRows = parseExclusionRows(exclusionResult.data);
  const withdrawalState = parseWithdrawalState(withdrawalResult.data);
  const candidates: Candidate[] = [];
  for (const heat of (boardResult.data as { heats?: Array<{ entries?: Candidate[] }> } | null)?.heats ?? []) {
    for (const entry of heat.entries ?? []) if (!candidates.some((c) => c.entry_id === entry.entry_id)) candidates.push(entry);
  }
  // An unresolved callback tie is read from the stored latest version only (its row outputs and cut trace); nothing is recomputed.
  let unresolvedTie: UnresolvedTie | null = null;
  if (isManager && isCallbackPreliminary && latest && (latest.status === "calculated" || latest.status === "approved")) {
    const [{ data: traceRow }, { data: outputRows }] = await Promise.all([
      supabase.from("event_competition_result_versions").select("trace").eq("id", latest.id).maybeSingle(),
      supabase.from("event_competition_result_rows").select("entry_id, output").eq("result_version_id", latest.id),
    ]);
    const outputs = new Map((outputRows ?? []).map((r) => [r.entry_id as string, r.output as unknown]));
    unresolvedTie = deriveUnresolvedTie({
      rows: latest.rows.map((r) => ({
        entryId: r.entry_id,
        label: `${r.entry_number ? `#${r.entry_number} ` : ""}${r.display_name ?? "Entry"}`,
        advanced: r.advanced,
        output: outputs.get(r.entry_id) ?? null,
      })),
      trace: (traceRow as { trace?: unknown } | null)?.trace ?? null,
    });
  }
  const approvedVersion = review.versions.find((version) => version.status === "approved") ?? null;

  return (
    <div className="space-y-4">
      <Link href={`/app/events/${id}/competition/results`} className="text-sm font-medium text-slate-600 hover:text-slate-950">
        &larr; All rounds
      </Link>
      {query.saved ? <p role="status" className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">{query.saved}</p> : null}
      {query.error ? <p role="alert" className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-950">{query.error}</p> : null}

      <div>
        <h2 className="text-lg font-semibold text-slate-950">{review.round.name}</h2>
        <p className="mt-1 text-sm text-slate-600">
          {label(review.round.scoring_method)} - round is {label(status)}
          {review.round.correction_open ? " (correction open)" : ""}
        </p>
      </div>

      {status === "ballots_locked" ? (
        <form action={calculateRoundResultAction} className="rounded border border-slate-200 bg-white p-4">
          <input type="hidden" name="roundId" value={roundId} />
          <input type="hidden" name="requestId" value={randomUUID()} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <p className="text-sm text-slate-700">
            Ballots are locked. Calculating runs the round&apos;s approved scoring engine on exactly these ballots and records a new result version.
          </p>
          <button type="submit" className="mt-3 rounded bg-slate-950 px-3 py-2 text-sm font-semibold text-white">
            Calculate result
          </button>
        </form>
      ) : null}

      {unresolvedTie ? <UnresolvedTiePanel tie={unresolvedTie} /> : null}

      {review.versions.length === 0 ? (
        <p className="rounded border border-slate-200 bg-white p-4 text-sm text-slate-700">No result has been calculated for this round yet.</p>
      ) : (
        review.versions.map((version, index) => {
          const canApprove = isManager && index === 0 && !(unresolvedTie && version.id === latest?.id) && status === "calculated" && version.status === "calculated" && !version.stale;
          const isCalculator = version.calculated_by === review.viewer_id;
          return (
            <section key={version.id} className="space-y-3 rounded border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-950">
                  Version {version.version} - {label(version.status)}
                  {version.stale ? " (ballots changed - recalculate)" : ""}
                </h3>
                <span className="text-xs text-slate-600">
                  Calculated by {version.calculated_by_name ?? "a manager"} on {new Date(version.calculated_at).toLocaleString()}
                </span>
              </div>
              <p className="break-all text-xs text-slate-500">
                Engine {version.engine_key}@{version.engine_version} - input {version.input_hash.slice(0, 12)} - trace {version.trace_hash.slice(0, 12)}
              </p>
              {version.warnings.length > 0 ? <p className="text-xs text-amber-800">Warnings: {version.warnings.join("; ")}</p> : null}
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs text-slate-600">
                    <th className="py-1 pr-3">Place</th>
                    <th className="py-1 pr-3">Entry</th>
                    <th className="py-1 pr-3">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {version.rows.map((row) => (
                    <tr key={row.entry_id} className="border-t border-slate-100">
                      <td className="py-1 pr-3">{row.placement ?? "-"}</td>
                      <td className="py-1 pr-3">
                        {row.entry_number ? `#${row.entry_number} ` : ""}
                        {row.display_name ?? "Entry"}
                      </td>
                      <td className="py-1 pr-3 text-xs text-slate-600">
                        {[row.tie_group ? `tie ${row.tie_group}` : null, row.advanced === null ? null : row.advanced ? "advances" : "does not advance", row.rating_band]
                          .filter(Boolean)
                          .join(" - ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {version.approval ? (
                <p className="text-xs text-slate-700">
                  Approved {new Date(version.approval.approved_at).toLocaleString()}
                  {version.approval.override_reason ? ` - single-staff override: ${version.approval.override_reason}` : ""}
                </p>
              ) : null}
              {canApprove ? (
                <form action={approveRoundResultAction} className="space-y-2 border-t border-slate-100 pt-3">
                  <input type="hidden" name="roundId" value={roundId} />
                  <input type="hidden" name="versionId" value={version.id} />
                  <input type="hidden" name="requestId" value={randomUUID()} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  {isCalculator ? (
                    <label className="block text-sm text-slate-700">
                      You calculated this result. A second manager should approve it. If you are the only manager, say why:
                      <input name="overrideReason" maxLength={500} className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
                    </label>
                  ) : null}
                  <button type="submit" className="rounded bg-slate-950 px-3 py-2 text-sm font-semibold text-white">
                    {isCalculator ? "Approve with override" : "Approve result"}
                  </button>
                </form>
              ) : null}
            </section>
          );
        })
      )}

      <ExcludedSection excluded={excluded} />

      {isManager && isCallbackPreliminary ? (
        <AdvancementSection preview={preview} roundId={roundId} roundStatus={status} versionId={approvedVersion?.id ?? null} returnTo={returnTo} />
      ) : null}

      {isManager ? (
        <ExclusionPanel rows={exclusionRows} candidates={candidates} roundId={roundId} roundStatus={status} viewerId={review.viewer_id} returnTo={returnTo} />
      ) : null}

      {isManager && isCallbackFinal ? (
        <WithdrawalPanel state={withdrawalState} candidates={candidates} roundId={roundId} viewerId={review.viewer_id} returnTo={returnTo} controlsBlocked={withdrawalBlocked} />
      ) : null}

      {isManager && correctionPanel.kind !== "hidden" ? (
        <section aria-label="Correction co-sign" className="space-y-2 rounded border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-950">Correction co-sign</h3>
          {correctionPanel.kind === "can_cosign" ? (
            <form action={cosignCorrectionAction} className="space-y-2">
              <input type="hidden" name="causeId" value={correctionPanel.causeId} />
              <input type="hidden" name="requestId" value={randomUUID()} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <p className="text-sm text-slate-700">A judge-entry correction needs a co-sign by the chair or a different manager before a replacement ballot is accepted.</p>
              <button type="submit" className="rounded border border-slate-400 px-3 py-2 text-sm font-semibold text-slate-950">
                Co-sign correction
              </button>
            </form>
          ) : (
            <p className="text-sm text-slate-700">{correctionPanel.text}</p>
          )}
        </section>
      ) : null}

      {isManager && ["calculated", "approved", "published"].includes(status) ? (
        <form action={openRoundCorrectionAction} className="space-y-2 rounded border border-slate-200 bg-white p-4">
          <input type="hidden" name="roundId" value={roundId} />
          <input type="hidden" name="requestId" value={randomUUID()} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <label className="block text-sm text-slate-700">
            Open a ballot correction (the current result becomes stale; certified heats stay certified). Reason:
            <input name="reason" required maxLength={500} className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
          </label>
          <button type="submit" className="rounded border border-slate-400 px-3 py-2 text-sm font-semibold text-slate-950">
            Open correction
          </button>
        </form>
      ) : null}

      {isManager && status === "published" && latest ? (
        <form action={completeRoundAction} className="rounded border border-slate-200 bg-white p-4">
          <input type="hidden" name="roundId" value={roundId} />
          <input type="hidden" name="requestId" value={randomUUID()} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button type="submit" className="rounded border border-slate-400 px-3 py-2 text-sm font-semibold text-slate-950">
            Complete round
          </button>
        </form>
      ) : null}
    </div>
  );
}
