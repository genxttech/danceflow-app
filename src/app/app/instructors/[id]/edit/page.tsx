import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import InstructorEditForm from "./InstructorEditForm";

type InstructorRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  active: boolean;
  specialties: string | null;
  bio: string | null;
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

  const { data: instructor, error } = await supabase
    .from("instructors")
    .select("*")
    .eq("id", id)
    .eq("studio_id", studioId)
    .single();

  if (error || !instructor) {
    notFound();
  }

  return <InstructorEditForm instructor={instructor as InstructorRow} />;
}