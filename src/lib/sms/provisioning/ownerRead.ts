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

/**
 * TW-4F J3: the owner's number choice from `get_studio_sms_number_offers` (owner of THIS studio only, derived from auth.uid() in the database). The offered numbers
 * are shown in full because they are what the owner chooses between; nothing else identifying is returned. Same strict, fail-closed parsing as above.
 */
export type OwnerNumberOffers = {
  stepOpen: boolean;
  /** The published customer price per month; null = not published, nothing can be approved. */
  monthlyCents: number | null;
  fundingMode: "credit_recurring" | "pilot";
  pilotCeilingReached: boolean;
  offer: { offerId: string; expiresAt: string; numbers: { e164: string; locality: string | null; region: string | null }[] } | null;
  approval: { selectionId: string; e164: string; status: "open" | "expired"; expiresAt: string; statement: string } | null;
  blocker: "none" | "not_open" | "unpriced" | "current_number" | "pilot_ceiling";
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164 = /^\+1[2-9][0-9]{9}$/;
const FUNDING = new Set(["credit_recurring", "pilot"]);
const BLOCKER = new Set(["none", "not_open", "unpriced", "current_number", "pilot_ceiling"]);
const APPROVAL = new Set(["open", "expired"]);
const text = (v: unknown, max: number): string | null => (typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "").slice(0, max) || null : null);
const id = (v: unknown): string => {
  if (typeof v !== "string" || !UUID.test(v)) throw new Invalid();
  return v;
};
const phone = (v: unknown): string => {
  if (typeof v !== "string" || !E164.test(v)) throw new Invalid();
  return v;
};
const time = (v: unknown): string => {
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw new Invalid();
  return v;
};

export function parseOwnerNumberOffers(raw: unknown): OwnerNumberOffers | null {
  const o = obj(raw);
  if (!o || o.available !== true || o.version !== 1) return null;
  try {
    const price = need(o.price);
    const published = bool(price.published);
    const cents = price.monthly_cents;
    if (published !== (typeof cents === "number" && Number.isInteger(cents) && cents > 0) || (!published && cents != null)) throw new Invalid();
    let offer: OwnerNumberOffers["offer"] = null;
    if (o.offer != null) {
      const f = need(o.offer);
      if (!Array.isArray(f.numbers)) throw new Invalid();
      offer = { offerId: id(f.offer_id), expiresAt: time(f.expires_at), numbers: f.numbers.map((n) => { const x = need(n); return { e164: phone(x.e164), locality: text(x.locality, 60), region: text(x.region, 20) }; }) };
    }
    let approval: OwnerNumberOffers["approval"] = null;
    if (o.approval != null) {
      const a = need(o.approval);
      approval = { selectionId: id(a.selection_id), e164: phone(a.e164), status: pick(APPROVAL, a.status) as "open" | "expired", expiresAt: time(a.expires_at), statement: text(a.statement, 2000) ?? "" };
    }
    return {
      stepOpen: bool(o.step_open),
      monthlyCents: published ? (cents as number) : null,
      fundingMode: pick(FUNDING, o.funding_mode) as OwnerNumberOffers["fundingMode"],
      pilotCeilingReached: bool(o.pilot_ceiling_reached),
      offer,
      approval,
      blocker: pick(BLOCKER, o.blocker) as OwnerNumberOffers["blocker"],
    };
  } catch {
    return null;
  }
}

export async function getOwnerNumberOffers(supabase: Client, studioId: string): Promise<OwnerNumberOffers | null> {
  try {
    const { data, error } = await supabase.rpc("get_studio_sms_number_offers", { p_studio_id: studioId });
    if (error) return null;
    return parseOwnerNumberOffers(data);
  } catch {
    return null;
  }
}

/** The anchor of the owner's number choice on the texting page. */
export const NUMBER_SELECTION_HREF = "#sms-number";

/** True when the owner can act on the number step right now: an approvable offer, or an open approval to review or withdraw. */
export function numberChoiceActionable(offers: OwnerNumberOffers | null): boolean {
  if (!offers || !offers.stepOpen) return false;
  if (offers.approval?.status === "open") return true;
  return offers.blocker === "none" && offers.monthlyCents != null && (offers.offer?.numbers.length ?? 0) > 0;
}

/** Wires the owner number choice into the journey: the number stage gets its link only when the choice is actually actionable. */
export function withNumberChoice(provisioning: ProvisioningFacts | null, offers: OwnerNumberOffers | null): ProvisioningFacts | null {
  if (!provisioning?.number || !numberChoiceActionable(offers)) return provisioning;
  return { ...provisioning, number: { ...provisioning.number, actionHref: NUMBER_SELECTION_HREF, priceCents: offers!.monthlyCents } };
}
