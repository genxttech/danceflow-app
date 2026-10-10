import type {
  AdjudicationKey,
  EntryFormatDefinition,
  FormatAdjudication,
  FormatKey,
  JudgingDefinition,
  PricingModel,
  ProfileDance,
  ProgramKey,
  SetupProfileDefaults,
} from "./types";

/**
 * 10C.5: pure model behind the Competition Setup Wizard.
 *
 * The organizer's answers are the only state. Every option the wizard offers is read from the rules
 * profile (never a hard-coded universal list), and deriveDraft() is the single derivation authority:
 * the Review step, the counts, the pricing summary, the special-format semantics and the
 * create_competition_draft payload all come from the same call. The server action re-derives from the
 * stored profile, so a client payload is never trusted.
 *
 * Every purpose works through the organizer's styles: a Country Showcase stays a Country offering.
 * Adjudication is answered per style; Showcase and Spotlight may override it where the profile allows.
 */

export type Purpose = "competition" | "showcase" | "competition_showcase";
export type RulesChoice = "studio_custom" | "ucwdc" | "wsdc" | "ndca";

export type FormatAnswer = {
  levelPreset: string;
  levels: string[];
  ageBands: string[];
  dances: string[];
  pricing: PricingModel;
  amount: string;
  /** Only meaningful for formats whose profile allows an override (Showcase, Spotlight). */
  adjudication: FormatAdjudication;
};

export type ProgramAnswer = {
  adjudication: AdjudicationKey | null;
  /** Adjudicated result option for this style (from the profile's judging_options). */
  judging: string;
  formats: Partial<Record<FormatKey, FormatAnswer>>;
  customDances: ProfileDance[];
  registrationFee: string;
};

export type SetupAnswers = {
  version: 2;
  purpose: Purpose | null;
  styleMode: "single" | "multiple";
  styles: ProgramKey[];
  rules: RulesChoice;
  programs: Record<ProgramKey, ProgramAnswer>;
  registration: { opens: string; closes: string; accountRequired: boolean };
};

export const PURPOSE_OPTIONS: Array<{ key: Purpose; label: string; description: string }> = [
  { key: "competition", label: "Competition", description: "Dancers compete in divisions." },
  { key: "showcase", label: "Showcase / Performance", description: "Showcase, Spotlight and routine performances." },
  { key: "competition_showcase", label: "Competition + Showcase / Performance", description: "Competition divisions plus showcase performances." },
];

/** Governing-body rules appear so organizers know they are coming; only Studio / Custom generates anything. */
export const RULE_OPTIONS: Array<{ key: RulesChoice; label: string; description: string; available: boolean }> = [
  { key: "studio_custom", label: "Studio / Custom Rules", description: "You decide the formats, divisions, dances and pricing.", available: true },
  { key: "ucwdc", label: "UCWDC", description: "Not available yet", available: false },
  { key: "wsdc", label: "WSDC", description: "Not available yet", available: false },
  { key: "ndca", label: "NDCA", description: "Not available yet", available: false },
];

export const PRICING_LABELS: Record<PricingModel, string> = {
  per_dance: "Per dance",
  per_entry: "Per entry",
  included: "Included with registration fee",
  free: "Free",
  later: "Configure later",
};

export const ADJUDICATION_OVERRIDE_LABELS: Record<FormatAdjudication, string> = {
  inherit: "Same as the style",
  adjudicated: "Adjudicated",
  non_adjudicated: "Non-Adjudicated",
};

export const PRICING_PENDING_TEXT = "Pricing requires completion before registration can open.";

export const SETUP_STEPS = [
  { key: "purpose", label: "Purpose" },
  { key: "styles", label: "Styles" },
  { key: "adjudication", label: "Adjudicated?" },
  { key: "rules", label: "Rules" },
  { key: "sanction", label: "Sanction" },
  { key: "offerings", label: "Offerings" },
  { key: "divisions", label: "Divisions" },
  { key: "dances", label: "Dances" },
  { key: "rounds", label: "Rounds" },
  { key: "registration", label: "Registration" },
  { key: "pricing", label: "Pricing" },
  { key: "review", label: "Review" },
] as const;

export type StepKey = (typeof SETUP_STEPS)[number]["key"];

const PRICE_PATTERN = /^\d{1,6}(\.\d{1,2})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CUSTOM_DANCE_PATTERN = /^custom_[a-z0-9_]{1,40}$/;
const ADJUDICATION_KEYS: AdjudicationKey[] = ["adjudicated", "non_adjudicated"];
const FORMAT_ADJUDICATION: FormatAdjudication[] = ["inherit", "adjudicated", "non_adjudicated"];

export function parsePrice(value: string): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return PRICE_PATTERN.test(trimmed) ? Number(trimmed) : null;
}

