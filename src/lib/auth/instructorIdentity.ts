import type { SupabaseClient } from "@supabase/supabase-js";

// FC-1B5D: shared helper for resolving the currently authenticated user's
// own instructors.id at a given studio -- used everywhere an
// instructor-role viewer's own appointments/schedule surfaces need to be
// scoped to their own teaching context rather than the studio-wide
// default. Mirrors the pattern already used in
// src/lib/integrations/google-calendar/access.ts. Returns null when the
// caller has no active instructor row at that studio (e.g. a role that is
// "instructor" in user_studio_roles but has not been linked to an
// instructors row yet) -- callers must treat null as "no own schedule",
// never as "show everyone's".
export async function resolveViewerInstructorId(
  supabase: SupabaseClient,
  studioId: string,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("instructors")
    .select("id")
    .eq("studio_id", studioId)
    .eq("user_id", userId)
    .eq("active", true)
    .maybeSingle();

  return data?.id ?? null;
}
