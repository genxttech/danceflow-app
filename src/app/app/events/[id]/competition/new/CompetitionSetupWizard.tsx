"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createCompetitionDraftAction, type ActionState } from "../simpleActions";
import type { FormatKey, ProgramKey, SetupProfileDefaults } from "@/lib/competition/setup/types";
import { clearStoredSetup, loadStoredSetup, saveStoredSetup } from "@/lib/competition/setup/persistence";
import {
  ADJUDICATION_OVERRIDE_LABELS,
  addCustomDivisionValue,
  clearAxis,
  divisionScheme,
  formatDivisions,
  orderedSelection,
  selectAllValues,
  missingRequiredAxes,
  toggleDivisionValue,
  availableFormats,
  formatRunNote,
  judgingSummary,
  recommendedFormats,
  setFormatAdjudication,
  PRICING_LABELS,
  PRICING_PENDING_TEXT,
  PURPOSE_OPTIONS,
  RULE_OPTIONS,
  SETUP_STEPS,
  activeProgramKeys,
  addCustomDance,
  canReach,
  chooseAdjudication,
  chooseJudging,
  choosePurpose,
  chooseSingleStyleMode,
  chooseStyle,
  deriveDraft,
  initialAnswers,
  nextStep,
  previousStep,
  programDances,
  removeCustomDance,
  restoreAnswers,
  resumeStep,
  setPricing,
  setRegistration,
  setRegistrationFee,
  stepErrors,
  styleOptions,
  toggleFormat,
  toggleFormatDance,
  updateFormat,
  visibleSteps,
  type SetupAnswers,
  type StepKey,
} from "@/lib/competition/setup/draft";

export type EventSummary = {
  name: string;
  dates: string | null;
  times: string | null;
  venue: string | null;
  existingWindow: string | null;
};

const INITIAL_ACTION: ActionState = { ok: false };
const subscribeNothing = () => () => undefined;
const fieldClass = "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-950";
const headingClass = "text-base font-semibold text-slate-950";
const groupClass = "rounded-xl border border-slate-200 p-4";

function Chip({ selected, onClick, children, label }: { selected: boolean; onClick: () => void; children: React.ReactNode; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={label}
      className={`rounded-full border px-3 py-1.5 text-sm ${selected ? "border-slate-950 bg-slate-950 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-slate-500"}`}
    >
      {children}
    </button>
  );
}

function Choice({
  selected,
  onClick,
  title,
  description,
  disabled = false,
  badge,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  description: string;
  disabled?: boolean;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`block w-full rounded-xl border p-4 text-left ${
        disabled ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400" : selected ? "border-slate-950 ring-2 ring-slate-950" : "border-slate-200 hover:border-slate-400"
      }`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className={`text-sm font-semibold ${disabled ? "text-slate-500" : "text-slate-950"}`}>{title}</span>
        {badge ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{badge}</span> : null}
      </span>
      <span className={`mt-1 block text-sm ${disabled ? "text-slate-400" : "text-slate-600"}`}>{description}</span>
    </button>
  );
}

/** The Styles step's choices: every style the profile offers, plus Multiple styles. */
export function StyleChoices({
  answers,
  defaults,
  update,
}: {
  answers: SetupAnswers;
  defaults: SetupProfileDefaults;
  update: (change: (current: SetupAnswers) => SetupAnswers) => void;
}) {
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      {styleOptions(defaults).map((key) => (
        <Choice
          key={key}
          selected={answers.styles.includes(key)}
          onClick={() => update((current) => chooseStyle(current, defaults, key))}
          title={defaults.programs[key].label}
          description={defaults.programs[key].description}
        />
      ))}
      <Choice
        selected={answers.styleMode === "multiple"}
        onClick={() => update((current) => (current.styleMode === "multiple" ? chooseSingleStyleMode(current, defaults) : chooseStyle(current, defaults, "multiple")))}
        title="Multiple styles"
        description={answers.styleMode === "multiple" ? "Selected. Tap again to pick just one style." : "Run more than one style at this event."}
      />
    </div>
  );
}