export function initialAnswers(registration?: Partial<SetupAnswers["registration"]>): SetupAnswers {
  return {
    version: 2,
    purpose: null,
    styleMode: "single",
    styles: [],
    rules: "studio_custom",
    programs: {},
    registration: { opens: "", closes: "", accountRequired: false, ...registration },
  };
}

/**
 * Styles (disciplines) the profile offers. The profile is stored as jsonb, which does not keep object key
 * order, so the order is set here: by label, with the organizer-defined style last.
 */
export function styleOptions(profile: SetupProfileDefaults): ProgramKey[] {
  const last = (key: ProgramKey) => (profile.programs[key]?.discipline_family === "custom" ? 1 : 0);
  return Object.keys(profile.programs).sort((a, b) => last(a) - last(b) || profile.programs[a].label.localeCompare(profile.programs[b].label));
}

/**
 * The wizard only works with the schema-2 shape it was built for. A profile/code mismatch (e.g. an older
 * deployment reading a newer profile, or the reverse) must fail loudly rather than render empty steps.
 */
export function setupProfileProblems(profile: unknown): string[] {
  const problems: string[] = [];
  const value = profile as Partial<SetupProfileDefaults> | null;
  if (!value || typeof value !== "object" || value.schema !== 2) return ["The profile is not schema 2."];
  const programs = value.programs && typeof value.programs === "object" ? Object.entries(value.programs) : [];
  if (programs.length === 0) problems.push("The profile offers no styles.");
  for (const [key, program] of programs) {
    if (!program || typeof program.label !== "string") problems.push(`Style ${key} has no label.`);
    if (!Array.isArray(program?.formats) || program.formats.length === 0 || program.formats.some((format) => !value.categoryTypes?.[format])) {
      problems.push(`Style ${key} has no valid entry formats.`);
    }
    if (!Array.isArray(program?.judging_options) || program.judging_options.length === 0 || program.judging_options.some((option) => !value.judging?.[option])) {
      problems.push(`Style ${key} has no valid result options.`);
    }
    if (!program?.programming || typeof program.programming !== "object") problems.push(`Style ${key} has no programming metadata.`);
  }
  return problems;
}

/** One program per chosen style, whatever the purpose: a Country Showcase stays in the Country program. */
export function activeProgramKeys(answers: SetupAnswers, profile: SetupProfileDefaults): ProgramKey[] {
  if (!answers.purpose) return [];
  return answers.styles.filter((key) => Boolean(profile.programs[key]));
}

export function formatLabel(profile: SetupProfileDefaults, _key: ProgramKey, format: FormatKey) {
  return profile.categoryTypes[format]?.label ?? format;
}

/** Formats the organizer may pick for this style and purpose (Showcase / Performance offers only special formats). */
export function availableFormats(profile: SetupProfileDefaults, key: ProgramKey, purpose: Purpose | null): FormatKey[] {
  const template = profile.programs[key];
  if (!template) return [];
  return purpose === "showcase" ? template.formats.filter((format) => profile.categoryTypes[format]?.kind === "special") : [...template.formats];
}

export function recommendedFormats(profile: SetupProfileDefaults, key: ProgramKey, purpose: Purpose | null): FormatKey[] {
  const template = profile.programs[key];
  if (!template) return [];
  if (purpose === "showcase") return [...template.recommended_special];
  if (purpose === "competition_showcase") return [...template.recommended_formats, ...template.recommended_special];
  return [...template.recommended_formats];
}

/** Steps that apply to these answers. Sanction is only asked for rules that can be sanctioned. */
export function visibleSteps(answers: SetupAnswers, profile: SetupProfileDefaults): StepKey[] {
  const programs = activeProgramKeys(answers, profile);
  const usesDances = programs.some((key) =>
    Object.keys(answers.programs[key]?.formats ?? {}).some((format) => profile.categoryTypes[format]?.uses_dances),
  );
  return SETUP_STEPS.map((step) => step.key).filter((key) => {
    if (key === "sanction") return profile.sanction.claimable;
    if (key === "dances") return usesDances;
    return true;
  });
}

export function programDances(profile: SetupProfileDefaults, key: ProgramKey, program: ProgramAnswer | undefined): ProfileDance[] {
  const template = profile.programs[key];
  const pool = template ? profile.dancePools[template.dance_pool] ?? [] : [];
  return [...pool, ...(template?.custom_dances ? program?.customDances ?? [] : [])];
}

function defaultFormatAnswer(profile: SetupProfileDefaults, key: ProgramKey, format: FormatKey): FormatAnswer {
  const definition = profile.categoryTypes[format];
  const template = profile.programs[key];
  const pool = new Set((profile.dancePools[template.dance_pool] ?? []).map((dance) => dance.key));
  let dances: string[] = [];
  if (definition.uses_dances) {
    dances = template.recommended_dances.filter((dance) => pool.has(dance));
    if (dances.length === 0) dances = [...pool].slice(0, 1);
    if (definition.dance_selection_mode === "prescribed_set") dances = dances.slice(0, 1);
  }
  return {
    levelPreset: definition.division_preset,
    levels: [...(profile.divisionPresets[definition.division_preset]?.levels ?? [])],
    ageBands: [],
    dances,
    pricing: definition.default_pricing,
    amount: "",
    adjudication: "inherit",
  };
}

