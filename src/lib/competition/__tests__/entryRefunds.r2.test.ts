import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Competition R2 (CI-D): static shape of 20270103090000_competition_r2_entry_refunds.sql. Database behaviour
 * (withdraw + scratch cascade, locked-heat guard, rollback round trip) is proven by
 * sql-tests/test_T_competition_r2_entry_refunds.sql.
 */

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");
const read = (name: string) => readFileSync(join(MIGRATIONS, name), "utf8").replace(/\r/g, "");
const sql = read("20270103090000_competition_r2_entry_refunds.sql");
const rollback = read("rollback/20270103090000_competition_r2_entry_refunds_rollback.sql");

function functionBody(source: string) {
  const start = source.indexOf("create or replace function public.sync_competition_entries_from_registration()");
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf("$$;") + 3);
}

describe("R2 Section 1: registration cascade gap", () => {
  it("replaces the trigger body only over the reviewed 10A definition", () => {
    expect(sql).toContain("is distinct from 'fabd4052257f261e300ccc1f191c4cdb' then");
    expect(sql.indexOf("R2 preflight")).toBeLessThan(sql.indexOf("create or replace function public.sync_competition_entries_from_registration()"));
  });

  it("keeps the locked/certified heat guard and scratches only open placements of the entries it withdraws", () => {
    const body = functionBody(sql);
    expect(body).toContain("h.lock_state in ('locked', 'certified')");
    expect(body).toMatch(/with withdrawn as \(\s*update public\.event_competition_entries/);
    expect(body).toContain("returning id");
    expect(body).toContain("where he.entry_id = w.id and he.status in ('scheduled', 'checked_in');");
    expect(body).not.toContain("'danced'");
  });

  it("writes no refund ledger, refund RPC or Stripe-facing object before the owner decisions", () => {
    expect(sql).not.toMatch(/create table/i);
    expect(sql).not.toMatch(/refund_request|event_order_item_refunds|reserve_competition_order_refund/);
  });

  it("rollback restores the exact 10A body and refuses unless the R2 body is live", () => {
    const tenA = read("20261107090000_phase10a_competition_foundation_reconcile.sql");
    expect(functionBody(rollback)).toBe(functionBody(tenA));
    expect(rollback).toContain("is distinct from '365777014132f1a8302773708a2394e6' then");
    expect(rollback.indexOf("R2 rollback preflight")).toBeLessThan(rollback.indexOf("create or replace function"));
    expect(rollback).toContain("is distinct from 'fabd4052257f261e300ccc1f191c4cdb' then");
  });
});
