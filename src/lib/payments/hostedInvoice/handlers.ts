import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { d24Enabled, isD24EventType, kindOf, normalizeD24Object, type D24EventInput } from "./normalize";

/**
 * D24 M1: record hosted-invoice facts (invoice void / uncollectible, invoice payments, credit notes) from a verified,
 * claimed Stripe event. Everything that decides ownership, order and idempotency lives in the database function
 * d24_apply_event, which re-checks the PAY-WH-1 claim, validates the account scope against the trusted registry and
 * stores the facts in one transaction. This module only sanitizes input and maps the outcome.
 *
 * No settlement, ledger, refund, credit or registration side effect exists here. Dark unless D24_HOSTED_INVOICE_EVENTS=on.
 */

export type HostedInvoiceOutcome =
  | "d24_disabled"
  | "d24_malformed_ignored"
  | "d24_not_applicable_ignored"
  | "d24_applied_matched"
  | "d24_applied_unmatched"
  | "d24_replayed";

export type HostedInvoiceClaim = { eventId: string; owner: string };

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export async function handleHostedInvoiceEvent(input: {
  supabase: Pick<SupabaseClient, "rpc">;
  event: D24EventInput;
  claim: HostedInvoiceClaim;
  env?: Record<string, string | undefined>;
}): Promise<{ outcome: HostedInvoiceOutcome }> {
  const { supabase, event, claim } = input;
  if (!d24Enabled(input.env)) return { outcome: "d24_disabled" };
  if (!isD24EventType(event.type)) return { outcome: "d24_malformed_ignored" };

  // A test-mode event reaching a deployment with a live key (for example Connect test traffic) is never recorded as a fact.
  const key = (input.env ?? process.env).STRIPE_SECRET_KEY?.trim() ?? "";
  if (event.livemode !== true && (key.startsWith("sk_live_") || key.startsWith("rk_live_"))) return { outcome: "d24_not_applicable_ignored" };

  const normalized = normalizeD24Object(event.type, event.data.object);
  if (!normalized.ok && normalized.reason === "subscription_invoice") return { outcome: "d24_not_applicable_ignored" };
  if (!normalized.ok) {
    // A structurally impossible object can never succeed on retry; acknowledge it and keep only the reason code.
    console.error("d24_event_malformed", { eventId: event.id, type: event.type, reason: normalized.reason });
    return { outcome: "d24_malformed_ignored" };
  }
  if (claim.eventId !== event.id) throw new Error("d24: claim does not belong to this event");

  // Hash of what is stored (not the raw body): a replay of the same event id must reproduce it exactly.
  const payloadHash = createHash("sha256").update(stable({ type: event.type, account: event.account ?? null, kind: kindOf(event.type), object: normalized.value.object })).digest("hex");

  const { data, error } = await supabase.rpc("d24_apply_event", {
    p_provider_event_id: event.id,
    p_owner: claim.owner,
    p_event_type: event.type,
    p_event_created: event.created,
    p_account: event.account ?? null,
    p_livemode: event.livemode === true,
    p_payload_hash: payloadHash,
    p_kind: normalized.value.kind,
    p_object: normalized.value.object,
  });
  // A failure (including a lost claim) is thrown so the route finalizes the event as failed and Stripe retries it.
  if (error) throw new Error(`d24_apply_event failed: ${error.code ?? "error"}`);

  const result = (data ?? {}) as { outcome?: string; matched?: boolean };
  if (result.outcome === "replayed") return { outcome: "d24_replayed" };
  if (result.outcome === "applied") return { outcome: result.matched ? "d24_applied_matched" : "d24_applied_unmatched" };
  throw new Error("d24_apply_event returned an unexpected result");
}
