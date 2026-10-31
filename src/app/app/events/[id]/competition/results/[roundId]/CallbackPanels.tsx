import { randomUUID } from "node:crypto";
import {
  advancementPanel,
  canCosign,
  effectivelyExcludedEntryIds,
  exclusionReasonLabel,
  exclusionWindowOpen,
  pendingExclusionRequests,
  EXCLUSION_REASON_KINDS,
  type AdvancementPreview,
  type ExclusionRow,
  type WithdrawalState,
} from "@/lib/competition/results/advancement";
import { excludedCoupleLabel, type ReviewExcludedCouple } from "@/lib/competition/results/reviewTypes";
import {
  applyAdvancementAction,
  cosignExclusionAction,
  cosignExclusionReversalAction,
  cosignFinalWithdrawalAction,
  requestExclusionAction,
  requestExclusionReversalAction,
  requestFinalWithdrawalAction,
} from "../actions";

export type Candidate = { entry_id: string; entry_number: string | null; display_name: string };

const input = "mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm";
const secondary = "rounded border border-slate-400 px-3 py-2 text-sm font-semibold text-slate-950";

function coupleName(candidates: readonly Candidate[], entryId: string) {
  const c = candidates.find((item) => item.entry_id === entryId);
  return c ? `${c.entry_number ? `#${c.entry_number} ` : ""}${c.display_name}` : "A couple of this round";
}

function Hidden({ returnTo, roundId }: { returnTo: string; roundId?: string }) {
  return (
    <>
      {roundId ? <input type="hidden" name="roundId" value={roundId} /> : null}
      <input type="hidden" name="requestId" value={randomUUID()} />
      <input type="hidden" name="returnTo" value={returnTo} />
    </>
  );
}