function defaultProgramAnswer(profile: SetupProfileDefaults, key: ProgramKey, purpose: Purpose | null): ProgramAnswer {
  const formats: ProgramAnswer["formats"] = {};
  for (const format of recommendedFormats(profile, key, purpose)) formats[format] = defaultFormatAnswer(profile, key, format);
  return { adjudication: null, judging: profile.programs[key].judging_options[0] ?? "", formats, customDances: [], registrationFee: "" };
}

/** Keeps a style's answers when the purpose changes, dropping formats the new purpose does not offer. */
function fitProgramToPurpose(profile: SetupProfileDefaults, key: ProgramKey, program: ProgramAnswer, purpose: Purpose | null): ProgramAnswer {
  const available = new Set(availableFormats(profile, key, purpose));
  const formats: ProgramAnswer["formats"] = {};
  for (const [format, value] of Object.entries(program.formats)) if (value && available.has(format)) formats[format] = value;
  if (purpose === "competition_showcase" && !Object.keys(formats).some((format) => profile.categoryTypes[format]?.kind === "special")) {
    for (const format of profile.programs[key].recommended_special) formats[format] = defaultFormatAnswer(profile, key, format);
  }
  if (Object.keys(formats).length === 0) {
    for (const format of recommendedFormats(profile, key, purpose)) formats[format] = defaultFormatAnswer(profile, key, format);
  }
  return { ...program, formats };
}

/** Keeps answers for styles that are still chosen and seeds newly chosen styles with profile recommendations. */
export function syncPrograms(answers: SetupAnswers, profile: SetupProfileDefaults): SetupAnswers {
  const programs: SetupAnswers["programs"] = {};
  for (const key of activeProgramKeys(answers, profile)) {
    programs[key] = answers.programs[key] ?? defaultProgramAnswer(profile, key, answers.purpose);
  }
  return { ...answers, programs };
}

export function choosePurpose(answers: SetupAnswers, profile: SetupProfileDefaults, purpose: Purpose): SetupAnswers {
  const programs: SetupAnswers["programs"] = {};
  for (const [key, program] of Object.entries(answers.programs)) programs[key] = fitProgramToPurpose(profile, key, program, purpose);
  return syncPrograms({ ...answers, purpose, programs }, profile);
}

export function chooseStyle(answers: SetupAnswers, profile: SetupProfileDefaults, style: ProgramKey | "multiple"): SetupAnswers {
  if (style === "multiple") return syncPrograms({ ...answers, styleMode: "multiple" }, profile);
  if (!styleOptions(profile).includes(style)) return answers;
  if (answers.styleMode === "multiple") {
    const styles = answers.styles.includes(style) ? answers.styles.filter((key) => key !== style) : [...answers.styles, style];
    return syncPrograms({ ...answers, styles }, profile);
  }
  return syncPrograms({ ...answers, styles: [style] }, profile);
}

export function chooseSingleStyleMode(answers: SetupAnswers, profile: SetupProfileDefaults): SetupAnswers {
  return syncPrograms({ ...answers, styleMode: "single", styles: answers.styles.slice(0, 1) }, profile);
}

function updateProgram(answers: SetupAnswers, key: ProgramKey, change: (program: ProgramAnswer) => ProgramAnswer): SetupAnswers {
  const program = answers.programs[key];
  if (!program) return answers;
  return { ...answers, programs: { ...answers.programs, [key]: change(program) } };
}

/** The style-level default every ordinary entry format inherits. */
export function chooseAdjudication(answers: SetupAnswers, key: ProgramKey, adjudication: AdjudicationKey): SetupAnswers {
  if (!ADJUDICATION_KEYS.includes(adjudication)) return answers;
  return updateProgram(answers, key, (program) => ({ ...program, adjudication }));
}

export function chooseJudging(answers: SetupAnswers, profile: SetupProfileDefaults, key: ProgramKey, judging: string): SetupAnswers {
  if (!profile.programs[key]?.judging_options.includes(judging)) return answers;
  return updateProgram(answers, key, (program) => ({ ...program, judging }));
}

/** Showcase / Spotlight may be judged differently from their style where the profile allows it. */
export function setFormatAdjudication(answers: SetupAnswers, profile: SetupProfileDefaults, key: ProgramKey, format: FormatKey, value: FormatAdjudication) {
  if (!profile.categoryTypes[format]?.adjudication_override || !FORMAT_ADJUDICATION.includes(value)) return answers;
  return updateFormat(answers, key, format, { adjudication: value });
}

