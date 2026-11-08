import "server-only";

import { createHash, createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * TW-4F inbound SMS usage recording (owner decisions D1-D4 of 2026-10-20; docs/twilio/TW-4F_Inbound_Pricing_Assessment.md). SERVER ONLY.
 *
 * Called by the inbound route AFTER its signature, tenant and replay checks and AFTER the message's own effects (consent changes), so recording can never
 * gate a received text or a STOP/START/HELP. The database records each text once per message SID for the receiving legal business, charges an ordinary
 * text within the business's negative-balance ceiling (the rest is uncollected) and never charges compliance traffic. A recording failure is logged with
 * a code only; the scheduled reconciler (a separate slice) recovers unrecorded texts from the provider's own records with the same function.
 */

type Client = Pick<SupabaseClient, "rpc">;

export function smsInboundRecordingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.SMS_INBOUND_RECORDING ?? "").trim().toLowerCase() === "on";
}

/**
 * The sender as stored by the reply counters: never the number itself. Keyed with a server secret (SMS_SENDER_HASH_KEY) so stored values cannot be reversed
 * by enumerating phone numbers; without the secret it falls back to a plain prefixed hash (pseudonymous only), which deployments must not rely on.
 */
export function inboundSenderHash(sender: string, env: Record<string, string | undefined> = process.env): string {
  const key = String(env.SMS_SENDER_HASH_KEY ?? "").trim();
  const value = `tw4-inbound:${sender.trim()}`;
  return key.length >= 16 ? createHmac("sha256", key).update(value).digest("hex") : createHash("sha256").update(value).digest("hex");
}

export type InboundReplyKind = "error_unavailable" | "error_invalid" | "error_unrecognized" | "error_unrouted" | "help" | "start";

/** D3: error replies at most one per sender per day. D2: HELP / START confirmations at most five (the opt-in or opt-out itself is never limited). */
export const INBOUND_REPLY_LIMITS: Record<InboundReplyKind, number> = {
  error_unavailable: 1,
  error_invalid: 1,
  error_unrecognized: 1,
  error_unrouted: 1,
  help: 5,
  start: 5,
};

/**
 * May this reply be sent? Counts it in the database. An error reply FAILS CLOSED (no reply when the count cannot be checked: it is a cost, not an
 * obligation); a compliance confirmation FAILS OPEN (it is sent when the count cannot be checked).
 */
export async function inboundReplyAllowed(
  admin: Client | null,
  input: { accountSid: string | null; sender: string; kind: InboundReplyKind },
): Promise<boolean> {
  const compliance = input.kind === "help" || input.kind === "start";
  if (!admin || !input.sender.trim()) return compliance;
  try {
    const { data, error } = await admin.rpc("tw4_inbound_reply_allowed", {
      p_account_sid: input.accountSid,
      p_sender_hash: inboundSenderHash(input.sender),
      p_kind: input.kind,
      p_limit: INBOUND_REPLY_LIMITS[input.kind],
    });
    if (error) return compliance;
    // only a definite "over the limit" stops a compliance confirmation; only a definite "within the limit" lets an error reply go
    return compliance ? data !== false : data === true;
  } catch {
    return compliance;
  }
}

export type InboundRecordOutcome =
  | { recorded: true; replayed: boolean; chargedCents: number; uncollectedCents: number }
  | { recorded: false; reason: "legacy" | "disabled" | "failed"; code?: string };

const SEGMENTS = /^[0-9]{1,2}$/;

/** Twilio's NumSegments / NumMedia; a missing or odd value counts as one segment and no media (the reconciler corrects from evidence later). */
export function parseInboundCounts(numSegments: string | null | undefined, numMedia: string | null | undefined): { segments: number; media: number } {
  const s = String(numSegments ?? "").trim();
  const m = String(numMedia ?? "").trim();
  const segments = SEGMENTS.test(s) ? Math.min(Math.max(Number(s), 1), 20) : 1;
  const media = SEGMENTS.test(m) ? Math.min(Number(m), 10) : 0;
  return { segments, media };
}

export async function recordInboundUsage(
  admin: Client,
  input: {
    studioId: string;
    signerAccountSid: string | null;
    providerSid: string;
    segments: number;
    media: number;
    classification: "ordinary" | "compliance";
    replyBody: string | null;
  },
  env: Record<string, string | undefined> = process.env,
): Promise<InboundRecordOutcome> {
  if (!smsInboundRecordingEnabled(env)) return { recorded: false, reason: "disabled" };
  try {
    const { data, error } = await admin.rpc("tw4_inbound_record", {
      p_studio_id: input.studioId,
      p_signer_account: input.signerAccountSid,
      p_provider_sid: input.providerSid,
      p_segments: input.segments,
      p_media: input.media,
      p_classification: input.classification,
      p_reply_body: input.replyBody,
      p_received_at: null,
      p_source: "webhook",
    });
    if (error) return { recorded: false, reason: "failed", code: String(error.code ?? "unknown") };
    const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    if (d.recorded === false && d.reason === "legacy") return { recorded: false, reason: "legacy" };
    if (d.recorded !== true) return { recorded: false, reason: "failed", code: "unreadable" };
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return { recorded: true, replayed: d.replayed === true, chargedCents: num(d.charged_cents), uncollectedCents: num(d.uncollected_cents) };
  } catch {
    return { recorded: false, reason: "failed", code: "exception" };
  }
}
