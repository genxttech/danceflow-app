import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCompetitionRegistrationError } from "../registrationCheckout";

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");
const forward = readFileSync(join(MIGRATIONS, "20270301120000_competition_s5_participant_age_guard.sql"), "utf8");
const rollback = readFileSync(join(MIGRATIONS, "rollback", "20270301120000_competition_s5_participant_age_guard_rollback.sql"), "utf8");
const original = readFileSync(join(MIGRATIONS, "20261109090000_phase10c_competitor_registration.sql"), "utf8");

function functionBlock(sql: string, header: string) {
  const start = sql.indexOf(header);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf("\n$$;", start);
  return sql.slice(start, end + 4);
}

describe("S5 database participant age guard (static checks; the executing suite is sql-tests/test_T_competition_s5_participant_age_guard.sql)", () => {
  it("maps the database refusal to a clean 422 with no date or age", () => {
    const minor = classifyCompetitionRegistrationError("COMP_S5_AGE_BLOCKED: participant not cleared (blocked_under_18)");
    expect(minor).toMatchObject({ code: "minors_not_permitted", status: 422 });
    const unknown = classifyCompetitionRegistrationError("COMP_S5_AGE_BLOCKED: participant not cleared (unknown_age)");
    expect(unknown).toMatchObject({ code: "age_not_established", status: 422 });
    expect(minor.message + unknown.message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(classifyCompetitionRegistrationError("something else")).toMatchObject({ code: "checkout_failed", status: 500 });
  });

  it("uses ONE enforcement point on participant rows plus a competitor date-of-birth guard, and no bypass setting", () => {
    expect(forward).toContain("event_competition_entry_participants_s5_age_guard");
    expect(forward).toContain("before insert or update\n  on public.event_competition_entry_participants");
    expect(forward).toContain("enable always trigger event_competition_entry_participants_s5_age_guard");
    expect(forward).toContain("enable always trigger event_competition_competitors_s5_dob_guard");
    expect(forward).toContain("for share");
    expect(forward).toContain("event_competition_competitors_s5_dob_guard");
    expect(forward).not.toMatch(/current_setting\(/);
    expect(forward).not.toMatch(/app\.comp10c_backfill/);
  });

  it("fails closed and raises reason codes only", () => {
    const raises = [...forward.matchAll(/raise exception '([^']+)'/g)].map((m) => m[1]);
    const s5 = raises.filter((text) => text.startsWith("COMP_S5_AGE_BLOCKED"));
    expect(s5.length).toBe(2);
    for (const text of s5) expect(text).toMatch(/\(%\)$/);
    const guard = functionBlock(forward, "create or replace function public._comp_s5_participant_age_guard()");
    expect(guard).toContain("v_code <> 'allowed'");
    expect(guard).not.toMatch(/date_of_birth/);
    const fromDob = functionBlock(forward, "create or replace function public._comp_age_clearance_from_dob");
    expect(fromDob).toContain("p_dob is null");
    expect(fromDob).toContain("'unknown_age'");
  });

  it("new functions are not executable by public, anon or authenticated and pin search_path", () => {
    for (const name of ["_comp_age_clearance_from_dob(date, timestamptz)", "_comp_participant_age_clearance(uuid)", "_comp_s5_participant_age_guard()", "_comp_s5_competitor_dob_guard()"]) {
      expect(forward).toContain(`revoke all on function public.${name} from public, anon, authenticated;`);
    }
    expect(forward.match(/set search_path = pg_catalog, public, pg_temp/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("does not modify, delete or backfill existing rows (the only DML is inside the resolve function)", () => {
    const outsideResolve = forward.replace(/create or replace function public\._comp10c_resolve_competitor[\s\S]*?\n\$\$;/, "");
    expect(outsideResolve).not.toMatch(/\bdelete\s+from\b/i);
    expect(outsideResolve).not.toMatch(/\bupdate\s+public\./i);
    expect(outsideResolve).not.toMatch(/\binsert\s+into\b/i);
  });

  it("has no CRLF in either file", () => {
    expect(forward).not.toContain("\r");
    expect(rollback).not.toContain("\r");
  });

  it("the rollback restores the previous _comp10c_resolve_competitor body byte for byte and drops every S5 object", () => {
    const previous = functionBlock(original, "create or replace function public._comp10c_resolve_competitor(");
    expect(rollback).toContain(previous);
    for (const drop of [
      "drop trigger if exists event_competition_entry_participants_s5_age_guard",
      "drop trigger if exists event_competition_competitors_s5_dob_guard",
      "drop function if exists public._comp_s5_participant_age_guard();",
      "drop function if exists public._comp_s5_competitor_dob_guard();",
      "drop function if exists public._comp_participant_age_clearance(uuid);",
      "drop function if exists public._comp_age_clearance_from_dob(date, timestamptz);",
    ]) expect(rollback).toContain(drop);
    expect(forward).not.toBe(previous);
  });

  it("the forward resolve body differs from the original only by the date-of-birth completion", () => {
    const previous = functionBlock(original, "create or replace function public._comp10c_resolve_competitor(");
    const next = functionBlock(forward, "create or replace function public._comp10c_resolve_competitor(");
    const strip = (text: string) => text.replace(/\n\s*-- S5:[^\n]*/g, "").replace(/,\n\s*date_of_birth = coalesce\(date_of_birth, p_date_of_birth\)/, "").replace(/\n\s*or \(date_of_birth is null and p_date_of_birth is not null\)/, "");
    expect(strip(next)).toBe(previous);
  });
});
