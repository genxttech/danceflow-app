"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { createSimpleCompetitionAction, type ActionState } from "../simpleActions";
import type { CategoryTypeKey, JudgingKey, PresetKey, ProfileDefaults } from "@/lib/competition/simple/types";
import {
  LAST_STEP,
  WIZARD_STEPS,
  addLevel,
  applyDivisionPreset,
  buildSpec,
  canAdvance,
  choosePreset,
  divisionList,
  goBack,
  goNext,
  goToStep,
  initialWizardState,
  removeLevel,
  setJudging,
  setPrice,
  stepErrors,
  toggleAgeBand,
  toggleCategory,
  toggleDance,
  type WizardState,
} from "@/lib/competition/simple/wizard";

export type EventSummary = {
  name: string;
  dates: string | null;
  times: string | null;
  venue: string | null;
  existingWindow: string | null;
};

const INITIAL_ACTION: ActionState = { ok: false };
const fieldClass = "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-950";
const chipBase = "rounded-full border px-3 py-1.5 text-sm";

function Chip({ selected, onClick, children, label }: { selected: boolean; onClick: () => void; children: React.ReactNode; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={label}
      className={`${chipBase} ${selected ? "border-slate-950 bg-slate-950 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-slate-500"}`}
    >
      {children}
    </button>
  );
}

