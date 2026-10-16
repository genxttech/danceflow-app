"use client";

import { useActionState, useEffect, useState } from "react";
import {
  ENTITY_TYPES,
  FIELD_LABELS,
  INDUSTRIES,
  REP_POSITIONS,
  US_STATES,
  WEBSITE_CHOICES,
  firstStepWith,
  FIELD_STEP,
  type DraftFieldKey,
  type DraftFields,
  type WizardFieldKey,
} from "@/lib/sms/onboarding/fields";
import { saveSmsSetupAction, submitSmsSetupAction, type SmsSetupState } from "./actions";

const input =
  "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200 disabled:bg-slate-50";
const primary = "rounded-xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50";
const secondary = "rounded-xl border border-violet-300 bg-white px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-50";
const initialState: SmsSetupState = {};

const STEPS = ["Business", "Representative", "Texting number", "Review"] as const;

// Each save result gets a new id. The form is re-created with it, because React resets uncontrolled fields after a form action
// and a <select> keeps its ORIGINAL default: without this, a rejected save would silently blank every dropdown.
const resultIds = new WeakMap<object, number>();
let nextResultId = 0;
function resultId(result: object) {
  let id = resultIds.get(result);
  if (id === undefined) {
    id = nextResultId++;
    resultIds.set(result, id);
  }
  return id;
}

export type WizardCampaignPreview = {
  description: string;
  samples: string[];
  termsUrl: string;
  privacyUrl: string;
  optInPageUrl: string;
};

