import { FIELD_LABELS, FIELD_STEP, type WizardFieldKey } from "./fields";

/** Pure view logic for the texting setup wizard: which screen a problem is on, and when the saved draft may be submitted. */

export const STEP_LABELS = ["Business", "Representative", "Texting number"] as const;

export type StepProblems = { step: 0 | 1 | 2; label: string; fields: { key: WizardFieldKey; label: string }[] };

/** Groups field keys by the screen that holds them, in screen order and then field order. Unknown keys are dropped; duplicates count once. */
export function problemsByStep(keys: readonly string[]): StepProblems[] {
  const wanted = new Set(keys);
  const groups: StepProblems[] = [];
  for (const [step, label] of STEP_LABELS.entries()) {
    const fields = (Object.keys(FIELD_STEP) as WizardFieldKey[])
      .filter((key) => FIELD_STEP[key] === step && wanted.has(key))
      .map((key) => ({ key, label: FIELD_LABELS[key] }));
    if (fields.length > 0) groups.push({ step: step as 0 | 1 | 2, label, fields });
  }
  return groups;
}

/** "Business: Legal business name, EIN. Representative: Business email." */
export function describeProblems(keys: readonly string[]): string {
  return problemsByStep(keys).map((group) => `${group.label}: ${group.fields.map((field) => field.label).join(", ")}.`).join(" ");
}

/**
 * Submitting sends the SAVED draft, never what is on screen, and the setup cannot be edited afterwards. So submitting is blocked until
 * a draft exists and nothing typed since is unsaved.
 */
export function submitBlockReason(input: { hasSavedDraft: boolean; unsaved: boolean }): string | null {
  if (input.unsaved) return "You have changes that are not saved. Click Save draft before you submit.";
  if (!input.hasSavedDraft) return "Nothing is saved yet. Next does not save: click Save draft before you submit.";
  return null;
}

/** The first save moves a setup from not_started to draft; the wizard must stay mounted so the screen and "Saved." survive it. */
export function wizardKey(state: string): string {
  return state === "not_started" ? "draft" : state;
}