export function toggleFormat(answers: SetupAnswers, profile: SetupProfileDefaults, key: ProgramKey, format: FormatKey): SetupAnswers {
  if (!availableFormats(profile, key, answers.purpose).includes(format)) return answers;
  return updateProgram(answers, key, (program) => {
    const formats = { ...program.formats };
    if (formats[format]) delete formats[format];
    else formats[format] = defaultFormatAnswer(profile, key, format);
    return { ...program, formats };
  });
}

export function updateFormat(answers: SetupAnswers, key: ProgramKey, format: FormatKey, change: Partial<FormatAnswer>): SetupAnswers {
  return updateProgram(answers, key, (program) => {
    const current = program.formats[format];
    return current ? { ...program, formats: { ...program.formats, [format]: { ...current, ...change } } } : program;
  });
}

export function applyLevelPreset(answers: SetupAnswers, profile: SetupProfileDefaults, key: ProgramKey, format: FormatKey, preset: string) {
  const levels = profile.divisionPresets[preset]?.levels;
  return levels ? updateFormat(answers, key, format, { levelPreset: preset, levels: [...levels] }) : answers;
}

export function addLevel(answers: SetupAnswers, profile: SetupProfileDefaults, key: ProgramKey, format: FormatKey, name: string) {
  const trimmed = name.trim();
  const current = answers.programs[key]?.formats[format];
  if (!current || !trimmed || trimmed.length > profile.limits.nameLength) return answers;
  if (current.levels.some((level) => level.toLowerCase() === trimmed.toLowerCase())) return answers;
  return updateFormat(answers, key, format, { levels: [...current.levels, trimmed] });
}

export function removeLevel(answers: SetupAnswers, key: ProgramKey, format: FormatKey, name: string) {
  const current = answers.programs[key]?.formats[format];
  return current ? updateFormat(answers, key, format, { levels: current.levels.filter((level) => level !== name) }) : answers;
}

export function toggleAgeBand(answers: SetupAnswers, key: ProgramKey, format: FormatKey, band: string) {
  const current = answers.programs[key]?.formats[format];
  if (!current) return answers;
  const ageBands = current.ageBands.includes(band) ? current.ageBands.filter((item) => item !== band) : [...current.ageBands, band];
  return updateFormat(answers, key, format, { ageBands });
}

export function toggleFormatDance(answers: SetupAnswers, key: ProgramKey, format: FormatKey, dance: string) {
  const current = answers.programs[key]?.formats[format];
  if (!current) return answers;
  const dances = current.dances.includes(dance) ? current.dances.filter((item) => item !== dance) : [...current.dances, dance];
  return updateFormat(answers, key, format, { dances });
}

export function customDanceKey(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return slug ? `custom_${slug}` : "";
}

export function addCustomDance(answers: SetupAnswers, profile: SetupProfileDefaults, key: ProgramKey, name: string) {
  const trimmed = name.trim().replace(/\s+/g, " ");
  const danceKey = customDanceKey(trimmed);
  if (!profile.programs[key]?.custom_dances || !danceKey || trimmed.length > 80) return answers;
  const existing = programDances(profile, key, answers.programs[key]);
  if (existing.some((dance) => dance.key === danceKey || dance.name.toLowerCase() === trimmed.toLowerCase())) return answers;
  return updateProgram(answers, key, (program) => ({
    ...program,
    customDances: [...program.customDances, { key: danceKey, name: trimmed, category: "Custom" }],
  }));
}

export function removeCustomDance(answers: SetupAnswers, key: ProgramKey, danceKey: string) {
  return updateProgram(answers, key, (program) => {
    const formats: ProgramAnswer["formats"] = {};
    for (const [format, value] of Object.entries(program.formats)) {
      if (value) formats[format] = { ...value, dances: value.dances.filter((dance) => dance !== danceKey) };
    }
    return { ...program, formats, customDances: program.customDances.filter((dance) => dance.key !== danceKey) };
  });
}

export function setPricing(answers: SetupAnswers, profile: SetupProfileDefaults, key: ProgramKey, format: FormatKey, model: PricingModel) {
  if (!profile.categoryTypes[format]?.pricing_models.includes(model)) return answers;
  return updateFormat(answers, key, format, { pricing: model });
}

export function setRegistrationFee(answers: SetupAnswers, key: ProgramKey, fee: string) {
  return updateProgram(answers, key, (program) => ({ ...program, registrationFee: fee }));
}

export function setRegistration(answers: SetupAnswers, change: Partial<SetupAnswers["registration"]>): SetupAnswers {
  return { ...answers, registration: { ...answers.registration, ...change } };
}

// ---------------------------------------------------------------------------------------------------
// Adjudication
// ---------------------------------------------------------------------------------------------------

/** Judging used by a style's ordinary formats. Empty until the style's adjudication is answered. */
export function programJudging(answers: SetupAnswers, profile: SetupProfileDefaults, key: ProgramKey): string {
  const program = answers.programs[key];
  const template = profile.programs[key];
  if (!program || !template || !program.adjudication) return "";
  if (program.adjudication === "non_adjudicated") return profile.adjudication.non_adjudicated.judging ?? "";
  return template.judging_options.includes(program.judging) ? program.judging : "";
}

