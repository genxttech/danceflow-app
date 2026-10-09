import type {
  CategoryTypeKey,
  JudgingKey,
  PresetKey,
  ProfileDefaults,
  SimpleCategorySpec,
  SimpleCompetitionSpec,
  SimpleDivisionSpec,
} from "./types";

/**
 * Pure state machine behind the Simple Mode creation wizard. It holds no persistence: finishing the
 * wizard produces a SimpleCompetitionSpec that create_simple_competition resolves into the existing
 * canonical Competition OS rows.
 */

export const WIZARD_STEPS = [
  { key: "type", label: "What are you creating?" },
  { key: "categories", label: "Categories" },
  { key: "divisions", label: "Divisions" },
  { key: "judging", label: "Judging" },
  { key: "registration", label: "Registration" },
] as const;

export const LAST_STEP = WIZARD_STEPS.length - 1;

export type WizardCategoryState = { dances: string[]; price: string };

export type WizardState = {
  step: number;
  preset: PresetKey | null;
  name: string;
  categories: Partial<Record<CategoryTypeKey, WizardCategoryState>>;
  divisionPreset: string;
  levels: string[];
  ageBands: string[];
  judging: JudgingKey;
  registrationOpens: string;
  registrationCloses: string;
};

const PRICE_PATTERN = /^\d{1,6}(\.\d{1,2})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parsePrice(value: string): number | null {
  const trimmed = value.trim();
  return PRICE_PATTERN.test(trimmed) ? Number(trimmed) : null;
}

export function initialWizardState(eventName: string): WizardState {
  return {
    step: 0,
    preset: null,
    name: eventName,
    categories: {},
    divisionPreset: "",
    levels: [],
    ageBands: [],
    judging: "placements",
    registrationOpens: "",
    registrationCloses: "",
  };
}

function usesDances(defaults: ProfileDefaults, type: CategoryTypeKey) {
  return defaults.categoryTypes[type].uses_dances;
}

function poolFor(defaults: ProfileDefaults, preset: PresetKey) {
  return defaults.dancePools[defaults.presets[preset].dance_pool] ?? [];
}

function defaultDances(defaults: ProfileDefaults, preset: PresetKey, type: CategoryTypeKey) {
  if (!usesDances(defaults, type)) return [];
  const available = new Set(poolFor(defaults, preset).map((dance) => dance.key));
  const chosen = defaults.presets[preset].default_dances.filter((key) => available.has(key));
  if (chosen.length > 0) return chosen;
  const first = poolFor(defaults, preset)[0];
  return first ? [first.key] : [];
}

/** Choosing a competition type resets everything downstream to that type's sensible defaults. */
export function choosePreset(state: WizardState, defaults: ProfileDefaults, preset: PresetKey): WizardState {
  const definition = defaults.presets[preset];
  const categories: WizardState["categories"] = {};
  for (const type of definition.default_categories) {
    categories[type] = { dances: defaultDances(defaults, preset, type), price: "" };
  }
  return {
    ...state,
    preset,
    categories,
    judging: definition.default_judging,
    divisionPreset: definition.division_preset,
    levels: [...(defaults.divisionPresets[definition.division_preset]?.levels ?? [])],
    ageBands: [],
  };
}

export function toggleCategory(state: WizardState, defaults: ProfileDefaults, type: CategoryTypeKey): WizardState {
  if (!state.preset || !defaults.presets[state.preset].category_types.includes(type)) return state;
  const categories = { ...state.categories };
  if (categories[type]) delete categories[type];
  else categories[type] = { dances: defaultDances(defaults, state.preset, type), price: "" };
  return { ...state, categories };
}

export function toggleDance(state: WizardState, type: CategoryTypeKey, danceKey: string): WizardState {
  const current = state.categories[type];
  if (!current) return state;
  const dances = current.dances.includes(danceKey)
    ? current.dances.filter((key) => key !== danceKey)
    : [...current.dances, danceKey];
  return { ...state, categories: { ...state.categories, [type]: { ...current, dances } } };
}

export function setPrice(state: WizardState, type: CategoryTypeKey, price: string): WizardState {
  const current = state.categories[type];
  if (!current) return state;
  return { ...state, categories: { ...state.categories, [type]: { ...current, price } } };
}

