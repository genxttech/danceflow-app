import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { loadPriceChanges, PRICE_FLASH_COOKIE } from "@/lib/sms/priceChange";
import { readPanelFlash } from "@/lib/sms/twilioIsv/panelFlash";
import PriceChanges from "./PriceChanges";

/**
 * Server wrapper: loads the price-change data (a read that fails reads as "not available") and the flash banner, then renders the section. The caller has already
 * run `requirePlatformAdmin()` and passes the session's administrator id and the two result query values.
 */
export default async function PriceChangesPanel({ adminId, notice, error }: { adminId: string; notice: string | null; error: string | null }) {
  const overview = await loadPriceChanges(await createClient());
  const flash = readPanelFlash((await cookies()).get(PRICE_FLASH_COOKIE)?.value, { panel: notice, panelError: error });
  return <PriceChanges overview={overview} adminId={adminId} notice={flash.notice} error={flash.error} />;
}
