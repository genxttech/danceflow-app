import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Competition R2 (CI-D): static shape of 20270103090000_competition_r2_entry_refunds.sql and its rollback. Database
 * behaviour (cascade, ledger, RPCs, exceptions, accounting, rollback refusal) is proven by
 * sql-tests/test_T_competition_r2_entry_refunds.sql on an isolated local Postgres.
 */

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");
const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (name: string) => readFileSync(join(MIGRATIONS, name), "utf8").replace(/\r/g, "");
const sql = read("20270103090000_competition_r2_entry_refunds.sql");
const rollback = read("rollback/20270103090000_competition_r2_entry_refunds_rollback.sql");

function definition(source: string, name: string) {
  const start = source.lastIndexOf(`create or replace function public.${name}(`);
  const rest = source.slice(start);
  const tag = /\bas\s+(\$[a-z_]*\$)/i.exec(rest)!;
  const end = rest.indexOf(tag[1], tag.index + tag[0].length) + tag[1].length;
  return rest.slice(0, end);
}

describe("R2 migration", () => {
  it("pins every redefined function to its reviewed repo body before changing anything", () => {
    for (const pin of [
      "('public.sync_competition_entries_from_registration()', 'fabd4052257f261e300ccc1f191c4cdb')",
      "('public.sync_event_payment_accounting_entry()', '7dc2d16ffb20b1a0fb472711eb86670c')",
      "('public._paywh1_exception_money_state(text)', '5bb0940bb4b22243206a59cc9e5998c9')",
      "('public.resolve_event_order_settlement_exception(uuid,text)', 'd0b3051696238b4867118e21b0ff928f')",
    ]) {
      expect(sql).toContain(pin);
    }
    expect(sql.indexOf("R2 preflight")).toBeLessThan(sql.indexOf("create table public.event_order_refunds"));
    expect(sql).toContain("competition event payments with recorded refunds exist");
  });

  it("registration cascade: withdraws only unplaced/open entries and records E-L / E-C for the rest (Q1)", () => {
    const body = definition(sql, "sync_competition_entries_from_registration");
    expect(body).toContain("h.lock_state in ('locked', 'certified')");
    expect(body).toContain("and (he.status in ('danced', 'disqualified') or (h.status in ('active', 'complete') and he.status <> 'scratched'))");
    // SC1 review P2-4: an entry already scratched is never rewritten to withdrawn by a later refund/cancel.
    expect(body).toContain("and status not in ('withdrawn', 'disqualified', 'complete', 'scratched')");
    expect(body).toContain("where he.entry_id = w.id and he.status in ('scheduled', 'checked_in');");
    expect(body).toContain("_r2_record_refund_exception");
  });

  it("C1: a refunded competition payment keeps gross revenue; refunds are separate dated entries", () => {
    const body = definition(sql, "sync_event_payment_accounting_entry");
    expect(body).toContain("v_refund_amount := case when v_competition then 0 else coalesce(new.refund_amount, 0) end;");
    expect(body).toContain("and not (new.status::text = 'refunded'");
    expect(sql).toContain("'competition_entry_refund', 'Competition Entry Refund', 'refund', 'contra_income', 'debit'");
    const post = definition(sql, "_r2_post_refund_accounting");
    expect(post).toContain("'event_order_refund_reversals'");
    expect(post).toContain("case when p_reversal then 'credit' else 'debit' end");
  });

  it("Q2: exception scopes carry round_id and competitive_effect for the K0 publish precondition", () => {
    expect(sql).toMatch(/create table public\.event_competition_refund_exception_scopes \([\s\S]*round_id uuid null[\s\S]*competitive_effect boolean not null/);
    expect(sql).toContain("on public.event_competition_refund_exception_scopes(round_id) where resolved_at is null and competitive_effect");
  });

  it("the generic PAY-WH-1A resolver refuses competition refund exceptions", () => {
    expect(definition(sql, "resolve_event_order_settlement_exception")).toContain("COMP_REFUND_EXCEPTION_GATED");
  });

  it("observe is the single service-role writer; staff RPCs run as the signed-in user", () => {
    expect(sql).toContain("grant execute on function public.observe_competition_stripe_refund(text, text, text, uuid, bigint, text, text) to service_role;");
    expect(sql).not.toMatch(/grant execute on function public\.observe_competition_stripe_refund[^;]*authenticated/);
    expect(sql).toContain("grant execute on function public.request_competition_order_refund(uuid, uuid, uuid, jsonb, text) to authenticated;");
    expect(definition(sql, "request_competition_order_refund")).toContain("_paywh1_actor_can_manage_event(p_event_id)");
  });

  it("no SQL reaches Stripe or the network", () => {
    expect(sql).not.toMatch(/\bnet\.|http_post|pg_net|stripe\.com/i);
  });

  it("K0 correction is only checked (never written) and only when the K0 table exists", () => {
    const body = definition(sql, "resolve_competition_refund_scope");
    expect(body).toContain("to_regclass('public.event_competition_result_events') is null");
    expect(sql).not.toMatch(/insert into public\.event_competition_result_events/);
  });
});

describe("R2 rollback", () => {
  it("restores the exact prior bodies of every redefined function", () => {
    const sources: Array<[string, string]> = [
      ["sync_competition_entries_from_registration", "20261107090000_phase10a_competition_foundation_reconcile.sql"],
      ["sync_event_payment_accounting_entry", "20261109090000_phase10c_competitor_registration.sql"],
      ["_paywh1_exception_money_state", "20261116094000_paywh1a_remediation.sql"],
      ["resolve_event_order_settlement_exception", "20261116094000_paywh1a_remediation.sql"],
    ];
    for (const [name, file] of sources) {
      expect(definition(rollback, name)).toBe(definition(read(file), name));
    }
  });

  it("refuses while refund evidence exists and only over the R2 bodies", () => {
    expect(rollback).toContain("R2 rollback refused: refund ledger rows exist");
    expect(rollback).toContain("R2 rollback refused: competition refund exceptions exist");
    expect(rollback).toContain("R2 rollback refused: competition_entry_refund accounting entries exist");
    expect(rollback.indexOf("R2 rollback preflight")).toBeLessThan(rollback.indexOf("drop table public.event_order_refunds"));
  });
});

describe("R2 webhook diff is minimal", () => {
  it("the route only imports the two routing helpers", () => {
    const route = readFileSync(join(ROOT, "src", "app", "api", "payments", "webhook", "route.ts"), "utf8");
    expect(route).toContain('import { isCompetitionOrderPaymentIntent, observeCompetitionRefundFromWebhook } from "@/lib/payments/competitionRefunds";');
    expect(route.match(/CI-D R2/g)).toHaveLength(2);
  });
});
