"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseServiceClient } from "@supabase/supabase-js";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type AriaActionStatus = "completed" | "dismissed" | "snoozed";

function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) return null;

  return createSupabaseServiceClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function readText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function normalizePriority(value: string) {
  const normalized = value.trim().toLowerCase();

  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }

  return "medium";
}

function normalizeStatus(value: string): AriaActionStatus {
  const normalized = value.trim().toLowerCase();

  if (
    normalized === "completed" ||
    normalized === "dismissed" ||
    normalized === "snoozed"
  ) {
    return normalized;
  }

  throw new Error("Invalid ARIA action status.");
}

export async function updateOrganizerAriaActionStatusAction(
  formData: FormData,
) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("You must be signed in to update ARIA actions.");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  if (!studioId) {
    throw new Error("No active workspace found.");
  }

  const writeSupabase = createServiceRoleClient() ?? supabase;

  const actionKey = readText(formData, "actionKey");
  const actionType = readText(formData, "actionType") || "organizer_action";
  const priority = normalizePriority(readText(formData, "priority"));
  const title = readText(formData, "title");
  const reason = readText(formData, "reason");
  const recommendedNextStep = readText(formData, "recommendedNextStep");
  const targetUrl = readText(formData, "targetUrl");
  const eventId = readText(formData, "eventId") || null;
  const status = normalizeStatus(readText(formData, "status"));

  if (!actionKey) {
    throw new Error("Missing ARIA action key.");
  }

  if (!title) {
    throw new Error("Missing ARIA action title.");
  }

  const now = new Date();
  const snoozedUntil =
    status === "snoozed"
      ? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
      : null;

  const statusFields =
    status === "completed"
      ? {
          completed_at: now.toISOString(),
          completed_by: user.id,
          dismissed_at: null,
          dismissed_by: null,
        }
      : status === "dismissed"
        ? {
            completed_at: null,
            completed_by: null,
            dismissed_at: now.toISOString(),
            dismissed_by: user.id,
          }
        : {
            completed_at: null,
            completed_by: null,
            dismissed_at: null,
            dismissed_by: null,
          };

  const { data: existingAction, error: existingActionError } = await writeSupabase
    .from("aria_action_items")
    .select("id")
    .eq("studio_id", studioId)
    .eq("action_key", actionKey)
    .maybeSingle<{ id: string }>();

  if (existingActionError) {
    throw new Error(
      `Failed to check ARIA action state: ${existingActionError.message}`,
    );
  }

  const payload = {
    studio_id: studioId,
    organizer_id: null,
    event_id: eventId,
    source: "organizer_aria",
    action_key: actionKey,
    action_type: actionType,
    priority,
    title,
    reason,
    recommended_next_step: recommendedNextStep,
    target_url: targetUrl,
    status,
    snoozed_until: snoozedUntil,
    metadata: {
      updated_from: "organizer_event_action_queue",
      original_priority: readText(formData, "priority"),
    },
    ...statusFields,
  };

  if (existingAction?.id) {
    const { error: updateError } = await writeSupabase
      .from("aria_action_items")
      .update(payload)
      .eq("id", existingAction.id);

    if (updateError) {
      throw new Error(`Failed to update ARIA action: ${updateError.message}`);
    }
  } else {
    const { error: insertError } = await writeSupabase
      .from("aria_action_items")
      .insert({
        ...payload,
        created_by: user.id,
      });

    if (insertError) {
      throw new Error(`Failed to save ARIA action: ${insertError.message}`);
    }
  }

  revalidatePath("/app");
  revalidatePath("/app/events");
  redirect("/app/events?ariaAction=updated");
}
