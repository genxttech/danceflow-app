import type { SupabaseClient } from "@supabase/supabase-js";
import { parseMonthlyLimitOverview, type MonthlyLimitOverview } from "./smsMonthlyLimits";

/**
 * TW-4F platform-admin panel: each legal business's monthly spending limit, READ-ONLY. The platform-admin-only definer function computes it with the same
 * helpers as the owner's sms_monthly_limit_overview and returns the same keys, so it is parsed by the same parser. Nothing here can change a limit.
 */
type Client = Pick<SupabaseClient, "rpc">;

/** Keyed by legal business id. */
export type PanelMonthlyLimits = Record<string, MonthlyLimitOverview>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePanelMonthlyLimits(raw: unknown): PanelMonthlyLimits {
  const out: PanelMonthlyLimits = {};
  for (const row of Array.isArray(raw) ? raw : []) {
    const id = row && typeof row === "object" ? (row as Record<string, unknown>).legal_entity_id : null;
    if (typeof id !== "string" || !UUID.test(id)) continue;
    const parsed = parseMonthlyLimitOverview(row);
    if (parsed.legalBusiness && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(parsed.month)) out[id] = parsed;
  }
  return out;
}

/** Null when it cannot be read (function not installed in this environment, or the actor is refused): the panel then says "not available", never "no limit". */
export async function loadPanelMonthlyLimits(admin: Client, actorId: string): Promise<PanelMonthlyLimits | null> {
  try {
    const { data, error } = await admin.rpc("tw4_panel_monthly_limits", { p_actor: actorId });
    if (error) return null;
    return parsePanelMonthlyLimits(data);
  } catch {
    return null;
  }
}
