import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STUDIO_SIMPLE_V1_DEFAULTS as defaults } from "@/lib/competition/simple/studioSimpleV1";
import type { CategoryTypeKey, PresetKey } from "@/lib/competition/simple/types";

/**
 * studio_simple@1: DanceFlow's generic studio competition profile. The database owns the version
 * lock (proved by sql-tests/test_T_phase10b_competition_profiles.sql); these tests keep the app's
 * copy of the defaults identical to the seeded row and keep Simple Mode honest about what it offers.
 */

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const MIGRATION = readFileSync(join(ROOT, "src/lib/supabase/migrations/20261108090000_phase10b_competition_profiles.sql"), "utf8");

// Existing canonical enumerations (CHECK constraints from the June 2026 foundation + 10B engine keys).
const CONTEST_TYPES = ["single_dance", "multi_dance", "scholarship", "showdance", "cabaret", "formation", "line_dance", "team", "spotlight", "jack_and_jill", "strictly", "exhibition", "custom"];
const ENTRY_FORMATS = ["solo", "couple", "pro_am", "pro_pro", "mixed_amateur", "professional", "team", "random_partner", "custom"];
const DANCE_MODES = ["individual", "prescribed_set", "choose_count", "routine", "none"];
const PRICING_METHODS = ["per_dance", "flat_entry", "base_plus_dance", "included_set", "custom"];
const PAIRING_MODES = ["fixed", "random_rotation", "random_final_pair", "individual", "team", "none"];
const ROUND_TYPES = ["qualifying", "preliminary", "quarterfinal", "semifinal", "final", "proficiency", "feedback", "exhibition", "custom"];
const COMPETITION_MODES = ["relative", "proficiency", "feedback_only", "exhibition"];
const DISCIPLINES = ["showcase", "ballroom", "country", "west_coast_swing", "collegiate_amateur", "custom"];
const ADVANCEMENT = ["promote_callback", "retire_callback", "recall_count", "custom", "none"];
const ENGINE_KEYS = ["ordinal_majority", "proficiency_rating", "callback_tally"];

function strings(value: unknown, path = ""): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${path}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => strings(item, `${path}.${key}`));
  return [];
}

