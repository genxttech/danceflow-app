import { STATE_DETAILS, STATE_LABELS, trackerSteps, type OnboardingDisplayState } from "@/lib/sms/onboarding/stateMachine";

const DOT: Record<string, string> = {
  done: "bg-emerald-500 border-emerald-500 text-white",
  current: "bg-violet-600 border-violet-600 text-white",
  attention: "bg-amber-500 border-amber-500 text-white",
  upcoming: "bg-white border-slate-300 text-slate-400",
};
const MARK: Record<string, string> = { done: "✓", current: "•", attention: "!", upcoming: "" };

export default function SmsStatusTracker({ state, textingOn }: { state: OnboardingDisplayState; textingOn: boolean }) {
  const steps = trackerSteps(state);
  return (
    <section className="rounded-2xl border border-violet-200 bg-white p-5 shadow-sm" aria-labelledby="sms-status-heading">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">Status</p>
      <h2 id="sms-status-heading" className="mt-1 text-xl font-semibold text-slate-950">
        {textingOn ? "Texting is on" : STATE_LABELS[state]}
      </h2>
      <p className="mt-1 text-sm text-slate-600">{textingOn ? STATE_DETAILS.active : STATE_DETAILS[state]}</p>
      <ol className="mt-4 grid gap-3 sm:grid-cols-5" aria-label="Texting setup progress">
        {steps.map((step) => (
          <li key={step.key} className="flex items-center gap-2 sm:flex-col sm:items-start" data-status={step.status}>
            <span
              aria-hidden="true"
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${DOT[step.status]}`}
            >
              {MARK[step.status]}
            </span>
            <span className="text-sm text-slate-800">
              {step.label}
              <span className="sr-only"> — {step.status === "done" ? "complete" : step.status === "current" ? "in progress" : step.status === "attention" ? "needs attention" : "not started"}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
