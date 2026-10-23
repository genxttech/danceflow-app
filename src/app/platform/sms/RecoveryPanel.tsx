import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { listOnboardings, type PlatformOnboardingRow } from "@/lib/sms/onboarding/client";
import { loadRecoveryOverview, RECOVERY_FLASH_COOKIE, RecoveryStore } from "@/lib/sms/provisioning/recoveryStore";
import { readPanelFlash } from "@/lib/sms/twilioIsv/panelFlash";
import Recovery from "./Recovery";

/** Onboarding states in which a location can have number operations (purchase, attachment, retirement). */
const NUMBER_STATES = new Set(["campaign_pending", "ready_for_activation", "active", "suspended", "exception", "blocked"]);

/**
 * Server wrapper: loads the recovery data (each read degrades to "unavailable" on its own) and the flash banner, then renders the panel. The caller has
 * already run `requirePlatformAdmin()` and passes the session's administrator id and the two result query values.
 */
export default async function RecoveryPanel({ adminId, notice, error }: { adminId: string; notice: string | null; error: string | null }) {
  let rows: PlatformOnboardingRow[] = [];
  try {
    rows = await listOnboardings(await createClient());
  } catch {
    rows = [];
  }
  const numberStudios = rows.filter((r) => r.state && NUMBER_STATES.has(r.state)).slice(0, 30);
  const overview = await loadRecoveryOverview(new RecoveryStore(createAdminClient()), adminId, numberStudios.map((r) => r.studioId));
  const names = Object.fromEntries(rows.map((r) => [r.studioId, r.studioName || r.studioId]));
  const flash = readPanelFlash((await cookies()).get(RECOVERY_FLASH_COOKIE)?.value, { panel: notice, panelError: error });
  return <Recovery overview={overview} studioNames={names} notice={flash.notice} error={flash.error} />;
}
