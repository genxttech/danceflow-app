"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requirePlatformStepUp } from "@/lib/auth/platform-assurance";
import { createAdminClient } from "@/lib/supabase/admin";
import { encodePanelFlash, PANEL_FLASH_MAX_AGE_SECONDS } from "@/lib/sms/twilioIsv/panelFlash";
import { ProvisioningLedgerStore } from "@/lib/sms/provisioning/provisionLedger";
import { reopenProvisioning, resolveOperation, type CommandResult } from "@/lib/sms/provisioning/provisionCommands";
import { PROV_FLASH_COOKIE } from "@/lib/sms/provisioning/provisionFlash";
import { buildEvidenceRuntime } from "@/lib/sms/provisioning/evidenceRuntime";
import { recordProviderListing } from "@/lib/sms/provisioning/recoveryCommands";
import { checkCampaignAbsence, ProvisionEvidenceStore } from "@/lib/sms/twilioIsv/provisionEvidence";
import { SupabaseProvisionStore } from "@/lib/sms/twilioIsv/provisionStore";

/**
 * TW-4F R2c-I1: platform-admin entry points for the provisioning ledger. Every entry point runs `requirePlatformAdmin` FIRST and takes the admin id from
 * that session; the browser supplies only a studio id, an operation id (re-verified against that studio's ledger) and the admin's written evidence.
 * The result travels in a short-lived httpOnly cookie, never the URL. No action calls a provider, except the F4 evidence console's read-only listing.
 */

const RETURN_PATH = "/platform/sms";

async function finish(result: CommandResult, studioId: string): Promise<never> {
  (await cookies()).set(PROV_FLASH_COOKIE, encodePanelFlash(result), { httpOnly: true, sameSite: "lax", path: RETURN_PATH, maxAge: PANEL_FLASH_MAX_AGE_SECONDS });
  revalidatePath(RETURN_PATH);
  const anchor = /^[0-9a-f-]{36}$/i.test(studioId) ? `#ledger-${studioId}` : "";
  redirect(`${RETURN_PATH}?${result.ok ? "prov=1" : "prov_error=1"}${anchor}`);
}

export async function resolveProvisioningOperationAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("recent");
  const result = await resolveOperation(new ProvisioningLedgerStore(createAdminClient()), admin.id, formData);
  const studio = formData.get("studioId");
  await finish(result, typeof studio === "string" ? studio : "");
}

/**
 * TW-4F F4 evidence console: one read-only provider listing of the studio's campaigns, recorded for the database to judge. Admin first, then validation
 * against the studio's ledger, then the environment-gated adapter (a fake on a local QA database only; real reads only behind the provisioning gates, off by
 * default). It never resolves an operation and never releases a held fee.
 */
export async function recordProviderListingAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("aal2");
  const client = createAdminClient();
  const ledger = new ProvisioningLedgerStore(client);
  const store = new SupabaseProvisionStore(client);
  const evidence = new ProvisionEvidenceStore(client);
  const studio = formData.get("studioId");
  const studioId = typeof studio === "string" ? studio.trim() : "";
  const result = await recordProviderListing(
    {
      ledgerStatus: (id, actor) => ledger.status(id, actor),
      store,
      evidence,
      runtime: buildEvidenceRuntime(),
      check: (adapter) => checkCampaignAbsence({ store, evidence, adapter, studioId, actorId: admin.id }),
    },
    admin.id,
    formData,
  );
  await finish(result, studioId);
}

export async function reopenProvisioningAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("recent");
  const result = await reopenProvisioning(new ProvisioningLedgerStore(createAdminClient()), admin.id, formData);
  const studio = formData.get("studioId");
  await finish(result, typeof studio === "string" ? studio : "");
}
