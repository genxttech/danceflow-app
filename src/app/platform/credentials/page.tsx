import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import {
  approveInstructorCredentialAction,
  rejectInstructorCredentialAction,
  resetInstructorCredentialAction,
} from "@/app/platform/actions";

type SearchParams = Promise<{
  status?: string;
  saved?: string;
}>;

type CredentialRow = {
  id: string;
  studio_id: string;
  instructor_id: string;
  credential_type: string;
  name: string;
  issuing_organization: string | null;
  credential_year: number | null;
  proof_url: string | null;
  notes: string | null;
  public_enabled: boolean | null;
  display_order: number | null;
  verification_status: string | null;
  review_note: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  created_at: string | null;
  instructors:
    | {
        id: string;
        first_name: string;
        last_name: string;
        email: string | null;
        public_photo_url: string | null;
      }
    | {
        id: string;
        first_name: string;
        last_name: string;
        email: string | null;
        public_photo_url: string | null;
      }[]
    | null;
  studios:
    | {
        id: string;
        name: string;
        slug: string | null;
      }
    | {
        id: string;
        name: string;
        slug: string | null;
      }[]
    | null;
};

const statusFilters = [
  { key: "submitted", label: "Submitted" },
  { key: "verified", label: "Verified" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

function firstItem<T>(value: T | T[] | null | undefined) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function instructorName(credential: CredentialRow) {
  const instructor = firstItem(credential.instructors);
  if (!instructor) return "Unknown instructor";
  return `${instructor.first_name} ${instructor.last_name}`.trim() || "Unnamed instructor";
}

function studioName(credential: CredentialRow) {
  return firstItem(credential.studios)?.name ?? "Unknown studio";
}

function credentialTypeLabel(value: string | null | undefined) {
  if (value === "title") return "Title";
  if (value === "achievement") return "Achievement";
  return "Certification";
}

function statusClass(status: string | null | undefined) {
  if (status === "verified") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "rejected") return "bg-red-50 text-red-700 ring-red-200";
  return "bg-amber-50 text-amber-700 ring-amber-200";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export default async function PlatformCredentialsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePlatformAdmin();

  const query = await searchParams;
  const selectedStatus = query.status ?? "submitted";
  const supabase = await createClient();

  const baseCredentialSelect = `
    id,
    studio_id,
    instructor_id,
    credential_type,
    name,
    issuing_organization,
    credential_year,
    proof_url,
    notes,
    public_enabled,
    display_order,
    verification_status,
    review_note,
    submitted_at,
    reviewed_at,
    created_at,
    instructors:instructor_id(id, first_name, last_name, email, public_photo_url),
    studios:studio_id(id, name, slug)
  `;

  let request = supabase
    .from("instructor_credentials")
    .select(baseCredentialSelect)
    .order("submitted_at", { ascending: false });

  if (selectedStatus !== "all") {
    request = request.eq("verification_status", selectedStatus);
  }

  const [filteredResult, countResult] = await Promise.all([
    request,
    supabase.from("instructor_credentials").select("verification_status"),
  ]);

  if (filteredResult.error) {
    throw new Error(`Failed to load credentials: ${filteredResult.error.message}`);
  }

  if (countResult.error) {
    throw new Error(`Failed to load credential counts: ${countResult.error.message}`);
  }

  const credentials = (filteredResult.data ?? []) as CredentialRow[];
  const allCredentialStatuses = (countResult.data ?? []) as Array<{
    verification_status: string | null;
  }>;
  const counts = allCredentialStatuses.reduce(
    (acc, credential) => {
      const status = credential.verification_status ?? "submitted";
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  counts.all = allCredentialStatuses.length;

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 shadow-sm">
        <div className="p-6 text-white md:p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-amber-200">
            Platform Verification
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">
            Staff Credential Review
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-200 md:text-base">
            Review each instructor certification, title, or achievement individually. Verified public credentials can appear on a studio’s public Staff section.
          </p>
        </div>
      </section>

      {query.saved === "1" ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
          Credential review updated.
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-4">
        {statusFilters.map((filter) => (
          <Link
            key={filter.key}
            href={`/platform/credentials?status=${filter.key}`}
            className={`rounded-2xl border p-4 shadow-sm ${
              selectedStatus === filter.key
                ? "border-slate-950 bg-slate-950 text-white"
                : "border-slate-200 bg-white text-slate-800 hover:bg-slate-50"
            }`}
          >
            <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
              {filter.label}
            </p>
            <p className="mt-2 text-2xl font-bold">
              {counts[filter.key] ?? 0}
            </p>
          </Link>
        ))}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
              Credential Queue
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Approve, reject, or send credentials back to the submitted queue. Each credential has its own proof/reference.
            </p>
          </div>
        </div>

        {credentials.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-5 py-10 text-center text-sm text-slate-600">
            No credentials match this filter.
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            {credentials.map((credential) => {
              const instructor = firstItem(credential.instructors);
              const studio = firstItem(credential.studios);
              const status = credential.verification_status ?? "submitted";

              return (
                <article key={credential.id} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                          {credentialTypeLabel(credential.credential_type)}
                        </span>
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${statusClass(status)}`}>
                          {status}
                        </span>
                        {credential.public_enabled ? (
                          <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700 ring-1 ring-violet-100">
                            Public when verified
                          </span>
                        ) : (
                          <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
                            Internal only
                          </span>
                        )}
                      </div>

                      <h3 className="mt-3 text-xl font-semibold text-slate-950">
                        {credential.name}
                      </h3>
                      <p className="mt-1 text-sm text-slate-600">
                        {studioName(credential)} · {instructorName(credential)}
                      </p>
                      <p className="mt-1 text-sm text-slate-500">
                        {[credential.issuing_organization, credential.credential_year]
                          .filter(Boolean)
                          .join(" · ") || "No issuer/year listed"}
                      </p>
                      <p className="mt-2 text-xs text-slate-500">
                        Submitted {formatDate(credential.submitted_at ?? credential.created_at)}
                        {credential.reviewed_at ? ` · Reviewed ${formatDate(credential.reviewed_at)}` : ""}
                      </p>

                      {credential.proof_url ? (
                        <a
                          href={credential.proof_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 inline-flex rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          Open proof / reference
                        </a>
                      ) : (
                        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                          No proof URL was provided. Review carefully before approving.
                        </p>
                      )}

                      {credential.notes ? (
                        <p className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
                          Studio note: {credential.notes}
                        </p>
                      ) : null}

                      {credential.review_note ? (
                        <p className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
                          Review note: {credential.review_note}
                        </p>
                      ) : null}

                      <div className="mt-4 flex flex-wrap gap-3">
                        {studio?.slug ? (
                          <Link
                            href={`/studios/${studio.slug}?tab=staff`}
                            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            Public Staff Page
                          </Link>
                        ) : null}
                        {instructor?.id ? (
                          <Link
                            href={`/app/instructors/${instructor.id}`}
                            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            Instructor Profile
                          </Link>
                        ) : null}
                      </div>
                    </div>

                    <div className="w-full space-y-3 rounded-2xl border border-slate-200 bg-white p-4 lg:w-80">
                      <p className="text-sm font-semibold text-slate-950">Review action</p>
                      <form action={approveInstructorCredentialAction} className="space-y-3">
                        <input type="hidden" name="credentialId" value={credential.id} />
                        <input type="hidden" name="currentStatus" value={selectedStatus} />
                        <textarea
                          name="reviewNote"
                          rows={2}
                          placeholder="Optional approval note"
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                        />
                        <button className="w-full rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
                          Approve
                        </button>
                      </form>

                      <form action={rejectInstructorCredentialAction} className="space-y-3">
                        <input type="hidden" name="credentialId" value={credential.id} />
                        <input type="hidden" name="currentStatus" value={selectedStatus} />
                        <textarea
                          name="reviewNote"
                          rows={2}
                          placeholder="Reason for rejection"
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                        />
                        <button className="w-full rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700">
                          Reject
                        </button>
                      </form>

                      {status !== "submitted" ? (
                        <form action={resetInstructorCredentialAction}>
                          <input type="hidden" name="credentialId" value={credential.id} />
                          <input type="hidden" name="currentStatus" value={selectedStatus} />
                          <button className="w-full rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                            Send back to queue
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
