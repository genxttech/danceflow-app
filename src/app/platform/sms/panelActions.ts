"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformStepUp } from "@/lib/auth/platform-assurance";
import { buildRunnerRuntime } from "@/lib/sms/twilioIsv/factory";
import { SupabasePanelStore } from "@/lib/sms/twilioIsv/panel";
import * as commands from "@/lib/sms/twilioIsv/panelCommands";
import type { CommandResult, SubaccountDeps } from "@/lib/sms/twilioIsv/panelCommands";
import { encodePanelFlash, PANEL_FLASH_COOKIE, PANEL_FLASH_MAX_AGE_SECONDS } from "@/lib/sms/twilioIsv/panelFlash";

/**
 * TW-4F platform-admin subaccount onboarding panel. Every action: requirePlatformAdmin here, then a service-role definer function that checks the
 * platform-admin actor again. The panel never sends SMS and never submits a registration; "Create subaccount" is the only action that can reach
 * Twilio, and only through the runner runtime (fake locally).
 */

const RETURN_PATH = "/platform/sms";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Back to the panel with the result. The text goes in a short-lived httpOnly cookie (see panelFlash.ts), never the URL; the studio the form was
 * about (a uuid, or nothing) reopens its card.
 */
async function finish(result: CommandResult, formData?: FormData): Promise<never> {
  revalidatePath(RETURN_PATH);
  (await cookies()).set(PANEL_FLASH_COOKIE, encodePanelFlash(result), {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: RETURN_PATH, maxAge: PANEL_FLASH_MAX_AGE_SECONDS,
  });
  const key = result.ok ? "panel" : "panel_error";
  const studio = String(formData?.get("studioId") ?? "");
  const focus = UUID.test(studio) ? `&studio=${studio}` : "";
  redirect(`${RETURN_PATH}?${key}=1${focus}#subaccount-panel`);
}

const store = () => new SupabasePanelStore(createAdminClient());

export async function panelCreateEntityAction(formData: FormData) {
  const admin = await requirePlatformStepUp("aal2");
  await finish(await commands.createEntity(store(), admin.id, formData), formData);
}

export async function panelDecideLinkAction(formData: FormData) {
  const admin = await requirePlatformStepUp("aal2");
  await finish(await commands.decideLink(store(), admin.id, formData), formData);
}

export async function panelSetSpendCapAction(formData: FormData) {
  const admin = await requirePlatformStepUp("recent");
  await finish(await commands.setSpendCap(store(), admin.id, formData), formData);
}

export async function panelAuthorizeFeeAction(formData: FormData) {
  const admin = await requirePlatformStepUp("recent");
  const panelStore = store();
  // the location's registration tier comes from the database, never from the form
  let studioTier: string | null = null;
  let onboardingFound = false;
  try {
    const studioId = String(formData.get("studioId") ?? "");
    const onboarding = (await panelStore.overview(admin.id)).onboardings.find((o) => o.studioId === studioId);
    onboardingFound = Boolean(onboarding);
    studioTier = onboarding?.tier ?? null;
  } catch {
    await finish({ ok: false, message: "The studio's registration path could not be read. Nothing was authorized." }, formData);
  }
  await finish(await commands.authorizeFee(panelStore, admin.id, formData, { studioTier, onboardingFound }), formData);
}

export async function panelWithdrawFeeAction(formData: FormData) {
  const admin = await requirePlatformStepUp("aal2");
  await finish(await commands.withdrawFee(store(), admin.id, formData), formData);
}

export async function panelCreatePilotExceptionAction(formData: FormData) {
  const admin = await requirePlatformStepUp("recent");
  await finish(await commands.createPilotException(store(), admin.id, formData), formData);
}

export async function panelCreateSubaccountAction(formData: FormData) {
  const admin = await requirePlatformStepUp("recent");
  const runtime = buildRunnerRuntime();
  const deps: SubaccountDeps = runtime.ok ? { entities: runtime.entities, parent: runtime.parent, envName: runtime.config.envName } : { refused: runtime.reason };
  let result: CommandResult;
  try {
    result = await commands.createSubaccount(store(), admin.id, formData, deps);
  } catch {
    result = { ok: false, message: "The subaccount step failed unexpectedly. Nothing is repeated automatically; reload and check its status before trying again." };
  }
  await finish(result, formData);
}

export async function panelDecideTierAction(formData: FormData) {
  const admin = await requirePlatformStepUp("aal2");
  await finish(await commands.decideTier(store(), admin.id, formData), formData);
}
