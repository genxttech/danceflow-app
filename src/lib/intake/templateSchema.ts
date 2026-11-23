/**
 * New Student Intake -- template builder model.
 *
 * The builder edits a `Draft` (stable ids, plain labels). `draftToSchema` produces exactly the jsonb that
 * `public.intake_save_template_draft` validates (`intake_private.schema_max_answer_bytes`), and `validateDraft`
 * mirrors those rules so mistakes surface before a round trip. The database remains the authority.
 *
 * Only the V1 field types are offered: no conditional logic, no file upload, no health/medical starter questions.
 * Field and option keys are generated once from the label and then never change, so a later version of a template
 * keeps mapping answers to the same keys.
 */

export const FIELD_TYPES = [
  "short_text",
  "long_text",
  "single_choice",
  "checkboxes",
  "dropdown",
  "yes_no",
  "date",
  "acknowledgment",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  short_text: "Short answer",
  long_text: "Long answer",
  single_choice: "Multiple choice (pick one)",
  checkboxes: "Checkboxes (pick several)",
  dropdown: "Dropdown",
  yes_no: "Yes / No",
  date: "Date",
  acknowledgment: "Acknowledgment (must be checked)",
};

export const CHOICE_TYPES: readonly FieldType[] = ["single_choice", "checkboxes", "dropdown"];

export const AUDIENCES = ["student", "guardian", "both"] as const;
export type Audience = (typeof AUDIENCES)[number];
export const AUDIENCE_LABEL: Record<Audience, string> = {
  student: "Student",
  guardian: "Parent / guardian",
  both: "Student and parent / guardian",
};

export const VISIBILITIES = ["staff_only", "front_desk", "instructor_visible"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const VISIBILITY_LABEL: Record<Visibility, string> = {
  staff_only: "Owners and admins only",
  front_desk: "Also front desk",
  instructor_visible: "Also the assigned instructor",
};

export const LIMITS = {
  maxFields: 200,
  maxLabel: 500,
  maxTitle: 500,
  maxOptions: 50,
  maxOptionLabel: 500,
  maxAnswerBytes: 262144,
  maxSchemaBytes: 131072,
  maxName: 200,
} as const;

export type DraftOption = { key: string; label: string };
export type DraftField = {
  id: string;
  key: string;
  type: FieldType;
  label: string;
  required: boolean;
  visibility: Visibility;
  options: DraftOption[];
  /** New questions follow their wording until saved once; saved questions keep their key forever. */
  autoKey?: boolean;
};
export type DraftSection = { id: string; key: string; title: string; audience: Audience; fields: DraftField[] };
export type Draft = { name: string; sections: DraftSection[] };

const FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const OPTION_KEY = /^[a-z0-9][a-z0-9_]{0,63}$/;

let idCounter = 0;
export function newId(prefix = "n"): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function slugKey(label: string, taken: Iterable<string>, kind: "field" | "option" = "field"): string {
  const used = new Set(taken);
  let base = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 56);
  if (kind === "field" && !/^[a-z]/.test(base)) base = `q_${base}`.replace(/_+$/g, "");
  if (!base || base === "q") base = kind === "field" ? "question" : "option";
  let candidate = base;
  for (let n = 2; used.has(candidate); n += 1) candidate = `${base}_${n}`;
  return candidate;
}

function allFieldKeys(draft: Draft): string[] {
  return draft.sections.flatMap((section) => section.fields.map((field) => field.key));
}

export function newField(draft: Draft, type: FieldType, label = ""): DraftField {
  const text = label || FIELD_TYPE_LABEL[type].replace(/ \(.*\)$/, "");
  const key = slugKey(text, allFieldKeys(draft));
  return {
    id: newId("f"),
    key,
    autoKey: true,
    type,
    label,
    required: false,
    visibility: "staff_only",
    options: CHOICE_TYPES.includes(type) ? [{ key: "option_1", label: "" }] : [],
  };
}

export function addOption(field: DraftField, label = ""): DraftOption {
  return { key: slugKey(label || "option", field.options.map((o) => o.key), "option"), label };
}

/** A new (never saved) question follows its wording; a saved question keeps its key. */
export function rekeyFromLabel(draft: Draft, field: DraftField, label: string): string {
  if (!field.autoKey) return field.key;
  const others = allFieldKeys(draft).filter((key) => key !== field.key);
  return slugKey(label, others);
}

export function newSection(draft: Draft, title = "", audience: Audience = "student"): DraftSection {
  const keys = draft.sections.map((section) => section.key);
  return { id: newId("s"), key: slugKey(title || "section", keys), title, audience, fields: [] };
}

