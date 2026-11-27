"use server";

import { revalidatePath } from "next/cache";
import { IntakeAccessError, requireStudentIntakeConfigure } from "@/lib/intake/guard";
import { SERVICE_TYPES, canTurnOn, type ServiceType } from "@/lib/intake/studioConfig";
import { loadConfigView } from "@/lib/intake/studioConfigLoader";
import { draftToSchema, schemaToDraft, validateDraft } from "@/lib/intake/templateSchema";

export type IntakeActionResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = "/app/settings/student-intake";

/** Database errors raised by the intake RPCs are written for staff ("nsi: …"); anything else stays generic. */
function friendly(error: unknown): string {
  if (error instanceof IntakeAccessError) return error.message;
  const message = typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : "";
  if (message.startsWith("nsi: ")) return message.slice(5).replace(/^./, (c) => c.toUpperCase());
  return "Something went wrong. Nothing was changed.";
}

async function guarded<T extends object>(run: (ctx: Awaited<ReturnType<typeof requireStudentIntakeConfigure>>) => Promise<IntakeActionResult<T>>) {
  try {
    const ctx = await requireStudentIntakeConfigure();
    const result = await run(ctx);
    if (result.ok) revalidatePath(PATH);
    return result;
  } catch (error) {
    return { ok: false, error: friendly(error) } as IntakeActionResult<T>;
  }
}

export async function setIntakeEnabledAction(enabled: boolean): Promise<IntakeActionResult<object>> {
  return guarded<object>(async ({ supabase, studioId }) => {
    if (enabled) {
      const view = await loadConfigView(supabase, studioId);
      if (!canTurnOn(view)) return { ok: false, error: "Choose a default form with a published version first." };
    }
    const { error } = await supabase.rpc("intake_update_settings", { p_studio_id: studioId, p_changes: { enabled: enabled === true } });
    if (error) return { ok: false, error: friendly(error) };
    return { ok: true };
  });
}

export async function setDefaultTemplateAction(templateId: string): Promise<IntakeActionResult<object>> {
  return guarded<object>(async ({ supabase, studioId }) => {
    if (!UUID.test(templateId)) return { ok: false, error: "Choose a form." };
    const view = await loadConfigView(supabase, studioId);
    const template = view.templates.find((t) => t.id === templateId);
    if (!template || template.archived) return { ok: false, error: "That form is not available." };
    if (!template.publishedVersion) return { ok: false, error: "Publish this form before making it the default." };
    const { error } = await supabase.rpc("intake_update_settings", { p_studio_id: studioId, p_changes: { default_template_id: templateId } });
    if (error) return { ok: false, error: friendly(error) };
    return { ok: true };
  });
}

/**
 * Turns a lesson type on or off for intake. A type that is not selected never asks for intake (no default fallback).
 * When selected, `templateId` empty = use the studio's default form for this type.
 */
export async function setServiceTypeAction(serviceType: string, enabled: boolean, templateId: string): Promise<IntakeActionResult<object>> {
  return guarded<object>(async ({ supabase, studioId }) => {
    if (!(SERVICE_TYPES as readonly string[]).includes(serviceType)) return { ok: false, error: "Unsupported lesson type." };
    if (typeof enabled !== "boolean") return { ok: false, error: "Choose whether this lesson type asks for intake." };
    if (templateId && !UUID.test(templateId)) return { ok: false, error: "Choose a form." };
    if (enabled && templateId) {
      const view = await loadConfigView(supabase, studioId);
      const template = view.templates.find((t) => t.id === templateId);
      if (!template || template.archived || !template.publishedVersion) return { ok: false, error: "Choose a published form." };
    }
    const { error } = await supabase.rpc("intake_set_service_type", {
      p_studio_id: studioId,
      p_appointment_type: serviceType as ServiceType,
      p_enabled: enabled,
      p_template_id: enabled && templateId ? templateId : null,
    });
    if (error) return { ok: false, error: friendly(error) };
    return { ok: true };
  });
}

/** Saves the working draft (creating the template when `templateId` is empty). Never publishes. */
export async function saveTemplateDraftAction(
  templateId: string,
  name: string,
  schemaJson: string,
): Promise<IntakeActionResult<{ templateId: string; versionId: string }>> {
  return guarded<{ templateId: string; versionId: string }>(async ({ supabase, studioId }) => {
    if (templateId && !UUID.test(templateId)) return { ok: false, error: "That form is not available." };
    let parsed: unknown;
    try {
      parsed = JSON.parse(schemaJson);
    } catch {
      return { ok: false, error: "The form could not be read. Reload and try again." };
    }
    const draft = schemaToDraft(name, parsed);
    const issues = validateDraft(draft);
    if (issues.length > 0) return { ok: false, error: issues[0].message };
    const { data, error } = await supabase.rpc("intake_save_template_draft", {
      p_studio_id: studioId,
      p_template_id: templateId || null,
      p_name: draft.name.trim(),
      p_schema: draftToSchema(draft),
    });
    if (error || typeof data !== "string") return { ok: false, error: friendly(error) };
    const { data: version } = await supabase
      .from("intake_template_versions")
      .select("template_id")
      .eq("studio_id", studioId)
      .eq("id", data)
      .maybeSingle();
    const savedTemplateId = (version as { template_id?: string } | null)?.template_id;
    if (!savedTemplateId) return { ok: false, error: "The draft was saved but could not be reopened. Reload the page." };
    return { ok: true, templateId: savedTemplateId, versionId: data };
  });
}

export async function publishVersionAction(versionId: string): Promise<IntakeActionResult<{ versionNumber: number }>> {
  return guarded<{ versionNumber: number }>(async ({ supabase, studioId }) => {
    if (!UUID.test(versionId)) return { ok: false, error: "That version is not available." };
    const { data, error } = await supabase.rpc("intake_publish_template_version", { p_studio_id: studioId, p_version_id: versionId });
    if (error || typeof data !== "number") return { ok: false, error: friendly(error) };
    return { ok: true, versionNumber: data };
  });
}
