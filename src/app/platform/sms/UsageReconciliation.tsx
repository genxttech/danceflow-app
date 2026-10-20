import { formatUsd } from "@/lib/billing/smsCreditView";
import type { ReconcileOverview, ReconcileSummaryKey } from "@/lib/sms/usageReconcileView";
import { resolveUsageAttemptAction } from "./usageReconcileActions";

/**
 * Platform-admin monitoring of billed-text reconciliation, plus the one write: resolving a stuck attempt with a written reason. The database decides
 * whether a resolution is allowed. No message bodies or client phone numbers are ever shown (the overview carries none).
 */

const ERRORS: Record<string, string> = {
  invalid: "Choose an outcome, enter segments (1 to 10) when charging, and give a reason of 10 to 300 characters.",
  not_allowed: "You are not allowed to resolve this attempt.",
  not_resolvable: "This attempt cannot be resolved now. It needs 15 minutes since dispatch; check the outcome, the segments and the reason.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  failed: "The attempt could not be resolved. Nothing changed.",
};

const SUMMARY_LABELS: [ReconcileSummaryKey, string][] = [
  ["released_unsent", "released unsent"], ["settled", "settled"], ["charged_cents", "charged"], ["pending", "pending"], ["review", "review"],
  ["retrying", "retrying"], ["errors", "errors"], ["escalated", "escalated"], ["inbound_recovered", "inbound recovered"],
  ["inbound_unrouted", "inbound unrouted"], ["inbound_keywords_unseen", "keywords unseen"], ["inbound_refused", "inbound refused"], ["inbound_stalled", "inbound stalled"], ["truncated", "truncated"], ["evidence_read", "evidence read"],
];

const stamp = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") + "Z" : "never");

function age(iso: string | null): string {
  const ms = iso ? Date.now() - Date.parse(iso) : NaN;
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const m = Math.floor(ms / 60000);
  return m < 120 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
}

