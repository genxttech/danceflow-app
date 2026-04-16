import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";

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

export default async function InstructorDetailPage({
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

  const typedInstructor = instructor as InstructorRow;

  return (
    <div className="max-w-3xl space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">
            {typedInstructor.first_name} {typedInstructor.last_name}
          </h2>
          <p className="mt-2 text-slate-600">Instructor detail</p>
        </div>

        <div className="flex gap-3">
          <Link
            href={`/app/instructors/${typedInstructor.id}/edit`}
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Edit Instructor
          </Link>
          <Link
            href="/app/instructors"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Instructors
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Email</p>
          <p className="mt-1 font-medium">{typedInstructor.email ?? "—"}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Phone</p>
          <p className="mt-1 font-medium">{typedInstructor.phone ?? "—"}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Status</p>
          <p className="mt-1 font-medium">
            {typedInstructor.active ? "active" : "inactive"}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Specialties</p>
          <p className="mt-1 font-medium">{typedInstructor.specialties ?? "—"}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5 md:col-span-2">
          <p className="text-sm text-slate-500">Bio</p>
          <p className="mt-1 whitespace-pre-wrap text-slate-700">
            {typedInstructor.bio ?? "—"}
          </p>
        </div>
      </div>
    </div>
  );
}