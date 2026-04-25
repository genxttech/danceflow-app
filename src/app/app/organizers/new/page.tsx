import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import OrganizerForm from "../OrganizerForm";

type ExistingOrganizerRow = {
  id: string;
  name: string;
  slug: string;
};

function canManageOrganizers(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;
  return role === "organizer_owner" || role === "organizer_admin";
}

export default async function NewOrganizerPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  if (!canManageOrganizers(context.studioRole, context.isPlatformAdmin)) {
    redirect("/app/organizers");
  }

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
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Organizer Workspace
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Create Organizer Profile
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Build the organizer profile that powers your public event presence,
                registrations, and branding across the platform.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/organizers"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Back to Organizer
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
            <h2 className="text-lg font-semibold text-sky-950">
              One primary organizer profile per organizer workspace
            </h2>
            <p className="mt-2 text-sm leading-7 text-sky-900">
              This organizer profile becomes the foundation for public discovery,
              event publishing, and registration management.
            </p>
          </div>
        </div>
      </section>

      <OrganizerForm />
    </div>
  );
}