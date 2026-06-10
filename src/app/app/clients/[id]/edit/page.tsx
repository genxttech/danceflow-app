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
  birthday: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  status: string;
  skill_level: string | null;
  dance_interests: string | null;
  referral_source: string | null;
  notes: string | null;
  photo_url: string | null;
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
        birthday,
        address_line1,
        address_line2,
        city,
        state,
        postal_code,
        country,
        status,
        skill_level,
        dance_interests,
        referral_source,
        notes,
        photo_url,
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
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow CRM
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Edit Client
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Update profile details, contact information, and follow-up context
                so every studio workflow uses the same client record.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href={`/app/clients/${id}`}
                className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-[var(--brand-primary)] hover:bg-white/90"
              >
                Back to Profile
              </Link>
              <Link
                href="/app/clients"
                className="inline-flex items-center justify-center rounded-xl border border-white/25 bg-white/10 px-4 py-2.5 text-sm font-medium text-white backdrop-blur hover:bg-white/20"
              >
                Back to Clients
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">Contact Ready</h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                Keep email and phone details accurate for reminders, payments, and follow-up.
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">Personalized</h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                Capture interests and skill level so instructors know what matters.
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">Follow-Up Clear</h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Status and notes help the front desk keep every next step moving.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-4xl">
        <EditClientForm client={client as ClientRow} />
      </div>
    </div>
  );
}