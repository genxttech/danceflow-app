import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import EditClientForm from "./EditClientForm";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type Params = Promise<{
  id: string;
}>;

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  skill_level: string | null;
  dance_interests: string | null;
  referral_source: string | null;
  notes: string | null;
  is_independent_instructor: boolean | null;
  linked_instructor_id: string | null;
};

type InstructorOption = {
  id: string;
  first_name: string;
  last_name: string;
  active: boolean;
};

export default async function EditClientPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  

const context = await getCurrentStudioContext();
const studioId = context.studioId;
const role = context.studioRole ?? "";

  const studioId = roleRow.studio_id as string;

  const [
    { data: client, error: clientError },
    { data: instructors, error: instructorsError },
  ] = await Promise.all([
    supabase
      .from("clients")
      .select(`
        id,
        first_name,
        last_name,
        email,
        phone,
        status,
        skill_level,
        dance_interests,
        referral_source,
        notes,
        is_independent_instructor,
        linked_instructor_id
      `)
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),

    supabase
      .from("instructors")
      .select("id, first_name, last_name, active")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("first_name", { ascending: true }),
  ]);

  if (clientError || !client) {
    notFound();
  }

  if (instructorsError) {
    throw new Error(`Failed to load instructors: ${instructorsError.message}`);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Edit Client</h2>
          <p className="mt-2 text-slate-600">
            Update client details with standardized CRM fields.
          </p>
        </div>

        <div className="flex gap-3">
          <Link
            href={`/app/clients/${id}`}
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Profile
          </Link>
          <Link
            href="/app/clients"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Clients
          </Link>
        </div>
      </div>

      <EditClientForm
        client={client as ClientRow}
        instructors={(instructors ?? []) as InstructorOption[]}
      />
    </div>
  );
}