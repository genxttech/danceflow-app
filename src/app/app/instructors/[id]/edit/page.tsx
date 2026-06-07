import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import InstructorEditForm from "./InstructorEditForm";

type InstructorCredentialRow = {
  id: string;
  credential_type: string;
  name: string;
  issuing_organization: string | null;
  credential_year: number | null;
  proof_url: string | null;
  notes: string | null;
  public_enabled: boolean;
  display_order: number;
  verification_status: string;
  review_note: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
};

type InstructorRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  active: boolean;
  specialties: string | null;
  bio: string | null;
  public_profile_enabled?: boolean | null;
  public_photo_url?: string | null;
  public_title?: string | null;
  public_bio?: string | null;
  public_specialties?: string | null;
  years_experience?: number | null;
  display_order?: number | null;
};

export default async function EditInstructorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;

  const [instructorResult, credentialsResult] = await Promise.all([
    supabase
      .from("instructors")
      .select("*")
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),
    supabase
      .from("instructor_credentials")
      .select(
        "id, credential_type, name, issuing_organization, credential_year, proof_url, notes, public_enabled, display_order, verification_status, review_note, submitted_at, reviewed_at"
      )
      .eq("instructor_id", id)
      .eq("studio_id", studioId)
      .order("display_order", { ascending: true })
      .order("created_at", { ascending: false }),
  ]);

  const instructor = instructorResult.data;
  const error = instructorResult.error;

  if (error || !instructor) {
    notFound();
  }

  if (credentialsResult.error) {
    throw new Error(`Failed to load instructor credentials: ${credentialsResult.error.message}`);
  }

  return (
    <InstructorEditForm
      instructor={instructor as InstructorRow}
      credentials={(credentialsResult.data ?? []) as InstructorCredentialRow[]}
    />
  );
}

