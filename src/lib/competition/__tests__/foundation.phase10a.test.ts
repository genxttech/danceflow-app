import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCompetitionCredentialTargets } from "@/lib/competition/checkin";
import { buildHeatPlan, type HeatPlannerInput } from "@/lib/competition/heatPlanner";
import {
  calculateCompetitionRegistrationQuote,
  type CompetitionRegistrationCatalog,
  type CompetitionRegistrationDraft,
} from "@/lib/competition/registrationPricing";
import { competitionWorkspaceHref, shouldShowCompetitionWorkspaceLink } from "@/lib/competition/workspaceLink";

/**
 * Phase 10A: baseline coverage of the June-2026 Competition OS foundation plus the 10A
 * reconciliation. Database behaviour (public catalog RLS, append-only entry history, the
 * audited heat-lock override, grants, schedule capture, generation -> apply) is proven by
 * sql-tests/test_T_phase10a_competition_foundation.sql.
 */

const ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(ROOT, "src/lib/supabase/migrations");
const MIGRATION = join(MIGRATIONS, "20261107090000_phase10a_competition_foundation_reconcile.sql");
const ROLLBACK = join(MIGRATIONS, "rollback/20261107090000_phase10a_competition_foundation_reconcile_rollback.sql");

function productionSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "__tests__" || name === "migrations" || name === "node_modules" ? [] : productionSourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("competition workspace entry point", () => {
  const base = { eventType: "competition", hasCompetitionProgram: false, isPlatformAdmin: false, studioRole: null, organizerUserRole: null };

  it("shows for competition and showcase events to the roles the workspace accepts", () => {
    expect(shouldShowCompetitionWorkspaceLink({ ...base, studioRole: "studio_owner" })).toBe(true);
    expect(shouldShowCompetitionWorkspaceLink({ ...base, eventType: "showcase", studioRole: "studio_admin" })).toBe(true);
    expect(shouldShowCompetitionWorkspaceLink({ ...base, organizerUserRole: "organizer_staff" })).toBe(true);
    expect(shouldShowCompetitionWorkspaceLink({ ...base, isPlatformAdmin: true })).toBe(true);
  });

  it("shows for any event type once competition configuration exists", () => {
    expect(shouldShowCompetitionWorkspaceLink({ ...base, eventType: "workshop", hasCompetitionProgram: true, studioRole: "studio_owner" })).toBe(true);
  });

  it("stays hidden for ordinary events and for roles the workspace rejects", () => {
    expect(shouldShowCompetitionWorkspaceLink({ ...base, eventType: "workshop", studioRole: "studio_owner" })).toBe(false);
    expect(shouldShowCompetitionWorkspaceLink({ ...base, studioRole: "front_desk" })).toBe(false);
    expect(shouldShowCompetitionWorkspaceLink({ ...base, studioRole: "instructor" })).toBe(false);
    expect(shouldShowCompetitionWorkspaceLink({ ...base, eventType: null })).toBe(false);
  });

  it("links to the existing workspace route", () => {
    expect(competitionWorkspaceHref("abc")).toBe("/app/events/abc/competition");
  });

  it("is wired into the event detail page without redesigning it", () => {
    const page = readFileSync(join(ROOT, "src/app/app/events/[id]/page.tsx"), "utf8");
    expect(page).toContain("shouldShowCompetitionWorkspaceLink({");
    // 10C.1: the same workspace link, or straight into setup when no competition exists yet.
    expect(page).toContain("href={Number(competitionProgramCount ?? 0) > 0 ? competitionWorkspaceHref(typedEvent.id) : competitionSetupHref(typedEvent.id)}");
    expect(page.match(/competitionWorkspaceHref\(/g)?.length).toBe(1);
  });

  it("mirrors the workspace guard roles", () => {
    const actions = readFileSync(join(ROOT, "src/app/app/events/[id]/competition/actions.ts"), "utf8");
    expect(actions).toContain('["studio_owner", "studio_admin"].includes(context.studioRole ?? "")');
    expect(actions).toContain('["organizer_owner", "organizer_admin", "organizer_staff"].includes(organizerUser?.role ?? "")');
  });
});

describe("registration catalog and quote (baseline)", () => {
  const catalog: CompetitionRegistrationCatalog = {
    programs: [{ id: "p1", name: "Ballroom", discipline_family: "ballroom" }],
    contests: [{ id: "c1", program_id: "p1", name: "Pro-Am Smooth", contest_type: "single_dance", entry_format: "pro_am" }],
    divisions: [{ id: "d1", program_id: "p1", contest_id: "c1", name: "Bronze", age_label: null, skill_label: "Bronze", role_label: null }],
    offerings: [
      { id: "o1", program_id: "p1", division_id: "d1", dance_id: "w", entry_fee: 25, currency: "usd", required: false, dance: { dance_key: "smooth_waltz", name: "Waltz", category_label: null } },
      { id: "o2", program_id: "p1", division_id: "d1", dance_id: "t", entry_fee: 25, currency: "usd", required: false, dance: { dance_key: "smooth_tango", name: "Tango", category_label: null } },
    ],
    rules: [{
      id: "r1", program_id: "p1", contest_id: "c1", dance_selection_mode: "individual", pricing_method: "per_dance",
      base_entry_fee: 0, currency: "usd", minimum_dances: 1, maximum_dances: null, minimum_participants: 2, maximum_participants: 2,
      requires_routine_title: false, requires_music: false, requires_duration: false, public_description: null, terminology: {},
    }],
    feeRules: [],
  };
  const draft: CompetitionRegistrationDraft = {
    registrationMode: "individual",
    buyerName: "Pat Dancer",
    buyerEmail: "pat@example.test",
    people: [
      { clientId: "s", firstName: "Pat", lastName: "Dancer", personType: "student" },
      { clientId: "i", firstName: "Lee", lastName: "Pro", personType: "professional" },
    ],
    entries: [{ clientId: "e1", programId: "p1", contestId: "c1", divisionId: "d1", participantIds: ["s", "i"], participantRoles: { s: "student", i: "professional" }, participantDanceRoles: { s: "follower", i: "leader" }, selectedOfferingIds: ["o1"] }],
  };

  it("prices a per-dance entry from the catalog", () => {
    const quote = calculateCompetitionRegistrationQuote(catalog, draft);
    expect(quote.valid).toBe(true);
    expect(quote.total).toBe(25);
    expect(quote.currency).toBe("USD");
  });

  it("rejects entries for options absent from the catalog (what RLS hides cannot be bought)", () => {
    const hidden = calculateCompetitionRegistrationQuote({ ...catalog, divisions: [] }, draft);
    expect(hidden.valid).toBe(false);
    expect(hidden.errors).toContain("One entry references a competition option that is no longer available.");
  });

  it("ignores offerings from another division", () => {
    const quote = calculateCompetitionRegistrationQuote(catalog, {
      ...draft,
      entries: [{ ...draft.entries[0], selectedOfferingIds: ["o1", "other-division-offering"] }],
    });
    expect(quote.effectiveOfferingIdsByEntry.e1).toEqual(["o1"]);
  });

  it("the shared loader keeps the filters the public read policies mirror", () => {
    const loader = readFileSync(join(ROOT, "src/lib/competition/registrationServer.ts"), "utf8");
    expect(loader).toContain('.in("status", ["configured", "active"])');
    expect(loader).toContain('.eq("registration_open", true)');
    expect(loader.match(/\.eq\("event_id", eventId\)/g)?.length).toBe(6);
    expect(loader).toContain("openContestIds.has(item.id)");
    expect(loader).toContain("contestIds.has(item.contest_id)");
  });
});

describe("heat planner (baseline)", () => {
  const start = "2026-11-01T10:00:00.000Z";
  const input = (overrides: Partial<HeatPlannerInput> = {}): HeatPlannerInput => ({
    eventId: "e",
    scheduleVersionId: "v",
    seed: "seed-1",
    contests: [{ id: "c1", name: "Pro-Am", contest_type: "multi_dance" }],
    divisions: [{ id: "d1", contest_id: "c1", name: "Bronze" }],
    rounds: [{ id: "r1", division_id: "d1", name: "Final", round_type: "final", sequence_number: 1, target_advancement_count: null }],
    dances: [{ id: "w", dance_key: "smooth_waltz", name: "Waltz" }],
    offerings: [{ division_id: "d1", dance_id: "w", required: true, sort_order: 1 }],
    entries: ["a", "b", "c", "d", "e"].map((id) => ({ id, division_id: "d1", display_name: id.toUpperCase(), entry_number: null })),
    entryDances: [],
    participants: [],
    blocks: [{ id: "b1", name: "Morning", starts_at: start, ends_at: "2026-11-01T12:00:00.000Z", floor_id: "f1", floor_name_snapshot: "Main", floor_capacity_snapshot: 2 }],
    assignments: [{ block_id: "b1", contest_id: "c1", planned_round_type: null, sort_order: 1 }],
    constraints: [],
    ...overrides,
  });

  it("balances heats to floor capacity and keeps every entry", () => {
    const plan = buildHeatPlan(input());
    const sizes = plan.proposals.map((proposal) => proposal.proposed_state.entry_ids.length);
    expect(sizes).toEqual([2, 2, 1]);
    expect(plan.proposals.flatMap((proposal) => proposal.proposed_state.entry_ids).sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(plan.summary.blocker_count).toBe(0);
  });

  it("is reproducible for a seed", () => {
    const first = buildHeatPlan(input()).proposals.map((proposal) => proposal.proposed_state.entry_ids);
    const second = buildHeatPlan(input()).proposals.map((proposal) => proposal.proposed_state.entry_ids);
    expect(second).toEqual(first);
  });

  it("flags a block without a floor as a blocker", () => {
    const plan = buildHeatPlan(input({ blocks: [{ ...input().blocks[0], floor_id: null }] }));
    expect(plan.conflicts.some((conflict) => conflict.conflict_type === "floor" && conflict.severity === "blocker")).toBe(true);
  });

  it("detects a professional placed in two overlapping heats on different floors", () => {
    const base = input();
    const plan = buildHeatPlan(input({
      contests: [{ id: "c1", name: "Smooth", contest_type: "multi_dance" }, { id: "c2", name: "Rhythm", contest_type: "multi_dance" }],
      divisions: [{ id: "d1", contest_id: "c1", name: "Smooth Bronze" }, { id: "d2", contest_id: "c2", name: "Rhythm Bronze" }],
      rounds: [
        { id: "r1", division_id: "d1", name: "Final", round_type: "final", sequence_number: 1, target_advancement_count: null },
        { id: "r2", division_id: "d2", name: "Final", round_type: "final", sequence_number: 1, target_advancement_count: null },
      ],
      offerings: [{ division_id: "d1", dance_id: "w", required: true, sort_order: 1 }, { division_id: "d2", dance_id: "w", required: true, sort_order: 1 }],
      entries: [{ id: "a", division_id: "d1", display_name: "A", entry_number: null }, { id: "b", division_id: "d2", display_name: "B", entry_number: null }],
      participants: [
        { entry_id: "a", client_id: null, instructor_id: "pro", registration_attendee_id: null, participant_role: "professional", display_name: "Pro" },
        { entry_id: "b", client_id: null, instructor_id: "pro", registration_attendee_id: null, participant_role: "professional", display_name: "Pro" },
      ],
      blocks: [base.blocks[0], { ...base.blocks[0], id: "b2", name: "Ballroom B", floor_id: "f2", floor_name_snapshot: "Second" }],
      assignments: [{ block_id: "b1", contest_id: "c1", planned_round_type: null, sort_order: 1 }, { block_id: "b2", contest_id: "c2", planned_round_type: null, sort_order: 1 }],
    }));
    expect(plan.conflicts.some((conflict) => conflict.conflict_type === "instructor")).toBe(true);
  });
});

describe("competitor numbers (baseline)", () => {
  it("assigns one number per primary participant and one per team entry", () => {
    const targets = buildCompetitionCredentialTargets({
      entries: [{ id: "e1", division_id: "d1", display_name: "Pat & Lee" }, { id: "e2", division_id: "d2", display_name: "Team" }],
      divisions: [{ id: "d1", contest_id: "c1" }, { id: "d2", contest_id: "c2" }],
      rules: [
        { contest_id: "c1", number_assignment_mode: "primary_participant", number_holder_role: "student" },
        { contest_id: "c2", number_assignment_mode: "team", number_holder_role: null },
      ],
      participants: [
        { entry_id: "e1", registration_attendee_id: "att-pro", participant_role: "professional", display_name: "Lee" },
        { entry_id: "e1", registration_attendee_id: "att-student", participant_role: "student", display_name: "Pat" },
      ],
    });
    expect(targets.map((target) => target.key).sort()).toEqual(["entry:e2", "participant:att-student"]);
  });
});

describe("Phase 10A migration shape", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const rollback = readFileSync(ROLLBACK, "utf8");

  it("captures the deployed schedule objects only when absent", () => {
    for (const table of ["versions", "floors", "sessions", "blocks", "block_contests"]) {
      expect(sql).toContain(`create table if not exists public.event_competition_schedule_${table} (`);
    }
    expect(sql).toContain("if to_regprocedure('public.create_competition_schedule_version(uuid, text, uuid)') is null then");
    expect(sql).toContain("if to_regprocedure('public.validate_competition_schedule_item()') is null then");
  });

  it("re-asserts the canonical deployed registration sync body (replay authority)", () => {
    const bridge = readFileSync(join(MIGRATIONS, "20260620_competition_generation_operations_v1.sql"), "utf8");
    const canonical = bridge.slice(bridge.indexOf("create or replace function public.sync_competition_entries_from_registration()"));
    const body = canonical.slice(0, canonical.indexOf("$$;") + 3);
    expect(sql).toContain(body);
    expect(sql.indexOf(body)).toBeLessThan(sql.lastIndexOf("-- Section B -- NEW 10A HARDENING"));
    expect(sql).toContain("<> 'fabd4052257f261e300ccc1f191c4cdb' then");
  });

  it("scopes every public catalog policy to its own published, registrable event", () => {
    expect(sql).toContain("where r.contest_id = event_competition_contests.id\n        and r.event_id = event_competition_contests.event_id");
    expect(sql).toContain("where r.contest_id = event_competition_divisions.contest_id\n        and r.event_id = event_competition_divisions.event_id");
    expect(sql.match(/and e\.status = 'published'\n\s+and e\.visibility in \('public', 'unlisted'\)\n\s+and e\.registration_required/g)?.length).toBe(4);
    expect(sql).not.toMatch(/r\.contest_id = id\b/);
    expect(sql).not.toMatch(/r\.contest_id = contest_id\b/);
  });

  it("makes entry history append-only and trigger-written", () => {
    expect(sql).toContain("drop policy if exists competition_history_insert on public.event_competition_entry_changes;");
    expect(sql).toContain("revoke all on public.event_competition_entry_changes from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant select on public.event_competition_entry_changes to authenticated, service_role;");
    expect(sql).toContain("before update or delete on public.event_competition_entry_changes");
    expect(sql).toContain("before truncate on public.event_competition_entry_changes");
  });

  it("no longer honours the heat override GUC and audits every lock change", () => {
    expect(sql).not.toContain("current_setting('app.competition_heat_override'");
    expect(sql).toContain("create table public.event_competition_heat_lock_events (");
    expect(sql).toContain("and le.transaction_id = txid_current()");
    expect(sql).toContain("and le.from_state = old.lock_state");
    expect(sql).toContain("revoke all on function public.set_competition_heat_lock_state(uuid, text, text) from public, anon;");
    expect(sql).toContain(
      "create trigger protect_competition_heat_initial_lock_state\n  before insert on public.event_competition_heats\n  for each row execute function public.protect_locked_competition_heat();",
    );
    expect(sql).toContain("raise exception 'Heat lock changes require set_competition_heat_lock_state.';");
  });

  it("removes creator-only authority and anonymous execution", () => {
    const helper = sql.slice(sql.indexOf("create or replace function public.can_manage_event_competition"), sql.indexOf("revoke all on function public.can_manage_event_competition"));
    expect(helper).not.toContain("created_by");
    expect(sql).toContain("revoke all on function public.can_manage_event_competition(uuid) from public, anon;");
    expect(sql).toContain("revoke all on function public.default_competition_registration_rule(uuid) from public, anon, authenticated;");
  });

  it("rollback never drops captured existing objects and refuses to discard evidence", () => {
    expect(rollback).not.toMatch(/drop table[^;]*event_competition_schedule/);
    expect(rollback).not.toMatch(/drop function[^;]*create_competition_schedule_version/);
    expect(rollback).not.toMatch(/drop function[^;]*validate_competition_schedule_item/);
    expect(rollback).not.toMatch(/(create|drop)[^;]*function public.sync_competition_entries_from_registration/);
    expect(rollback).toContain("Phase 10A rollback refused");
    expect(rollback).toContain("drop table public.event_competition_heat_lock_events;");
  });
});

describe("no application path bypasses the 10A integrity boundaries", () => {
  const files = productionSourceFiles(join(ROOT, "src"));

  it("nothing writes competition history or lock evidence directly", () => {
    const pattern = /from\(\s*["'](event_competition_entry_changes|event_competition_heat_lock_events)["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    expect(files.filter((file) => pattern.test(readFileSync(file, "utf8")))).toEqual([]);
  }, 30_000);

  it("nothing sets the retired heat override", () => {
    expect(files.filter((file) => readFileSync(file, "utf8").includes("competition_heat_override"))).toEqual([]);
  }, 30_000);
});
