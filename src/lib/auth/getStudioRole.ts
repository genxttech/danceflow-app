import { createClient } from "@/lib/supabase/server";

export async function getCurrentStudioRole() {
  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return null;
  }

  const { data: roleRow, error } = await supabase
    .from("user_studio_roles")
    .select("studio_id, role")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (error || !roleRow) {
    return null;
  }

  return {
    user,
    studioId: roleRow.studio_id as string,
    role: roleRow.role as string,
  };
}