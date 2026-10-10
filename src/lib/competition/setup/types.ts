/**
 * 10C.5: rules-profile metadata contract (schema 2) used by the Competition setup wizard.
 *
 * A profile version tells the wizard what it may offer: which programs (disciplines / showcase) exist,
 * which entry formats each program supports and recommends, the participant and lead/follow rules of each
 * format (10C.4), division and dance recommendations, round defaults, adjudication options and which pricing
 * models apply. The wizard never hard-codes a universal format list; future governing-body profiles
 * (UCWDC, WSDC, NDCA) supply their own metadata in the same shape.
 */

export type ProgramKey = string;
export type FormatKey = string;
export type PricingModel = "per_dance" | "per_entry" | "included" | "free" | "later";
export type AdjudicationKey = "adjudicated" | "non_adjudicated";

export type ProfileDance = { key: string; name: string; category: string };

export type JudgingDefinition = {
  label: string;
  description: string;
  engine: { key: string; version: number };
  competition_mode: string;
  advancement_method: string;
  bands?: string[];
  rounds: Array<{ round_type: string; name: string; scoring_method: string }>;
};

export type EntryFormatDefinition = {
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
  /** Relationship roles (10C.4 participant_role) an entry of this format uses. */
  participant_roles: string[];
  /** Lead/follow (10C.4 dance_role): pair = one leader + one follower, single = one role, optional, none. */
  dance_roles: "pair" | "single" | "optional" | "none";
  pricing_models: PricingModel[];
  default_pricing: PricingModel;
  division_preset: string;
};

export type ProgramTemplate = {
  label: string;
  description: string;
  purpose: "competition" | "showcase";
  discipline_family: string;
  dance_pool: string;
  formats: FormatKey[];
  recommended_formats: FormatKey[];
  recommended_dances: string[];
  custom_dances: boolean;
  /** Fixed adjudication for this program (showcase programs are always Non-Adjudicated). */
  adjudication?: AdjudicationKey;
};

export type AdjudicationOption = {
  label: string;
  description: string;
  judging_options?: string[];
  default_judging?: string;
  judging?: string;
};

export type SetupProfileDefaults = {
  schema: 2;
  label: string;
  sanction: { status: string; claimable: boolean };
  roundsDefault: string;
  roundsNote: string;
  currency: string;
  terminology: Record<string, string>;
  adjudication: Record<AdjudicationKey, AdjudicationOption>;
  judging: Record<string, JudgingDefinition>;
  programs: Record<ProgramKey, ProgramTemplate>;
  categoryTypes: Record<FormatKey, EntryFormatDefinition>;
  dancePools: Record<string, ProfileDance[]>;
  divisionPresets: Record<string, { label: string; levels: string[] }>;
  ageBands: string[];
  /** divisions is per entry format; totalDivisions caps the whole draft. */
  limits: { programs: number; categories: number; divisions: number; totalDivisions: number; dances: number; nameLength: number; maxPrice: number };
};
