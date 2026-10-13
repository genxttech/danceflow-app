import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fulfillTerminalPayment, releaseTerminalEventHold, TerminalEventNotFulfilledError } from "@/lib/payments/terminal-fulfillment";
import { createFakeAdminClient, FakeTable, type Row } from "@/lib/supabase/__tests__/simpleFakeAdminClient";

/**
 * PAY-WH-1A M-2 -- box-office card-reader ticket sales. A successful charge is never treated as proof of fulfilment:
 * the registration is confirmed by the database (confirm_terminal_event_registration, capacity re-checked under lock);
 * when it cannot be fulfilled the sale fails visibly (TerminalEventNotFulfilledError, exception recorded by the
 * database) and no ticket or event payment row is written. A replay of an already-paid sale re-runs the idempotent
 * confirmation. The database side is covered by sql-tests/test_T_paywh1a_remediation.sql.
 */

const STUDIO = "studio-1";
const ACCOUNT = "acct_1TestAccount";

type ConfirmOutcome = { outcome: string; reason?: string; exception_id?: string };

function setup(options: { confirm: ConfirmOutcome; paymentStatus?: string; paymentIntentOnPayment?: string | null; registrationStatus?: string }) {
  const tables: Record<string, FakeTable> = {};
  for (const name of ["payments", "terminal_payment_sessions", "event_registrations", "event_ticket_types", "event_registration_items",
    "event_registration_attendees", "event_payments"]) {
    tables[name] = new FakeTable();
  }
  tables.payments.rows.push({
    id: "pay-1", studio_id: STUDIO, amount: 20, currency: "usd", status: options.paymentStatus ?? "pending", client_package_id: null,
    payment_type: "event_registration", external_reference: "reg-1", commerce_order_id: null,
    stripe_payment_intent_id: options.paymentIntentOnPayment ?? null,
  });
  tables.terminal_payment_sessions.rows.push({
    id: "sess-1", studio_id: STUDIO, payment_id: "pay-1", amount_cents: 2000, currency: "usd", stripe_payment_intent_id: "pi_term", stripe_account_id: ACCOUNT,
  });
  tables.event_registrations.rows.push({
    id: "reg-1", event_id: "event-1", studio_id: STUDIO, client_id: null, ticket_type_id: "tt-1", quantity: 1, order_id: null,
    status: options.registrationStatus ?? "pending", payment_status: options.registrationStatus === "confirmed" ? "paid" : "pending",
    attendee_first_name: "Box", attendee_last_name: "Buyer", attendee_email: "box@example.com", attendee_phone: null,
    total_amount: 20, total_price: 20, currency: "USD",
  });
  tables.event_ticket_types.rows.push({ id: "tt-1", name: "General", attendees_per_ticket: 1 });

  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = createFakeAdminClient(tables) as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown> };
  client.rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (fn === "confirm_terminal_event_registration") {
      if (options.confirm.outcome === "confirmed") {
        Object.assign(tables.event_registrations.rows[0], { status: "confirmed", payment_status: "paid", stripe_payment_intent_id: args.p_payment_intent_id });
      }
      return { data: options.confirm, error: null };
    }
    if (fn === "record_stale_payment_success_conflict") return { data: null, error: null };
    if (fn === "release_terminal_event_registration_hold") return { data: true, error: null };
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  };
  return { tables, rpcCalls, supabase: client as unknown as SupabaseClient };
}

const fulfil = (supabase: SupabaseClient) =>
  fulfillTerminalPayment({ supabase, studioId: STUDIO, paymentId: "pay-1", sessionId: "sess-1", paymentIntentId: "pi_term" });

