import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { listOnboardings, type PlatformOnboardingRow } from "@/lib/sms/onboarding/client";
import { ACTIVATION_FLASH_COOKIE, ACTIVATION_STATES, activationProviderReads, loadActivationOverview } from "@/lib/sms/activation";
import { readPanelFlash } from "@/lib/sms/twilioIsv/panelFlash";
import Activation from "./Activation";

/** Pre-activation locations shown at most; active and suspended locations are NEVER capped (the emergency stop must always be reachable). */
const PENDING_CAP = 30;

/** Active first, then suspended (all of them), then campaign_pending / ready_for_activation up to the cap. */
export function selectActivationRows(rows: PlatformOnboardingRow[]): PlatformOnboardingRow[] {
  const listed = rows.filter((r) => r.state && ACTIVATION_STATES.includes(r.state));
  const active = listed.filter((r) => r.state === "active");
  const suspended = listed.filter((r) => r.state === "suspended");
  const pending = listed.filter((r) => r.state === "campaign_pending" || r.state === "ready_for_activation").slice(0, PENDING_CAP);
  return [...active, ...suspended, ...pending];
}

/**
 * TW-4F J4 server wrapper: lists the locations that can reach activation, loads each one's checklist (each read degrades to "unavailable" on its own) and
 * the flash banner, then renders the console. The caller has already run `requirePlatformAdmin()` and passes the session's administrator id and the two
 * result query values. An unreadable location list is reported as such, never as "no location".
 */
export default async function ActivationPanel({ adminId, notice, error }: { adminId: string; notice: string | null; error: string | null }) {
  let rows: PlatformOnboardingRow[] = [];
  let listError = false;
  try {
    rows = await listOnboardings(await createClient());
  } catch {
    listError = true;
  }
  const studios = selectActivationRows(rows);
  const overview = await loadActivationOverview(createAdminClient(), adminId, studios.map((r) => r.studioId));
  const flash = readPanelFlash((await cookies()).get(ACTIVATION_FLASH_COOKIE)?.value, { panel: notice, panelError: error });
  return (
    <Activation
      studios={studios.map((r) => ({ studioId: r.studioId, name: r.studioName || r.studioId, state: r.state }))}
      overview={overview}
      reads={activationProviderReads(process.env)}
      notice={flash.notice}
      error={flash.error}
      listError={listError}
    />
  );
}
