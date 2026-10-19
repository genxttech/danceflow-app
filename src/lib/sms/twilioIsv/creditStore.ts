import type { SupabaseClient } from "@supabase/supabase-js";
import { RunnerStoreError, type SpendKind } from "./store";

/**
 * TW-4F-3b-0: persistence for the prepaid SMS credit ledger (see migration 20261122090000). Service-role `tw4_credit_*` / `tw4_price_set` functions only;
 * the tables have no API privileges. Errors carry the SQLSTATE, never the database message text.
 *
 * Money is integer US cents. Credit becomes spendable ONLY through `settleTopup` (a settled payment); nothing here charges a card, stores a payment
 * method or tops up automatically.
 */

export type CreditVerification = { balance_cents: number; reserved_cents: number; ledger_balance_cents: number; ledger_reserved_cents: number; open_reservations_cents: number; ok: boolean };

export interface CreditStore {
  setPrice(kind: SpendKind, customerCents: number, providerCents: number, description: string, actorId: string): Promise<string>;
  topupPending(studioId: string, providerRef: string, amountCents: number): Promise<void>;
  /** The Stripe webhook calls this once a payment is SETTLED. Replays (same provider ref) credit nothing again. */
  settleTopup(studioId: string, providerRef: string, amountCents: number, eventId: string): Promise<{ replayed: boolean }>;
  reverseTopup(providerRef: string, amountCents: number, eventId: string, reason: string): Promise<{ replayed: boolean }>;
  adjust(studioId: string, amountCents: number, key: string, note: string, actorId: string): Promise<{ replayed: boolean }>;
  setHold(studioId: string, hold: boolean, reason: string, actorId: string): Promise<void>;
  setThreshold(studioId: string, cents: number, actorId: string): Promise<void>;
  debitUsage(studioId: string, cents: number, key: string, ref: string): Promise<{ replayed: boolean }>;
  /** Credits back part of a recorded usage charge (by its key); never more than that charge in total. Replays by `key` change nothing. */
  refundUsage(studioId: string, cents: number, key: string, originalUsageKey: string): Promise<{ replayed: boolean }>;
  topupFailed(providerRef: string, eventId: string): Promise<void>;
  /** Platform admin: capture or release a reservation no run can settle any more (another generation, a cancelled setup, a crash). */
  resolveReservation(reservationId: string, outcome: "captured" | "released", note: string, actorId: string): Promise<{ replayed: boolean }>;
  openReservations(studioId: string, actorId: string): Promise<{ id: string; kind: string; amount_cents: number; created_at: string }[]>;
  /** Platform admin: withdraw an authorization that was never used. */
  withdrawAuthorization(spendEventId: string, note: string, actorId: string): Promise<void>;
  recordProviderCharge(studioId: string, kind: SpendKind, providerRef: string, providerCostCents: number, actorId: string): Promise<{ status: "matched" | "variance"; replayed: boolean }>;
  verify(studioId: string): Promise<CreditVerification>;
}

type Client = Pick<SupabaseClient, "rpc">;

export class SupabaseCreditStore implements CreditStore {
  constructor(private readonly admin: Client) {}

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = (await this.admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
    if (error) throw new RunnerStoreError(String(error.code ?? "unknown"));
    return data as T;
  }

  async setPrice(kind: SpendKind, customerCents: number, providerCents: number, description: string, actorId: string) {
    const row = await this.call<{ price_id: string }>("tw4_price_set", { p_kind: kind, p_customer_cents: customerCents, p_provider_cents: providerCents, p_description: description, p_actor: actorId });
    return row.price_id;
  }
  async topupPending(studioId: string, providerRef: string, amountCents: number) {
    await this.call("tw4_credit_topup_pending", { p_studio_id: studioId, p_provider_ref: providerRef, p_amount_cents: amountCents });
  }
  async settleTopup(studioId: string, providerRef: string, amountCents: number, eventId: string) {
    const row = await this.call<{ replayed: boolean }>("tw4_credit_settle_topup", { p_studio_id: studioId, p_provider_ref: providerRef, p_amount_cents: amountCents, p_event_id: eventId });
    return { replayed: Boolean(row?.replayed) };
  }
  async reverseTopup(providerRef: string, amountCents: number, eventId: string, reason: string) {
    const row = await this.call<{ replayed: boolean }>("tw4_credit_reverse_topup", { p_provider_ref: providerRef, p_amount_cents: amountCents, p_event_id: eventId, p_reason: reason });
    return { replayed: Boolean(row?.replayed) };
  }
  async adjust(studioId: string, amountCents: number, key: string, note: string, actorId: string) {
    const row = await this.call<{ replayed: boolean }>("tw4_credit_adjust", { p_studio_id: studioId, p_amount_cents: amountCents, p_key: key, p_note: note, p_actor: actorId });
    return { replayed: Boolean(row?.replayed) };
  }
  async setHold(studioId: string, hold: boolean, reason: string, actorId: string) {
    await this.call("tw4_credit_set_hold", { p_studio_id: studioId, p_hold: hold, p_reason: reason, p_actor: actorId });
  }
  async setThreshold(studioId: string, cents: number, actorId: string) {
    await this.call("tw4_credit_set_threshold", { p_studio_id: studioId, p_cents: cents, p_actor: actorId });
  }
  async debitUsage(studioId: string, cents: number, key: string, ref: string) {
    const row = await this.call<{ replayed: boolean }>("tw4_credit_debit_usage", { p_studio_id: studioId, p_cents: cents, p_key: key, p_ref: ref });
    return { replayed: Boolean(row?.replayed) };
  }
  async refundUsage(studioId: string, cents: number, key: string, originalUsageKey: string) {
    const row = await this.call<{ replayed: boolean }>("tw4_credit_refund_usage", { p_studio_id: studioId, p_cents: cents, p_key: key, p_original_key: originalUsageKey });
    return { replayed: Boolean(row?.replayed) };
  }
  async topupFailed(providerRef: string, eventId: string) {
    await this.call("tw4_credit_topup_failed", { p_provider_ref: providerRef, p_event_id: eventId });
  }
  async resolveReservation(reservationId: string, outcome: "captured" | "released", note: string, actorId: string) {
    const row = await this.call<{ replayed: boolean }>("tw4_credit_resolve_reservation", { p_reservation_id: reservationId, p_outcome: outcome, p_actor: actorId, p_note: note });
    return { replayed: Boolean(row?.replayed) };
  }
  async openReservations(studioId: string, actorId: string) {
    return this.call<{ id: string; kind: string; amount_cents: number; created_at: string }[]>("tw4_credit_open_reservations", { p_studio_id: studioId, p_actor: actorId });
  }
  async withdrawAuthorization(spendEventId: string, note: string, actorId: string) {
    await this.call("tw4_spend_withdraw", { p_spend_event_id: spendEventId, p_actor: actorId, p_note: note });
  }
  async recordProviderCharge(studioId: string, kind: SpendKind, providerRef: string, providerCostCents: number, actorId: string) {
    const row = await this.call<{ status: "matched" | "variance"; replayed: boolean }>("tw4_credit_record_provider_charge", {
      p_studio_id: studioId, p_kind: kind, p_provider_ref: providerRef, p_provider_cost_cents: providerCostCents, p_actor: actorId,
    });
    return { status: row.status, replayed: Boolean(row.replayed) };
  }
  verify(studioId: string) {
    return this.call<CreditVerification>("tw4_credit_verify", { p_studio_id: studioId });
  }
}