export function applyDivisionPreset(state: WizardState, defaults: ProfileDefaults, key: string): WizardState {
  const preset = defaults.divisionPresets[key];
  if (!preset) return state;
  return { ...state, divisionPreset: key, levels: [...preset.levels] };
}

export function addLevel(state: WizardState, defaults: ProfileDefaults, name: string): WizardState {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > defaults.limits.nameLength) return state;
  if (state.levels.some((level) => level.toLowerCase() === trimmed.toLowerCase())) return state;
  return { ...state, levels: [...state.levels, trimmed] };
}

export function removeLevel(state: WizardState, name: string): WizardState {
  return { ...state, levels: state.levels.filter((level) => level !== name) };
}

export function toggleAgeBand(state: WizardState, band: string): WizardState {
  const ageBands = state.ageBands.includes(band) ? state.ageBands.filter((item) => item !== band) : [...state.ageBands, band];
  return { ...state, ageBands };
}

export function setJudging(state: WizardState, judging: JudgingKey): WizardState {
  return { ...state, judging };
}

/** Levels x optional age groups. The resulting names become canonical division rows. */
export function divisionList(state: Pick<WizardState, "levels" | "ageBands">): SimpleDivisionSpec[] {
  const ages: Array<string | null> = state.ageBands.length > 0 ? state.ageBands : [null];
  const divisions: SimpleDivisionSpec[] = [];
  for (const level of state.levels) {
    for (const age of ages) {
      divisions.push({ name: age ? `${level} · ${age}` : level, skill_label: level, ...(age ? { age_label: age } : {}) });
    }
  }
  return divisions;
}

export function stepErrors(state: WizardState, step: number, defaults: ProfileDefaults): string[] {
  const errors: string[] = [];
  if (step === 0) {
    if (!state.preset) errors.push("Choose what you are creating.");
    if (state.name.trim().length < 1 || state.name.trim().length > 160) errors.push("Give the competition a name (up to 160 characters).");
  }
  if (step === 1) {
    const types = Object.keys(state.categories) as CategoryTypeKey[];
    if (types.length === 0) errors.push("Choose at least one category.");
    for (const type of types) {
      if (usesDances(defaults, type) && (state.categories[type]?.dances.length ?? 0) < 1) {
        errors.push(`Choose at least one dance for ${defaults.categoryTypes[type].label}.`);
      }
    }
  }
  if (step === 2) {
    const divisions = divisionList(state);
    if (divisions.length < 1) errors.push("Add at least one division.");
    if (divisions.length > defaults.limits.divisions) errors.push(`Use ${defaults.limits.divisions} divisions or fewer.`);
    const seen = new Set<string>();
    for (const division of divisions) {
      const key = division.name.toLowerCase();
      if (seen.has(key)) errors.push(`${division.name} appears twice.`);
      seen.add(key);
      if (division.name.length > defaults.limits.nameLength) errors.push(`${division.name} is too long.`);
    }
  }
  if (step === 3) {
    if (!defaults.judging[state.judging]) errors.push("Choose how the competition is judged.");
  }
  if (step === 4) {
    for (const type of Object.keys(state.categories) as CategoryTypeKey[]) {
      const price = parsePrice(state.categories[type]?.price ?? "");
      if (price === null || price > defaults.limits.maxPrice) {
        errors.push(`Enter a price for ${defaults.categoryTypes[type].label} (use 0 for free).`);
      }
    }
    for (const value of [state.registrationOpens, state.registrationCloses]) {
      if (value && !DATE_PATTERN.test(value)) errors.push("Registration dates must be valid dates.");
    }
    if (state.registrationOpens && state.registrationCloses && state.registrationCloses < state.registrationOpens) {
      errors.push("Registration cannot close before it opens.");
    }
  }
  return errors;
}

export function canAdvance(state: WizardState, defaults: ProfileDefaults, step = state.step) {
  return stepErrors(state, step, defaults).length === 0;
}

export function goNext(state: WizardState, defaults: ProfileDefaults): WizardState {
  if (state.step >= LAST_STEP || !canAdvance(state, defaults)) return state;
  return { ...state, step: state.step + 1 };
}