/** The couples currently excluded from the ranking, with the recorded reason. Shown to everyone who can read the review; never as a no-show. */
export function ExcludedSection({ excluded }: { excluded: readonly ReviewExcludedCouple[] }) {
  if (excluded.length === 0) return null;
  return (
    <section className="space-y-2 rounded border border-amber-300 bg-amber-50 p-4" aria-label="Excluded couples">
      <h3 className="text-sm font-semibold text-slate-950">Excluded from the ranking</h3>
      <p className="text-xs text-slate-700">These couples danced but are not ranked. Their heat entries, ballots and marks are kept.</p>
      <ul className="space-y-1 text-sm">
        {excluded.map((couple) => (
          <li key={couple.exclusion_id}>
            <span className="font-medium">
              {couple.entry_number ? `#${couple.entry_number} ` : ""}
              {couple.display_name ?? "Entry"}
            </span>{" "}
            - {excludedCoupleLabel(couple)}
            <span className="block text-xs text-slate-600">
              Requested by {couple.requested_by_name || "a manager"}
              {couple.requested_by_role ? ` (${couple.requested_by_role})` : ""}, co-signed by {couple.cosigned_by_name || "a second person"}
              {couple.cosigned_by_role ? ` (${couple.cosigned_by_role})` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Advance to Final: shown to managers on a callback preliminary round. No override control exists for a blocked tie. */
export function AdvancementSection({
  preview,
  roundId,
  roundStatus,
  versionId,
  returnTo,
}: {
  preview: AdvancementPreview;
  roundId: string;
  roundStatus: string;
  versionId: string | null;
  returnTo: string;
}) {
  const panel = advancementPanel(preview, { isManager: true, roundStatus });
  if (!panel.show) return null;
  return (
    <section className="space-y-2 rounded border border-slate-200 bg-white p-4" aria-label="Advance to Final">
      <h3 className="text-sm font-semibold text-slate-950">Advance to Final</h3>
      <p className="text-sm text-slate-700">{panel.headline}</p>
      {panel.blockerMessages.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-rose-900">
          {panel.blockerMessages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      {panel.canApply && versionId ? (
        <form action={applyAdvancementAction}>
          <Hidden roundId={roundId} returnTo={returnTo} />
          <input type="hidden" name="versionId" value={versionId} />
          <button type="submit" className="rounded bg-slate-950 px-3 py-2 text-sm font-semibold text-white">
            Advance to Final
          </button>
        </form>
      ) : null}
    </section>
  );
}

/** Manager-only exclusion panel: request, co-sign, reversal request, reversal co-sign. A reason is always required. */
export function ExclusionPanel({
  rows,
  candidates,
  roundId,
  roundStatus,
  viewerId,
  returnTo,
}: {
  rows: readonly ExclusionRow[];
  candidates: readonly Candidate[];
  roundId: string;
  roundStatus: string;
  viewerId: string;
  returnTo: string;
}) {
  const pending = pendingExclusionRequests(rows);
  const excludedIds = effectivelyExcludedEntryIds(rows);
  const open = exclusionWindowOpen(roundStatus);
  if (!open && pending.length === 0 && excludedIds.size === 0) return null;
  return (
    <section className="space-y-3 rounded border border-slate-200 bg-white p-4" aria-label="Exclude a couple">
      <h3 className="text-sm font-semibold text-slate-950">Exclude a couple (danced, then ineligible or refunded)</h3>
      <p className="text-xs text-slate-600">
        Only for a couple who danced and later became ineligible or was refunded. It needs a reason and a second person to co-sign, and your email must be verified.
        {open ? "" : " New requests are only possible while the round is running or its ballots are locked; open a correction first."}
      </p>

      {pending.length > 0 ? (
        <ul className="space-y-2">
          {pending.map((row) => {
            const reversal = row.kind === "reverse_requested";
            return (
              <li key={row.id} className="rounded border border-slate-200 p-2 text-sm">
                <p>
                  <span className="font-medium">{reversal ? "Reversal requested" : "Exclusion requested"}</span> for {coupleName(candidates, row.entryId)} ({exclusionReasonLabel(row.reasonKind)}): {row.reason}
                </p>
                {canCosign(row, viewerId) ? (
                  <form action={reversal ? cosignExclusionReversalAction : cosignExclusionAction} className="mt-2">
                    <Hidden returnTo={returnTo} />
                    <input type="hidden" name="decisionId" value={row.id} />
                    <button type="submit" className={secondary}>
                      Co-sign {reversal ? "reversal" : "exclusion"}
                    </button>
                  </form>
                ) : (
                  <p className="mt-1 text-xs text-slate-600">Waiting for a different person to co-sign.</p>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {open && candidates.length > 0 ? (
        <form action={requestExclusionAction} className="space-y-2">
          <Hidden roundId={roundId} returnTo={returnTo} />
          <label className="block text-sm text-slate-700">
            Couple
            <select name="entryId" required className={input}>
              {candidates
                .filter((c) => !excludedIds.has(c.entry_id))
                .map((c) => (
                  <option key={c.entry_id} value={c.entry_id}>
                    {coupleName(candidates, c.entry_id)}
                  </option>
                ))}
            </select>
          </label>
          <label className="block text-sm text-slate-700">
            Why
            <select name="reasonKind" required className={input}>
              {EXCLUSION_REASON_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {exclusionReasonLabel(kind)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-slate-700">
            Reason (required, kept in the record)
            <input name="reason" required minLength={3} maxLength={500} className={input} />
          </label>
          <button type="submit" className={secondary}>
            Request exclusion
          </button>
        </form>
      ) : null}

      {open && excludedIds.size > 0 ? (
        <form action={requestExclusionReversalAction} className="space-y-2 border-t border-slate-100 pt-3">
          <Hidden roundId={roundId} returnTo={returnTo} />
          <p className="text-xs text-slate-600">After the cause is corrected, a still-ineligible or still-refunded couple cannot be restored.</p>
          <label className="block text-sm text-slate-700">
            Excluded couple
            <select name="entryId" required className={input}>
              {[...excludedIds].map((id) => (
                <option key={id} value={id}>
                  {coupleName(candidates, id)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-slate-700">
            Reason for reversing (required)
            <input name="reason" required minLength={3} maxLength={500} className={input} />
          </label>
          <button type="submit" className={secondary}>
            Request reversal
          </button>
        </form>
      ) : null}
    </section>
  );
}

/** Final round only: withdraw / reinstate an advanced couple, two-person. */
export function WithdrawalPanel({
  state,
  candidates,
  roundId,
  viewerId,
  returnTo,
}: {
  state: WithdrawalState;
  candidates: readonly Candidate[];
  roundId: string;
  viewerId: string;
  returnTo: string;
}) {
  return (
    <section className="space-y-3 rounded border border-slate-200 bg-white p-4" aria-label="Withdraw a couple from the Final">
      <h3 className="text-sm font-semibold text-slate-950">Withdraw or reinstate a couple</h3>
      <p className="text-xs text-slate-600">
        Before the Final starts and before it has ballots. A manager requests; a different chair or manager co-signs. The reason must be specific (at least 20 characters).
      </p>
      {state.withdrawn.length > 0 ? <p className="text-sm text-slate-700">Withdrawn: {state.withdrawn.map((w) => coupleName(candidates, w.entryId)).join(", ")}</p> : null}
      {state.pending.length > 0 ? (
        <ul className="space-y-2">
          {state.pending.map((p) => (
            <li key={p.requestId} className="rounded border border-slate-200 p-2 text-sm">
              <p>
                <span className="font-medium">{p.kind === "withdraw" ? "Withdrawal" : "Reinstatement"} requested</span> for {coupleName(candidates, p.entryId)}: {p.reason}
              </p>
              {p.requestedBy !== viewerId ? (
                <form action={cosignFinalWithdrawalAction} className="mt-2">
                  <input type="hidden" name="requestId" value={p.requestId} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button type="submit" className={secondary}>
                    Co-sign
                  </button>
                </form>
              ) : (
                <p className="mt-1 text-xs text-slate-600">Waiting for a different person to co-sign.</p>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {(["withdraw", "reinstate"] as const).map((kind) => {
        const options = kind === "withdraw" ? candidates.filter((c) => !state.withdrawn.some((w) => w.entryId === c.entry_id)) : candidates.filter((c) => state.withdrawn.some((w) => w.entryId === c.entry_id));
        if (options.length === 0) return null;
        return (
          <form key={kind} action={requestFinalWithdrawalAction} className="space-y-2 border-t border-slate-100 pt-3">
            <Hidden roundId={roundId} returnTo={returnTo} />
            <input type="hidden" name="kind" value={kind} />
            <label className="block text-sm text-slate-700">
              {kind === "withdraw" ? "Couple to withdraw" : "Couple to reinstate"}
              <select name="entryId" required className={input}>
                {options.map((c) => (
                  <option key={c.entry_id} value={c.entry_id}>
                    {coupleName(candidates, c.entry_id)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-slate-700">
              Reason (required)
              <input name="reason" required minLength={20} maxLength={500} className={input} />
            </label>
            <button type="submit" className={secondary}>
              Request {kind === "withdraw" ? "withdrawal" : "reinstatement"}
            </button>
          </form>
        );
      })}
    </section>
  );
}