/**
 * The Divisions choices for one entry format: for each division axis (e.g. Levels, Age divisions), a
 * multi-select of the recommended values, "More options" for the rest, Select all / Clear, and an
 * organizer-defined value where the rules allow it. The divisions themselves come from deriveDraft.
 */
export function DivisionChoices({
  answers,
  defaults,
  styleKey,
  format,
  update,
}: {
  answers: SetupAnswers;
  defaults: SetupProfileDefaults;
  styleKey: ProgramKey;
  format: FormatKey;
  update: (change: (current: SetupAnswers) => SetupAnswers) => void;
}) {
  const [custom, setCustom] = useState<Record<string, string>>({});
  const value = answers.programs[styleKey]?.formats[format];
  if (!value) return null;
  const scheme = divisionScheme(defaults, styleKey, format);
  const divisions = formatDivisions(defaults, styleKey, format, value);
  const missing = missingRequiredAxes(scheme, value.divisions);
  const counts = scheme.axes.map((axis) => ({ axis, selected: orderedSelection(axis, value.divisions[axis.key]) }));
  const crossDetail = counts.filter((item) => item.selected.length > 0).map((item) => `${item.selected.length} ${item.axis.label.toLowerCase()}`).join(" × ");
  return (
    <div className="mt-3 space-y-4">
      {counts.map(({ axis, selected }) => {
        const customSelected = selected.filter((label) => !axis.values.some((item) => item.label === label));
        const id = `${styleKey}:${format}:${axis.key}`;
        const chip = (label: string) => (
          <Chip key={label} selected={selected.includes(label)} onClick={() => update((current) => toggleDivisionValue(current, defaults, styleKey, format, axis.key, label))}>
            {label}
          </Chip>
        );
        return (
          <div key={axis.key}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {axis.label} <span className="font-normal normal-case text-slate-400">{axis.required ? "· choose at least one" : "· optional"}</span>
              </p>
              <span className="flex gap-3 text-xs font-semibold text-slate-600">
                <button type="button" className="underline" onClick={() => update((current) => selectAllValues(current, defaults, styleKey, format, axis.key))}>
                  Select all
                </button>
                <button type="button" className="underline" onClick={() => update((current) => clearAxis(current, defaults, styleKey, format, axis.key))}>
                  Clear
                </button>
              </span>
            </div>
            {axis.note ? <p className="mt-1 text-xs text-slate-500">{axis.note}</p> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              {axis.values.map((item) => chip(item.label))}
              {customSelected.map(chip)}
            </div>
            {axis.allow_custom ? (
              <div className="mt-2 flex gap-2">
                <input
                  value={custom[id] ?? ""}
                  onChange={(changeEvent) => setCustom((current) => ({ ...current, [id]: changeEvent.target.value }))}
                  placeholder={`Add your own ${axis.label.toLowerCase().replace(/s$/, "")}`}
                  aria-label={`Add your own ${axis.label.toLowerCase()} value`}
                  maxLength={80}
                  className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-950"
                />
                <button
                  type="button"
                  onClick={() => {
                    update((current) => addCustomDivisionValue(current, defaults, styleKey, format, axis.key, custom[id] ?? ""));
                    setCustom((current) => ({ ...current, [id]: "" }));
                  }}
                  className="h-9 shrink-0 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50"
                >
                  Add
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
      <p className="text-sm text-slate-600">
        {divisions.length} {divisions.length === 1 ? "division" : "divisions"}
        {scheme.combination === "cross" && crossDetail.includes("×") ? ` (${crossDetail})` : ""}
        {scheme.combination === "separate" && divisions.length > 0 ? " — each is its own contest" : ""}
        {missing.length > 0 ? ` — choose at least one ${missing.map((axis) => axis.label.toLowerCase().replace(/s$/, "")).join(" and one ")}` : ""}
      </p>
    </div>
  );
}

export default function CompetitionSetupWizard({
  eventId,
  event,
  profile,
  defaults,
  initialRegistration,
  requestKey: initialRequestKey,
}: {
  eventId: string;
  event: EventSummary;
  profile: { key: string; version: number };
  defaults: SetupProfileDefaults;
  initialRegistration: SetupAnswers["registration"];
  requestKey: string;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<SetupAnswers>(() => initialAnswers(initialRegistration));
  const [step, setStep] = useState<StepKey>("purpose");
  const [requestKey, setRequestKey] = useState(initialRequestKey);
  const [restored, setRestored] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [newDance, setNewDance] = useState<Record<string, string>>({});
  const [action, formAction, pending] = useActionState(createCompetitionDraftAction, INITIAL_ACTION);

  // Resume an unsent setup from this tab (Back, Continue and refresh keep the answers). The server and the
  // hydration pass render the fresh state; the first client render after hydration adjusts it once.
  const isClient = useSyncExternalStore(subscribeNothing, () => true, () => false);
  if (isClient && !restored) {
    setRestored(true);
    const stored = loadStoredSetup(eventId);
    const storedAnswers = stored ? restoreAnswers(stored.answers, defaults) : null;
    if (stored && storedAnswers) {
      setAnswers(storedAnswers);
      setRequestKey(stored.requestKey);
      setStep(resumeStep(storedAnswers, defaults, stored.step));
    }
  }

  useEffect(() => {
    if (restored && !action.ok) saveStoredSetup(eventId, { answers, step, requestKey });
  }, [restored, eventId, answers, step, requestKey, action.ok]);

  useEffect(() => {
    if (action.ok && action.href) {
      clearStoredSetup(eventId);
      router.replace(action.href);
    }
  }, [action.ok, action.href, eventId, router]);

  const draft = useMemo(
    () => deriveDraft(answers, defaults, { eventName: event.name, profileKey: profile.key, profileVersion: profile.version, requestKey }),
    [answers, defaults, event.name, profile.key, profile.version, requestKey],
  );
  const steps = visibleSteps(answers, defaults);
  const errors = stepErrors(answers, defaults, step);
  const programs = activeProgramKeys(answers, defaults);
  const isReview = step === "review";
  const update = (change: (current: SetupAnswers) => SetupAnswers) => setAnswers((current) => change(current));
  const fmt = (format: FormatKey) => defaults.categoryTypes[format];
  const tpl = (key: ProgramKey) => defaults.programs[key];

  function go(target: StepKey) {
    setShowErrors(false);
    setStep(target);
  }

  function next() {
    if (errors.length > 0) {
      setShowErrors(true);
      return;
    }
    go(nextStep(answers, defaults, step));
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-950">Set up your competition</h2>
        <Link href={`/app/events/${eventId}/competition/advanced`} className="text-sm font-medium text-slate-600 underline hover:text-slate-950">
          Need an exception? Advanced settings
        </Link>
      </div>

      <ol className="mt-5 flex flex-wrap gap-2" aria-label="Steps">
        {steps.map((key, index) => {
          const label = SETUP_STEPS.find((item) => item.key === key)?.label ?? key;
          const current = key === step;
          const reachable = current || steps.indexOf(key) < steps.indexOf(step) || canReach(answers, defaults, key);
          return (
            <li key={key}>
              <button
                type="button"
                disabled={!reachable}
                onClick={() => go(key)}
                aria-current={current ? "step" : undefined}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  current ? "bg-slate-950 text-white" : reachable ? "bg-slate-100 text-slate-700 hover:bg-slate-200" : "bg-slate-50 text-slate-400"
                }`}
              >
                {index + 1}. {label}
              </button>
            </li>
          );
        })}
      </ol>

      <form action={formAction} className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
        <input type="hidden" name="eventId" value={eventId} />
        <input type="hidden" name="requestKey" value={requestKey} />
        <input type="hidden" name="answers" value={JSON.stringify(answers)} />

        {step === "purpose" ? (
          <section aria-labelledby="step-purpose">
            <h3 id="step-purpose" className={headingClass}>What are you creating?</h3>
            <div className="mt-3 rounded-lg bg-slate-50 p-4 text-sm text-slate-700">
              <p className="font-semibold text-slate-950">{event.name}</p>
              <p className="mt-1">{[event.dates, event.times, event.venue].filter(Boolean).join(" · ") || "No date or venue set yet."}</p>
              <Link href={`/app/events/${eventId}/edit`} className="mt-2 inline-block text-xs font-semibold text-slate-600 underline">
                Edit event details
              </Link>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {PURPOSE_OPTIONS.map((option) => (
                <Choice
                  key={option.key}
                  selected={answers.purpose === option.key}
                  onClick={() => update((current) => choosePurpose(current, defaults, option.key))}
                  title={option.label}
                  description={option.description}
                />
              ))}
            </div>
          </section>
        ) : null}

        {step === "styles" ? (
          <section aria-labelledby="step-styles">
            <h3 id="step-styles" className={headingClass}>Which styles?</h3>
            <p className="mt-1 text-sm text-slate-600">
              {answers.styleMode === "multiple" ? "Choose every style you will run. Each style gets its own divisions and pricing." : "Choose the style you will run."}
            </p>
            <StyleChoices answers={answers} defaults={defaults} update={update} />
            {answers.purpose !== "competition" ? (
              <p className="mt-3 text-sm text-slate-600">Showcase and performance offerings stay inside their style, so a Country Showcase is part of Country.</p>
            ) : null}
          </section>
        ) : null}

        {step === "adjudication" ? (
          <section aria-labelledby="step-adjudication" className="space-y-4">
            <div>
              <h3 id="step-adjudication" className={headingClass}>Will this produce an official competitive result?</h3>
              <p className="mt-1 text-sm text-slate-600">Adjudicated offerings produce official results such as placements. Non-Adjudicated offerings do not, but dancers can still receive evaluator feedback. This applies to every entry format in the style; Showcase-type offerings can be set differently later.</p>
            </div>
            {programs.map((key) => {
              const program = answers.programs[key];
              const options = tpl(key).judging_options;
              return (
                <div key={key} className={groupClass}>
                  {programs.length > 1 ? <p className="text-sm font-semibold text-slate-950">{tpl(key).label}</p> : null}
                  <div className={`${programs.length > 1 ? "mt-3 " : ""}grid gap-3 sm:grid-cols-2`}>
                    {(["adjudicated", "non_adjudicated"] as const).map((choice) => (
                      <Choice
                        key={choice}
                        selected={program?.adjudication === choice}
                        onClick={() => update((current) => chooseAdjudication(current, key, choice))}
                        title={defaults.adjudication[choice].label}
                        description={choice === "adjudicated" ? judgingSummary(defaults.judging[options[0]]).replace(/^Adjudicated · /, "Official result · ") : defaults.adjudication[choice].description}
                      />
                    ))}
                  </div>
                  {program?.adjudication === "adjudicated" && options.length > 1 ? (
                    <div className="mt-4">
                      <p className="text-sm font-semibold text-slate-900">How are results given?</p>
                      <div className="mt-2 space-y-2">
                        {options.map((option) => (
                          <Choice
                            key={option}
                            selected={program.judging === option}
                            onClick={() => update((current) => chooseJudging(current, defaults, key, option))}
                            title={defaults.judging[option].label}
                            description={defaults.judging[option].description}
                          />
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-slate-500">Gold, Silver and Bronze are DanceFlow&apos;s own simple rating levels.</p>
                    </div>
                  ) : null}
                </div>
              );
            })}
            <p className="text-xs text-slate-500">Judging and results are set up now and run in a later update. Evaluator feedback (written, with an optional grade or score) is set up in a later update and never becomes an official result.</p>
          </section>
        ) : null}

        {step === "rules" ? (
          <section aria-labelledby="step-rules">
            <h3 id="step-rules" className={headingClass}>Which rules?</h3>
            <div className="mt-4 space-y-2">
              {RULE_OPTIONS.map((option) => (
                <Choice
                  key={option.key}
                  selected={answers.rules === option.key}
                  disabled={!option.available}
                  onClick={() => undefined}
                  title={option.label}
                  description={option.description}
                  badge={option.available ? undefined : "Not available yet"}
                />
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Studio / Custom Rules are DanceFlow&apos;s generic rules. Choosing them never means the event is run under, or approved by, a sanctioning organization.
            </p>
          </section>
        ) : null}

        {step === "sanction" ? (
          <section aria-labelledby="step-sanction">
            <h3 id="step-sanction" className={headingClass}>Sanction</h3>
            <p className="mt-1 text-sm text-slate-600">Sanction status is not used with Studio / Custom Rules.</p>
          </section>
        ) : null}

        {step === "offerings" ? (
          <section aria-labelledby="step-offerings" className="space-y-4">
            <div>
              <h3 id="step-offerings" className={headingClass}>What will you offer?</h3>
              <p className="mt-1 text-sm text-slate-600">Choose the entry formats for each style. The list comes from the rules you chose.</p>
            </div>
            {programs.map((key) => {
              const recommended = recommendedFormats(defaults, key, answers.purpose);
              return (
                <div key={key} className={groupClass}>
                  <p className="text-sm font-semibold text-slate-950">{tpl(key).label}</p>
                  <div className="mt-3 space-y-3">
                    {availableFormats(defaults, key, answers.purpose).map((format) => {
                      const value = answers.programs[key]?.formats[format];
                      const note = formatRunNote(defaults, key, format);
                      return (
                        <div key={format}>
                          <label className="flex cursor-pointer items-start gap-3">
                            <input type="checkbox" checked={Boolean(value)} onChange={() => update((current) => toggleFormat(current, defaults, key, format))} className="mt-1 h-4 w-4" />
                            <span>
                              <span className="text-sm font-semibold text-slate-950">{fmt(format).label}</span>
                              {recommended.includes(format) ? <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">Recommended</span> : null}
                              <span className="block text-sm text-slate-600">{fmt(format).description}</span>
                              {note ? <span className="block text-xs text-slate-500">{note}</span> : null}
                            </span>
                          </label>
                          {value && fmt(format).adjudication_override ? (
                            <div className="ml-7 mt-2 flex flex-wrap items-center gap-2">
                              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Judged</span>
                              {(["inherit", "adjudicated", "non_adjudicated"] as const).map((choice) => (
                                <Chip key={choice} selected={value.adjudication === choice} onClick={() => update((current) => setFormatAdjudication(current, defaults, key, format, choice))}>
                                  {choice === "inherit" ? `Same as ${tpl(key).label}` : ADJUDICATION_OVERRIDE_LABELS[choice]}
                                </Chip>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}

        {step === "divisions" ? (
          <section aria-labelledby="step-divisions" className="space-y-4">
            <div>
              <h3 id="step-divisions" className={headingClass}>Divisions</h3>
              <p className="mt-1 text-sm text-slate-600">Divisions group dancers of a similar level. Each entry format has its own.</p>
            </div>
            {programs.flatMap((key) =>
              tpl(key).formats
                .filter((format) => answers.programs[key]?.formats[format])
                .map((format) => (
                  <div key={`${key}:${format}`} className={groupClass}>
                    <p className="text-sm font-semibold text-slate-950">
                      {tpl(key).label} · {fmt(format).label}
                    </p>
                    <DivisionChoices answers={answers} defaults={defaults} styleKey={key} format={format} update={update} />
                  </div>
                )),
            )}
          </section>
        ) : null}

        {step === "dances" ? (
          <section aria-labelledby="step-dances" className="space-y-4">
            <div>
              <h3 id="step-dances" className={headingClass}>Dances</h3>
              <p className="mt-1 text-sm text-slate-600">Choose the dances for each entry format. Routine formats use the dancers&apos; own music instead.</p>
            </div>
            {programs.map((key) => {
              const formats = tpl(key).formats.filter((format) => answers.programs[key]?.formats[format] && fmt(format).uses_dances);
              if (formats.length === 0) return null;
              const available = programDances(defaults, key, answers.programs[key]);
              return (
                <div key={key} className={groupClass}>
                  <p className="text-sm font-semibold text-slate-950">{tpl(key).label}</p>
                  {formats.map((format) => (
                    <div key={format} className="mt-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{fmt(format).label}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {available.map((dance) => (
                          <Chip
                            key={dance.key}
                            selected={answers.programs[key].formats[format]!.dances.includes(dance.key)}
                            onClick={() => update((current) => toggleFormatDance(current, key, format, dance.key))}
                          >
                            {dance.name}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  ))}
                  {tpl(key).custom_dances ? (
                    <div className="mt-4 border-t border-slate-100 pt-3">
                      <div className="flex flex-wrap gap-2">
                        {answers.programs[key].customDances.map((dance) => (
                          <span key={dance.key} className="inline-flex items-center gap-2 rounded-full bg-slate-100 py-1.5 pl-3 pr-2 text-sm text-slate-800">
                            {dance.name}
                            <button type="button" aria-label={`Remove ${dance.name}`} onClick={() => update((current) => removeCustomDance(current, key, dance.key))} className="rounded-full px-1.5 text-slate-500 hover:bg-slate-200">
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <input
                          value={newDance[key] ?? ""}
                          onChange={(changeEvent) => setNewDance((current) => ({ ...current, [key]: changeEvent.target.value }))}
                          placeholder="Add a dance that is not listed"
                          aria-label={`Add a dance for ${tpl(key).label}`}
                          maxLength={80}
                          className={fieldClass}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            update((current) => addCustomDance(current, defaults, key, newDance[key] ?? ""));
                            setNewDance((current) => ({ ...current, [key]: "" }));
                          }}
                          className="h-10 shrink-0 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50"
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
        ) : null}

        {step === "rounds" ? (
          <section aria-labelledby="step-rounds">
            <h3 id="step-rounds" className={headingClass}>Rounds</h3>
            <ul className="mt-3 space-y-2 text-sm text-slate-700">
              {draft.programs.map((program) => (
                <li key={program.key} className={groupClass}>
                  <p className="font-semibold text-slate-950">{program.styleLabel}</p>
                  {program.categories.map((category) => (
                    <p key={category.label}>
                      {category.label}: every division starts with a single {category.rounds.join(", ") || "Final"}.
                    </p>
                  ))}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-slate-600">{defaults.roundsNote}</p>
          </section>
        ) : null}

        {step === "registration" ? (
          <section aria-labelledby="step-registration">
            <h3 id="step-registration" className={headingClass}>Registration basics</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium text-slate-800">
                Registration opens (optional)
                <input type="date" value={answers.registration.opens} onChange={(changeEvent) => update((current) => setRegistration(current, { opens: changeEvent.target.value }))} className={`${fieldClass} mt-1`} />
              </label>
              <label className="text-sm font-medium text-slate-800">
                Registration closes (optional)
                <input type="date" value={answers.registration.closes} onChange={(changeEvent) => update((current) => setRegistration(current, { closes: changeEvent.target.value }))} className={`${fieldClass} mt-1`} />
              </label>
            </div>
            <p className="mt-2 text-xs text-slate-500">These dates are the registration window for the whole event, including any tickets.</p>
            {event.existingWindow ? <p className="mt-1 text-xs text-slate-500">This event already has a registration window ({event.existingWindow}); the dates here replace it.</p> : null}
            <label className="mt-4 flex items-start gap-3 text-sm text-slate-800">
              <input
                type="checkbox"
                checked={answers.registration.accountRequired}
                onChange={(changeEvent) => update((current) => setRegistration(current, { accountRequired: changeEvent.target.checked }))}
                className="mt-0.5 h-4 w-4"
              />
              <span>Registrants need a DanceFlow account to register</span>
            </label>
            <div className="mt-3 rounded-lg border border-slate-200 p-3 text-sm text-slate-700">
              <p className="font-semibold text-slate-900">Why a DanceFlow account helps</p>
              <p className="mt-1">
                <span className="mr-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">Planned</span>
                A DanceFlow account allows competitors to receive released competition results and judges&apos; feedback directly in their personal portal, reducing manual distribution for organizers.
              </p>
              <p className="mt-2">
                <span className="mr-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">Available now</span>
                Requiring an account means every registration is submitted by a signed-in person, and dancers who register themselves are linked to their own account.
              </p>
              <p className="mt-2 text-slate-600">
                Registrants can be dancers, instructors registering students, studios registering several competitors, or parents and guardians. Registering for your competition never makes anyone a lead or client of your studio.
              </p>
            </div>
            <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
              Registration stays closed until you open it. Online registration for dancers opens in a later update; nothing is sold yet.
            </p>
          </section>
        ) : null}

        {step === "pricing" ? (
          <section aria-labelledby="step-pricing" className="space-y-4">
            <div>
              <h3 id="step-pricing" className={headingClass}>Pricing</h3>
              <p className="mt-1 text-sm text-slate-600">Choose how each entry format is priced. You can finish pricing later, but registration cannot open until you do.</p>
            </div>
            {programs.map((key) => {
              const program = answers.programs[key];
              const included = Object.values(program?.formats ?? {}).some((value) => value?.pricing === "included");
              return (
                <div key={key} className={groupClass}>
                  <p className="text-sm font-semibold text-slate-950">{tpl(key).label}</p>
                  {tpl(key).formats
                    .filter((format) => program?.formats[format])
                    .map((format) => {
                      const value = program.formats[format]!;
                      return (
                        <div key={format} className="mt-4">
                          <p className="text-sm font-medium text-slate-900">{fmt(format).label}</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {fmt(format).pricing_models.map((model) => (
                              <Chip key={model} selected={value.pricing === model} onClick={() => update((current) => setPricing(current, defaults, key, format, model))}>
                                {PRICING_LABELS[model]}
                              </Chip>
                            ))}
                          </div>
                          {value.pricing === "per_dance" || value.pricing === "per_entry" ? (
                            <label className="mt-2 flex items-center gap-2 text-sm text-slate-700">
                              $
                              <input
                                inputMode="decimal"
                                value={value.amount}
                                onChange={(changeEvent) => update((current) => updateFormat(current, key, format, { amount: changeEvent.target.value }))}
                                placeholder="0.00"
                                aria-label={`${tpl(key).label} ${fmt(format).label} price ${value.pricing === "per_dance" ? "per dance" : "per entry"}`}
                                className="h-10 w-28 rounded-lg border border-slate-300 px-3 text-right text-sm"
                              />
                              {value.pricing === "per_dance" ? "per dance" : "per entry"}
                            </label>
                          ) : null}
                          {value.pricing === "later" ? <p className="mt-2 text-sm text-amber-800">{PRICING_PENDING_TEXT}</p> : null}
                        </div>
                      );
                    })}
                  {included ? (
                    <label className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-3 text-sm text-slate-700">
                      Registration fee $
                      <input
                        inputMode="decimal"
                        value={program.registrationFee}
                        onChange={(changeEvent) => update((current) => setRegistrationFee(current, key, changeEvent.target.value))}
                        placeholder="0.00"
                        aria-label={`${tpl(key).label} registration fee per competitor`}
                        className="h-10 w-28 rounded-lg border border-slate-300 px-3 text-right text-sm"
                      />
                      per competitor, charged once for this style
                    </label>
                  ) : null}
                </div>
              );
            })}
          </section>
        ) : null}

        {isReview ? (
          <section aria-labelledby="step-review" className="space-y-4">
            <div>
              <h3 id="step-review" className={headingClass}>Review</h3>
              <p className="mt-1 text-sm text-slate-600">
                {draft.counts.categories} entry {draft.counts.categories === 1 ? "format" : "formats"} · {draft.counts.divisions}{" "}
                {draft.counts.divisions === 1 ? "division" : "divisions"} · {draft.counts.rounds} {draft.counts.rounds === 1 ? "round" : "rounds"} · {draft.counts.dances}{" "}
                {draft.counts.dances === 1 ? "dance" : "dances"}
              </p>
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">Rules</dt>
                <dd className="text-slate-900">{defaults.label}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Sanction</dt>
                <dd className="text-slate-900">Not sanctioned</dd>
              </div>
              <div>
                <dt className="text-slate-500">Registration</dt>
                <dd className="text-slate-900">
                  {[answers.registration.opens ? `opens ${answers.registration.opens}` : null, answers.registration.closes ? `closes ${answers.registration.closes}` : null].filter(Boolean).join(", ") || "No window set"}
                  {answers.registration.accountRequired ? " · account required" : ""}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">After creating</dt>
                <dd className="text-slate-900">Draft · registration closed</dd>
              </div>
            </dl>
            {draft.programs.map((program) => (
              <div key={program.key} className={groupClass}>
                <p className="text-sm font-semibold text-slate-950">{program.name}</p>
                <p className="text-xs text-slate-500">
                  {program.styleLabel} · {program.judging}
                  {program.registrationFee ? ` · Registration fee ${program.registrationFee}` : ""}
                </p>
                <ul className="mt-3 space-y-3">
                  {program.categories.map((category) => (
                    <li key={category.label} className="text-sm text-slate-700">
                      <p className="font-medium text-slate-950">
                        {program.styleLabel} {category.label}
                      </p>
                      <p>{category.judging}</p>
                      {category.runNote ? <p className="text-slate-500">{category.runNote}</p> : null}
                      <p>Divisions: {category.divisions.join(", ")}</p>
                      {category.dances.length > 0 ? <p>Dances: {category.dances.join(", ")}</p> : null}
                      <p>Rounds: {category.rounds.join(", ")}</p>
                      <p className={category.pricingPending ? "text-amber-800" : ""}>Pricing: {category.pricing}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {draft.pricingPending ? (
              <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{PRICING_PENDING_TEXT}</p>
            ) : null}
            {Object.keys(draft.errors).length > 0 ? (
              <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                {SETUP_STEPS.filter((item) => draft.errors[item.key]?.length).map((item) => (
                  <p key={item.key}>
                    <button type="button" className="font-semibold underline" onClick={() => go(item.key)}>
                      {item.label}
                    </button>
                    : {draft.errors[item.key]?.[0]}
                  </p>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {(showErrors && errors.length > 0) || action.error ? (
          <div role="alert" className="mt-5 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {action.error ? <p>{action.error}</p> : errors.map((error) => <p key={error}>{error}</p>)}
          </div>
        ) : null}

        <div className="mt-6 flex items-center justify-between gap-3 border-t border-slate-100 pt-5">
          <button
            type="button"
            onClick={() => go(previousStep(answers, defaults, step))}
            disabled={step === steps[0]}
            className="h-11 rounded-lg border border-slate-300 px-5 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40"
          >
            Back
          </button>
          {isReview ? (
            <button
              type="submit"
              disabled={pending || action.ok || !draft.payload}
              className="h-11 rounded-lg bg-slate-950 px-6 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {pending || action.ok ? "Creating…" : "Create Competition Draft"}
            </button>
          ) : (
            <button type="button" onClick={next} className="h-11 rounded-lg bg-slate-950 px-6 text-sm font-semibold text-white hover:bg-slate-800">
              Continue
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