export function goBack(state: WizardState): WizardState {
  return state.step <= 0 ? state : { ...state, step: state.step - 1 };
}

/** Going back to any earlier step is always allowed; going forward needs every step in between to be valid. */
export function goToStep(state: WizardState, defaults: ProfileDefaults, target: number): WizardState {
  if (target < 0 || target > LAST_STEP) return state;
  if (target <= state.step) return { ...state, step: target };
  for (let step = state.step; step < target; step += 1) {
    if (!canAdvance(state, defaults, step)) return state;
  }
  return { ...state, step: target };
}

export function wizardComplete(state: WizardState, defaults: ProfileDefaults) {
  for (let step = 0; step <= LAST_STEP; step += 1) {
    if (!canAdvance(state, defaults, step)) return false;
  }
  return true;
}

export function buildSpec(
  state: WizardState,
  defaults: ProfileDefaults,
  profile: { key: string; version: number },
  requestKey: string,
): SimpleCompetitionSpec {
  const categories: SimpleCategorySpec[] = (Object.keys(state.categories) as CategoryTypeKey[]).map((type) => ({
    type,
    price: parsePrice(state.categories[type]?.price ?? "") ?? 0,
    ...(defaults.categoryTypes[type].uses_dances ? { dances: state.categories[type]?.dances ?? [] } : {}),
  }));
  return {
    profile_key: profile.key,
    profile_version: profile.version,
    request_key: requestKey,
    preset: state.preset as PresetKey,
    judging: state.judging,
    name: state.name.trim(),
    division_preset: state.divisionPreset,
    categories,
    divisions: divisionList(state),
  };
}

/** Server-side mirror of the rules create_simple_competition enforces, for friendly early errors. */
export function validateSpec(spec: SimpleCompetitionSpec, defaults: ProfileDefaults): string[] {
  const errors: string[] = [];
  const preset = defaults.presets[spec.preset];
  if (!preset) return ["Unknown competition type."];
  if (!defaults.judging[spec.judging]) errors.push("Unknown judging choice.");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(spec.request_key ?? "")) errors.push("A request key is required.");
  if (!spec.name || spec.name.length > 160) errors.push("The competition name must be 1 to 160 characters.");
  if (!Array.isArray(spec.categories) || spec.categories.length < 1 || spec.categories.length > defaults.limits.categories) {
    errors.push(`Choose between 1 and ${defaults.limits.categories} categories.`);
    return errors;
  }
  const pool = new Set((defaults.dancePools[preset.dance_pool] ?? []).map((dance) => dance.key));
  const seenTypes = new Set<string>();
  for (const category of spec.categories) {
    const definition = defaults.categoryTypes[category.type];
    if (!definition || !preset.category_types.includes(category.type)) {
      errors.push(`Category type ${category.type} is not available for this competition type.`);
      continue;
    }
    if (seenTypes.has(category.type)) errors.push("Each category type can be added once.");
    seenTypes.add(category.type);
    if (typeof category.price !== "number" || !(category.price >= 0) || category.price > defaults.limits.maxPrice) {
      errors.push(`Enter a valid price for ${definition.label}.`);
    }
    if (definition.uses_dances) {
      const dances = category.dances ?? [];
      if (dances.length < 1 || dances.length > 20) errors.push(`Choose at least one dance for ${definition.label}.`);
      if (new Set(dances).size !== dances.length) errors.push("Dances can be chosen once per category.");
      for (const key of dances) if (!pool.has(key)) errors.push(`Dance ${key} is not available for this competition type.`);
    }
  }
  if (!Array.isArray(spec.divisions) || spec.divisions.length < 1 || spec.divisions.length > defaults.limits.divisions) {
    errors.push(`Add between 1 and ${defaults.limits.divisions} divisions.`);
  } else {
    const seen = new Set<string>();
    for (const division of spec.divisions) {
      const name = (division.name ?? "").trim();
      if (name.length < 1 || name.length > defaults.limits.nameLength) errors.push("Each division needs a name.");
      if (seen.has(name.toLowerCase())) errors.push(`Division names must be unique (${name}).`);
      seen.add(name.toLowerCase());
    }
  }
  return errors;
}
