import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOwnershipFakeSupabase } from "./ownershipFakes";
import {
  guardFunctionBody,
  paydc2dRowGuard,
  protectedColumnsFromMigration,
  readPaydc2dMigration,
} from "./identityWriteLockModel";

/** PAY-DC-2D: identity write-lock migration source guards and lock semantics. */

const sql = readPaydc2dMigration().replace(/--[^\n]*/g, "");
const rollback = readFileSync(
  join(
    process.cwd(),
    "src",
    "lib",
    "supabase",
    "migrations",
    "rollback",
    "20260929090000_paydc2d_payment_identity_write_lock_rollback.sql",
  ),
  "utf8",
).replace(/--[^\n]*/g, "");

const EXPECTED_PROTECTED: Record<string, string[]> = {
  payments: [
    "stripe_account_id",
    "stripe_payment_intent_id",
    "stripe_charge_id",
    "stripe_checkout_session_id",
    "stripe_invoice_id",
    "stripe_refund_id",
    "stripe_balance_transaction_id",
  ],
  event_payments: [
    "stripe_account_id",
    "stripe_payment_intent_id",
    "stripe_charge_id",
    "stripe_checkout_session_id",
    "stripe_refund_id",
  ],
  event_registrations: ["stripe_payment_intent_id", "stripe_checkout_session_id"],
  studios: ["stripe_connected_account_id"],
};

const FUNCTIONS: Record<string, string> = {
  payments: "_guard_payments_stripe_identity",
  event_payments: "_guard_event_payments_stripe_identity",
  event_registrations: "_guard_event_registrations_stripe_identity",
  studios: "_guard_studios_connected_account",
};

const DROPPED_POLICIES = [
  ["stripe_subscriptions_staff_insert", "stripe_subscriptions"],
  ["stripe_subscriptions_staff_update", "stripe_subscriptions"],
  ["stripe_customers_staff_insert", "stripe_customers"],
  ["stripe_customers_staff_update", "stripe_customers"],
  ["event_registrations_public_insert", "event_registrations"],
  ["event_registration_attendees_public_insert", "event_registration_attendees"],
];

describe("migration source", () => {
  it("protects exactly the approved columns on INSERT and UPDATE (incl. clearing)", () => {
    expect(protectedColumnsFromMigration(sql)).toEqual(EXPECTED_PROTECTED);

    for (const [table, fn] of Object.entries(FUNCTIONS)) {
      const body = guardFunctionBody(sql, fn);
      expect(body).toContain("if current_user in ('anon', 'authenticated') then");
      const updateClause = body.slice(body.indexOf("elsif"));
      for (const column of EXPECTED_PROTECTED[table]) {
        // "is distinct from" covers NULL->value, value->other and value->NULL.
        expect(updateClause).toContain(`new.${column} is distinct from old.${column}`);
      }
      expect(body).toContain("using errcode = '42501'");
    }
  });

  it("uses the canonical SECURITY INVOKER current_user guard and revokes execute", () => {
    for (const fn of Object.values(FUNCTIONS)) {
      const start = sql.indexOf(`create or replace function public.${fn}()`);
      const header = sql.slice(start, sql.indexOf("$$", start));
      expect(header).toContain("security invoker");
      expect(header).toContain("set search_path = 'public'");
      expect(sql).toContain(`revoke all on function public.${fn}()\n  from public, anon, authenticated, service_role;`);
    }
    expect(sql).not.toMatch(/auth\.role\(\)/);
  });

  it("fires before insert and update on each guarded table", () => {
    expect(sql).toMatch(/create trigger trg_payments_stripe_identity_guard\s+before insert or update on public\.payments/);
    expect(sql).toMatch(/create trigger trg_event_payments_stripe_identity_guard\s+before insert or update on public\.event_payments/);
    expect(sql).toMatch(
      /create trigger trg_event_registrations_stripe_identity_guard\s+before insert or update on public\.event_registrations/,
    );
    expect(sql).toMatch(
      /create trigger guard_studios_connected_account\s+before insert or update of stripe_connected_account_id on public\.studios/,
    );
  });

  it("drops exactly the approved write policies and keeps read policies", () => {
    for (const [policy, table] of DROPPED_POLICIES) {
      expect(sql).toContain(`drop policy if exists ${policy} on public.${table};`);
    }
    expect([...sql.matchAll(/drop policy/g)]).toHaveLength(DROPPED_POLICIES.length);
    expect(sql).not.toMatch(/_select on public\./);
    expect(sql).not.toMatch(/create policy/);
  });

  it("changes no data and leaves PAY-DC-2A/2B/2C objects alone", () => {
    expect(sql).not.toMatch(/insert into|update public\.|delete from/);
    expect(sql).not.toContain("guard_stripe_account_id_immutable");
    expect(sql).not.toContain("payment_disputes");
  });
});