describe("box-office terminal ticket sale fulfilment", () => {
  it("confirms through the database, then issues the ticket and the event payment row (without the non-existent event_id column)", async () => {
    const { tables, rpcCalls, supabase } = setup({ confirm: { outcome: "confirmed" } });
    expect(await fulfil(supabase)).toBe(true);
    expect(rpcCalls.find((call) => call.fn === "confirm_terminal_event_registration")?.args).toEqual({
      p_studio_id: STUDIO, p_payment_id: "pay-1", p_registration_id: "reg-1", p_payment_intent_id: "pi_term",
      p_amount_cents: 2000, p_currency: "usd", p_stripe_account: ACCOUNT,
    });
    expect(tables.event_payments.rows).toHaveLength(1);
    const payment = tables.event_payments.rows[0] as Row;
    expect(payment).toMatchObject({ registration_id: "reg-1", status: "paid", source: "terminal_ticket_sale", stripe_payment_intent_id: "pi_term", stripe_account_id: ACCOUNT });
    expect(payment).not.toHaveProperty("event_id");
    expect(tables.event_registration_attendees.rows).toHaveLength(1);
    expect(tables.payments.rows[0]).toMatchObject({ status: "paid" });
  });

  it("a charge that cannot be fulfilled fails visibly: no ticket, no event payment row, the exception id is surfaced", async () => {
    const { tables, supabase } = setup({ confirm: { outcome: "not_fulfilled", reason: "capacity_unavailable", exception_id: "exc-1" } });
    const error = await fulfil(supabase).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TerminalEventNotFulfilledError);
    expect(error).toMatchObject({ reason: "capacity_unavailable", exceptionId: "exc-1" });
    expect(tables.event_payments.rows).toHaveLength(0);
    expect(tables.event_registration_attendees.rows).toHaveLength(0);
    expect(tables.event_registrations.rows[0]).toMatchObject({ status: "pending", payment_status: "pending" });
    // the charge itself is recorded honestly (it did happen); the exception is what staff act on
    expect(tables.payments.rows[0]).toMatchObject({ status: "paid" });
  });

  it("a replayed fulfilment of an already-paid sale re-runs the idempotent confirmation and never duplicates rows", async () => {
    const { tables, rpcCalls, supabase } = setup({ confirm: { outcome: "already_confirmed" }, paymentStatus: "paid", paymentIntentOnPayment: "pi_term", registrationStatus: "confirmed" });
    tables.event_payments.rows.push({ id: "ep-1", registration_id: "reg-1", stripe_payment_intent_id: "pi_term", amount: 20, status: "paid", stripe_account_id: ACCOUNT });
    tables.event_registration_attendees.rows.push({ id: "att-1", registration_id: "reg-1", sort_order: 1, ticket_code: "DF-1", ticket_token: "t", ticket_issued_at: "2026-10-12" });
    tables.event_registration_items.rows.push({ id: "item-1", registration_id: "reg-1" });
    expect(await fulfil(supabase)).toBe(false);
    expect(rpcCalls.map((call) => call.fn)).toEqual(["record_stale_payment_success_conflict", "confirm_terminal_event_registration"]);
    expect(tables.event_payments.rows).toHaveLength(1);
    expect(tables.event_registration_attendees.rows).toHaveLength(1);
  });

  it("a crash between 'payment paid' and 'tickets issued' is repaired on replay (tickets issued then)", async () => {
    const { tables, supabase } = setup({ confirm: { outcome: "confirmed" }, paymentStatus: "paid", paymentIntentOnPayment: "pi_term" });
    expect(await fulfil(supabase)).toBe(false);
    expect(tables.event_registrations.rows[0]).toMatchObject({ status: "confirmed", payment_status: "paid" });
    expect(tables.event_payments.rows).toHaveLength(1);
    expect(tables.event_registration_attendees.rows).toHaveLength(1);
  });

  it("a paid payment row with ANOTHER PaymentIntent is a conflict, never a fulfilment", async () => {
    const { tables, rpcCalls, supabase } = setup({ confirm: { outcome: "confirmed" }, paymentStatus: "paid", paymentIntentOnPayment: "pi_other" });
    expect(await fulfil(supabase)).toBe(false);
    expect(rpcCalls.map((call) => call.fn)).toEqual(["record_stale_payment_success_conflict"]);
    expect(tables.event_payments.rows).toHaveLength(0);
  });

  it("a cancelled reader payment releases the sale's terminal hold (and only for event ticket sales)", async () => {
    const { rpcCalls, supabase, tables } = setup({ confirm: { outcome: "confirmed" }, paymentStatus: "failed" });
    await releaseTerminalEventHold({ supabase, studioId: STUDIO, paymentId: "pay-1" });
    expect(rpcCalls).toEqual([{ fn: "release_terminal_event_registration_hold", args: { p_studio_id: STUDIO, p_registration_id: "reg-1" } }]);
    tables.payments.rows[0].payment_type = "package";
    rpcCalls.length = 0;
    await releaseTerminalEventHold({ supabase, studioId: STUDIO, paymentId: "pay-1" });
    expect(rpcCalls).toEqual([]);
  });
});
