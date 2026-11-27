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
  type DraftFieldKey,
  type DraftFields,
  type WizardFieldKey,
} from "@/lib/sms/onboarding/fields";
import { problemsByStep } from "@/lib/sms/onboarding/wizardState";
import { smsSetupAction, type SmsSetupState } from "./actions";

const input =
  "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200 disabled:bg-slate-50";
const primary = "rounded-xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50";
const secondary = "rounded-xl border border-violet-300 bg-white px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-50";
const initialState: SmsSetupState = {};

const STEPS = ["Business", "Representative", "Texting number", "Review"] as const;
const invalidRing = "border-rose-500 ring-2 ring-rose-200";

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

type WizardProps = {
  initial: DraftFields;
  /** A draft exists in the database. When it disappears (cancelled) the form starts clean. */
  hasSavedDraft: boolean;
  einOnFile: boolean;
  einLast4: string | null;
  canEdit: boolean;
  isOwner: boolean;
  highlightFields: string[];
  campaign: WizardCampaignPreview;
};

export default function SmsSetupWizard(props: WizardProps) {
  // A saved draft that disappears (the setup was cancelled) starts a clean form.
  const [generation, setGeneration] = useState(0);
  const [wasSaved, setWasSaved] = useState(props.hasSavedDraft);
  if (wasSaved !== props.hasSavedDraft) {
    setWasSaved(props.hasSavedDraft);
    if (!props.hasSavedDraft) setGeneration(generation + 1);
  }
  return <WizardForm key={generation} {...props} />;
}

