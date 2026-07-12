import "server-only";

import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageSettings } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";

export type GoogleCalendarScope = "studio" | "instructor";

export async function getGoogleCalendarAccess(scope: GoogleCalendarScope) {
  const context = await getCurrentStudioContext();
  const supabase = await createClient();

  if (scope === "studio") {
    if (!canManageSettings(context.studioRole ?? "")) {
      throw new Error("You do not have permission to manage the studio calendar.");
    }

    return {
      supabase,
      context,
      scope,
      instructorId: null as string | null,
    };
  }

  const { data: instructor, error } = await supabase
    .from("instructors")
    .select("id, first_name, last_name, active")
    .eq("studio_id", context.studioId)
    .eq("user_id", context.userId)
    .eq("active", true)
    .maybeSingle<{
      id: string;
      first_name: string;
      last_name: string;
      active: boolean;
    }>();

  if (error) {
    throw new Error(`Failed to load your instructor profile: ${error.message}`);
  }
  if (!instructor) {
    throw new Error(
      "Your DanceFlow account is not linked to an active instructor profile in this studio.",
    );
  }

  return {
    supabase,
    context,
    scope,
    instructorId: instructor.id,
    instructor,
  };
}

export function parseGoogleCalendarScope(value: string | null | undefined): GoogleCalendarScope {
  return value === "instructor" ? "instructor" : "studio";
}

export function googleCalendarReturnPath(scope: GoogleCalendarScope) {
  return scope === "instructor"
    ? "/app/settings/integrations/google-calendar/personal"
    : "/app/settings/integrations/google-calendar";
}