export default function CreateCompetitionWizard({
  eventId,
  event,
  profile,
  defaults,
  requestKey,
}: {
  eventId: string;
  event: EventSummary;
  profile: { key: string; version: number };
  defaults: ProfileDefaults;
  requestKey: string;
}) {
  const [state, setState] = useState<WizardState>(() => initialWizardState(event.name));
  const [customLevel, setCustomLevel] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [action, formAction, pending] = useActionState(createSimpleCompetitionAction, INITIAL_ACTION);

  const errors = stepErrors(state, state.step, defaults);
  const spec = useMemo(() => (state.preset ? buildSpec(state, defaults, profile, requestKey) : null), [state, defaults, profile, requestKey]);
  const preset = state.preset ? defaults.presets[state.preset] : null;
  const divisions = divisionList(state);
  const pool = preset ? (defaults.dancePools[preset.dance_pool] ?? []) : [];
  const selectedTypes = Object.keys(state.categories) as CategoryTypeKey[];
  const isLast = state.step === LAST_STEP;

  function next() {
    if (!canAdvance(state, defaults)) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setState((current) => goNext(current, defaults));
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-950">Create competition</h2>
        <Link href={`/app/events/${eventId}/competition/advanced`} className="text-sm font-medium text-slate-600 underline hover:text-slate-950">
          Prefer to set everything up yourself? Advanced settings
        </Link>
      </div>

      <ol className="mt-5 flex flex-wrap gap-2" aria-label="Steps">
        {WIZARD_STEPS.map((step, index) => {
          const reachable = index <= state.step;
          const current = index === state.step;
          return (
            <li key={step.key}>
              <button
                type="button"
                disabled={!reachable}
                onClick={() => {
                  setShowErrors(false);
                  setState((currentState) => goToStep(currentState, defaults, index));
                }}
                aria-current={current ? "step" : undefined}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  current ? "bg-slate-950 text-white" : reachable ? "bg-slate-100 text-slate-700 hover:bg-slate-200" : "bg-slate-50 text-slate-400"
                }`}
              >
                {index + 1}. {step.label}
              </button>
            </li>
          );
        })}
      </ol>

      <form action={formAction} className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
        <input type="hidden" name="eventId" value={eventId} />
        <input type="hidden" name="spec" value={spec ? JSON.stringify(spec) : ""} />
        <input type="hidden" name="registrationOpens" value={state.registrationOpens} />
        <input type="hidden" name="registrationCloses" value={state.registrationCloses} />

        {state.step === 0 ? (
          <section aria-labelledby="step-type">
            <h3 id="step-type" className="text-base font-semibold text-slate-950">What are you creating?</h3>
            <div className="mt-3 rounded-lg bg-slate-50 p-4 text-sm text-slate-700">
              <p className="font-semibold text-slate-950">{event.name}</p>
              <p className="mt-1">{[event.dates, event.times, event.venue].filter(Boolean).join(" · ") || "No date or venue set yet."}</p>
              <Link href={`/app/events/${eventId}/edit`} className="mt-2 inline-block text-xs font-semibold text-slate-600 underline">
                Edit event details
              </Link>
            </div>
            <label className="mt-4 block text-sm font-medium text-slate-800">
              Competition name
              <input
                value={state.name}
                maxLength={160}
                onChange={(changeEvent) => setState((current) => ({ ...current, name: changeEvent.target.value }))}
                className={`${fieldClass} mt-1`}
              />
            </label>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {(Object.keys(defaults.presets) as PresetKey[]).map((key) => {
                const item = defaults.presets[key];
                const selected = state.preset === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setState((current) => choosePreset(current, defaults, key))}
                    aria-pressed={selected}
                    className={`rounded-xl border p-4 text-left ${selected ? "border-slate-950 ring-2 ring-slate-950" : "border-slate-200 hover:border-slate-400"}`}
                  >
                    <span className="block text-sm font-semibold text-slate-950">{item.label}</span>
                    <span className="mt-1 block text-sm text-slate-600">{item.description}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-slate-500">These are starting points. Nothing here means your event is run under, or approved by, a sanctioning organization.</p>
          </section>
        ) : null}

        {state.step === 1 && preset ? (
          <section aria-labelledby="step-categories">
            <h3 id="step-categories" className="text-base font-semibold text-slate-950">Which categories will you offer?</h3>
            <p className="mt-1 text-sm text-slate-600">Pick the kinds of entries dancers can sign up for.</p>
            <div className="mt-4 space-y-3">
              {preset.category_types.map((type) => {
                const definition = defaults.categoryTypes[type];
                const category = state.categories[type];
                return (
                  <div key={type} className={`rounded-xl border p-4 ${category ? "border-slate-950" : "border-slate-200"}`}>
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={Boolean(category)}
                        onChange={() => setState((current) => toggleCategory(current, defaults, type))}
                        className="mt-1 h-4 w-4"
                      />
                      <span>
                        <span className="block text-sm font-semibold text-slate-950">{definition.label}</span>
                        <span className="block text-sm text-slate-600">{definition.description}</span>
                      </span>
                    </label>
                    {category && definition.uses_dances ? (
                      <div className="mt-3 border-t border-slate-100 pt-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Dances</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {pool.map((dance) => (
                            <Chip key={dance.key} selected={category.dances.includes(dance.key)} onClick={() => setState((current) => toggleDance(current, type, dance.key))}>
                              {dance.name}
                            </Chip>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {state.step === 2 ? (
          <section aria-labelledby="step-divisions">
            <h3 id="step-divisions" className="text-base font-semibold text-slate-950">Divisions</h3>
            <p className="mt-1 text-sm text-slate-600">Divisions group dancers of a similar level. Every category gets the same divisions.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {Object.entries(defaults.divisionPresets).map(([key, item]) => (
                <Chip key={key} selected={state.divisionPreset === key} onClick={() => setState((current) => applyDivisionPreset(current, defaults, key))}>
                  {item.label}
                </Chip>
              ))}
            </div>
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Levels</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {state.levels.map((level) => (
                  <span key={level} className="inline-flex items-center gap-2 rounded-full bg-slate-100 py-1.5 pl-3 pr-2 text-sm text-slate-800">
                    {level}
                    <button type="button" aria-label={`Remove ${level}`} onClick={() => setState((current) => removeLevel(current, level))} className="rounded-full px-1.5 text-slate-500 hover:bg-slate-200">
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <input
                  value={customLevel}
                  onChange={(changeEvent) => setCustomLevel(changeEvent.target.value)}
                  onKeyDown={(keyEvent) => {
                    if (keyEvent.key === "Enter") {
                      keyEvent.preventDefault();
                      setState((current) => addLevel(current, defaults, customLevel));
                      setCustomLevel("");
                    }
                  }}
                  placeholder="Add your own division"
                  className={fieldClass}
                />
                <button
                  type="button"
                  onClick={() => {
                    setState((current) => addLevel(current, defaults, customLevel));
                    setCustomLevel("");
                  }}
                  className="h-10 shrink-0 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50"
                >
                  Add
                </button>
              </div>
            </div>
            <div className="mt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Age groups (optional)</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {defaults.ageBands.map((band) => (
                  <Chip key={band} selected={state.ageBands.includes(band)} onClick={() => setState((current) => toggleAgeBand(current, band))}>
                    {band}
                  </Chip>
                ))}
              </div>
            </div>
            <p className="mt-4 text-sm text-slate-600">
              {divisions.length} {divisions.length === 1 ? "division" : "divisions"} per category
              {selectedTypes.length > 1 ? `, ${divisions.length * selectedTypes.length} in total` : ""}.
            </p>
          </section>
        ) : null}

        {state.step === 3 ? (
          <section aria-labelledby="step-judging">
            <h3 id="step-judging" className="text-base font-semibold text-slate-950">How will it be judged?</h3>
            <div className="mt-4 space-y-3">
              {(Object.keys(defaults.judging) as JudgingKey[]).map((key) => {
                const item = defaults.judging[key];
                const selected = state.judging === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setState((current) => setJudging(current, key))}
                    className={`block w-full rounded-xl border p-4 text-left ${selected ? "border-slate-950 ring-2 ring-slate-950" : "border-slate-200 hover:border-slate-400"}`}
                  >
                    <span className="block text-sm font-semibold text-slate-950">{item.label}</span>
                    <span className="mt-1 block text-sm text-slate-600">{item.description}</span>
                    {item.bands ? <span className="mt-2 block text-xs font-medium text-slate-500">{item.bands.join(" · ")}</span> : null}
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-slate-500">Every division gets a Final round. You can change rounds later in Advanced settings.</p>
          </section>
        ) : null}

        {state.step === 4 ? (
          <section aria-labelledby="step-registration">
            <h3 id="step-registration" className="text-base font-semibold text-slate-950">Registration &amp; pricing</h3>
            <div className="mt-4 space-y-3">
              {selectedTypes.map((type) => (
                <label key={type} className="flex items-center justify-between gap-4 text-sm font-medium text-slate-800">
                  <span>
                    {defaults.categoryTypes[type].label}
                    <span className="ml-2 text-xs font-normal text-slate-500">{defaults.categoryTypes[type].price_unit}</span>
                  </span>
                  <span className="flex items-center gap-1">
                    $
                    <input
                      inputMode="decimal"
                      value={state.categories[type]?.price ?? ""}
                      onChange={(changeEvent) => setState((current) => setPrice(current, type, changeEvent.target.value))}
                      placeholder="0.00"
                      className="h-10 w-28 rounded-lg border border-slate-300 px-3 text-right text-sm"
                      aria-label={`${defaults.categoryTypes[type].label} price ${defaults.categoryTypes[type].price_unit}`}
                    />
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium text-slate-800">
                Registration opens (optional)
                <input type="date" value={state.registrationOpens} onChange={(changeEvent) => setState((current) => ({ ...current, registrationOpens: changeEvent.target.value }))} className={`${fieldClass} mt-1`} />
              </label>
              <label className="text-sm font-medium text-slate-800">
                Registration closes (optional)
                <input type="date" value={state.registrationCloses} onChange={(changeEvent) => setState((current) => ({ ...current, registrationCloses: changeEvent.target.value }))} className={`${fieldClass} mt-1`} />
              </label>
            </div>
            {event.existingWindow ? <p className="mt-2 text-xs text-slate-500">This event already has a registration window ({event.existingWindow}); dates you enter replace it.</p> : null}
            <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
              Next you will review everything and publish. Online registration for dancers opens in a later update; nothing is sold yet.
            </p>
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
            onClick={() => {
              setShowErrors(false);
              setState((current) => goBack(current));
            }}
            disabled={state.step === 0}
            className="h-11 rounded-lg border border-slate-300 px-5 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40"
          >
            Back
          </button>
          {isLast ? (
            <button
              type="submit"
              disabled={pending}
              onClick={(clickEvent) => {
                if (errors.length > 0) {
                  clickEvent.preventDefault();
                  setShowErrors(true);
                }
              }}
              className="h-11 rounded-lg bg-slate-950 px-6 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {pending ? "Creating…" : "Create competition"}
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
