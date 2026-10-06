import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  capacityBelowBookedMessage,
  mapOccurrenceUpdateDbError,
} from "@/lib/schedule/groupClassOccurrenceEdit";

/**
 * GC-S1C-3: focused application-side checks for the database authority backstops. The authority itself is proven in live
 * Postgres (test_T_gcsc3 + the two-session harness); here: safe mapping of the new database codes, and a static review of the
 * migration/rollback so the posture cannot silently drift (trigger-only functions, no grants, no policies, exact rollback).
 */

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const MIGRATION = read("src", "lib", "supabase", "migrations", "20261017090000_gcsc3_group_class_db_authority.sql");
const ROLLBACK = read("src", "lib", "supabase", "migrations", "rollback", "20261017090000_gcsc3_group_class_db_authority_rollback.sql");
const noComments = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("GC-S1C-3 error mapping (no raw database text reaches the owner)", () => {
  it("maps the database capacity floor to the same copy as the app-level check", () => {
    const db = "GCSC3_CAPACITY_BELOW_BOOKED: Maximum students cannot be lower than the 8 students already booked.";
    expect(mapOccurrenceUpdateDbError(db)).toBe(capacityBelowBookedMessage(8));
    expect(mapOccurrenceUpdateDbError("GCSC3_CAPACITY_BELOW_BOOKED: ... the 1 students already booked.")).toBe(capacityBelowBookedMessage(1));
  });

  it("falls back to a fixed sentence when the count cannot be read, and returns null for every other error", () => {
    expect(mapOccurrenceUpdateDbError("GCSC3_CAPACITY_BELOW_BOOKED: unexpected")).toBe(
      "Capacity cannot be set below the number of students already booked.",
    );
    expect(mapOccurrenceUpdateDbError("permission denied for table appointments")).toBeNull();
    expect(mapOccurrenceUpdateDbError(null)).toBeNull();
    expect(mapOccurrenceUpdateDbError(undefined)).toBeNull();
  });

  it("is applied where the occurrence edit surfaces a database failure", () => {
    const actions = read("src", "app", "app", "schedule", "actions.ts");
    expect(actions).toMatch(/mapOccurrenceUpdateDbError\(classUpdateError\.message\) \?\? OCCURRENCE_EDIT_ERROR_COPY\.generic/);
  });

  it("maps a cancelled-class enrollment refusal for staff and for portal self-enrollment, never exposing the code", () => {
    // GC-S1D-1: the staff mapping now lives in the shared roster classifier, which the action delegates to.
    const actions = read("src", "app", "app", "schedule", "actions.ts");
    expect(actions).toMatch(/return classifyRosterEnrollError\(message\);/);
    const classifier = read("src", "lib", "schedule", "groupClassRosterPanel.ts");
    expect(classifier).toMatch(/message\.includes\("GCSC3_CLASS_CANCELLED"\)\) return "class_cancelled";/);
    const page = read("src", "app", "app", "schedule", "enroll-student", "page.tsx");
    expect(page).toMatch(/case "class_cancelled":\s*return "This class has been cancelled and can't take new students\.";/);
    // GC-3.4C: the portal mapping now lives in the shared self-enrollment classifier (also used by the public class flow).
    const portal = read("src", "app", "portal", "[studioSlug]", "schedule", "actions.ts");
    expect(portal).toMatch(/return selfEnrollmentErrorMessage\(classifySelfEnrollmentError\(message\)\);/);
    const shared = read("src", "lib", "schedule", "selfEnrollmentErrors.ts");
    expect(shared).toMatch(/text\.includes\("GCSC3_CLASS_CANCELLED"\)\) return "cancelled";/);
    expect(shared).toMatch(/cancelled: "This class has been cancelled\.",/);
  });
});

