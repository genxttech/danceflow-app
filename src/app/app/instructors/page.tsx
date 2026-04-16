import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { deactivateInstructorAction } from "./actions";
import { canManageInstructors } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type InstructorRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  specialties: string | null;
  active: boolean;
  created_at: string;
};

export default async function InstructorsPage() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!canManageInstructors(role)) {
    redirect("/app");
  }

  const { data: instructors, error } = await supabase
    .from("instructors")
    .select("id, first_name, last_name, email, phone, specialties, active, created_at")
    .eq("studio_id", studioId)
    .order("first_name", { ascending: true });

  if (error) {
    throw new Error(`Failed to load instructors: ${error.message}`);
  }

  const typedInstructors = (instructors ?? []) as InstructorRow[];
  const activeCount = typedInstructors.filter((item) => item.active).length;
  const inactiveCount = typedInstructors.filter((item) => !item.active).length;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Instructors</h2>
          <p className="mt-2 text-slate-600">Manage studio instructors.</p>
        </div>

        <Link
          href="/app/instructors/new"
          className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
        >
          New Instructor
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Total Instructors</p>
          <p className="mt-2 text-3xl font-semibold">{typedInstructors.length}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Active</p>
          <p className="mt-2 text-3xl font-semibold">{activeCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Inactive</p>
          <p className="mt-2 text-3xl font-semibold">{inactiveCount}</p>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr className="text-left text-slate-600">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-4 py-3 font-medium">Specialties</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {typedInstructors.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  No instructors yet.
                </td>
              </tr>
            ) : (
              typedInstructors.map((instructor) => (
                <tr key={instructor.id} className="border-t">
                  <td className="px-4 py-3 font-medium text-slate-900">
                    <Link
                      href={`/app/instructors/${instructor.id}`}
                      className="hover:underline"
                    >
                      {instructor.first_name} {instructor.last_name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{instructor.email ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{instructor.phone ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{instructor.specialties ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {instructor.active ? "active" : "inactive"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/app/instructors/${instructor.id}`}
                        className="text-slate-900 underline"
                      >
                        View
                      </Link>
                      <Link
                        href={`/app/instructors/${instructor.id}/edit`}
                        className="text-slate-900 underline"
                      >
                        Edit
                      </Link>
                      {instructor.active ? (
                        <form action={deactivateInstructorAction}>
                          <input type="hidden" name="instructorId" value={instructor.id} />
                          <button type="submit" className="text-red-600 underline">
                            Deactivate
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}