function WizardForm({ initial, einOnFile, einLast4, canEdit, isOwner, highlightFields, campaign }: WizardProps) {
  const [step, setStep] = useState(0);
  const [pressed, setPressed] = useState<"save" | "submit">("save");
  const [website, setWebsite] = useState(initial.website_choice || "danceflow");
  const [state, action, pending] = useActionState(smsSetupAction, initialState);
  // A result returns what was typed or written (never the EIN) so the form keeps it; loaded values are the fallback.
  const value = (key: DraftFieldKey) => state.values?.[key] ?? initial[key];

  // Jump to the first screen that has a problem, so an error is never hidden on another screen.
  const errorKeys = Object.keys(state.fieldErrors ?? {});
  const needed = state.missing ?? [];
  const problems = problemsByStep([...errorKeys, ...needed]);
  const errorSteps = new Set<number>(problems.map((group) => group.step));
  useEffect(() => {
    const target = firstStepWith(errorKeys.length > 0 ? errorKeys : state.intent === "submit" ? needed : []);
    if (target !== null) setStep(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const error = (key: WizardFieldKey) => state.fieldErrors?.[key] ?? (needed.includes(key) ? "Required before you can submit." : undefined);
  const warning = (key: WizardFieldKey) => state.warnings?.[key];
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
        className={`${input} ${error(key) ? invalidRing : flagged(key) ? "border-amber-400 ring-2 ring-amber-100" : ""}`}
      />
      {error(key) ? <span role="alert" className="mt-1 block text-xs text-rose-700">{error(key)}</span> : null}
      {!error(key) && warning(key) ? <span className="mt-1 block text-xs text-amber-700">{warning(key)}</span> : null}
    </label>
  );

  const select = (key: DraftFieldKey, options: readonly { value: string; label: string }[], placeholder: string) => (
    <label className="block text-sm font-medium text-slate-800">
      {FIELD_LABELS[key]}
      <select name={key} defaultValue={value(key)} disabled={!canEdit} className={`${input} ${error(key) ? invalidRing : ""}`} aria-invalid={Boolean(error(key)) || flagged(key)}>
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

      {problems.length > 0 ? (
        <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <p className="font-semibold">{errorKeys.length > 0 ? "These need attention:" : state.intent === "submit" ? "Nothing was submitted. Your details are saved. Still needed:" : "Saved. Still needed before you can submit:"}</p>
          <ul className="mt-1 space-y-1">
            {problems.map((group) => (
              <li key={group.step}>
                <button type="button" className="font-semibold underline" onClick={() => setStep(group.step)}>Screen {group.step + 1}, {group.label}</button>
                : {group.fields.map((item) => item.label).join(", ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* noValidate: the browser's own validation cannot focus a bad value on a hidden step and would block the save silently;
          the server validates every field, and this page jumps to the step with the problem. */}
      {/* One form: whichever button is pressed, what is on screen is what gets saved or submitted. "Save draft" is the first submit
          button in the form, so pressing Enter in a field only saves. */}
      <form key={resultId(state)} action={action} noValidate className="space-y-5">
        <section hidden={step !== 0} className="space-y-4 rounded-2xl border border-violet-200 bg-white p-5 shadow-sm" aria-label="Business identity">
          <div>
            <h3 className="text-lg font-semibold text-slate-950">Business identity</h3>
            <p className="mt-1 text-sm text-slate-600">These details must match your IRS records. Carriers check them.</p>
            <p className="mt-1 text-sm text-slate-600">Registration needs an LLC, corporation, partnership, non-profit or co-op with its own EIN, including a one-person business. Sole proprietors cannot register yet.</p>
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
              className={`${input} ${error("ein") ? invalidRing : flagged("ein") ? "border-amber-400 ring-2 ring-amber-100" : ""}`}
            />
            {error("ein") ? <span role="alert" className="mt-1 block text-xs text-rose-700">{error("ein")}</span> : null}
            <span className="mt-1 block text-xs text-slate-500">Stored encrypted and used only for business verification. DanceFlow never shows it again; only the last four digits.</span>
            {state.ok === false && !error("ein") && !einOnFile ? (
              <span className="mt-1 block text-xs text-amber-700">For your security the EIN is never sent back to this page. Please type it again before saving.</span>
            ) : null}
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">{field("address_line1", { autoComplete: "address-line1" })}</div>
            <div className="sm:col-span-2">{field("address_line2", { autoComplete: "address-line2" })}</div>
            {field("city", { autoComplete: "address-level2" })}
            <label className="block text-sm font-medium text-slate-800">
              {FIELD_LABELS.region}
              <select name="region" defaultValue={value("region")} disabled={!canEdit} className={`${input} ${error("region") ? invalidRing : ""}`} aria-invalid={Boolean(error("region"))}>
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
            {error("website_choice") ? <span role="alert" className="block text-xs text-rose-700">{error("website_choice")}</span> : null}
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
          <fieldset className="space-y-3">
            <legend className="sr-only">Statements</legend>
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
            <p className="text-sm text-slate-600">Submit saves what you entered and sends it to DanceFlow. It cannot be edited afterwards. Nothing is charged.</p>
          </fieldset>
        ) : (
          <p className="text-sm text-slate-600">{isOwner ? "This information can no longer be edited here." : "Only the studio owner can submit this setup."}</p>
        )}
      </section>

        <div className="flex flex-wrap items-center gap-3">
          {canEdit ? (
            <button type="submit" name="intent" value="save" className={secondary} disabled={pending} onClick={() => setPressed("save")}>{pending && pressed === "save" ? "Saving…" : "Save draft"}</button>
          ) : null}
          {step < STEPS.length - 1 ? (
            <button type="button" className={primary} onClick={() => setStep(step + 1)}>Next</button>
          ) : null}
          {canEdit ? (
            <button type="submit" name="intent" value="submit" hidden={step !== STEPS.length - 1} className={primary} disabled={pending} onClick={() => setPressed("submit")}>{pending && pressed === "submit" ? "Submitting…" : "Submit for review"}</button>
          ) : null}
          {state.error ? <span role="alert" className="text-sm font-medium text-rose-700">{state.error}</span> : null}
          {state.ok && state.notice ? <span role="status" className="text-sm font-medium text-emerald-700">{state.notice}</span> : null}
        </div>
        {canEdit ? <p className="text-xs text-slate-500">Save draft is optional: use it to finish later.</p> : null}
      </form>

    </div>
  );
}