describe("rollback source", () => {
  it("drops only the 2D triggers/functions and recreates exactly the removed policies", () => {
    for (const fn of Object.values(FUNCTIONS)) {
      expect(rollback).toContain(`drop function if exists public.${fn}();`);
    }
    for (const [policy, table] of DROPPED_POLICIES) {
      expect(rollback).toMatch(new RegExp(`create policy ${policy}\\s+on public\\.${table}`));
    }
    expect([...rollback.matchAll(/create policy/g)]).toHaveLength(DROPPED_POLICIES.length);
    expect(rollback).not.toContain("guard_stripe_account_id_immutable");
    expect(rollback).not.toContain("payment_disputes");
    expect(rollback).not.toMatch(/insert into|update public\.|delete from/);
  });
});

describe("lock semantics (model derived from the migration)", () => {
  function lockedDb() {
    return createOwnershipFakeSupabase(
      {
        payments: [{ id: "pay-legacy", studio_id: "studio-A", status: "paid", stripe_account_id: null, stripe_payment_intent_id: "pi_A" }],
        event_payments: [{ id: "ep-1", registration_id: "reg-1", status: "paid", stripe_account_id: "acct_A" }],
      },
      { rowGuard: paydc2dRowGuard() },
    );
  }

  it("tenant INSERT with a forged account/PaymentIntent is rejected", async () => {
    const db = lockedDb();
    const { error } = await db.client.from("payments").insert({
      studio_id: "studio-A",
      status: "paid",
      stripe_payment_intent_id: "pi_B",
      stripe_account_id: "acct_B",
    });
    expect(error?.code).toBe("42501");
    expect(db.rows("payments")).toHaveLength(1);
  });

  it.each([
    ["NULL -> acct", "payments", "pay-legacy", { stripe_account_id: "acct_B" }],
    ["PaymentIntent rewrite", "payments", "pay-legacy", { stripe_payment_intent_id: "pi_B" }],
    ["charge set", "payments", "pay-legacy", { stripe_charge_id: "ch_B" }],
    ["session set", "payments", "pay-legacy", { stripe_checkout_session_id: "cs_B" }],
    ["clearing a value", "event_payments", "ep-1", { stripe_account_id: null }],
  ])("tenant UPDATE %s is rejected", async (_name, table, id, patch) => {
    const db = lockedDb();
    const { error } = await db.client.from(table).update(patch).eq("id", id);
    expect(error?.code).toBe("42501");
  });

  it("status/accounting-only tenant updates are allowed; unchanged identity does not block", async () => {
    const db = lockedDb();
    const statusOnly = await db.client.from("payments").update({ status: "refunded", refund_amount: 10 }).eq("id", "pay-legacy");
    expect(statusOnly.error).toBeNull();
    const sameValue = await db.client
      .from("event_payments")
      .update({ status: "refunded", stripe_account_id: "acct_A" })
      .eq("id", "ep-1");
    expect(sameValue.error).toBeNull();
  });

  it("trusted server (service-role) writers pass", async () => {
    const db = lockedDb();
    const { error } = await db.adminClient.from("payments").update({ stripe_account_id: "acct_A" }).eq("id", "pay-legacy");
    expect(error).toBeNull();
    expect(db.rows("payments")[0].stripe_account_id).toBe("acct_A");
  });

  it("tenant writes to stripe_subscriptions / stripe_customers are denied", async () => {
    const db = createOwnershipFakeSupabase({ stripe_subscriptions: [] }, { rowGuard: paydc2dRowGuard() });
    const { error } = await db.client.from("stripe_subscriptions").insert({
      studio_id: "studio-A",
      stripe_subscription_id: "sub_B",
      stripe_account_id: "acct_B",
    });
    expect(error?.code).toBe("42501");
  });
});
