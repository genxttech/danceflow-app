"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requirePlatformStepUp } from "@/lib/auth/platform-assurance";
import { createAdminClient } from "@/lib/supabase/admin";
import { encodePanelFlash, PANEL_FLASH_MAX_AGE_SECONDS } from "@/lib/sms/twilioIsv/panelFlash";
import type { CommandResult } from "@/lib/sms/provisioning/provisionCommands";
import { retireDeferred, retryRegistration } from "@/lib/sms/provisioning/recoveryCommands";
import { RECOVERY_FLASH_COOKIE, RecoveryStore } from "@/lib/sms/provisioning/recoveryStore";

/**
 * TW-4F F4: platform-administrator recovery entry points. Every action runs `requirePlatformAdmin` FIRST and takes the actor from that session; the browser
 * supplies only a studio id (and a number SID), re-verified against what the database lists now, plus the administrator's written reason, which the
 * database audits with the administrator's id. The result travels in a short-lived httpOnly cookie, never the URL. Nothing here calls a provider, charges,
 * releases a held fee or asks a studio owner for anything.
 */

const RETURN_PATH = "/platform/sms";

async function finish(result: CommandResult): Promise<never> {
  (await cookies()).set(RECOVERY_FLASH_COOKIE, encodePanelFlash(result), { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: RETURN_PATH, maxAge: PANEL_FLASH_MAX_AGE_SECONDS });
  revalidatePath(RETURN_PATH);
  // redirect throws: it stays outside any try/catch
  redirect(`${RETURN_PATH}?${result.ok ? "recovery=1" : "recovery_error=1"}#sms-recovery`);
}

export async function retryRegistrationAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("recent");
  await finish(await retryRegistration(new RecoveryStore(createAdminClient()), admin.id, formData));
}

export async function retireDeferredAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("aal2");
  await finish(await retireDeferred(new RecoveryStore(createAdminClient()), admin.id, formData));
}