export function subjectScopeFor(section: Pick<DraftSection, "audience">, field: Pick<DraftField, "type">) {
  if (field.type === "acknowledgment") return "consent";
  return section.audience === "guardian" ? "about_guardian" : "about_student";
}

export function draftToSchema(draft: Draft): { sections: unknown[] } {
  return {
    sections: draft.sections.map((section) => ({
      key: section.key,
      title: section.title.trim(),
      audience: section.audience,
      fields: section.fields.map((field) => ({
        key: field.key,
        type: field.type,
        label: field.label.trim(),
        required: field.required,
        visibility: field.visibility,
        subject_scope: subjectScopeFor(section, field),
        ...(CHOICE_TYPES.includes(field.type)
          ? { options: field.options.map((option) => ({ key: option.key, label: option.label.trim() })) }
          : {}),
      })),
    })),
  };
}

type RawField = {
  key?: unknown;
  type?: unknown;
  label?: unknown;
  required?: unknown;
  visibility?: unknown;
  options?: unknown;
};
type RawSection = { key?: unknown; title?: unknown; audience?: unknown; fields?: unknown };

export function schemaToDraft(name: string, schema: unknown): Draft {
  const sections = Array.isArray((schema as { sections?: unknown })?.sections)
    ? ((schema as { sections: RawSection[] }).sections as RawSection[])
    : [];
  return {
    name,
    sections: sections.map((section, index) => ({
      id: newId("s"),
      key: typeof section.key === "string" ? section.key : `section_${index + 1}`,
      title: typeof section.title === "string" ? section.title : "",
      audience: (AUDIENCES as readonly unknown[]).includes(section.audience) ? (section.audience as Audience) : "student",
      fields: (Array.isArray(section.fields) ? (section.fields as RawField[]) : []).map((field, fieldIndex) => ({
        id: newId("f"),
        key: typeof field.key === "string" ? field.key : `question_${fieldIndex + 1}`,
        type: (FIELD_TYPES as readonly unknown[]).includes(field.type) ? (field.type as FieldType) : "short_text",
        label: typeof field.label === "string" ? field.label : "",
        required: field.required === true,
        visibility: (VISIBILITIES as readonly unknown[]).includes(field.visibility) ? (field.visibility as Visibility) : "staff_only",
        options: Array.isArray(field.options)
          ? (field.options as { key?: unknown; label?: unknown }[]).map((option) => ({
              key: typeof option.key === "string" ? option.key : "option",
              label: typeof option.label === "string" ? option.label : "",
            }))
          : [],
      })),
    })),
  };
}

/** Worst-case stored answer size, mirroring `intake_private.schema_max_answer_bytes`. */
export function estimateMaxAnswerBytes(draft: Draft): number {
  let total = 2;
  for (const section of draft.sections) {
    for (const field of section.fields) {
      total += 4 * field.key.length + 8;
      if (CHOICE_TYPES.includes(field.type)) {
        const maxOption = field.options.reduce((max, option) => Math.max(max, option.key.length), 0);
        total += field.type === "checkboxes" ? 2 + field.options.length * (4 * maxOption + 3) : 4 * maxOption + 2;
      } else if (field.type === "short_text") total += 4 * 500 + 2;
      else if (field.type === "long_text") total += 4 * 5000 + 2;
      else if (field.type === "date") total += 12;
      else total += 5;
    }
  }
  return total;
}

export type DraftIssue = { path: string; message: string };

