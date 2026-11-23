import type { SupabaseClient } from "@supabase/supabase-js";
import { shapeConfig, type AssignmentRow, type ConfigView, type SettingsRow, type TemplateRow, type VersionRow } from "./studioConfig";
import { schemaToDraft, type Draft } from "./templateSchema";

function unwrap<T>(result: { data: T[] | null; error: unknown }, what: string): T[] {
  if (result.error) throw new Error(`Student Intake ${what} could not be loaded.`);
  return result.data ?? [];
}

/** Loads the configuration with the signed-in user's client (RLS: active staff of the studio only). */
export async function loadConfigView(supabase: SupabaseClient, studioId: string): Promise<ConfigView> {
  const [settings, templates, versions, assignments] = await Promise.all([
    supabase.from("intake_settings").select("studio_id, enabled, enabled_at, default_template_id").eq("studio_id", studioId),
    supabase.from("intake_templates").select("id, studio_id, name, status, created_at").eq("studio_id", studioId),
    supabase.from("intake_template_versions").select("id, studio_id, template_id, version_number, status, published_at").eq("studio_id", studioId),
    supabase.from("intake_service_assignments").select("studio_id, appointment_type, template_id").eq("studio_id", studioId),
  ]);
  return shapeConfig(studioId, {
    settings: unwrap<SettingsRow>(settings, "settings")[0] ?? null,
    templates: unwrap<TemplateRow>(templates, "templates"),
    versions: unwrap<VersionRow>(versions, "versions"),
    assignments: unwrap<AssignmentRow>(assignments, "lesson types"),
  });
}

/** Loads the editable draft for a template: its open draft version, else a copy of its latest published version. */
export async function loadTemplateDraft(
  supabase: SupabaseClient,
  studioId: string,
  templateId: string,
): Promise<{ draft: Draft; basedOn: "draft" | "published"; versionNumber: number } | null> {
  const [templates, versions] = await Promise.all([
    supabase.from("intake_templates").select("id, studio_id, name, status").eq("studio_id", studioId).eq("id", templateId),
    supabase
      .from("intake_template_versions")
      .select("id, studio_id, template_id, version_number, status, schema")
      .eq("studio_id", studioId)
      .eq("template_id", templateId),
  ]);
  const template = unwrap<TemplateRow>(templates, "template").find((t) => t.id === templateId && t.studio_id === studioId);
  if (!template) return null;
  const own = unwrap<{ id: string; studio_id: string; template_id: string; version_number: number; status: string; schema: unknown }>(
    versions,
    "template",
  ).filter((v) => v.template_id === templateId && v.studio_id === studioId);
  const draft = own.find((v) => v.status === "draft");
  const published = own.filter((v) => v.status === "published").sort((a, b) => b.version_number - a.version_number)[0];
  const source = draft ?? published;
  if (!source) return null;
  return { draft: schemaToDraft(template.name, source.schema), basedOn: draft ? "draft" : "published", versionNumber: source.version_number };
}
