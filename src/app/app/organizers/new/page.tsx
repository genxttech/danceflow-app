import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import OrganizerForm from "../OrganizerForm";

type ExistingOrganizerRow = {
  id: string;
  name: string;
  slug: string;
};

export default async function NewOrganizerPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  const { data: existingOrganizer, error } = await supabase
    .from("organizers")
    .select("id, name, slug")
    .eq("studio_id", context.studioId)
    .limit(1)
    .maybeSingle<ExistingOrganizerRow>();

  if (error) {
    throw new Error(`Failed to load organizer state: ${error.message}`);
  }

  if (existingOrganizer) {
    redirect("/app/organizers");
  }

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <OrganizerForm />
    </div>
  );
}