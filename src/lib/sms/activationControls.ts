import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activationCheck } from "./activation";
import { expectedInboundUrl } from "./senderVerification";
import type { ReconcilerReadinessDetail } from "./usageReconcilerReadiness";

/**
 * The server half of two platform-administrator controls that activation depends on: the pinned inbound route (`tw4_inbound_route_pin_set`) and the billed
 * texting switch (`tw4_usage_set_switch`). The database decides every outcome; nothing here schedules, retries or switches anything on its own. Database
 * error text is never shown: SQLSTATEs (and, for TW024, a fixed detail code) map to fixed sentences.
 */

type Client = Pick<SupabaseClient, "rpc">;
type Env = Record<string, string | undefined>;

export const CONTROLS_FLASH_COOKIE = "tw4_activation_controls_flash";
/** What an administrator types to switch billed texting ON. Switching OFF needs no phrase. */
export const SWITCH_ON_PHRASE = "SWITCH ON BILLED TEXTING";
/** The written reason's bounds (the database's own: 10 to 300 characters). */
export const REASON_MIN = 10;
export const REASON_MAX = 300;

const INBOUND_PATH = "/api/sms/twilio/inbound";
// the database's own rule (20261208090000: tw4_inbound_route_pin_set, plus the table's 255-character check)
const PINNABLE_ORIGIN = /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{2,5})?$/;
const PINNABLE_ORIGIN_MAX = 255;

export type ConfiguredRoute = { ok: true; origin: string; inboundUrl: string } | { ok: false; origin: string | null; message: string };

/**
 * The only origin that can be pinned from the console: the one this application is configured with (`expectedInboundUrl`, which compliance validation and
 * provisioning also use). It is never typed by a person and never rewritten here: compliance validation compares the two strings exactly.
 */
export function configuredInboundRoute(env: Env = process.env): ConfiguredRoute {
  const inboundUrl = expectedInboundUrl(env);
  if (!inboundUrl) {
    return { ok: false, origin: null, message: "The application URL is not configured (NEXT_PUBLIC_APP_URL or NEXT_PUBLIC_SITE_URL), so there is no address to pin." };
  }
  const origin = inboundUrl.slice(0, -INBOUND_PATH.length);
  if (origin.length > PINNABLE_ORIGIN_MAX || !PINNABLE_ORIGIN.test(origin)) {
    return { ok: false, origin, message: "The configured application URL cannot be pinned. The database accepts only https, a lower-case domain name and an optional port, with no path." };
  }
  return { ok: true, origin, inboundUrl };
}

/** Whether ANY pin exists. No database function returns the pinned address itself. */
export type PinState = "recorded" | "not_recorded" | "unknown";

const PIN_ITEM = "inbound_route_pinned";
const PIN_READ_TRIES = 3;

/**
 * Reads the pin through the activation checklist (`tw4_act_check`), whose `inbound_route_pinned` item is the same for every location. It therefore needs a
 * location to ask about; with none, or when the reads fail, the answer is "unknown", never a guess.
 */
export async function loadInboundPinState(admin: Client, actorId: string, studioIds: string[]): Promise<PinState> {
  for (const studioId of studioIds.slice(0, PIN_READ_TRIES)) {
    try {
      const res = await activationCheck(admin, studioId, actorId);
      if (!res.ok) continue;
      const item = res.data.items.find((i) => i.id === PIN_ITEM);
      if (item?.ok) return "recorded";
      if (item?.detail === "inbound_route_not_pinned") return "not_recorded";
    } catch {
      /* try the next location */
    }
  }
  return "unknown";
}

export const RECONCILER_REASONS: Record<ReconcilerReadinessDetail, string> = {
  ready: "the usage reconciler is ready",
  no_completed_run: "no reconciliation run has completed yet",
  no_evidence_reads: "no completed run has read provider evidence (evidence reads are off)",
  evidence_failing: "recent runs read provider evidence but settled nothing that was due",
  stale: "the last successful run is more than 30 minutes old",
  stuck_lease: "a run's lease expired and was never taken over (the schedule has stopped)",
  unknown: "the readiness check returned an unexpected answer",
};

const UNCONFIRMED = "The database did not confirm the change. Reload and check the current state before trying again.";
const NOT_ADMIN = "The database refused: only a platform administrator can make this change. Nothing changed.";
const NOT_INSTALLED = "This control is not available in this database yet. Nothing changed.";

export function pinRefusalMessage(code: string): string {
  switch (code) {
    case "42501": return NOT_ADMIN;
    case "22023":
    case "23514": return "The database refused the address or the reason (https domain name only; a reason of 10 to 300 characters). Nothing changed.";
    case "42883":
    case "PGRST202": return NOT_INSTALLED;
    default: return UNCONFIRMED;
  }
}

/** TW024 carries a fixed detail code in the database's message; only that code is read, and only to pick one of the sentences above. */
export function switchRefusalMessage(code: string, message?: string): string {
  switch (code) {
    case "TW024": {
      const text = typeof message === "string" ? message : "";
      if (text.includes("reconciliation gaps")) return "Billed texting was not switched on: the usage ledger has reconciliation gaps. Resolve them first. Nothing changed.";
      const detail = /not ready \(([a-z_]{1,40})\)/.exec(text)?.[1] ?? "";
      const reason = detail !== "ready" && Object.hasOwn(RECONCILER_REASONS, detail) ? `: ${RECONCILER_REASONS[detail as ReconcilerReadinessDetail]}` : "";
      return `Billed texting was not switched on: the usage reconciler is not ready${reason}. Nothing changed.`;
    }
    case "42501": return NOT_ADMIN;
    case "22023":
    case "23514": return "The database refused the input (a reason of 10 to 300 characters is required). Nothing changed.";
    case "55P03": return "The database is busy with another change. Try again shortly. Nothing changed.";
    case "42883":
    case "PGRST202": return NOT_INSTALLED;
    default: return UNCONFIRMED;
  }
}

export type ControlWrite = { ok: true } | { ok: false; message: string };

type RpcReply = { data: unknown; error: { code?: string; message?: string } | null };
const field = (data: unknown, name: string): unknown => (data && typeof data === "object" ? (data as Record<string, unknown>)[name] : undefined);

export async function pinInboundRoute(admin: Client, input: { actorId: string; origin: string; reason: string }): Promise<ControlWrite> {
  try {
    const { data, error } = (await admin.rpc("tw4_inbound_route_pin_set", { p_actor: input.actorId, p_origin: input.origin, p_reason: input.reason })) as RpcReply;
    if (error) return { ok: false, message: pinRefusalMessage(String(error.code ?? "")) };
    return field(data, "origin") === input.origin ? { ok: true } : { ok: false, message: UNCONFIRMED };
  } catch {
    return { ok: false, message: UNCONFIRMED };
  }
}

export async function setBilledTextingSwitch(admin: Client, input: { actorId: string; enabled: boolean; reason: string }): Promise<ControlWrite> {
  try {
    const { data, error } = (await admin.rpc("tw4_usage_set_switch", { p_enabled: input.enabled, p_actor: input.actorId, p_reason: input.reason })) as RpcReply;
    if (error) return { ok: false, message: switchRefusalMessage(String(error.code ?? ""), error.message) };
    return field(data, "enabled") === input.enabled ? { ok: true } : { ok: false, message: UNCONFIRMED };
  } catch {
    return { ok: false, message: UNCONFIRMED };
  }
}
