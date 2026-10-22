import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadRecurringFeeOps, RFL_FLASH_COOKIE } from "@/lib/sms/providerFeeOps";
import { panelRenderContext, readPanelFlash } from "@/lib/sms/twilioIsv/panelFlash";
import RecurringFees from "./RecurringFees";

/**
 * Server wrapper: loads the operations data (each read degrades to "not available") and the flash banner, then renders the panel. The caller has already
 * run `requirePlatformAdmin()` and passes the session's administrator id and the two result query values.
 */
export default async function RecurringFeesPanel({ adminId, notice, error }: { adminId: string; notice: string | null; error: string | null }) {
  const ops = await loadRecurringFeeOps(createAdminClient(), adminId);
  const flash = readPanelFlash((await cookies()).get(RFL_FLASH_COOKIE)?.value, { panel: notice, panelError: error });
  return <RecurringFees ops={ops} adminId={adminId} now={panelRenderContext([]).now} notice={flash.notice} error={flash.error} />;
}
