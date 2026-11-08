"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requirePlatformStepUp } from "@/lib/auth/platform-assurance";
import { encodePanelFlash, PANEL_FLASH_MAX_AGE_SECONDS } from "@/lib/sms/twilioIsv/panelFlash";
import { buildNumberRuntime, buildProvisioningRuntime } from "@/lib/sms/twilioIsv/factory";
import { PROV_FLASH_COOKIE } from "@/lib/sms/provisioning/provisionFlash";
import { numberCommand, provisioningCommand, type RunCommandResult, type RunDeps } from "@/lib/sms/provisioning/runOrchestration";

/**
 * TW-4F J1: platform-admin entry points that run the R2a provisioning runner and the R2b number runner for ONE studio. Every entry point runs
 * `requirePlatformAdmin` FIRST and takes the admin id from that session; the browser supplies only a studio id, an intent and the confirmations.
 * The real provider is reachable only on a production deployment with TW4_ISV_REAL_CALLS + TW4_PROVISIONING_REAL_CALLS (+ TW4_NUMBER_REAL_CALLS for
 * numbers); the fake only with TW4_ISV_FAKE on a local database. The result travels in the short-lived httpOnly provisioning cookie, never the URL.
 */

const RETURN_PATH = "/platform/sms";
const deps: RunDeps = { provisioning: () => buildProvisioningRuntime(), numbers: () => buildNumberRuntime() };
const audit = (event: Record<string, unknown>) => console.info(JSON.stringify(event));

async function finish(result: RunCommandResult): Promise<never> {
  (await cookies()).set(PROV_FLASH_COOKIE, encodePanelFlash({ ok: result.ok, message: result.message }), { httpOnly: true, sameSite: "lax", path: RETURN_PATH, maxAge: PANEL_FLASH_MAX_AGE_SECONDS });
  revalidatePath(RETURN_PATH);
  redirect(`${RETURN_PATH}?${result.ok ? "prov=1" : "prov_error=1"}${result.studioId ? `#prov-run-${result.studioId}` : ""}`);
}

/** intent: service (free Messaging Service only) | campaign (fee-bearing; confirmFee + the typed phrase) | refresh (GET-only). */
export async function runProvisioningStepAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("recent");
  await finish(await provisioningCommand(deps, admin.id, formData, audit));
}

/** intent: offer (free search, recorded as an offer for the owner) | acquire (fee-bearing; confirmFee + the typed owner-approved number) | refresh (GET-only). */
export async function runNumberStepAction(formData: FormData): Promise<void> {
  const admin = await requirePlatformStepUp("recent");
  await finish(await numberCommand(deps, admin.id, formData, audit));
}
