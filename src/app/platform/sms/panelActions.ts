"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { buildRunnerRuntime } from "@/lib/sms/twilioIsv/factory";
import { SupabasePanelStore } from "@/lib/sms/twilioIsv/panel";
import * as commands from "@/lib/sms/twilioIsv/panelCommands";
import type { CommandResult, SubaccountDeps } from "@/lib/sms/twilioIsv/panelCommands";

/**
 * TW-4F platform-admin subaccount onboarding panel. Every action: requirePlatformAdmin here, then a service-role definer function that checks the
 * platform-admin actor again. The panel never sends SMS and never submits a registration; "Create subaccount" is the only action that can reach
 * Twilio, and only through the runner runtime (fake locally).
 */

const RETURN_PATH = "/platform/sms";

function finish(result: CommandResult): never {
  revalidatePath(RETURN_PATH);
  const key = result.ok ? "panel" : "panel_error";
  redirect(`${RETURN_PATH}?${key}=${encodeURIComponent(result.message.slice(0, 400))}#subaccount-panel`);
}

const store = () => new SupabasePanelStore(createAdminClient());

export async function panelCreateEntityAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  finish(await commands.createEntity(store(), admin.id, formData));
}

export async function panelDecideLinkAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  finish(await commands.decideLink(store(), admin.id, formData));
}

export async function panelSetSpendCapAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  finish(await commands.setSpendCap(store(), admin.id, formData));
}

export async function panelAuthorizeFeeAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const panelStore = store();
  // the location's registration tier comes from the database, never from the form
  let studioTier: string | null = null;
  try {
    const studioId = String(formData.get("studioId") ?? "");
    studioTier = (await panelStore.overview(admin.id)).onboardings.find((o) => o.studioId === studioId)?.tier ?? null;
  } catch {
    finish({ ok: false, message: "The studio's registration path could not be read. Nothing was authorized." });
  }
  finish(await commands.authorizeFee(panelStore, admin.id, formData, { studioTier }));
}

export async function panelWithdrawFeeAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  finish(await commands.withdrawFee(store(), admin.id, formData));
}

export async function panelCreatePilotExceptionAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  finish(await commands.createPilotException(store(), admin.id, formData));
}

export async function panelCreateSubaccountAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const runtime = buildRunnerRuntime();
  const deps: SubaccountDeps = runtime.ok ? { entities: runtime.entities, parent: runtime.parent, envName: runtime.config.envName } : { refused: runtime.reason };
  let result: CommandResult;
  try {
    result = await commands.createSubaccount(store(), admin.id, formData, deps);
  } catch {
    result = { ok: false, message: "The subaccount step failed unexpectedly. Nothing is repeated automatically; reload and check its status before trying again." };
  }
  finish(result);
}

export async function panelDecideTierAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  finish(await commands.decideTier(store(), admin.id, formData));
}
