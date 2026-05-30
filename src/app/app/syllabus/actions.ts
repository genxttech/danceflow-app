"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function redirectWithResult(returnTo: string, key: "success" | "error", value: string): never {
  const separator = returnTo.includes("?") ? "&" : "?";
  redirect(`${returnTo}${separator}${key}=${value}`);
}

function canManageSyllabus(role: string) {
  return [
    "studio_owner",
    "studio_admin",
    "front_desk",
    "instructor",
    "independent_instructor",
  ].includes(role);
}

async function getSyllabusStudioContext(returnTo = "/app/syllabus") {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!studioId || !canManageSyllabus(role)) {
    redirectWithResult(returnTo, "error", "unauthorized");
  }

  return { supabase, studioId };
}

export async function createSyllabusTemplateAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/syllabus";
  const { supabase, studioId } = await getSyllabusStudioContext(returnTo);

  const name = getString(formData, "name");
  const danceStyle = getString(formData, "danceStyle");
  const level = getString(formData, "level");
  const description = getString(formData, "description");

  if (!name) redirectWithResult(returnTo, "error", "syllabus_name_required");
  if (!danceStyle) redirectWithResult(returnTo, "error", "dance_style_required");

  const { error } = await supabase.from("syllabus_templates").insert({
    studio_id: studioId,
    name,
    dance_style: danceStyle,
    level: level || null,
    description: description || null,
    active: true,
  });

  if (error) redirectWithResult(returnTo, "error", "syllabus_template_create_failed");

  revalidatePath("/app/syllabus");
  redirectWithResult(returnTo, "success", "syllabus_template_created");
}

export async function addSyllabusTemplateItemAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/syllabus";
  const { supabase, studioId } = await getSyllabusStudioContext(returnTo);

  const templateId = getString(formData, "templateId");
  const title = getString(formData, "title");
  const category = getString(formData, "category");
  const description = getString(formData, "description");

  if (!templateId) redirectWithResult(returnTo, "error", "syllabus_template_required");
  if (!title) redirectWithResult(returnTo, "error", "syllabus_item_title_required");

  const { data: template, error: templateError } = await supabase
    .from("syllabus_templates")
    .select("id, studio_id")
    .eq("id", templateId)
    .eq("studio_id", studioId)
    .single();

  if (templateError || !template) {
    redirectWithResult(returnTo, "error", "syllabus_template_not_found");
  }

  const { count } = await supabase
    .from("syllabus_template_items")
    .select("id", { count: "exact", head: true })
    .eq("template_id", templateId)
    .eq("studio_id", studioId);

  const { error } = await supabase.from("syllabus_template_items").insert({
    studio_id: studioId,
    template_id: templateId,
    title,
    category: category || null,
    description: description || null,
    sort_order: count ?? 0,
    active: true,
  });

  if (error) redirectWithResult(returnTo, "error", "syllabus_item_create_failed");

  revalidatePath("/app/syllabus");
  redirectWithResult(returnTo, "success", "syllabus_item_added");
}

export async function archiveSyllabusTemplateAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/syllabus";
  const { supabase, studioId } = await getSyllabusStudioContext(returnTo);

  const templateId = getString(formData, "templateId");
  if (!templateId) redirectWithResult(returnTo, "error", "syllabus_template_required");

  const { error } = await supabase
    .from("syllabus_templates")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("id", templateId)
    .eq("studio_id", studioId);

  if (error) redirectWithResult(returnTo, "error", "syllabus_template_archive_failed");

  revalidatePath("/app/syllabus");
  redirectWithResult(returnTo, "success", "syllabus_template_archived");
}

export async function archiveSyllabusTemplateItemAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/syllabus";
  const { supabase, studioId } = await getSyllabusStudioContext(returnTo);

  const itemId = getString(formData, "itemId");
  if (!itemId) redirectWithResult(returnTo, "error", "syllabus_item_required");

  const { error } = await supabase
    .from("syllabus_template_items")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("studio_id", studioId);

  if (error) redirectWithResult(returnTo, "error", "syllabus_item_archive_failed");

  revalidatePath("/app/syllabus");
  redirectWithResult(returnTo, "success", "syllabus_item_archived");
}
