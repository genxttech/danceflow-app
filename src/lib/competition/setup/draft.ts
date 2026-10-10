import type {
  AdjudicationKey,
  EntryFormatDefinition,
  FormatKey,
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
 * the Review step, the counts, the pricing summary and the create_competition_draft payload all come
 * from the same call. The server action re-derives from the stored profile, so a client payload is
 * never trusted.
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
};

export type ProgramAnswer = {
  formats: Partial<Record<FormatKey, FormatAnswer>>;
  customDances: ProfileDance[];
  registrationFee: string;
};

export type SetupAnswers = {
  version: 1;
  purpose: Purpose | null;
  styleMode: "single" | "multiple";
  styles: ProgramKey[];
  adjudication: AdjudicationKey | null;
  judging: string;
  rules: RulesChoice;
  programs: Record<ProgramKey, ProgramAnswer>;
  registration: { opens: string; closes: string; accountRequired: boolean };
};

export const PURPOSE_OPTIONS: Array<{ key: Purpose; label: string; description: string }> = [
  { key: "competition", label: "Competition", description: "Dancers compete in divisions." },
  { key: "showcase", label: "Showcase / Performance", description: "Routines performed for an audience." },
  { key: "competition_showcase", label: "Competition + Showcase", description: "A competition with a separate showcase." },
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

export function parsePrice(value: string): number | null {
  const trimmed = value.trim();
  return PRICE_PATTERN.test(trimmed) ? Number(trimmed) : null;
}

export function initialAnswers(registration?: Partial<SetupAnswers["registration"]>): SetupAnswers {
  return {
    version: 1,
    purpose: null,
    styleMode: "single",
    styles: [],
    adjudication: null,
    judging: "",
    rules: "studio_custom",
    programs: {},
    registration: { opens: "", closes: "", accountRequired: false, ...registration },
  };
}

/** Competition (discipline) programs the profile offers, in profile order. */
export function styleOptions(profile: SetupProfileDefaults): ProgramKey[] {
  return Object.keys(profile.programs).filter((key) => profile.programs[key].purpose === "competition");
}

function showcaseProgramKey(profile: SetupProfileDefaults): ProgramKey | null {
  return Object.keys(profile.programs).find((key) => profile.programs[key].purpose === "showcase") ?? null;
}

/** One program per chosen discipline, plus a separate showcase program when the purpose includes one. */
export function activeProgramKeys(answers: SetupAnswers, profile: SetupProfileDefaults): ProgramKey[] {
  const showcase = showcaseProgramKey(profile);
  const styles = answers.styles.filter((key) => profile.programs[key]?.purpose === "competition");
  if (answers.purpose === "competition") return styles;
  if (answers.purpose === "showcase") return showcase ? [showcase] : [];
  if (answers.purpose === "competition_showcase") return showcase ? [...styles, showcase] : styles;
  return [];
}

export function needsStyles(answers: SetupAnswers) {
  return answers.purpose === "competition" || answers.purpose === "competition_showcase";
}

/** Steps that apply to these answers. Sanction is only asked for rules that can be sanctioned. */
export function visibleSteps(answers: SetupAnswers, profile: SetupProfileDefaults): StepKey[] {
  const programs = activeProgramKeys(answers, profile);
  const usesDances = programs.some((key) =>
    Object.keys(answers.programs[key]?.formats ?? {}).some((format) => profile.categoryTypes[format]?.uses_dances),
  );
  return SETUP_STEPS.map((step) => step.key).filter((key) => {
    if (key === "styles") return needsStyles(answers) || answers.purpose === null;
    if (key === "adjudication") return needsStyles(answers) || answers.purpose === null;
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
  };
}

function defaultProgramAnswer(profile: SetupProfileDefaults, key: ProgramKey): ProgramAnswer {
  const formats: ProgramAnswer["formats"] = {};
  for (const format of profile.programs[key].recommended_formats) formats[format] = defaultFormatAnswer(profile, key, format);
  return { formats, customDances: [], registrationFee: "" };
}

/** Keeps answers for programs that are still chosen and seeds newly chosen programs with profile recommendations. */
export function syncPrograms(answers: SetupAnswers, profile: SetupProfileDefaults): SetupAnswers {
  const programs: SetupAnswers["programs"] = {};
  for (const key of activeProgramKeys(answers, profile)) {
    programs[key] = answers.programs[key] ?? defaultProgramAnswer(profile, key);
  }
  return { ...answers, programs };
}

export function choosePurpose(answers: SetupAnswers, profile: SetupProfileDefaults, purpose: Purpose): SetupAnswers {
  return syncPrograms({ ...answers, purpose }, profile);
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

export function chooseAdjudication(answers: SetupAnswers, profile: SetupProfileDefaults, adjudication: AdjudicationKey): SetupAnswers {
  const option = profile.adjudication[adjudication];
  if (!option) return answers;
  const judging = adjudication === "adjudicated" ? option.default_judging ?? "" : option.judging ?? "";
  return { ...answers, adjudication, judging };
}

export function chooseJudging(answers: SetupAnswers, profile: SetupProfileDefaults, judging: string): SetupAnswers {
  if (answers.adjudication !== "adjudicated" || !profile.adjudication.adjudicated.judging_options?.includes(judging)) return answers;
  return { ...answers, judging };
}

function updateProgram(answers: SetupAnswers, key: ProgramKey, change: (program: ProgramAnswer) => ProgramAnswer): SetupAnswers {
  const program = answers.programs[key];
  if (!program) return answers;
  return { ...answers, programs: { ...answers.programs, [key]: change(program) } };
}

export function toggleFormat(answers: SetupAnswers, profile: SetupProfileDefaults, key: ProgramKey, format: FormatKey): SetupAnswers {
  if (!profile.programs[key]?.formats.includes(format)) return answers;
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
// Derivation
// ---------------------------------------------------------------------------------------------------

export type DraftDivision = { name: string; skill_label: string; age_label?: string };

export type DraftCategoryPayload = {
  type: FormatKey;
  divisions: DraftDivision[];
  dances: string[];
  pricing: { model: PricingModel; amount: number | null };
};

export type DraftProgramPayload = {
  key: ProgramKey;
  name: string;
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
  adjudication: AdjudicationKey;
  answers: SetupAnswers;
  registration: { opens_at: string | null; closes_at: string | null; account_required: boolean };
  programs: DraftProgramPayload[];
};

export type DraftCategorySummary = {
  label: string;
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
  judgingLabel: string;
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

/** Judging used by a program: showcase programs are fixed Non-Adjudicated; the rest follow the organizer's answer. */
export function programJudging(answers: SetupAnswers, profile: SetupProfileDefaults, key: ProgramKey): string {
  const fixed = profile.programs[key]?.adjudication;
  if (fixed) return profile.adjudication[fixed]?.judging ?? "";
  if (answers.adjudication === "non_adjudicated") return profile.adjudication.non_adjudicated.judging ?? "";
  return answers.judging;
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
  if (step === "styles" && needsStyles(answers)) {
    const styles = programs.filter((key) => profile.programs[key].purpose === "competition");
    if (styles.length < 1) errors.push("Choose at least one style.");
    if (answers.styleMode === "multiple" && styles.length < 2) errors.push("Choose two or more styles, or pick a single style.");
    if (programs.length > limits.programs) errors.push(`Choose ${limits.programs} programs or fewer.`);
  }
  if (step === "adjudication" && needsStyles(answers)) {
    if (!answers.adjudication || !profile.adjudication[answers.adjudication]) errors.push("Choose Adjudicated or Non-Adjudicated.");
    else if (!profile.judging[programJudging(answers, profile, programs.find((key) => !profile.programs[key].adjudication) ?? "")]) {
      errors.push("Choose how results are given.");
    }
  }
  if (step === "rules" && !RULE_OPTIONS.some((option) => option.key === answers.rules && option.available)) {
    errors.push("Only Studio / Custom Rules are available.");
  }
  if (step === "offerings") {
    if (programs.length < 1) errors.push("Choose what you are creating first.");
    for (const key of programs) {
      const count = Object.keys(answers.programs[key]?.formats ?? {}).length;
      if (count < 1) errors.push(`Choose at least one entry format for ${profile.programs[key].label}.`);
      if (count > limits.categories) errors.push(`Choose ${limits.categories} entry formats or fewer for ${profile.programs[key].label}.`);
    }
  }
  if (step === "divisions") {
    let total = 0;
    for (const key of programs) {
      for (const [format, value] of Object.entries(answers.programs[key]?.formats ?? {})) {
        if (!value) continue;
        const label = `${profile.programs[key].label} ${profile.categoryTypes[format]?.label ?? format}`;
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
        const label = `${profile.programs[key].label} ${definition.label}`;
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
    for (const value of [opens, closes]) if (value && !DATE_PATTERN.test(value)) errors.push("Registration dates must be valid dates.");
    if (opens && closes && closes < opens) errors.push("Registration cannot close before it opens.");
  }
  if (step === "pricing") {
    for (const key of programs) {
      const program = answers.programs[key];
      let included = false;
      for (const [format, value] of Object.entries(program?.formats ?? {})) {
        const definition = profile.categoryTypes[format];
        if (!value || !definition) continue;
        const label = `${profile.programs[key].label} ${definition.label}`;
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
    const judgingKey = programJudging(answers, profile, key);
    const judging = profile.judging[judgingKey];
    const roundNames = (judging?.rounds ?? []).map((round) => round.name);
    const dancesByKey = new Map(programDances(profile, key, program).map((dance) => [dance.key, dance]));
    const usedDances: string[] = [];
    const categories: DraftCategorySummary[] = [];
    const payloadCategories: DraftCategoryPayload[] = [];
    let included = false;

    for (const format of template.formats) {
      const value = program?.formats[format];
      const definition = profile.categoryTypes[format];
      if (!value || !definition) continue;
      const divisions = divisionsFor(value);
      const dances = definition.uses_dances ? value.dances.filter((dance) => dancesByKey.has(dance)) : [];
      for (const dance of dances) if (!usedDances.includes(dance)) usedDances.push(dance);
      const pending = value.pricing === "later";
      if (value.pricing === "included") included = true;
      pricingPending ||= pending;
      const pricing = pricingText(definition, value, program?.registrationFee ?? "", profile.currency);
      pricingLines.push(`${template.label} ${definition.label}: ${pricing}`);
      counts.categories += 1;
      counts.divisions += divisions.length;
      counts.rounds += divisions.length * roundNames.length;
      counts.offerings += divisions.length * dances.length;
      categories.push({
        label: definition.label,
        divisions: divisions.map((division) => division.name),
        dances: dances.map((dance) => dancesByKey.get(dance)?.name ?? dance),
        rounds: roundNames,
        pricing,
        pricingPending: pending,
      });
      const amount = value.pricing === "per_dance" || value.pricing === "per_entry" ? parsePrice(value.amount) : null;
      payloadCategories.push({ type: format, divisions, dances, pricing: { model: value.pricing, amount } });
    }

    counts.dances += usedDances.length;
    const name = programName(context.eventName, template.label, keys.length > 1);
    const fee = included ? parsePrice(program?.registrationFee ?? "") : null;
    programs.push({
      key,
      name,
      styleLabel: template.label,
      judgingLabel: judging?.label ?? "Not chosen",
      registrationFee: included ? (fee === null ? "Fee needed" : `${money(fee, profile.currency)} per competitor`) : null,
      categories,
    });
    payloadPrograms.push({
      key,
      name,
      judging: judgingKey,
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
  const adjudication: AdjudicationKey = needsStyles(answers) ? (answers.adjudication as AdjudicationKey) : "non_adjudicated";
  const payload: CompetitionDraftSpec | null = valid
    ? {
        request_key: context.requestKey,
        profile_key: context.profileKey,
        profile_version: context.profileVersion,
        purpose: answers.purpose as Purpose,
        adjudication,
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
  if (value.version !== 1 || typeof value.programs !== "object" || value.programs === null || !Array.isArray(value.styles)) return null;
  if (!value.registration || typeof value.registration !== "object") return null;
  const answers: SetupAnswers = { ...initialAnswers(), ...value, rules: "studio_custom" } as SetupAnswers;
  for (const [key, program] of Object.entries(answers.programs)) {
    if (!profile.programs[key] || !program || typeof program.formats !== "object" || !Array.isArray(program.customDances)) return null;
    for (const [format, entry] of Object.entries(program.formats)) {
      if (!profile.programs[key].formats.includes(format) || !entry || !Array.isArray(entry.levels) || !Array.isArray(entry.dances) || !Array.isArray(entry.ageBands)) return null;
    }
  }
  return syncPrograms(answers, profile);
}

export function isCustomDanceKey(key: string) {
  return CUSTOM_DANCE_PATTERN.test(key);
}