describe("studio_simple@1 seed", () => {
  it("is identical to the profile row the migration seeds (drift guard)", () => {
    const open = MIGRATION.indexOf("$studio_simple_v1$");
    const close = MIGRATION.indexOf("$studio_simple_v1$", open + 1);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const seeded = JSON.parse(MIGRATION.slice(open + "$studio_simple_v1$".length, close));
    expect(seeded).toEqual(defaults);
  });

  it("is seeded as version 1 of studio_simple, active", () => {
    expect(MIGRATION).toContain("'studio_simple', 1, 'Studio Competition'");
    expect(MIGRATION).toMatch(/'studio_simple', 1, 'Studio Competition',\s+'(?:[^']|'')*',\s+'active'/);
  });

  it("is a generic profile: no sanctioning organization and no claim of one", () => {
    expect(defaults.sanction).toEqual({ status: "none", claimable: false });
    const text = JSON.stringify(defaults).toLowerCase();
    for (const forbidden of ["ndca", "ucwdc", "wsdc", "sanctioned", "medal"]) expect(text).not.toContain(forbidden);
  });

  it("defaults to a final-only structure for placements and ratings; callbacks add one callback round", () => {
    expect(defaults.roundsDefault).toBe("final_only");
    expect(defaults.judging.placements.rounds).toEqual([{ round_type: "final", name: "Final", scoring_method: "ordinal_majority" }]);
    expect(defaults.judging.ratings.rounds).toEqual([{ round_type: "final", name: "Final", scoring_method: "proficiency_rating" }]);
    expect(defaults.judging.callbacks.rounds.map((round) => round.round_type)).toEqual(["preliminary", "final"]);
  });

  it("maps the three judging choices to the studio engines and Gold/Silver/Bronze ratings", () => {
    expect(defaults.judging.placements.engine).toEqual({ key: "ordinal_majority", version: 1 });
    expect(defaults.judging.ratings.engine).toEqual({ key: "proficiency_rating", version: 1 });
    expect(defaults.judging.callbacks.engine).toEqual({ key: "callback_tally", version: 1 });
    expect(defaults.judging.ratings.bands).toEqual(["Gold", "Silver", "Bronze"]);
  });

  it("uses only values the existing canonical tables accept (no parallel model)", () => {
    for (const mode of Object.values(defaults.judging)) {
      expect(COMPETITION_MODES).toContain(mode.competition_mode);
      expect(ADVANCEMENT).toContain(mode.advancement_method);
      expect(ENGINE_KEYS).toContain(mode.engine.key);
      for (const round of mode.rounds) {
        expect(ROUND_TYPES).toContain(round.round_type);
        expect([...ENGINE_KEYS]).toContain(round.scoring_method);
      }
    }
    for (const category of Object.values(defaults.categoryTypes)) {
      expect(CONTEST_TYPES).toContain(category.contest_type);
      expect(ENTRY_FORMATS).toContain(category.entry_format);
      expect(DANCE_MODES).toContain(category.dance_selection_mode);
      expect(PRICING_METHODS).toContain(category.pricing_method);
      expect(PAIRING_MODES).toContain(category.pairing_mode);
      expect(category.minimum_participants).toBeGreaterThan(0);
      expect(category.maximum_participants).toBeGreaterThanOrEqual(category.minimum_participants);
      expect(category.uses_dances).toBe(category.dance_selection_mode !== "routine");
    }
    for (const preset of Object.values(defaults.presets)) expect(DISCIPLINES).toContain(preset.discipline_family);
  });

  it("registers the engine keys in the scoring checks it extends", () => {
    for (const key of ENGINE_KEYS) {
      expect(MIGRATION.match(new RegExp(`'${key}'`, "g"))?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it("offers exactly the six first-level choices and the six category types", () => {
    expect(Object.keys(defaults.presets).sort()).toEqual(["ballroom", "country", "custom", "showcase", "studio_competition", "west_coast_swing"]);
    expect(Object.keys(defaults.categoryTypes).sort()).toEqual(["couples", "jack_and_jill", "pro_am", "showcase", "solo", "team"]);
    expect(Object.values(defaults.presets).map((preset) => preset.label)).toEqual(["Studio Competition", "Showcase", "Ballroom", "Country", "West Coast Swing", "Custom"]);
  });

  it("only offers categories, dances and divisions that exist for each preset", () => {
    for (const [key, preset] of Object.entries(defaults.presets) as Array<[PresetKey, (typeof defaults.presets)[PresetKey]]>) {
      for (const type of preset.category_types) expect(defaults.categoryTypes[type], `${key}:${type}`).toBeDefined();
      for (const type of preset.default_categories) expect(preset.category_types).toContain(type);
      const pool = new Set(defaults.dancePools[preset.dance_pool].map((dance) => dance.key));
      for (const dance of preset.default_dances) expect(pool.has(dance), `${key}:${dance}`).toBe(true);
      expect(defaults.divisionPresets[preset.division_preset]).toBeDefined();
      expect(defaults.judging[preset.default_judging]).toBeDefined();
      const usesDances = preset.default_categories.some((type: CategoryTypeKey) => defaults.categoryTypes[type].uses_dances);
      if (usesDances) expect(preset.default_dances.length).toBeGreaterThan(0);
    }
  });

  it("speaks to organizers in Event/Competition/Category/Division/Round/Heat terms, never engine or database terms", () => {
    const visible = strings({
      judging: Object.values(defaults.judging).map((item) => ({ label: item.label, description: item.description })),
      categories: Object.values(defaults.categoryTypes).map((item) => ({ label: item.label, description: item.description, unit: item.price_unit })),
      presets: Object.values(defaults.presets).map((item) => ({ label: item.label, description: item.description })),
      divisions: Object.values(defaults.divisionPresets).map((item) => item.label),
      terminology: defaults.terminology,
    });
    for (const { path, text } of visible) {
      expect(text, path).not.toMatch(/\b(program|contest)s?\b/i);
      expect(text, path).not.toMatch(/ordinal|majority|tally|proficiency|skating|engine|schema/i);
    }
  });

  it("limits stay within what the database enforces", () => {
    expect(defaults.limits).toEqual({ categories: 6, divisions: 60, nameLength: 200, maxPrice: 100000 });
  });
});

describe("Phase 10B migration shape", () => {
  const rollback = readFileSync(join(ROOT, "src/lib/supabase/migrations/rollback/20261108090000_phase10b_competition_profiles_rollback.sql"), "utf8");

  it("adds no parallel simple-mode tables", () => {
    expect(MIGRATION).not.toMatch(/create table[^;]*simple_(competition|division|round|scoring)/i);
    const created = [...MIGRATION.matchAll(/create table (?:if not exists )?public\.(\w+)/gi)].map((match) => match[1]);
    expect(created.sort()).toEqual(["competition_rules_profiles", "event_competition_program_locks"]);
  });

  it("keeps profile versions and publish locks append-only", () => {
    expect(MIGRATION).toContain("Rules profile versions are append-only");
    expect(MIGRATION).toContain("before update or delete on public.competition_rules_profiles");
    expect(MIGRATION).toContain("before truncate on public.competition_rules_profiles");
    expect(MIGRATION).toContain("before update or delete on public.event_competition_program_locks");
    expect(MIGRATION).toContain("before truncate on public.event_competition_program_locks");
    expect(MIGRATION).toContain("revoke all on public.event_competition_program_locks from public, anon, authenticated, service_role;");
    expect(MIGRATION).toContain("grant select on public.event_competition_program_locks to authenticated, service_role;");
  });

  it("makes the three profile columns writable only by the definer functions", () => {
    expect(MIGRATION).toContain("revoke insert, update on public.event_competition_programs from anon, authenticated");
    expect(MIGRATION).toMatch(/attname not in \('rules_profile_key', 'rules_profile_version', 'profile_locked_at'\)/);
  });

  it("publishes by writing the lock row first, then locking the program, atomically", () => {
    const publish = MIGRATION.slice(MIGRATION.indexOf("create or replace function public.publish_competition_program"), MIGRATION.indexOf("create or replace function public.add_competition_division"));
    expect(publish.indexOf("insert into public.event_competition_program_locks")).toBeGreaterThan(-1);
    expect(publish.indexOf("insert into public.event_competition_program_locks")).toBeLessThan(publish.indexOf("update public.event_competition_programs set status = 'configured'"));
    expect(publish).toContain("This competition is not ready to publish");
  });

  it("never opens registration or touches checkout", () => {
    expect(MIGRATION).not.toMatch(/registration_open\s*=\s*true/i);
    expect(MIGRATION).not.toMatch(/event_orders|event_registrations|event_payments|stripe/i);
  });

  it("creates the competition in one canonical, idempotent transaction", () => {
    const create = MIGRATION.slice(MIGRATION.indexOf("create or replace function public.create_simple_competition"), MIGRATION.indexOf("create or replace function public.publish_competition_program"));
    for (const table of ["event_competition_programs", "event_competition_dances", "event_competition_contests", "event_competition_divisions", "event_competition_rounds", "event_competition_division_dances"]) {
      expect(create).toContain(`insert into public.${table}`);
    }
    expect(create).toContain("pg_advisory_xact_lock");
    expect(create).toContain("simple,request_key");
    expect(create).toContain("can_manage_event_competition(target_event_id)");
  });

  it("rolls back without dropping historical configuration", () => {
    expect(rollback).toContain("Phase 10B rollback refused");
    expect(rollback).toContain("phase10b.allow_profile_loss");
    expect(rollback.indexOf("Phase 10B rollback refused")).toBeLessThan(rollback.indexOf("drop function public.remove_competition_division"));
  });
});
