"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function firstJoin<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function inferStyleName(danceName: string) {
  const normalized = danceName.trim().toLowerCase();

  if (
    [
      "country two step",
      "triple two step",
      "polka",
      "country waltz",
      "nightclub two step",
      "line dance",
    ].includes(normalized)
  ) {
    return "Country";
  }

  if (
    [
      "waltz",
      "foxtrot",
      "tango",
      "viennese waltz",
      "quickstep",
      "rumba",
      "bolero",
      "mambo",
      "samba",
      "jive",
      "hustle",
    ].includes(normalized)
  ) {
    return "Ballroom";
  }

  // Cha Cha and East/West Coast Swing can belong to multiple studio systems.
  // New records should always provide styleName explicitly. Legacy fallback
  // remains intentionally neutral instead of forcing one canonical style.
  return "Uncategorized";
}

async function ensureCurriculumPath(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  styleName: string;
  danceName: string;
  levelName: string;
}) {
  const { supabase, studioId, styleName, danceName, levelName } = params;
  const { data: userData } = await supabase.auth.getUser();
  const createdBy = userData.user?.id ?? null;

  const { data: style, error: styleError } = await supabase
    .from("syllabus_styles")
    .upsert(
      {
        studio_id: studioId,
        name: styleName,
        status: "active",
        created_by: createdBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "studio_id,name" },
    )
    .select("id")
    .single();

  if (styleError || !style) throw new Error("syllabus_style_create_failed");

  const { data: dance, error: danceError } = await supabase
    .from("syllabus_dances")
    .upsert(
      {
        studio_id: studioId,
        style_id: style.id,
        name: danceName,
        status: "active",
        created_by: createdBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "style_id,name" },
    )
    .select("id")
    .single();

  if (danceError || !dance) throw new Error("syllabus_dance_create_failed");

  const { data: level, error: levelError } = await supabase
    .from("syllabus_levels")
    .upsert(
      {
        studio_id: studioId,
        dance_id: dance.id,
        name: levelName,
        status: "active",
        created_by: createdBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "dance_id,name" },
    )
    .select("id")
    .single();

  if (levelError || !level) throw new Error("syllabus_level_create_failed");

  return { styleId: style.id, danceId: dance.id, levelId: level.id, createdBy };
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
  const styleName = getString(formData, "styleName");
  const danceName = getString(formData, "danceName");
  const legacyDanceStyle = getString(formData, "danceStyle");
  const levelName = getString(formData, "level") || "All Levels";
  const description = getString(formData, "description");
  const resolvedDanceName = danceName || legacyDanceStyle;
  const resolvedStyleName = styleName || inferStyleName(resolvedDanceName);

  const allowedDancesByStyle: Record<string, string[]> = {
    Country: [
      "Country Two Step",
      "Triple Two Step",
      "Polka",
      "Country Waltz",
      "Nightclub Two Step",
      "Line Dance",
      "Cha Cha",
      "East Coast Swing",
      "West Coast Swing",
    ],
    Ballroom: [
      "Waltz",
      "Foxtrot",
      "Tango",
      "Viennese Waltz",
      "Quickstep",
      "Rumba",
      "Cha Cha",
      "Bolero",
      "Mambo",
      "Samba",
      "East Coast Swing",
      "West Coast Swing",
    ],
    "Social / Latin": [
      "Salsa",
      "Bachata",
      "Argentine Tango",
      "Merengue",
      "Cha Cha",
      "East Coast Swing",
      "West Coast Swing",
      "Other",
    ],
    Uncategorized: [],
  };

  if (!name) redirectWithResult(returnTo, "error", "syllabus_name_required");
  if (!resolvedDanceName) redirectWithResult(returnTo, "error", "dance_style_required");

  const allowedDances = allowedDancesByStyle[resolvedStyleName];
  if (
    styleName &&
    (!allowedDances || !allowedDances.includes(resolvedDanceName))
  ) {
    redirectWithResult(returnTo, "error", "syllabus_style_dance_mismatch");
  }

  let curriculumPath: Awaited<ReturnType<typeof ensureCurriculumPath>>;

  try {
    curriculumPath = await ensureCurriculumPath({
      supabase,
      studioId,
      styleName: resolvedStyleName,
      danceName: resolvedDanceName,
      levelName,
    });
  } catch {
    redirectWithResult(returnTo, "error", "syllabus_hierarchy_create_failed");
  }

  const { error } = await supabase.from("syllabus_templates").insert({
    studio_id: studioId,
    name,
    dance_style: resolvedDanceName,
    level: levelName,
    description: description || null,
    dance_id: curriculumPath.danceId,
    level_id: curriculumPath.levelId,
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
    .select("id, studio_id, dance_id, level_id")
    .eq("id", templateId)
    .eq("studio_id", studioId)
    .single();

  if (templateError || !template?.dance_id) {
    redirectWithResult(returnTo, "error", "syllabus_template_not_found");
  }

  const { count } = await supabase
    .from("syllabus_template_items")
    .select("id", { count: "exact", head: true })
    .eq("template_id", templateId)
    .eq("studio_id", studioId);

  const { data: userData } = await supabase.auth.getUser();
  const sortOrder = count ?? 0;

  const { data: step, error: stepError } = await supabase
    .from("syllabus_steps")
    .upsert(
      {
        studio_id: studioId,
        dance_id: template.dance_id,
        level_id: template.level_id,
        name: title,
        summary: description || null,
        sort_order: sortOrder,
        status: "active",
        created_by: userData.user?.id ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "dance_id,level_id,name" },
    )
    .select("id")
    .single();

  if (stepError || !step) {
    redirectWithResult(returnTo, "error", "syllabus_step_create_failed");
  }

  const { error } = await supabase.from("syllabus_template_items").insert({
    studio_id: studioId,
    template_id: templateId,
    syllabus_step_id: step.id,
    title,
    category: category || null,
    description: description || null,
    sort_order: sortOrder,
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

export async function updateSyllabusStepDetailsAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/syllabus";
  const { supabase, studioId } = await getSyllabusStudioContext(returnTo);

  const stepId = getString(formData, "stepId");
  const name = getString(formData, "name");
  const alternateName = getString(formData, "alternateName");
  const summary = getString(formData, "summary");
  const prerequisiteNotes = getString(formData, "prerequisiteNotes");
  const timing = getString(formData, "timing");
  const counts = getString(formData, "counts");
  const startingPosition = getString(formData, "startingPosition");
  const endingPosition = getString(formData, "endingPosition");
  const techniqueNotes = getString(formData, "techniqueNotes");
  const instructorNotes = getString(formData, "instructorNotes");
  const studentNotes = getString(formData, "studentNotes");
  const status = getString(formData, "status") || "active";

  if (!stepId) redirectWithResult(returnTo, "error", "syllabus_step_required");
  if (!name) redirectWithResult(returnTo, "error", "syllabus_step_name_required");
  if (!["draft", "active", "archived"].includes(status)) {
    redirectWithResult(returnTo, "error", "syllabus_step_status_invalid");
  }

  const { error } = await supabase
    .from("syllabus_steps")
    .update({
      name,
      alternate_name: alternateName || null,
      summary: summary || null,
      prerequisite_notes: prerequisiteNotes || null,
      timing: timing || null,
      counts: counts || null,
      starting_position: startingPosition || null,
      ending_position: endingPosition || null,
      technique_notes: techniqueNotes || null,
      instructor_notes: instructorNotes || null,
      student_notes: studentNotes || null,
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", stepId)
    .eq("studio_id", studioId);

  if (error) {
    redirectWithResult(returnTo, "error", "syllabus_step_update_failed");
  }

  // Keep the existing assignment-facing template item title/description in sync.
  await supabase
    .from("syllabus_template_items")
    .update({
      title: name,
      description: summary || null,
      active: status !== "archived",
      updated_at: new Date().toISOString(),
    })
    .eq("syllabus_step_id", stepId)
    .eq("studio_id", studioId);

  revalidatePath("/app/syllabus");
  redirectWithResult(returnTo, "success", "syllabus_step_updated");
}

export async function saveSyllabusStepChartAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/syllabus";
  const { supabase, studioId } = await getSyllabusStudioContext(returnTo);

  const stepId = getString(formData, "stepId");
  const title = getString(formData, "title") || "Dance chart";
  const chartFormat = getString(formData, "chartFormat") || "partner";
  const notes = getString(formData, "chartNotes");

  if (!stepId) redirectWithResult(returnTo, "error", "syllabus_step_required");
  if (!["partner", "solo", "custom"].includes(chartFormat)) {
    redirectWithResult(returnTo, "error", "syllabus_chart_format_invalid");
  }

  const { data: step } = await supabase
    .from("syllabus_steps")
    .select("id")
    .eq("id", stepId)
    .eq("studio_id", studioId)
    .single();

  if (!step) redirectWithResult(returnTo, "error", "syllabus_step_required");

  const { data: userData } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("syllabus_step_charts")
    .upsert(
      {
        studio_id: studioId,
        syllabus_step_id: stepId,
        title,
        chart_format: chartFormat,
        notes: notes || null,
        created_by: userData.user?.id ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "syllabus_step_id" },
    );

  if (error) redirectWithResult(returnTo, "error", "syllabus_chart_save_failed");

  revalidatePath("/app/syllabus");
  redirectWithResult(returnTo, "success", "syllabus_chart_saved");
}

export async function addSyllabusStepChartRowAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/syllabus";
  const { supabase, studioId } = await getSyllabusStudioContext(returnTo);

  const stepId = getString(formData, "stepId");
  if (!stepId) redirectWithResult(returnTo, "error", "syllabus_step_required");

  const { data: chart } = await supabase
    .from("syllabus_step_charts")
    .select("id")
    .eq("syllabus_step_id", stepId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (!chart) redirectWithResult(returnTo, "error", "syllabus_chart_required");

  const { count } = await supabase
    .from("syllabus_step_chart_rows")
    .select("id", { count: "exact", head: true })
    .eq("chart_id", chart.id)
    .eq("studio_id", studioId);

  const { data: userData } = await supabase.auth.getUser();

  const { error } = await supabase.from("syllabus_step_chart_rows").insert({
    studio_id: studioId,
    chart_id: chart.id,
    sort_order: count ?? 0,
    count_label: getString(formData, "countLabel") || null,
    leader_foot: getString(formData, "leaderFoot") || null,
    leader_action: getString(formData, "leaderAction") || null,
    follower_foot: getString(formData, "followerFoot") || null,
    follower_action: getString(formData, "followerAction") || null,
    direction: getString(formData, "direction") || null,
    notes: getString(formData, "rowNotes") || null,
    created_by: userData.user?.id ?? null,
  });

  if (error) redirectWithResult(returnTo, "error", "syllabus_chart_row_add_failed");

  revalidatePath("/app/syllabus");
  redirectWithResult(returnTo, "success", "syllabus_chart_row_added");
}

export async function updateSyllabusStepChartRowAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/syllabus";
  const { supabase, studioId } = await getSyllabusStudioContext(returnTo);

  const rowId = getString(formData, "rowId");
  if (!rowId) redirectWithResult(returnTo, "error", "syllabus_chart_row_required");

  const sortOrderRaw = getString(formData, "sortOrder");
  const sortOrder = Number.parseInt(sortOrderRaw || "0", 10);

  const { error } = await supabase
    .from("syllabus_step_chart_rows")
    .update({
      sort_order: Number.isFinite(sortOrder) ? sortOrder : 0,
      count_label: getString(formData, "countLabel") || null,
      leader_foot: getString(formData, "leaderFoot") || null,
      leader_action: getString(formData, "leaderAction") || null,
      follower_foot: getString(formData, "followerFoot") || null,
      follower_action: getString(formData, "followerAction") || null,
      direction: getString(formData, "direction") || null,
      notes: getString(formData, "rowNotes") || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", rowId)
    .eq("studio_id", studioId);

  if (error) redirectWithResult(returnTo, "error", "syllabus_chart_row_update_failed");

  revalidatePath("/app/syllabus");
  redirectWithResult(returnTo, "success", "syllabus_chart_row_updated");
}

export async function deleteSyllabusStepChartRowAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/syllabus";
  const { supabase, studioId } = await getSyllabusStudioContext(returnTo);

  const rowId = getString(formData, "rowId");
  if (!rowId) redirectWithResult(returnTo, "error", "syllabus_chart_row_required");

  const { error } = await supabase
    .from("syllabus_step_chart_rows")
    .delete()
    .eq("id", rowId)
    .eq("studio_id", studioId);

  if (error) redirectWithResult(returnTo, "error", "syllabus_chart_row_delete_failed");

  revalidatePath("/app/syllabus");
  redirectWithResult(returnTo, "success", "syllabus_chart_row_deleted");
}

export async function createSyllabusStepVideoAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/syllabus";
  const { supabase, studioId } = await getSyllabusStudioContext(returnTo);

  const stepId = getString(formData, "stepId");
  const title = getString(formData, "title");
  const description = getString(formData, "description");
  const contentType = getString(formData, "contentType") || "figure";
  const presentationType = getString(formData, "presentationType") || "demonstration";
  const visibility = getString(formData, "visibility") || "assigned_students";

  const contentTypes = new Set([
    "figure",
    "technique",
    "practice_drill",
    "general_instruction",
    "course_lesson",
  ]);
  const presentationTypes = new Set([
    "demonstration",
    "explanation",
    "leader",
    "follower",
    "slow_motion",
    "full_speed",
  ]);
  const visibilityValues = new Set([
    "private",
    "assigned_students",
    "studio_students",
  ]);

  if (!stepId) redirectWithResult(returnTo, "error", "syllabus_step_required");
  if (!title) redirectWithResult(returnTo, "error", "syllabus_video_title_required");
  if (!contentTypes.has(contentType)) {
    redirectWithResult(returnTo, "error", "syllabus_video_content_type_invalid");
  }
  if (!presentationTypes.has(presentationType)) {
    redirectWithResult(returnTo, "error", "syllabus_video_presentation_type_invalid");
  }
  if (!visibilityValues.has(visibility)) {
    redirectWithResult(returnTo, "error", "syllabus_video_visibility_invalid");
  }

  const { data: step, error: stepError } = await supabase
    .from("syllabus_steps")
    .select("id, dance_id, level_id, syllabus_dances(style_id)")
    .eq("id", stepId)
    .eq("studio_id", studioId)
    .single();

  if (stepError || !step) {
    redirectWithResult(returnTo, "error", "syllabus_step_required");
  }

  const dance = firstJoin(
    step.syllabus_dances as { style_id: string | null } | { style_id: string | null }[] | null,
  );
  const { data: userData } = await supabase.auth.getUser();

  const { data: asset, error: assetError } = await supabase
    .from("studio_video_assets")
    .insert({
      studio_id: studioId,
      title,
      description: description || null,
      content_type: contentType,
      presentation_type: presentationType,
      style_id: dance?.style_id ?? null,
      dance_id: step.dance_id,
      level_id: step.level_id,
      step_id: stepId,
      visibility,
      status: "draft",
      created_by: userData.user?.id ?? null,
      updated_by: userData.user?.id ?? null,
    })
    .select("id")
    .single();

  if (assetError || !asset) {
    redirectWithResult(returnTo, "error", "syllabus_video_create_failed");
  }

  const { count } = await supabase
    .from("syllabus_step_videos")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("syllabus_step_id", stepId);

  const { error: linkError } = await supabase.from("syllabus_step_videos").insert({
    studio_id: studioId,
    syllabus_step_id: stepId,
    video_asset_id: asset.id,
    display_order: count ?? 0,
    student_visible: visibility !== "private",
    created_by: userData.user?.id ?? null,
  });

  if (linkError) {
    await supabase
      .from("studio_video_assets")
      .delete()
      .eq("id", asset.id)
      .eq("studio_id", studioId);

    redirectWithResult(returnTo, "error", "syllabus_video_create_failed");
  }

  revalidatePath("/app/syllabus");
  redirectWithResult(returnTo, "success", "syllabus_video_created");
}

export async function removeSyllabusStepVideoAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/syllabus";
  const { supabase, studioId } = await getSyllabusStudioContext(returnTo);

  const videoAssetId = getString(formData, "videoAssetId");
  if (!videoAssetId) {
    redirectWithResult(returnTo, "error", "syllabus_video_required");
  }

  const { error } = await supabase
    .from("studio_video_assets")
    .update({
      status: "archived",
      updated_at: new Date().toISOString(),
    })
    .eq("id", videoAssetId)
    .eq("studio_id", studioId);

  if (error) {
    redirectWithResult(returnTo, "error", "syllabus_video_archive_failed");
  }

  revalidatePath("/app/syllabus");
  redirectWithResult(returnTo, "success", "syllabus_video_archived");
}

