/**
 * 10C.5: rules-profile metadata contract (schema 2) used by the Competition setup wizard.
 *
 * A profile version tells the wizard what it may offer: which styles (disciplines) exist, which entry
 * formats each style supports and recommends, the participant and lead/follow rules of each format
 * (10C.4), division and dance recommendations, round defaults, adjudication and result terminology,
 * scoring stages, programming order and which pricing models apply. The wizard never hard-codes a
 * universal format list; future governing-body profiles (UCWDC, WSDC, NDCA) supply their own metadata in
 * the same shape.
 */

export type ProgramKey = string;
export type FormatKey = string;
export type PricingModel = "per_dance" | "per_entry" | "included" | "free" | "later";
export type AdjudicationKey = "adjudicated" | "non_adjudicated";
/** Per special format: follow the style's answer, or override it. */
export type FormatAdjudication = "inherit" | AdjudicationKey;

export type ProfileDance = { key: string; name: string; category: string };

// -----------------------------------------------------------------------------------------------------
// Sources
// -----------------------------------------------------------------------------------------------------

/** Where a rule comes from. Governing-body facts must cite one; Studio policy says so explicitly. */
export type SourceReference = {
  document: string;
  edition: string;
  section?: string;
  page?: string;
  quote?: string;
};

/** Two supplied documents disagree. Never resolved silently; a material conflict blocks sanctioned-profile activation. */
export type SourceConflict = {
  key: string;
  description: string;
  references: SourceReference[];
  status: "unresolved" | "resolved";
  material: boolean;
  resolution?: string;
};

/**
 * What a piece of metadata rests on:
 * - source_grounded: stated in a supplied governing-body document (cite it);
 * - studio_recommendation: DanceFlow's Studio / Custom default;
 * - owner_operational: how real events are run, from the owner and supplied event schedules;
 * - not_specified: the supplied source does not say ("NOT SPECIFIED IN PROVIDED SOURCE").
 */
export type Basis = "source_grounded" | "studio_recommendation" | "owner_operational" | "not_specified";

export type Grounded<T> = { value: T; basis: Basis; sources?: SourceReference[]; note?: string };

// -----------------------------------------------------------------------------------------------------
// Scoring (metadata only -- no engine is implemented in 10C.5)
// -----------------------------------------------------------------------------------------------------

export type MarkInput =
  | "callback_yes_alternates"
  | "callback_retire"
  | "medal_marks"
  | "placement_marks"
  | "rating"
  | "raw_score"
  | "recall_marks"
  | "proficiency_score"
  | "none";

/** A judge/ballot input scheme. Values and scales are profile parameters, never engine constants. */
export type MarkScheme = {
  input: MarkInput;
  /** e.g. callback values {yes: 10, alt1: 4.5, ...} or medal values {HM: 6, ..., GG: 1}. */
  values?: Record<string, number>;
  /** Ordered labels from lowest to highest, when the input is a scale. */
  scale?: string[];
  ties_allowed?: boolean;
  /** Who a mark is about: the entry (couple/team) or each role separately (e.g. leaders and followers). */
  scored_by?: "entry" | "role";
  note?: string;
};

export type ScoringEngine =
  | "none"
  | "studio_placeholder"
  | "callback_tally"
  | "relative_placement"
  | "majority_rules_medal"
  | "majority_rules_overall"
  | "skating_single"
  | "skating_multi"
  | "cumulative_points"
  | "proficiency_rating";

export type EngineStatus = "implemented" | "placeholder" | "not_implemented" | "not_applicable";

/** An engine key plus profile/version-supplied parameters. Generic engines never hard-code a body's values. */
export type EngineBinding = { key: ScoringEngine; params?: Record<string, unknown>; status: EngineStatus };

export type ResultOutputType =
  | "placement"
  | "medal_threshold"
  | "proficiency_percentage"
  | "rating"
  | "registry_points"
  | "advancement_ranking"
  | "team_placement"
  | "none";

export type ResultOutput = { type: ResultOutputType; primary: boolean; label?: string; note?: string };

export type TieBreakPolicy = { chain: string[]; note?: string; sources?: SourceReference[] };