/** Judging for one format: the style default, or the Showcase / Spotlight override. */
export function formatJudging(answers: SetupAnswers, profile: SetupProfileDefaults, key: ProgramKey, format: FormatKey): string {
  const value = answers.programs[key]?.formats[format];
  const base = programJudging(answers, profile, key);
  if (!value || !profile.categoryTypes[format]?.adjudication_override || value.adjudication === "inherit") return base;
  if (value.adjudication === "non_adjudicated") return profile.adjudication.non_adjudicated.judging ?? "";
  const program = answers.programs[key];
  return program?.adjudication === "adjudicated" && base ? base : profile.programs[key]?.judging_options[0] ?? "";
}

/** The final stage of a scoring model and its primary result output. */
export function finalStage(judging: JudgingDefinition | undefined) {
  const stage = judging?.scoring.stages.find((item) => item.family === "final");
  return { stage, primary: stage?.outputs.find((output) => output.primary) };
}

/** Organizer-facing summary: Medal Marks are the judge input, Placement is the result -- never the same thing. */
export function judgingSummary(judging: JudgingDefinition | undefined): string {
  if (!judging) return "Not chosen";
  const { stage, primary } = finalStage(judging);
  if (!primary || primary.type === "none") return "Non-Adjudicated · Performance / exhibition · No competitive result";
  if (stage?.ballot.input === "medal_marks") return `Adjudicated · Judge input: ${judging.input_label} · Final result: ${judging.result_label}`;
  if (primary.type === "rating") return `Adjudicated · ${judging.label} ratings`;
  return `Adjudicated · ${judging.label}`;
}

