import Link from "next/link";
import OrganizerForm from "../OrganizerForm";

export default function NewOrganizerPage() {
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">
            New Organizer
          </h2>
          <p className="mt-2 text-slate-600">
            Create an organizer profile for event publishing and management.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/app/organizers"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Organizers
          </Link>
        </div>
      </div>

      <OrganizerForm />
    </div>
  );
}