/** One family of rounds scored the same way (advancement, final, overall/multi-dance). */
export type ScoringStage = {
  key: string;
  family: "advancement" | "final" | "overall";
  round_types: string[];
  /** For advancement stages: promote (callbacks) or retire (inverted callbacks). */
  direction?: "promote" | "retire";
  ballot: MarkScheme;
  engine: EngineBinding;
  tie_break: TieBreakPolicy;
  outputs: ResultOutput[];
  sources: SourceReference[];
};

export type AdjudicationTiming =
  | "ballot_or_recall_alteration"
  | "per_dance_final_adjustment"
  | "post_multi_dance_adjustment"
  | "post_result_adjustment"
  | "disqualification"
  | "other";

/** Penalties and other post-scoring adjudication, in the order they apply. */
export type AdjudicationStage = { key: string; timing: AdjudicationTiming; description: string; sources: SourceReference[] };

export type ScoringModel = {
  basis: "studio_custom" | "governing_body_reference";
  stages: ScoringStage[];
  adjudication_stages: AdjudicationStage[];
  source_conflicts: SourceConflict[];
  note?: string;
};

export type JudgingDefinition = {
  /** Organizer-facing name of the adjudication option (e.g. Medal Marks, Placements). */
  label: string;
  description: string;
  /** Organizer-facing names for the judge input and the final result (Review). */
  input_label: string | null;
  result_label: string;
  scoring: ScoringModel;
  /**
   * Storage binding for the current Competition OS columns only -- not the scoring semantics. Medal Marks,
   * for example, bind to the generic "custom" method until a real engine exists.
   */
  engine: { key: string; version: number };
  competition_mode: string;
  advancement_method: string;
  bands?: string[];
  rounds: Array<{ round_type: string; name: string; scoring_method: string }>;
};

// -----------------------------------------------------------------------------------------------------
// Entry formats
// -----------------------------------------------------------------------------------------------------

export type MusicSource = "event_music" | "profile_defined" | "entry_selected";
/** "not_specified" = the supplied source does not establish how many entries share the floor. */
export type FloorMode = "multi_entry" | "single_entry" | "team" | "not_specified";

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
  /** regular = danced in the normal dance sequence; special = a routine / performance offering. */
  kind: "regular" | "special";
  music_source: Grounded<MusicSource>;
  floor_mode: Grounded<FloorMode>;
  /** Routine length limits when a source sets them. */
  duration?: Grounded<{ min_seconds: number; max_seconds: number }>;
  /** Where the offering runs: inside the regular sequence, or at a program-block boundary. */
  program_placement: Grounded<"within_sequence" | "block_boundary">;
  /** Whether the organizer may judge this format differently from its style's default. */
  adjudication_override: boolean;
  /**
   * Organizer-defined routine offerings (future): which properties an organizer may rename/configure,
   * so local terminology never requires reversing an official format name.
   */
  organizer_configurable?: Array<"label" | "music_source" | "duration" | "adjudication" | "floor_mode" | "program_placement">;
  sources?: SourceReference[];
};

// -----------------------------------------------------------------------------------------------------
// Styles (programs)
// -----------------------------------------------------------------------------------------------------

export type ProgrammingDimension = "level" | "age" | "dance" | "style" | "event" | "contest_format" | "division" | "round";

export type ProgrammingMetadata = {
  /** Semantic running order, outermost first (metadata only; the floor planner does not read it yet). */
  hierarchy: Grounded<ProgrammingDimension[]>;
  /** Standard dance order inside a block. */
  dance_sequence: Grounded<string[]>;
  /** Major style blocks (Ballroom), when the style has them. */
  style_blocks?: Grounded<Array<{ key: string; label: string; dance_category: string | null; dances?: string[] }>>;
  /** Special offerings run after a complete block of this dimension. */
  special_boundary: Grounded<ProgrammingDimension>;
};

export type ProgramTemplate = {
  label: string;
  description: string;
  discipline_family: string;
  dance_pool: string;
  formats: FormatKey[];
  /** Regular formats recommended for a competition. */
  recommended_formats: FormatKey[];
  /** Special (showcase / performance) formats recommended when the purpose includes performance. */
  recommended_special: FormatKey[];
  recommended_dances: string[];
  custom_dances: boolean;
  /** Adjudicated result options for this style (first is the default). */
  judging_options: string[];
  programming: ProgrammingMetadata;
};

export type AdjudicationOption = { label: string; description: string; judging?: string };

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
