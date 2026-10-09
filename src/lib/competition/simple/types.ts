/**
 * Types for the Competition OS rules profile `studio_simple@1` and the Simple Mode specification.
 *
 * The defaults object is the single source of truth for what Simple Mode offers. It is stored (and
 * version-locked) in competition_rules_profiles; the app loads the active row and these types
 * describe it. Simple Mode is only an organizer experience over the canonical Competition OS rows:
 * the specification below is resolved into programs/contests/divisions/rounds/offerings by the
 * create_simple_competition database function.
 */

export type JudgingKey = "placements" | "ratings" | "callbacks";
export type PresetKey = "studio_competition" | "showcase" | "ballroom" | "country" | "west_coast_swing" | "custom";
export type CategoryTypeKey = "pro_am" | "couples" | "solo" | "showcase" | "jack_and_jill" | "team";

export type ProfileDance = { key: string; name: string; category: string };

export type JudgingRound = { round_type: string; name: string; scoring_method: string };

export type JudgingDefinition = {
  label: string;
  description: string;
  engine: { key: string; version: number };
  competition_mode: string;
  advancement_method: string;
  bands?: string[];
  rounds: JudgingRound[];
};

export type CategoryTypeDefinition = {
  label: string;
  description: string;
  contest_type: string;
  entry_format: string;
  uses_dances: boolean;
  dance_selection_mode: string;
  pricing_method: "per_dance" | "flat_entry";
  price_unit: string;
  minimum_participants: number;
  maximum_participants: number;
  pairing_mode: string;
};

export type PresetDefinition = {
  label: string;
  description: string;
  discipline_family: string;
  dance_pool: string;
  category_types: CategoryTypeKey[];
  default_categories: CategoryTypeKey[];
  default_dances: string[];
  default_judging: JudgingKey;
  division_preset: string;
};

export type DivisionPreset = { label: string; levels: string[] };

export type ProfileDefaults = {
  schema: number;
  label: string;
  sanction: { status: string; claimable: boolean };
  roundsDefault: string;
  currency: string;
  terminology: Record<string, string>;
  judging: Record<JudgingKey, JudgingDefinition>;
  categoryTypes: Record<CategoryTypeKey, CategoryTypeDefinition>;
  dancePools: Record<string, ProfileDance[]>;
  presets: Record<PresetKey, PresetDefinition>;
  divisionPresets: Record<string, DivisionPreset>;
  ageBands: string[];
  limits: { categories: number; divisions: number; nameLength: number; maxPrice: number };
};

export type ProfileRef = { profileKey: string; profileVersion: number; defaults: ProfileDefaults };

export type SimpleCategorySpec = { type: CategoryTypeKey; price: number; dances?: string[] };
export type SimpleDivisionSpec = { name: string; skill_label?: string; age_label?: string };

export type SimpleCompetitionSpec = {
  profile_key: string;
  profile_version: number;
  request_key: string;
  preset: PresetKey;
  judging: JudgingKey;
  name: string;
  division_preset: string;
  categories: SimpleCategorySpec[];
  divisions: SimpleDivisionSpec[];
};