export function validateDraft(draft: Draft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const name = draft.name.trim();
  if (!name) issues.push({ path: "name", message: "Give the template a name." });
  if (name.length > LIMITS.maxName) issues.push({ path: "name", message: `Template names are limited to ${LIMITS.maxName} characters.` });
  if (draft.sections.length === 0) issues.push({ path: "sections", message: "Add at least one section." });
  const keys = new Set<string>();
  let fieldCount = 0;
  draft.sections.forEach((section, si) => {
    const sp = `sections.${si}`;
    if (!section.title.trim()) issues.push({ path: sp, message: `Section ${si + 1} needs a title.` });
    if (section.title.length > LIMITS.maxTitle) issues.push({ path: sp, message: `Section ${si + 1}: title is too long.` });
    if (section.fields.length === 0) issues.push({ path: sp, message: `Section “${section.title.trim() || si + 1}” needs at least one question.` });
    section.fields.forEach((field, fi) => {
      const fp = `${sp}.fields.${fi}`;
      fieldCount += 1;
      if (!field.label.trim()) issues.push({ path: fp, message: `Question ${fi + 1} in “${section.title.trim() || si + 1}” needs wording.` });
      if (field.label.length > LIMITS.maxLabel) issues.push({ path: fp, message: "A question is too long (500 characters at most)." });
      if (!FIELD_KEY.test(field.key) || keys.has(field.key)) issues.push({ path: fp, message: "Two questions share the same internal key; reword one of them." });
      keys.add(field.key);
      if (!(FIELD_TYPES as readonly string[]).includes(field.type)) issues.push({ path: fp, message: "Unsupported question type." });
      if (CHOICE_TYPES.includes(field.type)) {
        if (field.options.length < 1 || field.options.length > LIMITS.maxOptions)
          issues.push({ path: fp, message: `“${field.label.trim() || "A choice question"}” needs 1–${LIMITS.maxOptions} choices.` });
        const optionKeys = new Set<string>();
        for (const option of field.options) {
          if (!option.label.trim() || option.label.length > LIMITS.maxOptionLabel)
            issues.push({ path: fp, message: `Every choice in “${field.label.trim() || "a question"}” needs wording (500 characters at most).` });
          if (!OPTION_KEY.test(option.key) || optionKeys.has(option.key))
            issues.push({ path: fp, message: `Two choices in “${field.label.trim() || "a question"}” are too similar; reword one.` });
          optionKeys.add(option.key);
        }
      }
    });
  });
  if (fieldCount === 0 && draft.sections.length > 0) issues.push({ path: "sections", message: "Add at least one question." });
  if (fieldCount > LIMITS.maxFields) issues.push({ path: "sections", message: `Templates are limited to ${LIMITS.maxFields} questions.` });
  if (estimateMaxAnswerBytes(draft) > LIMITS.maxAnswerBytes)
    issues.push({ path: "sections", message: "The answers this template could collect are too large. Shorten it or use fewer long-answer questions." });
  if (JSON.stringify(draftToSchema(draft)).length > LIMITS.maxSchemaBytes) issues.push({ path: "sections", message: "This template is too large." });
  return issues;
}

/**
 * A short, general starter. No health or medical questions (spec 10.13: none by default); the guardian section is a
 * plain acknowledgment that the studio edits to its own wording.
 */
export function starterDraft(name = "New student intake"): Draft {
  const draft: Draft = { name, sections: [] };
  const goals = newSection(draft, "About your dancing", "student");
  draft.sections.push(goals);
  const add = (section: DraftSection, type: FieldType, label: string, required = false, options: string[] = []) => {
    const field = newField(draft, type, label);
    field.label = label;
    field.required = required;
    field.options = options.map((optionLabel) => ({ key: slugKey(optionLabel, [], "option"), label: optionLabel }));
    const taken = new Set(allFieldKeys(draft));
    field.key = slugKey(label, taken);
    field.autoKey = false;
    section.fields.push(field);
    return field;
  };
  add(goals, "long_text", "What would you like to get out of your lessons?", true).visibility = "instructor_visible";
  add(goals, "single_choice", "Have you danced before?", false, ["Never", "A little", "Quite a bit"]).visibility = "instructor_visible";
  add(goals, "checkboxes", "Which styles are you curious about?", false, ["Ballroom", "Latin", "Social dancing", "Wedding dance", "Other"]).visibility = "instructor_visible";
  add(goals, "dropdown", "How do you prefer to learn?", false, ["Step by step", "Learning by doing", "A mix"]).visibility = "instructor_visible";
  add(goals, "short_text", "How did you hear about us?");
  const policies = newSection(draft, "Studio policies", "both");
  draft.sections.push(policies);
  add(policies, "acknowledgment", "I have read and agree to the studio’s lesson and cancellation policies.", true);
  return draft;
}

/** Rebuilds a field's options from one-per-line text, keeping the key of any choice whose wording is unchanged. */
export function optionsFromLines(field: Pick<DraftField, "options">, text: string): DraftOption[] {
  const byLabel = new Map(field.options.map((option) => [option.label.trim(), option.key]));
  const used = new Set<string>();
  const result: DraftOption[] = [];
  for (const raw of text.split("\n")) {
    const label = raw.trim();
    if (!label) continue;
    const kept = byLabel.get(label);
    const key = kept && !used.has(kept) ? kept : slugKey(label, used, "option");
    used.add(key);
    result.push({ key, label });
  }
  return result;
}

export function moveItem<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
