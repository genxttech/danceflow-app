import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { ACTIVATION_STATES } from "@/lib/sms/activation";
import { configuredInboundRoute, CONTROLS_FLASH_COOKIE, loadInboundPinState } from "@/lib/sms/activationControls";
import type { ReconcilerReadiness } from "@/lib/sms/usageReconcilerReadiness";
import { readPanelFlash } from "@/lib/sms/twilioIsv/panelFlash";
import ActivationControls, { type SwitchOverview } from "./ActivationControls";

/**
 * Server wrapper for the activation controls. The caller has already run `requirePlatformAdmin()` and passes the session's administrator id, the locations
 * it listed (used only to read the pin through the activation checklist) and the usage reads it already made.
 */
export default async function ActivationControlsPanel({ adminId, locations, usage, readiness, notice, error }: {
  adminId: string; locations: { studioId: string; state: string | null }[]; usage: SwitchOverview | null; readiness: ReconcilerReadiness | null; notice: string | null; error: string | null;
}) {
  // locations near activation first: their checklist is the one most certainly readable
  const rank = (state: string | null) => (state && ACTIVATION_STATES.includes(state) ? 0 : state ? 1 : 2);
  const studioIds = [...locations].sort((a, b) => rank(a.state) - rank(b.state)).map((l) => l.studioId);
  const pin = studioIds.length ? await loadInboundPinState(createAdminClient(), adminId, studioIds) : "unknown";
  const flash = readPanelFlash((await cookies()).get(CONTROLS_FLASH_COOKIE)?.value, { panel: notice, panelError: error });
  return <ActivationControls route={configuredInboundRoute(process.env)} pin={pin} usage={usage} readiness={readiness} notice={flash.notice} error={flash.error} />;
}
