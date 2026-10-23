import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActivationArea, CampaignFact, ComplianceFact, FeeAttention, FeeFacts, MessagingServiceFact, NumberFact, NumberSelectionFact, ProvisioningFacts, SenderFact } from "./journey";

/**
 * TW-4F R2c-I2: the owner-safe provisioning read. It calls `get_studio_sms_provisioning` THROUGH THE SIGNED-IN USER'S OWN client, so the database derives the
 * caller from auth.uid() and decides, from its own role tables, whether this user may see this studio. Nothing here is an authorization layer and no identity
 * is passed in. The answer is coarse enums only (no SIDs, no error detail, no other studio). Parsing is strict and fail-closed: anything unexpected, any
 * database refusal, and a function that is not installed yet all return null, which the journey renders as "not available yet" (never as progress).
 */

type Client = Pick<SupabaseClient, "rpc">;

const CAMPAIGN = new Set<CampaignFact>(["not_started", "preparing", "pending", "approved", "rejected", "attention"]);
const SERVICE = new Set<MessagingServiceFact>(["not_started", "in_progress", "ready", "attention"]);

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Defense in depth: even a mis-built database answer must not put identifiers or links in front of an owner. */
export function scrubSummary(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[A-Za-z0-9]{24,}/g, "(id)")
    .replace(/[A-Za-z]{0,2}[0-9a-fA-F]{12,}/g, "(id)")
    .replace(/https?:\/\/\S+/g, "(link)")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "(email)")
    .replace(/[0-9]{3,}/g, "(number)")
    .replace(/[{}[\]"]/g, "")
    .trim()
    .slice(0, 200);
  return cleaned || null;
}

/** null = not readable / not available (fail closed). */
export function parseOwnerProvisioning(raw: unknown): ProvisioningFacts | null {
  const o = obj(raw);
  if (!o || o.available !== true) return null;
  const campaign = obj(o.campaign);
  const service = obj(o.messaging_service);
  if (!campaign || !service) return null;
  const cStatus = campaign.status as CampaignFact;
  const sStatus = service.status as MessagingServiceFact;
  if (!CAMPAIGN.has(cStatus) || !SERVICE.has(sStatus)) return null;
  return {
    campaign: { status: cStatus, rejectionSummary: cStatus === "rejected" ? scrubSummary(campaign.rejection_summary) : null },
    messagingService: { status: sStatus },
  };
}

export async function getOwnerProvisioning(supabase: Client, studioId: string): Promise<ProvisioningFacts | null> {
  try {
    const { data, error } = await supabase.rpc("get_studio_sms_provisioning", { p_studio_id: studioId });
    if (error) return null;
    return parseOwnerProvisioning(data);
  } catch {
    return null;
  }
}

/**
 * TW-4F J2: the owner's number, sender, compliance, activation-checklist and recurring-fee status from `get_studio_sms_texting_status` (owner of THIS studio only,
 * derived from auth.uid() in the database). Same rules as above: enums only, the number only masked, strict fail-closed parsing. An unexpected key is ignored,
 * an unexpected value drops the whole answer (null), so number, sender and compliance then render "not available yet".
 */
export type OwnerTextingStatus = Required<Pick<ProvisioningFacts, "number" | "sender" | "compliance" | "fees" | "unexpectedResourceReview">> & Pick<ProvisioningFacts, "activation">;

const NUMBER = new Set<NumberFact>(["not_started", "options_available", "selected", "purchasing", "secured", "attention", "failed"]);
const SELECTION = new Set<NumberSelectionFact>(["none", "open", "used", "withdrawn", "expired"]);
const SENDER = new Set<SenderFact>(["not_ready", "verifying", "ready", "failed_verification"]);
const COMPLIANCE = new Set<ComplianceFact>(["pending", "complete", "attention"]);
const AREA = new Set<ActivationArea>(["provider", "number", "sender", "compliance", "billing", "monitoring", "other"]);
const ATTENTION = new Set<FeeAttention>(["none", "authorization_needed", "payment_processing", "funds_needed", "contact_danceflow", "pilot_approval", "danceflow_review"]);
const FEE_KIND = new Set(["texting_service", "phone_number"]);
const PERIOD = new Set(["covered", "not_covered"]);
const MASKED = /^\*{3}-\*{3}-[0-9]{4}$/;

class Invalid extends Error {}
const pick = <T extends string>(set: Set<T>, v: unknown): T => {
  if (typeof v !== "string" || !set.has(v as T)) throw new Invalid();
  return v as T;
};
const bool = (v: unknown): boolean => {
  if (typeof v !== "boolean") throw new Invalid();
  return v;
};
const need = (v: unknown) => {
  const o = obj(v);
  if (!o) throw new Invalid();
  return o;
};

export function parseOwnerTextingStatus(raw: unknown): OwnerTextingStatus | null {
  const o = obj(raw);
  if (!o || o.available !== true || o.version !== 1) return null;
  try {
    const n = need(o.number);
    const status = pick(NUMBER, n.status);
    // the masked number is shown only for a secured number and only in the masked form
    const display = status === "secured" && typeof n.display === "string" && MASKED.test(n.display) ? n.display : null;
    let activation: OwnerTextingStatus["activation"] = null;
    if (o.activation != null) {
      const a = need(o.activation);
      if (!Array.isArray(a.checklist)) throw new Invalid();
      activation = { ready: bool(a.ready), checklist: a.checklist.map((i) => { const x = need(i); return { area: pick(AREA, x.area), ok: bool(x.ok) }; }) };
    }
    const f = need(o.fees);
    if (!Array.isArray(f.items)) throw new Invalid();
    return {
      number: { status, display, selection: pick(SELECTION, n.selection) },
      sender: { status: pick(SENDER, need(o.sender).status) },
      compliance: { status: pick(COMPLIANCE, need(o.compliance).status) },
      activation,
      fees: {
        textingPaused: bool(f.texting_paused),
        cancellationInProgress: bool(f.cancellation_in_progress),
        items: f.items.map((i) => {
          const x = need(i);
          return { kind: pick(FEE_KIND, x.kind) as FeeFacts["items"][number]["kind"], currentPeriod: pick(PERIOD, x.current_period) as "covered" | "not_covered", nextPeriod: pick(PERIOD, x.next_period) as "covered" | "not_covered", attention: pick(ATTENTION, x.attention) };
        }),
      },
      unexpectedResourceReview: bool(o.unexpected_resource_review),
    };
  } catch {
    return null;
  }
}

export async function getOwnerTextingStatus(supabase: Client, studioId: string): Promise<OwnerTextingStatus | null> {
  try {
    const { data, error } = await supabase.rpc("get_studio_sms_texting_status", { p_studio_id: studioId });
    if (error) return null;
    return parseOwnerTextingStatus(data);
  } catch {
    return null;
  }
}

/** The journey's provisioning facts: the campaign read is required (null stays null); the texting status adds the R2b/RFL facts only when it parsed. */
export function mergeOwnerFacts(provisioning: ProvisioningFacts | null, texting: OwnerTextingStatus | null): ProvisioningFacts | null {
  if (!provisioning) return null;
  return texting ? { ...provisioning, ...texting } : provisioning;
}
