import { ChevronDown } from "lucide-react";
import { STATE_LABELS } from "@/lib/sms/onboarding/stateMachine";
import { buildJourney, chargeLines, type JourneyInput, type NextAction, type StageStatus } from "@/lib/sms/provisioning/journey";

/**
 * TW-4F R2c: the owner's texting-setup journey. Presentation only: `buildJourney` decides every status and the single next action. A call to
 * action renders as a link only when the journey supplied one; otherwise the card states why nothing is clickable. Native <details> keeps the
 * detail sections progressive and keyboard-accessible, with a rotating chevron as the state indicator.
 */

const DOT: Record<StageStatus, string> = {
  done: "bg-emerald-500 border-emerald-500 text-white",
  current: "bg-violet-600 border-violet-600 text-white",
  waiting: "bg-sky-500 border-sky-500 text-white",
  attention: "bg-amber-500 border-amber-500 text-white",
  upcoming: "bg-white border-slate-300 text-slate-400",
  unavailable: "bg-slate-100 border-slate-300 text-slate-400",
};
const MARK: Record<StageStatus, string> = { done: "✓", current: "•", waiting: "…", attention: "!", upcoming: "", unavailable: "–" };
const WORD: Record<StageStatus, string> = { done: "complete", current: "your turn", waiting: "waiting on review", attention: "needs attention", upcoming: "not started", unavailable: "not available yet" };

const TONE: Record<NextAction["kind"], string> = {
  owner: "border-violet-300 bg-violet-50",
  waiting: "border-sky-200 bg-sky-50",
  blocked: "border-amber-300 bg-amber-50",
  unavailable: "border-slate-200 bg-slate-50",
  complete: "border-emerald-200 bg-emerald-50",
  stopped: "border-slate-200 bg-slate-50",
};
const KICKER: Record<NextAction["kind"], string> = { owner: "Your next step", waiting: "In progress", blocked: "On hold", unavailable: "Coming soon", complete: "All set", stopped: "Setup status" };

export default function SmsJourney(props: JourneyInput) {
  const { stages, next } = buildJourney(props);
  const charges = chargeLines(props.finance);
  const done = stages.filter((s) => s.status === "done").length;
  return (
    <section className="rounded-2xl border border-violet-200 bg-white p-5 shadow-sm" aria-labelledby="sms-journey-heading" data-testid="sms-journey">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">Texting setup</p>
      <h2 id="sms-journey-heading" className="mt-1 text-xl font-semibold text-slate-950">{props.textingOn ? "Texting is on" : STATE_LABELS[props.state]}</h2>

      <div className={`mt-3 rounded-xl border p-4 ${TONE[next.kind]}`} data-testid="sms-next-action" data-kind={next.kind} role="status">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">{KICKER[next.kind]}</p>
        <p className="mt-1 text-base font-semibold text-slate-950">{next.title}</p>
        <p className="mt-1 text-sm text-slate-700">{next.detail}</p>
        {next.cta ? (
          <a href={next.cta.href} className="mt-3 inline-flex rounded-xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800" data-testid="sms-next-cta">{next.cta.label}</a>
        ) : null}
      </div>

      <details className="group/stages mt-4" data-testid="sms-journey-stages">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-semibold text-violet-800 [&::-webkit-details-marker]:hidden">
          <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open/stages:rotate-180" />
          All steps ({done} of {stages.length} complete)
        </summary>
        <ol className="mt-3 space-y-3" aria-label="Texting setup steps">
          {stages.map((stage) => (
            <li key={stage.key} className="flex gap-3" data-stage={stage.key} data-status={stage.status}>
              <span aria-hidden="true" className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${DOT[stage.status]}`}>{MARK[stage.status]}</span>
              <span className="text-sm text-slate-800">
                <span className="font-medium">{stage.label}</span>
                <span className="sr-only"> — {WORD[stage.status]}</span>
                <span className="block text-slate-600">{stage.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </details>

      <details className="group/charges mt-3" data-testid="sms-charges">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-semibold text-violet-800 [&::-webkit-details-marker]:hidden">
          <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open/charges:rotate-180" />
          What this costs
        </summary>
        <p className="mt-2 text-xs text-slate-600">Viewing this charges nothing. You approve each charge yourself before it happens, and submitting a registration does not mean the carriers have approved it.</p>
        <dl className="mt-2 divide-y divide-slate-100 text-sm">
          {charges.map((c) => (
            <div key={c.key} className="grid gap-1 py-2 sm:grid-cols-[1fr_auto]" data-charge={c.key}>
              <dt><span className="font-medium text-slate-900">{c.label}</span><span className="block text-xs text-slate-500">{c.when}</span></dt>
              <dd className="font-semibold text-slate-900">{c.amount}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