/** How a special format runs, from its profile metadata (music source and placement in the running order). */
export function formatRunNote(profile: SetupProfileDefaults, key: ProgramKey, format: FormatKey): string | null {
  const definition = profile.categoryTypes[format];
  if (!definition || definition.kind !== "special") return null;
  const music = definition.music_source.value === "profile_defined" ? "Set music for each dance" : definition.music_source.value === "entry_selected" ? "Music chosen by the dancers" : "Event music";
  const boundary = profile.programs[key]?.programming.special_boundary.value;
  const where = boundary === "style" ? "runs after its style block" : boundary === "contest_format" ? "runs as its own contest block" : "runs after each age group's dances";
  const duration = definition.duration?.value;
  const length = duration ? `${duration.min_seconds / 60}–${duration.max_seconds / 60} minutes` : null;
  return [music, length, where].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------------------------------

export type DraftDivision = { name: string; skill_label: string; age_label?: string };

export type DraftCategoryPayload = {
  type: FormatKey;
  adjudication: FormatAdjudication;
  divisions: DraftDivision[];
  dances: string[];
  pricing: { model: PricingModel; amount: number | null };
};

export type DraftProgramPayload = {
  key: ProgramKey;
  name: string;
  adjudication: AdjudicationKey;
  judging: string;
  registration_fee: number | null;
  dances: ProfileDance[];
  categories: DraftCategoryPayload[];
};

/** The create_competition_draft specification (registration dates are converted to timestamps by the server). */
export type CompetitionDraftSpec = {
  request_key: string;
  profile_key: string;
  profile_version: number;
  purpose: Purpose;
  answers: SetupAnswers;
  registration: { opens_at: string | null; closes_at: string | null; account_required: boolean };
  programs: DraftProgramPayload[];
};

export type DraftCategorySummary = {
  label: string;
  special: boolean;
  judging: string;
  runNote: string | null;
  divisions: string[];
  dances: string[];
  rounds: string[];
  pricing: string;
  pricingPending: boolean;
};

export type DraftProgramSummary = {
  key: ProgramKey;
  name: string;
  styleLabel: string;
  judging: string;
  registrationFee: string | null;
  categories: DraftCategorySummary[];
};

export type DerivedDraft = {
  programs: DraftProgramSummary[];
  counts: { programs: number; categories: number; divisions: number; rounds: number; dances: number; offerings: number };
  pricingPending: boolean;
  pricingLines: string[];
  errors: Partial<Record<StepKey, string[]>>;
  /** Present only when every step is valid. */
  payload: CompetitionDraftSpec | null;
};

export function divisionsFor(format: Pick<FormatAnswer, "levels" | "ageBands">): DraftDivision[] {
  const ages: Array<string | null> = format.ageBands.length > 0 ? format.ageBands : [null];
  const divisions: DraftDivision[] = [];
  for (const level of format.levels) {
    for (const age of ages) {
      divisions.push({ name: age ? `${level} · ${age}` : level, skill_label: level, ...(age ? { age_label: age } : {}) });
    }
  }
  return divisions;
}

function money(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function pricingText(definition: EntryFormatDefinition, format: FormatAnswer, programFee: string, currency: string) {
  const amount = parsePrice(format.amount);
  if (format.pricing === "per_dance") return amount === null ? "Per dance (price needed)" : `${money(amount, currency)} per dance`;
  if (format.pricing === "per_entry") return amount === null ? "Per entry (price needed)" : `${money(amount, currency)} per entry`;
  if (format.pricing === "included") {
    const fee = parsePrice(programFee);
    return fee === null ? "Included with registration fee (fee needed)" : `Included with the ${money(fee, currency)} registration fee`;
  }
  if (format.pricing === "free") return "Free";
  return `Configure later — ${PRICING_PENDING_TEXT}`;
}

function programName(eventName: string, label: string, many: boolean) {
  const base = eventName.trim() || "Competition";
  return (many ? `${base} — ${label}` : base).slice(0, 160).trim();
}

export function stepErrors(answers: SetupAnswers, profile: SetupProfileDefaults, step: StepKey): string[] {
  const errors: string[] = [];
  const programs = activeProgramKeys(answers, profile);
  const limits = profile.limits;
  if (step === "purpose" && !answers.purpose) errors.push("Choose what you are creating.");
  if (step === "styles") {
    if (programs.length < 1) errors.push("Choose at least one style.");
    if (answers.styleMode === "multiple" && programs.length < 2) errors.push("Choose two or more styles, or pick a single style.");
    if (programs.length > limits.programs) errors.push(`Choose ${limits.programs} styles or fewer.`);
  }
  if (step === "adjudication") {
    for (const key of programs) {
      const program = answers.programs[key];
      const label = profile.programs[key].label;
      if (!program?.adjudication) errors.push(`Choose Adjudicated or Non-Adjudicated for ${label}.`);
      else if (!programJudging(answers, profile, key)) errors.push(`Choose how ${label} results are given.`);
    }
  }
  if (step === "rules" && !RULE_OPTIONS.some((option) => option.key === answers.rules && option.available)) {
    errors.push("Only Studio / Custom Rules are available.");
  }
  if (step === "offerings") {
    if (programs.length < 1) errors.push("Choose what you are creating first.");
    let regular = 0;
    let special = 0;
    for (const key of programs) {
      const chosen = Object.keys(answers.programs[key]?.formats ?? {});
      const label = profile.programs[key].label;
      if (chosen.length < 1) errors.push(`Choose at least one offering for ${label}.`);
      if (chosen.length > limits.categories) errors.push(`Choose ${limits.categories} offerings or fewer for ${label}.`);
      const available = availableFormats(profile, key, answers.purpose);
      for (const format of chosen) {
        if (!available.includes(format)) errors.push(`${formatLabel(profile, key, format)} is not offered for this purpose.`);
        if (profile.categoryTypes[format]?.kind === "special") special += 1;
        else regular += 1;
      }
    }
    if (answers.purpose === "competition_showcase" && programs.length > 0) {
      if (special < 1) errors.push("Add a Showcase or Spotlight offering, or choose Competition as the purpose.");
      if (regular < 1) errors.push("Add a competition entry format, or choose Showcase / Performance as the purpose.");
    }
  }
  if (step === "divisions") {
    let total = 0;
    for (const key of programs) {
      for (const [format, value] of Object.entries(answers.programs[key]?.formats ?? {})) {
        if (!value) continue;
        const label = `${profile.programs[key].label} ${formatLabel(profile, key, format)}`;
        const divisions = divisionsFor(value);
        total += divisions.length;
        if (divisions.length < 1) errors.push(`Add at least one division for ${label}.`);
        if (divisions.length > limits.divisions) errors.push(`Use ${limits.divisions} divisions or fewer for ${label}.`);
        const seen = new Set<string>();
        for (const division of divisions) {
          if (seen.has(division.name.toLowerCase())) errors.push(`${division.name} appears twice in ${label}.`);
          seen.add(division.name.toLowerCase());
          if (division.name.length > limits.nameLength) errors.push(`${division.name} is too long.`);
        }
      }
    }
    if (total > limits.totalDivisions) errors.push(`This draft has ${total} divisions; use ${limits.totalDivisions} or fewer.`);
  }
  if (step === "dances") {
    for (const key of programs) {
      const available = new Set(programDances(profile, key, answers.programs[key]).map((dance) => dance.key));
      const used = new Set<string>();
      for (const [format, value] of Object.entries(answers.programs[key]?.formats ?? {})) {
        const definition = profile.categoryTypes[format];
        if (!value || !definition?.uses_dances) continue;
        const label = `${profile.programs[key].label} ${formatLabel(profile, key, format)}`;
        if (value.dances.length < 1) errors.push(`Choose at least one dance for ${label}.`);
        if (value.dances.length > limits.dances) errors.push(`Choose ${limits.dances} dances or fewer for ${label}.`);
        for (const dance of value.dances) {
          if (!available.has(dance)) errors.push(`A dance chosen for ${label} is no longer available.`);
          used.add(dance);
        }
      }
      if (used.size > limits.dances) errors.push(`${profile.programs[key].label} uses ${used.size} dances; use ${limits.dances} or fewer.`);
    }
  }
  if (step === "registration") {
    const { opens, closes } = answers.registration;
    for (const value of [opens, closes]) if (value && (typeof value !== "string" || !DATE_PATTERN.test(value))) errors.push("Registration dates must be valid dates.");
    if (opens && closes && closes < opens) errors.push("Registration cannot close before it opens.");
  }
  if (step === "pricing") {
    for (const key of programs) {
      const program = answers.programs[key];
      let included = false;
      for (const [format, value] of Object.entries(program?.formats ?? {})) {
        const definition = profile.categoryTypes[format];
        if (!value || !definition) continue;
        const label = `${profile.programs[key].label} ${formatLabel(profile, key, format)}`;
        if (!definition.pricing_models.includes(value.pricing)) errors.push(`Choose how ${label} is priced.`);
        if (value.pricing === "per_dance" || value.pricing === "per_entry") {
          const amount = parsePrice(value.amount);
          if (amount === null || amount <= 0 || amount > limits.maxPrice) errors.push(`Enter a price for ${label}, or choose Free or Configure later.`);
        }
        if (value.pricing === "included") included = true;
      }
      if (included) {
        const fee = parsePrice(program?.registrationFee ?? "");
        if (fee === null || fee <= 0 || fee > limits.maxPrice) errors.push(`Enter the ${profile.programs[key].label} registration fee.`);
      }
    }
  }
  return errors;
}

export function deriveDraft(
  answers: SetupAnswers,
  profile: SetupProfileDefaults,
  context: { eventName: string; profileKey: string; profileVersion: number; requestKey: string },
): DerivedDraft {
  const keys = activeProgramKeys(answers, profile);
  const errors: DerivedDraft["errors"] = {};
  for (const step of visibleSteps(answers, profile)) {
    const list = stepErrors(answers, profile, step);
    if (list.length > 0) errors[step] = list;
  }

  const counts = { programs: keys.length, categories: 0, divisions: 0, rounds: 0, dances: 0, offerings: 0 };
  const programs: DraftProgramSummary[] = [];
  const payloadPrograms: DraftProgramPayload[] = [];
  const pricingLines: string[] = [];
  let pricingPending = false;

  for (const key of keys) {
    const template = profile.programs[key];
    const program = answers.programs[key];
    const dancesByKey = new Map(programDances(profile, key, program).map((dance) => [dance.key, dance]));
    const usedDances: string[] = [];
    const categories: DraftCategorySummary[] = [];
    const payloadCategories: DraftCategoryPayload[] = [];
    let included = false;

    for (const format of template.formats) {
      const value = program?.formats[format];
      const definition = profile.categoryTypes[format];
      if (!value || !definition) continue;
      const label = formatLabel(profile, key, format);
      const judging = profile.judging[formatJudging(answers, profile, key, format)];
      const roundNames = (judging?.rounds ?? []).map((round) => round.name);
      const divisions = divisionsFor(value);
      const dances = definition.uses_dances ? value.dances.filter((dance) => dancesByKey.has(dance)) : [];
      for (const dance of dances) if (!usedDances.includes(dance)) usedDances.push(dance);
      const pending = value.pricing === "later";
      if (value.pricing === "included") included = true;
      pricingPending ||= pending;
      const pricing = pricingText(definition, value, program?.registrationFee ?? "", profile.currency);
      pricingLines.push(`${template.label} ${label}: ${pricing}`);
      counts.categories += 1;
      counts.divisions += divisions.length;
      counts.rounds += divisions.length * roundNames.length;
      counts.offerings += divisions.length * dances.length;
      categories.push({
        label,
        special: definition.kind === "special",
        judging: judgingSummary(judging),
        runNote: formatRunNote(profile, key, format),
        divisions: divisions.map((division) => division.name),
        dances: dances.map((dance) => dancesByKey.get(dance)?.name ?? dance),
        rounds: roundNames,
        pricing,
        pricingPending: pending,
      });
      const amount = value.pricing === "per_dance" || value.pricing === "per_entry" ? parsePrice(value.amount) : null;
      payloadCategories.push({
        type: format,
        adjudication: definition.adjudication_override ? value.adjudication : "inherit",
        divisions,
        dances,
        pricing: { model: value.pricing, amount },
      });
    }

    counts.dances += usedDances.length;
    const name = programName(context.eventName, template.label, keys.length > 1);
    const fee = included ? parsePrice(program?.registrationFee ?? "") : null;
    const styleJudging = programJudging(answers, profile, key);
    programs.push({
      key,
      name,
      styleLabel: template.label,
      judging: judgingSummary(profile.judging[styleJudging]),
      registrationFee: included ? (fee === null ? "Fee needed" : `${money(fee, profile.currency)} per competitor`) : null,
      categories,
    });
    payloadPrograms.push({
      key,
      name,
      adjudication: (program?.adjudication ?? "adjudicated") as AdjudicationKey,
      judging: styleJudging,
      registration_fee: fee,
      dances: usedDances.map((dance) => {
        const found = dancesByKey.get(dance) as ProfileDance;
        return { key: found.key, name: found.name, category: found.category };
      }),
      categories: payloadCategories,
    });
  }

  if (pricingPending) pricingLines.push(PRICING_PENDING_TEXT);

  const valid = Object.keys(errors).length === 0 && answers.purpose !== null && keys.length > 0;
  const payload: CompetitionDraftSpec | null = valid
    ? {
        request_key: context.requestKey,
        profile_key: context.profileKey,
        profile_version: context.profileVersion,
        purpose: answers.purpose as Purpose,
        answers,
        registration: {
          opens_at: answers.registration.opens || null,
          closes_at: answers.registration.closes || null,
          account_required: answers.registration.accountRequired,
        },
        programs: payloadPrograms,
      }
    : null;

  return { programs, counts, pricingPending, pricingLines, errors, payload };
}

// ---------------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------------

export function firstInvalidStep(answers: SetupAnswers, profile: SetupProfileDefaults, upTo?: StepKey): StepKey | null {
  for (const step of visibleSteps(answers, profile)) {
    if (step === upTo) return null;
    if (stepErrors(answers, profile, step).length > 0) return step;
  }
  return null;
}

/** Going back is always allowed; going forward needs every earlier visible step to be valid. */
export function canReach(answers: SetupAnswers, profile: SetupProfileDefaults, target: StepKey) {
  return visibleSteps(answers, profile).includes(target) && firstInvalidStep(answers, profile, target) === null;
}

export function nextStep(answers: SetupAnswers, profile: SetupProfileDefaults, current: StepKey): StepKey {
  const steps = visibleSteps(answers, profile);
  const index = steps.indexOf(current);
  if (index < 0) return steps[0];
  if (stepErrors(answers, profile, current).length > 0) return current;
  return steps[Math.min(index + 1, steps.length - 1)];
}

export function previousStep(answers: SetupAnswers, profile: SetupProfileDefaults, current: StepKey): StepKey {
  const steps = visibleSteps(answers, profile);
  const index = steps.indexOf(current);
  return index <= 0 ? steps[0] : steps[index - 1];
}

/** Restores a persisted step safely: an unknown or no-longer-reachable step falls back to the first invalid one. */
export function resumeStep(answers: SetupAnswers, profile: SetupProfileDefaults, stored: string | null | undefined): StepKey {
  const steps = visibleSteps(answers, profile);
  const target = steps.find((step) => step === stored);
  if (target && canReach(answers, profile, target)) return target;
  return firstInvalidStep(answers, profile) ?? steps[steps.length - 1];
}

/** Parses persisted answers; anything malformed starts over rather than producing a partial draft. */
export function restoreAnswers(raw: unknown, profile: SetupProfileDefaults): SetupAnswers | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<SetupAnswers>;
  if (value.version !== 2 || typeof value.programs !== "object" || value.programs === null || !Array.isArray(value.styles)) return null;
  if (!value.registration || typeof value.registration !== "object") return null;
  if (value.purpose !== null && !PURPOSE_OPTIONS.some((option) => option.key === value.purpose)) return null;
  const answers: SetupAnswers = {
    version: 2,
    purpose: value.purpose ?? null,
    styleMode: value.styleMode === "multiple" ? "multiple" : "single",
    styles: value.styles.filter((key): key is string => typeof key === "string"),
    rules: "studio_custom",
    programs: value.programs as SetupAnswers["programs"],
    registration: {
      opens: typeof value.registration.opens === "string" ? value.registration.opens : "",
      closes: typeof value.registration.closes === "string" ? value.registration.closes : "",
      accountRequired: value.registration.accountRequired === true,
    },
  };
  for (const [key, program] of Object.entries(answers.programs)) {
    if (!profile.programs[key] || !program || typeof program.formats !== "object" || !Array.isArray(program.customDances)) return null;
    if (program.adjudication !== null && !ADJUDICATION_KEYS.includes(program.adjudication)) return null;
    for (const [format, entry] of Object.entries(program.formats)) {
      if (!profile.programs[key].formats.includes(format) || !entry || !Array.isArray(entry.levels) || !Array.isArray(entry.dances) || !Array.isArray(entry.ageBands)) return null;
      if (!FORMAT_ADJUDICATION.includes(entry.adjudication)) return null;
    }
  }
  return syncPrograms(answers, profile);
}

export function isCustomDanceKey(key: string) {
  return CUSTOM_DANCE_PATTERN.test(key);
}