function duration(start: string | null, end: string | null): string {
  const ms = start && end ? Date.parse(end) - Date.parse(start) : NaN;
  return Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms / 1000)} s` : "-";
}

function summaryText(summary: Partial<Record<ReconcileSummaryKey, number>>): string {
  const parts = SUMMARY_LABELS.flatMap(([k, label]) => (summary[k] === undefined ? [] : [k === "charged_cents" ? `${label} ${formatUsd(summary[k] ?? 0)}` : `${label} ${summary[k]}`]));
  return parts.length ? parts.join(" · ") : "no summary";
}

export default function UsageReconciliation({ overview, notice = false, error = null }: { overview: ReconcileOverview | null; notice?: boolean; error?: string | null }) {
  if (!overview) return null;
  const o = overview;
  const gaps = o.usageGaps > 0 || o.inboundGaps > 0;
  const attention = o.stale || gaps || o.exceptions.length > 0 || o.inbound.keywordsUnseen.length > 0 || o.inbound.unresolved.length > 0 || o.inbound.unscannedAccounts > 0;
  const states = Object.entries(o.byState);

  return (
    <section id="usage-reconciliation" aria-labelledby="usage-reconciliation-title" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <h2 id="usage-reconciliation-title" className="text-base font-semibold text-slate-900">Usage reconciliation</h2>

      {notice ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">The attempt was resolved.</p> : null}
      {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{ERRORS[error] ?? ERRORS.failed}</p> : null}

      {o.stale ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900">
          Reconciliation is not running. Last completed run: {stamp(o.lastCompletedAt)}. Billed texts can sit reserved or unsettled until it runs.
        </p>
      ) : null}
      {gaps ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900">
          The ledger does not reconcile: {o.usageGaps} outbound gap(s), {o.inboundGaps} inbound gap(s). Do not resolve anything until this is understood.
        </p>
      ) : null}

      <p className="text-sm text-slate-700">
        Billed texting is <span className="font-semibold">{o.switchOn ? "ON" : "OFF"}</span> · last completed run {stamp(o.lastCompletedAt)}
        {o.running ? ` · a run is in progress (started ${stamp(o.running.startedAt)}, lease until ${stamp(o.running.leaseExpiresAt)})` : ""}
      </p>

      <details open={attention}>
        <summary className="cursor-pointer text-sm font-semibold text-violet-800">
          Needs attention ({o.exceptions.length} escalated, {o.inbound.keywordsUnseen.length} keywords unseen)
        </summary>
        <div className="mt-3 space-y-4 text-sm">
          <div>
            <h3 className="font-semibold text-slate-800">Open attempts</h3>
            <p className="mt-1 text-slate-700">
              {states.length ? states.map(([s, n]) => `${s} ${n}`).join(" · ") : "None open."}
            </p>
            <p className="text-slate-700">
              Stale reserved {o.staleReserved} · evidence retrying {o.evidenceRetrying} · escalated open {o.escalatedOpen} · reserved {formatUsd(o.reservedOpenCents)}
            </p>
          </div>

          <div>
            <h3 className="font-semibold text-slate-800">Escalated attempts</h3>
            {o.exceptions.length ? (
              <ul className="mt-1 space-y-3">
                {o.exceptions.map((x) => (
                  <li key={x.attemptId} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
                    <p className="text-slate-900">
                      <span className="font-mono font-medium">{x.attemptId.slice(0, 8)}</span> · {x.state} · escalated {age(x.escalatedAt)} ago · {formatUsd(x.reservedCents)} reserved ·{" "}
                      {x.hasProviderMessage ? "has provider message" : "no provider message"}
                    </p>
                    <p className="text-xs text-slate-600">
                      {[x.reviewReason, x.submitErrorCode, x.evidenceStatus, x.evidenceErrorCode, x.callbackStatus].filter(Boolean).join(" · ") || "no reason recorded"}
                      {x.evidenceFailures > 0 ? ` · evidence failures ${x.evidenceFailures}` : ""}
                    </p>
                    <form action={resolveUsageAttemptAction} className="space-y-2">
                      <input type="hidden" name="attemptId" value={x.attemptId} />
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="text-xs font-semibold text-slate-700">
                          Outcome{" "}
                          <select name="outcome" required defaultValue={x.hasProviderMessage ? "charged" : "released"} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
                            {x.hasProviderMessage ? (
                              <>
                                <option value="charged">Charge segments</option>
                                <option value="not_charged">Close without charge</option>
                              </>
                            ) : (
                              <option value="released">Release (not sent)</option>
                            )}
                          </select>
                        </label>
                        {x.hasProviderMessage ? (
                          <label className="text-xs font-semibold text-slate-700">
                            Segments{" "}
                            <input type="number" name="segments" min={1} max={10} defaultValue={x.estimatedSegments} className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-sm" />
                          </label>
                        ) : null}
                      </div>
                      <label className="block text-xs font-semibold text-slate-700">
                        Reason (10 to 300 characters)
                        <textarea name="reason" required minLength={10} maxLength={300} rows={2} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm font-normal" />
                      </label>
                      <p className="text-xs text-amber-800">This moves money and is final. Check the provider record first; it cannot be undone.</p>
                      <button type="submit" className="rounded-lg bg-violet-700 px-3 py-1.5 text-sm font-semibold text-white">Resolve attempt</button>
                    </form>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-slate-600">None.</p>
            )}
          </div>

          <div>
            <h3 className="font-semibold text-slate-800">Inbound recovery</h3>
            <p className="mt-1 text-slate-700">
              Unscanned accounts {o.inbound.unscannedAccounts} · recovered in 7 days:{" "}
              {Object.entries(o.inbound.recovered7d).length ? Object.entries(o.inbound.recovered7d).map(([b, n]) => `${b} ${n}`).join(", ") : "none"}
            </p>
            {o.inbound.cursors.length ? (
              <ul className="mt-1 divide-y divide-slate-100 rounded-xl border border-slate-200">
                {o.inbound.cursors.map((c) => (
                  <li key={c.accountSid} className="flex justify-between gap-2 px-3 py-1.5">
                    <span className="font-mono text-xs text-slate-800">{c.accountSid.slice(0, 6)}...{c.accountSid.slice(-4)}</span>
                    <span className="text-slate-700">scanned through {stamp(c.scannedThrough)} · lag {c.lagMinutes} min</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {o.inbound.keywordsUnseen.length ? (
              <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-red-900">
                <p className="font-semibold">STOP/START/HELP recovered from Twilio that the webhook did not record ({o.inbound.keywordsUnseen.length})</p>
                <p className="text-xs">
                  DanceFlow may not have applied the consent change (the webhook never saw it, or stopped after receiving it). Twilio Advanced Opt-Out still blocks at
                  the carrier. Review the client&apos;s consent by hand.
                </p>
                <ul className="mt-1 text-xs">
                  {o.inbound.keywordsUnseen.map((k) => (
                    <li key={k.providerSid}>{k.providerSid} · recovered {stamp(k.recoveredAt)} · {k.webhookSeen ? "webhook received it but did not finish" : "webhook never saw it"}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {o.inbound.unresolved.length ? (
              <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                <p className="font-semibold">
                  Inbound texts that could not be recorded ({Object.entries(o.inbound.unresolved7d).map(([r, n]) => `${r} ${n}`).join(", ") || "none"} in 7 days)
                </p>
                <p className="text-xs">Nothing was charged for these. Unrouted: no sender is recorded for the receiving number. Refused: the database would not attribute it.</p>
                <ul className="mt-1 text-xs">
                  {o.inbound.unresolved.map((u) => (
                    <li key={u.providerSid}>{u.providerSid} · {u.reason}{u.code ? ` (${u.code})` : ""} · {stamp(u.notedAt)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      </details>

      <details>
        <summary className="cursor-pointer text-sm font-semibold text-violet-800">Last runs ({o.runs.length})</summary>
        {o.runs.length ? (
          <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
            {o.runs.map((r) => (
              <li key={r.runId} className="px-3 py-2">
                <p className="text-slate-900">
                  {r.status}{r.hasError ? " (error)" : ""} · started {stamp(r.startedAt)} · {duration(r.startedAt, r.finishedAt)}
                </p>
                <p className="text-xs text-slate-600">{summaryText(r.summary)}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">No runs yet.</p>
        )}
      </details>
    </section>
  );
}
