"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createAdminClient } from "@/lib/supabase/admin";
import { encodePanelFlash, PANEL_FLASH_MAX_AGE_SECONDS } from "@/lib/sms/twilioIsv/panelFlash";
import { ProvisioningLedgerStore } from "@/lib/sms/provisioning/provisionLedger";
import { reopenProvisioning, resolveOperation, type CommandResult } from "@/lib/sms/provisioning/provisionCommands";
import { PROV_FLASH_COOKIE } from "@/lib/sms/provisioning/provisionFlash";

/**
 * TW-4F R2c-I1: platform-admin entry points for the provisioning ledger. Every entry point runs `requirePlatformAdmin` FIRST and takes the admin id from
 * that session; the browser supplies only a studio id, an operation id (re-verified against that studio's ledger) and the admin's written evidence.
 * The result travels in a short-lived httpOnly cookie, never the URL. No action calls a provider.
 */

const RETURN_PATH = "/platform/sms";

async function finish(result: CommandResult, studioId: string): Promise<never> {
  (await cookies()).set(PROV_FLASH_COOKIE, encodePanelFlash(result), { httpOnly: true, sameSite: "lax", path: RETURN_PATH, maxAge: PANEL_FLASH_MAX_AGE_SECONDS });
  revalidatePath(RETURN_PATH);
  const anchor = /^[0-9a-f-]{36}$/i.test(studioId) ? `#ledger-${studioId}` : "";
  redirect(`${RETURN_PATH}?${result.ok ? "prov=1" : "prov_error=1"}${anchor}`);
}

export async function resolveProvisioningOperationAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const result = await resolveOperation(new ProvisioningLedgerStore(createAdminClient()), admin.id, formData);
  const studio = formData.get("studioId");
  await finish(result, typeof studio === "string" ? studio : "");
}

export async function reopenProvisioningAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const result = await reopenProvisioning(new ProvisioningLedgerStore(createAdminClient()), admin.id, formData);
  const studio = formData.get("studioId");
  await finish(result, typeof studio === "string" ? studio : "");
}
