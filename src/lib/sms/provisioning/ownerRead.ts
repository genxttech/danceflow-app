import type { SupabaseClient } from "@supabase/supabase-js";
import type { CampaignFact, MessagingServiceFact, ProvisioningFacts } from "./journey";

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