describe("GC-S1C-3 migration posture (static)", () => {
  const sql = noComments(MIGRATION);

  it("adds exactly the five triggers and their functions, all trigger-only", () => {
    for (const t of [
      "appointments_03_guard_group_class_cancel_authority",
      "appointments_04_guard_group_class_capacity_floor",
      "appointments_guard_series_occurrence_delete",
      "appointments_gcsc3_cancel_pending_reminders",
    ]) {
      expect(sql).toContain(`create trigger ${t}`);
    }
    expect((sql.match(/create trigger /g) ?? []).length).toBe(4);
    expect((sql.match(/create function /g) ?? []).length).toBe(4);
    expect(sql).toMatch(/create or replace function public\.enforce_group_class_roster_capacity\(\)/);
    for (const fn of [
      "enforce_group_class_capacity_floor",
      "_gcsc3_guard_group_class_cancel_authority",
      "_gcsc3_guard_series_occurrence_delete",
      "_gcsc3_cancel_pending_class_reminders",
      "enforce_group_class_roster_capacity",
    ]) {
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}\\(\\) from public, anon, authenticated, service_role;`));
    }
  });

  it("grants nothing, adds no policy, changes no RLS, and moves no data", () => {
    expect(sql).not.toMatch(/\bgrant\b/i);
    expect(sql).not.toMatch(/create policy|alter policy|drop policy/i);
    expect(sql).not.toMatch(/enable row level security|disable row level security|force row level security/i);
    expect(sql).not.toMatch(/\b(insert into|delete from)\b/i);
    expect(sql).not.toMatch(/\bexecute\s+'|\bexecute format\b/i); // no dynamic SQL
    expect(sql).not.toMatch(/\balter table\b/i);
  });

  it("decides tenant authority on current_user (the definer cancellation RPC and service_role run as non-tenant roles)", () => {
    expect(sql.match(/current_user in \('anon', 'authenticated'\)/g)?.length).toBe(2);
    expect(sql).toMatch(/_gcsc3_guard_group_class_cancel_authority\(\)\s+returns trigger\s+language plpgsql\s+security invoker/);
    expect(sql).toMatch(/_gcsc3_guard_series_occurrence_delete\(\)\s+returns trigger\s+language plpgsql\s+security invoker/);
  });

  it("keeps the class row lock before the status read and the count (lock order preserved)", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.enforce_group_class_roster_capacity"));
    const lock = fn.indexOf("for update;");
    expect(lock).toBeGreaterThan(0);
    expect(fn.indexOf("GCSC3_CLASS_CANCELLED")).toBeGreaterThan(lock);
    expect(fn.indexOf("_group_class_roster_reserved_count")).toBeGreaterThan(lock);
  });

  it("names the cancel-authority trigger so the S1C-2 attendance refusal still fires first", () => {
    expect("appointments_02_guard_cancel_terminal_attendance" < "appointments_03_guard_group_class_cancel_authority").toBe(true);
  });

  it("scopes the reminder invalidation to pending client reminders of a cancelled group class", () => {
    expect(sql).toMatch(/when \(new\.appointment_type = 'group_class'::public\.appointment_type\s+and old\.status is distinct from 'cancelled'::public\.appointment_status\s+and new\.status = 'cancelled'::public\.appointment_status\)\s+execute function public\._gcsc3_cancel_pending_class_reminders/);
    expect(sql).toMatch(/and status = 'pending'\s+and delivery_type in \('student_lesson_reminder_24h', 'student_lesson_reminder_2h'\)/);
  });
});

describe("GC-S1C-3 rollback (static)", () => {
  const sql = noComments(ROLLBACK);

  it("drops every GC-S1C-3 trigger and function and nothing else", () => {
    for (const t of [
      "appointments_gcsc3_cancel_pending_reminders",
      "appointments_guard_series_occurrence_delete",
      "appointments_03_guard_group_class_cancel_authority",
      "appointments_04_guard_group_class_capacity_floor",
    ]) {
      expect(sql).toContain(`drop trigger if exists ${t} on public.appointments;`);
    }
    for (const fn of [
      "_gcsc3_cancel_pending_class_reminders",
      "_gcsc3_guard_series_occurrence_delete",
      "_gcsc3_guard_group_class_cancel_authority",
      "enforce_group_class_capacity_floor",
    ]) {
      expect(sql).toContain(`drop function if exists public.${fn}();`);
    }
    expect((sql.match(/drop trigger/g) ?? []).length).toBe(4);
    expect(sql).not.toMatch(/\bdrop (table|policy|column)\b/i);
  });

  it("restores the exact GC-3.1 roster-capacity body (no cancelled-class branch)", () => {
    const original = noComments(read("src", "lib", "supabase", "migrations", "20260913090800_gc3a_group_class_roster_capacity.sql"));
    const body = (s: string) => s.slice(s.indexOf("declare"), s.indexOf("$$;", s.indexOf("declare"))).replace(/\s+/g, " ").trim();
    const originalFn = original.slice(original.indexOf("create or replace function public.enforce_group_class_roster_capacity"));
    const rollbackFn = sql.slice(sql.indexOf("create or replace function public.enforce_group_class_roster_capacity"));
    expect(body(rollbackFn)).toBe(body(originalFn));
    expect(rollbackFn).not.toContain("GCSC3_CLASS_CANCELLED");
  });
});
