import type { RunnerStatus } from "@/lib/sms/twilioIsv/store";

/**
 * TW-4F-1b: read-only evidence for one studio's registration run, for platform admins. It shows what the ledger and the audit trail say:
 * each step's status, the verdict of the evaluations (S10 / T5), who confirmed each irreversible submission and whether the confirmation
 * was used. It contains no business data, no EIN, no Twilio identifiers and offers no action.
 */

type Status = NonNullable<RunnerStatus>;

const EVALUATION_NOTE = /^step=(S10|T5);verdict=(compliant|noncompliant|unrecognized);context=(step|preverify);seq=(\d+)$/;

export function parseEvaluationNote(note: string): { step: "S10" | "T5"; verdict: "compliant" | "noncompliant" | "unrecognized"; context: "step" | "preverify"; seq: number } | null {
  const match = EVALUATION_NOTE.exec(note);
  if (!match) return null;
  return { step: match[1] as "S10" | "T5", verdict: match[2] as "compliant" | "noncompliant" | "unrecognized", context: match[3] as "step" | "preverify", seq: Number(match[4]) };
}

export const STEP_LABELS: Record<string, string> = {
  S1: "Draft profile", S2: "Business details", S3: "Representative", S4: "Address", S5: "Address document", S6: "Attach business", S7: "Attach representative",
  S8: "Attach document", S9: "Attach primary profile", S10: "Evaluate profile", S11: "SUBMIT profile for review", T1: "Trust product", T2: "Messaging details",
  T3: "Attach details", T4: "Attach profile", T5: "Evaluate trust product", T6: "SUBMIT trust product", B1: "Brand (fee)",
};

const VERDICT_TEXT: Record<string, string> = { compliant: "Compliant", noncompliant: "Not compliant", unrecognized: "Not recognized (treated as not compliant)" };

const shortId = (id: string) => (id.length > 8 ? `…${id.slice(-6)}` : id);

export default function SmsStepEvidence({ status }: { status: Status }) {
  const steps = status.steps ?? [];
  const confirmations = status.confirmations ?? [];
  const evaluations = (status.evaluations ?? []).map((event) => ({ at: event.at, parsed: parseEvaluationNote(event.note) })).filter((event) => event.parsed !== null);
  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700" data-testid="sms-step-evidence">
      <summary className="cursor-pointer select-none font-semibold text-slate-800">
        Steps and evidence (attempt {status.submission_seq}, {steps.length} step{steps.length === 1 ? "" : "s"} recorded)
      </summary>
      {steps.length === 0 ? (
        <p className="mt-2 text-slate-500">Nothing has run for this attempt yet.</p>
      ) : (
        <table className="mt-2 min-w-full text-left">
          <thead className="text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-1 pr-3">Step</th>
              <th className="py-1 pr-3">Result</th>
              <th className="py-1 pr-3">Evaluation</th>
              <th className="py-1 pr-3">Code</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {steps.map((step) => (
              <tr key={step.step_key}>
                <td className="py-1 pr-3 font-medium">{step.step_key} {STEP_LABELS[step.step_key] ?? ""}</td>
                <td className="py-1 pr-3">{step.status}</td>
                <td className="py-1 pr-3">{step.evaluation_verdict ? VERDICT_TEXT[step.evaluation_verdict] ?? step.evaluation_verdict : "—"}</td>
                <td className="py-1 pr-3">{step.error_code ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 font-semibold text-slate-800">Irreversible submissions</p>
      {confirmations.length === 0 ? (
        <p className="text-slate-500">None confirmed for this attempt.</p>
      ) : (
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {confirmations.map((confirmation, index) => (
            <li key={`${confirmation.step_key}-${index}`}>
              {STEP_LABELS[confirmation.step_key] ?? confirmation.step_key}: confirmed {new Date(confirmation.confirmed_at).toLocaleString()} by admin {shortId(confirmation.confirmed_by)},{" "}
              {confirmation.consumed ? "used" : "not used (expires after 15 minutes)"}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 font-semibold text-slate-800">Recent evaluations</p>
      {evaluations.length === 0 ? (
        <p className="text-slate-500">No evaluation recorded yet.</p>
      ) : (
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {evaluations.map((event, index) => (
            <li key={`${event.at}-${index}`}>
              {STEP_LABELS[event.parsed!.step]}: {VERDICT_TEXT[event.parsed!.verdict]} ({event.parsed!.context === "preverify" ? "fresh re-check before a submission" : "evaluation step"}), {new Date(event.at).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
