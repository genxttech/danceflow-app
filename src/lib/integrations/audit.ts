import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

export type IntegrationAuditOutcome = "succeeded" | "failed" | "skipped";

/** Keys that could carry secrets or personal data are dropped, whatever the caller passes. */
const FORBIDDEN_KEY = /token|secret|password|authorization|^code$|email|name|phone|note|address/i;

export function sanitizeAuditDetails(details: Record<string, unknown> | undefined) {
  const clean: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    if (FORBIDDEN_KEY.test(key)) continue;
    if (typeof value === "string") clean[key] = value.slice(0, 200);
    else if (typeof value === "number" || typeof value === "boolean") clean[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) clean[key] = (value as string[]).slice(0, 20).map((v) => v.slice(0, 100));
  }
  return clean;
}

/**
 * Appends an audit row with the service role. NEVER throws: an audit failure must not break a connect or disconnect, so it is logged
 * (message only, no payload) and swallowed.
 */
export async function recordIntegrationEvent(args: {
  studioId: string;
  provider: string;
  eventType: string;
  outcome?: IntegrationAuditOutcome;
  connectionId?: string | null;
  actorUserId?: string | null;
  details?: Record<string, unknown>;
}) {
  try {
    const { error } = await createAdminClient().from("integration_audit_events").insert({
      studio_id: args.studioId,
      provider: args.provider,
      event_type: args.eventType,
      outcome: args.outcome ?? "succeeded",
      connection_id: args.connectionId ?? null,
      actor_user_id: args.actorUserId ?? null,
      details: sanitizeAuditDetails(args.details),
    });
    if (error) console.error("Integration audit event could not be written:", error.message);
  } catch (error) {
    console.error("Integration audit event could not be written:", error instanceof Error ? error.message : "unknown error");
  }
}