export default function SmsSetupWizard({
  initial,
  einOnFile,
  einLast4,
  canEdit,
  highlightFields,
  campaign,
}: {
  initial: DraftFields;
  einOnFile: boolean;
  einLast4: string | null;
  canEdit: boolean;
  highlightFields: string[];
  campaign: WizardCampaignPreview;
}) {
  const [step, setStep] = useState(0);
  const [website, setWebsite] = useState(initial.website_choice || "danceflow");
  const [saveState, saveAction, saving] = useActionState(saveSmsSetupAction, initialState);
  const [submitState, submitAction, submitting] = useActionState(submitSmsSetupAction, initialState);
  // A rejected save returns what was typed (never the EIN) so the form keeps it; saved/loaded values are the fallback.
  const value = (key: DraftFieldKey) => saveState.values?.[key] ?? initial[key];

  // Jump to the first step that has a problem, so an error is never hidden on another step.
  const errorKeys = Object.keys(saveState.fieldErrors ?? {});
  const submitMissing = submitState.missing ?? [];
  const errorSteps = new Set<number>([...errorKeys, ...submitMissing].map((key) => (FIELD_STEP as Record<string, number | undefined>)[key]).filter((n): n is number => n !== undefined));
  useEffect(() => {
    const target = firstStepWith(errorKeys);
    if (target !== null) setStep(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveState]);
  useEffect(() => {
    const target = firstStepWith(submitMissing);
    if (target !== null) setStep(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitState]);

  const error = (key: WizardFieldKey) => saveState.fieldErrors?.[key];
  const warning = (key: WizardFieldKey) => saveState.warnings?.[key];
  const flagged = (key: WizardFieldKey) => highlightFields.includes(key);

  const field = (key: DraftFieldKey, extra?: { type?: string; placeholder?: string; autoComplete?: string }) => (
    <label className="block text-sm font-medium text-slate-800">
      {FIELD_LABELS[key]}
      <input
        name={key}
        defaultValue={value(key)}
        disabled={!canEdit}
        type={extra?.type ?? "text"}
        placeholder={extra?.placeholder}
        autoComplete={extra?.autoComplete ?? "off"}
        aria-invalid={Boolean(error(key)) || flagged(key)}
        className={`${input} ${flagged(key) ? "border-amber-400 ring-2 ring-amber-100" : ""}`}
      />
      {error(key) ? <span role="alert" className="mt-1 block text-xs text-rose-700">{error(key)}</span> : null}
      {!error(key) && warning(key) ? <span className="mt-1 block text-xs text-amber-700">{warning(key)}</span> : null}
    </label>
  );

  const select = (key: DraftFieldKey, options: readonly { value: string; label: string }[], placeholder: string) => (
    <label className="block text-sm font-medium text-slate-800">
      {FIELD_LABELS[key]}
      <select name={key} defaultValue={value(key)} disabled={!canEdit} className={input} aria-invalid={Boolean(error(key)) || flagged(key)}>
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {error(key) ? <span role="alert" className="mt-1 block text-xs text-rose-700">{error(key)}</span> : null}
    </label>
  );

  return (
    <div className="space-y-5">
      <nav aria-label="Setup steps" className="flex flex-wrap gap-2">
        {STEPS.map((label, index) => (
          <button
            key={label}
            type="button"
            onClick={() => setStep(index)}
            aria-current={step === index ? "step" : undefined}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${step === index ? "border-violet-600 bg-violet-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-violet-300"}`}
          >
            {index + 1}. {label}
            {index < 3 && errorSteps.has(index) ? <span className="ml-1 text-rose-300" aria-label="needs attention">●</span> : null}
          </button>
        ))}
      </nav>

      {/* noValidate: the browser's own validation cannot focus a bad value on a hidden step and would block the save silently;
          the server validates every field, and this page jumps to the step with the problem. */}
      <form key={resultId(saveState)} action={saveAction} noValidate className="space-y-5">
        <section hidden={step !== 0} className="space-y-4 rounded-2xl border border-violet-200 bg-white p-5 shadow-sm" aria-label="Business identity">
          <div>
            <h3 className="text-lg font-semibold text-slate-950">Business identity</h3>
            <p className="mt-1 text-sm text-slate-600">These details must match your IRS records. Carriers check them.</p>
          </div>
          <div>
            {field("legal_name")}
            <p className="mt-1 text-xs text-amber-700">Confirm this exactly as printed on your IRS EIN letter (CP 575 or 147C). It is often different from your studio&rsquo;s display name.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {select("entity_type", ENTITY_TYPES, "Choose…")}
            {select("industry", INDUSTRIES, "Choose…")}
          </div>
          <label className="block text-sm font-medium text-slate-800">
            {FIELD_LABELS.ein}
            <input
              name="ein"
              inputMode="numeric"
              autoComplete="off"
              disabled={!canEdit}
              placeholder={einOnFile ? `On file, ending ${einLast4 ?? "••••"}. Type a new EIN to replace it.` : "12-3456789"}
              aria-invalid={Boolean(error("ein")) || flagged("ein")}
              className={`${input} ${flagged("ein") ? "border-amber-400 ring-2 ring-amber-100" : ""}`}
            />
            {error("ein") ? <span role="alert" className="mt-1 block text-xs text-rose-700">{error("ein")}</span> : null}
            <span className="mt-1 block text-xs text-slate-500">Stored encrypted and used only for business verification. DanceFlow never shows it again; only the last four digits.</span>
            {saveState.ok === false && saveState.fieldErrors && !error("ein") ? (
              <span className="mt-1 block text-xs text-amber-700">For your security the EIN is never sent back to this page. Please type it again before saving.</span>
            ) : null}
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">{field("address_line1", { autoComplete: "address-line1" })}</div>
            <div className="sm:col-span-2">{field("address_line2", { autoComplete: "address-line2" })}</div>
            {field("city", { autoComplete: "address-level2" })}
            <label className="block text-sm font-medium text-slate-800">
              {FIELD_LABELS.region}
              <select name="region" defaultValue={value("region")} disabled={!canEdit} className={input} aria-invalid={Boolean(error("region"))}>
                <option value="">Choose…</option>
                {US_STATES.map((code) => (
                  <option key={code} value={code}>{code}</option>
                ))}
              </select>
              {error("region") ? <span role="alert" className="mt-1 block text-xs text-rose-700">{error("region")}</span> : null}
            </label>
            {field("postal_code", { autoComplete: "postal-code" })}
          </div>
          <fieldset className="space-y-2" disabled={!canEdit}>
            <legend className="text-sm font-medium text-slate-800">{FIELD_LABELS.website_choice}</legend>
            {WEBSITE_CHOICES.map((choice) => (
              <label key={choice.value} className="flex items-center gap-2 text-sm text-slate-800">
                <input type="radio" name="website_choice" value={choice.value} checked={website === choice.value} onChange={() => setWebsite(choice.value)} />
                {choice.label}
              </label>
            ))}
            {website === "own" ? <div>{field("website_url", { placeholder: "https://www.yourstudio.com" })}</div> : <input type="hidden" name="website_url" value="" />}
          </fieldset>
        </section>

        <section hidden={step !== 1} className="space-y-4 rounded-2xl border border-violet-200 bg-white p-5 shadow-sm" aria-label="Authorized representative">
          <div>
            <h3 className="text-lg font-semibold text-slate-950">Authorized representative</h3>
            <p className="mt-1 text-sm text-slate-600">The person who can speak for the business. Carriers may contact them.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {field("rep_first_name", { autoComplete: "given-name" })}
            {field("rep_last_name", { autoComplete: "family-name" })}
            {field("rep_title", { placeholder: "Owner" })}
            {select("rep_position", REP_POSITIONS, "Choose…")}
            {field("rep_email", { type: "email", autoComplete: "email" })}
            {field("rep_phone", { type: "tel", autoComplete: "tel", placeholder: "(503) 555-0123" })}
          </div>
        </section>

        <section hidden={step !== 2} className="space-y-4 rounded-2xl border border-violet-200 bg-white p-5 shadow-sm" aria-label="Texting number">
          <div>
            <h3 className="text-lg font-semibold text-slate-950">Texting number</h3>
            <p className="mt-1 text-sm text-slate-600">We will pick a local number for your studio. You cannot choose a vanity number.</p>
          </div>
          <div className="max-w-xs">{field("preferred_area_code", { placeholder: "503" })}</div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          {canEdit ? (
            <button type="submit" className={secondary} disabled={saving}>{saving ? "Saving…" : "Save draft"}</button>
          ) : null}
          {step < STEPS.length - 1 ? (
            <button type="button" className={primary} onClick={() => setStep(step + 1)}>Next</button>
          ) : null}
          {saveState.error ? <span role="alert" className="text-sm font-medium text-rose-700">{saveState.error}</span> : null}
          {saveState.ok && saveState.notice ? <span role="status" className="text-sm font-medium text-emerald-700">{saveState.notice}</span> : null}
        </div>
      </form>

      <section hidden={step !== 3} className="space-y-4 rounded-2xl border border-violet-200 bg-white p-5 shadow-sm" aria-label="Review and submit">
        <div>
          <h3 className="text-lg font-semibold text-slate-950">Review and submit</h3>
          <p className="mt-1 text-sm text-slate-600">Here is what clients will agree to and the messages your studio will send. DanceFlow writes this for you.</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">{campaign.description}</div>
        <div>
          <h4 className="text-sm font-semibold text-slate-900">Sample messages</h4>
          <ul className="mt-2 space-y-2">
            {campaign.samples.map((sample, index) => (
              <li key={index} className="whitespace-pre-line rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-800">{sample}</li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-slate-600">
          Your texting pages: <a className="font-semibold text-violet-700 underline" href={campaign.termsUrl}>SMS Terms</a> ·{" "}
          <a className="font-semibold text-violet-700 underline" href={campaign.privacyUrl}>SMS Privacy</a> ·{" "}
          <a className="font-semibold text-violet-700 underline" href={campaign.optInPageUrl}>Opt-in form</a>
        </p>
        {canEdit ? (
          <form action={submitAction} className="space-y-3">
            {([
              ["attest_authorized", "I am authorized to register this business for text messaging."],
              ["attest_accurate", "The information is accurate and matches my business records."],
              ["attest_opt_in_only", "We will text only people who opted in, and only about appointments and lessons. No marketing."],
              ["attest_fees_terms", "I understand texting may carry setup and monthly fees, and I accept DanceFlow's SMS terms."],
            ] as const).map(([name, label]) => (
              <label key={name} className="flex items-start gap-2 text-sm text-slate-800">
                <input type="checkbox" name={name} className="mt-1" />
                <span>{label}</span>
              </label>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" className={primary} disabled={submitting}>{submitting ? "Submitting…" : "Submit for review"}</button>
              {submitState.error ? <span role="alert" className="text-sm font-medium text-rose-700">{submitState.error}</span> : null}
              {submitState.ok && submitState.notice ? <span role="status" className="text-sm font-medium text-emerald-700">{submitState.notice}</span> : null}
            </div>
          </form>
        ) : (
          <p className="text-sm text-slate-600">Only the studio owner can submit this setup.</p>
        )}
      </section>

    </div>
  );
}
