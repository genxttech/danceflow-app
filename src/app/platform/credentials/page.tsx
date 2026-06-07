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

type InstructorCredentialRow = {
  id: string;
  studio_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  photo_url?: string | null;
  public_photo_url?: string | null;
  teaching_certifications: string | null;
  competitive_titles: string | null;
  credential_proof_url: string | null;
  credentials_verification_status: string | null;
  credentials_review_note: string | null;
  credentials_submitted_at: string | null;
  credentials_verified_at: string | null;
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

const FILTERS = [
  { value: "submitted", label: "Submitted" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
  { value: "unverified", label: "Unverified" },
  { value: "all", label: "All" },
];

function normalizeStatus(value: string | null | undefined) {
  const normalized = String(value ?? "submitted").trim().toLowerCase();

  if (["submitted", "verified", "rejected", "unverified", "all"].includes(normalized)) {
    return normalized;
  }

  return "submitted";
}

function fullName(instructor: InstructorCredentialRow) {
  return `${instructor.first_name ?? ""} ${instructor.last_name ?? ""}`.trim() || "Unnamed instructor";
}

function getStudio(
  value: InstructorCredentialRow["studios"],
): { id: string; name: string; slug: string | null } | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusBadgeClass(status: string | null | undefined) {
  const normalized = normalizeStatus(status);

  if (normalized === "verified") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  if (normalized === "submitted") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (normalized === "rejected") return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";

  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function splitLines(value: string | null | undefined) {
  return String(value ?? "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "DF";
}

function CredentialList({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
        {title}
      </p>
      {items.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm text-slate-700">
          {items.map((item) => (
            <li key={item} className="rounded-xl bg-slate-50 px-3 py-2">
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-slate-500">No details submitted.</p>
      )}
    </div>
  );
}

export default async function PlatformCredentialsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePlatformAdmin();

  const query = await searchParams;
  const statusFilter = normalizeStatus(query.status);
  const supabase = await createClient();

  let request = supabase
    .from("instructors")
    .select(
      `
        id,
        studio_id,
        first_name,
        last_name,
        email,
        photo_url,
        public_photo_url,
        teaching_certifications,
        competitive_titles,
        credential_proof_url,
        credentials_verification_status,
        credentials_review_note,
        credentials_submitted_at,
        credentials_verified_at,
        studios (
          id,
          name,
          slug
        )
      `,
    )
    .or(
      "teaching_certifications.not.is.null,competitive_titles.not.is.null,credential_proof_url.not.is.null",
    )
    .order("credentials_submitted_at", { ascending: false, nullsFirst: false })
    .order("last_name", { ascending: true });

  if (statusFilter !== "all") {
    request = request.eq("credentials_verification_status", statusFilter);
  }

  const { data: credentials, error } = await request;

  if (error) {
    throw new Error(`Failed to load instructor credentials: ${error.message}`);
  }

  const rows = (credentials ?? []) as InstructorCredentialRow[];
  const counts = FILTERS.reduce<Record<string, number>>((acc, filter) => {
    if (filter.value === "all") {
      acc[filter.value] = rows.length;
    } else {
      acc[filter.value] = rows.filter(
        (row) => normalizeStatus(row.credentials_verification_status) === filter.value,
      ).length;
    }
    return acc;
  }, {});

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 shadow-sm">
        <div className="p-6 text-white md:p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-cyan-200">
            Platform verification
          </p>
          <div className="mt-3 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
                Staff credential queue
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-200 md:text-base">
                Review teaching certifications, competitive titles, and proof links before
                credentials appear on public studio staff profiles.
              </p>
            </div>
            <Link
              href="/platform"
              className="inline-flex rounded-2xl border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Platform dashboard
            </Link>
          </div>
        </div>
      </section>

      {query.saved ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          Credential review saved.
        </div>
      ) : null}

      <section className="grid gap-3 md:grid-cols-5">
        {FILTERS.map((filter) => {
          const active = statusFilter === filter.value;
          return (
            <Link
              key={filter.value}
              href={`/platform/credentials?status=${filter.value}`}
              className={`rounded-2xl border p-4 shadow-sm transition ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
              }`}
            >
              <p className="text-xs font-semibold uppercase tracking-[0.16em] opacity-75">
                {filter.label}
              </p>
              <p className="mt-2 text-3xl font-bold">{counts[filter.value] ?? 0}</p>
            </Link>
          );
        })}
      </section>

      <section className="space-y-4">
        {rows.length > 0 ? (
          rows.map((row) => {
            const name = fullName(row);
            const studio = getStudio(row.studios);
            const photoUrl = row.photo_url || row.public_photo_url || null;
            const status = normalizeStatus(row.credentials_verification_status);
            const certifications = splitLines(row.teaching_certifications);
            const titles = splitLines(row.competitive_titles);

            return (
              <article
                key={row.id}
                className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6"
              >
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                  <div className="flex gap-4">
                    {photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={photoUrl}
                        alt={name}
                        className="h-16 w-16 rounded-2xl object-cover ring-1 ring-slate-200"
                      />
                    ) : (
                      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-900 text-lg font-bold text-white">
                        {initials(name)}
                      </div>
                    )}

                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold text-slate-950">{name}</h2>
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(
                            status,
                          )}`}
                        >
                          {status}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-slate-600">
                        {studio?.name ?? "Unknown studio"}
                        {row.email ? ` · ${row.email}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        Submitted {formatDateTime(row.credentials_submitted_at)}
                        {row.credentials_verified_at
                          ? ` · Verified ${formatDateTime(row.credentials_verified_at)}`
                          : ""}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {studio?.id ? (
                      <Link
                        href={`/platform/studios/${studio.id}`}
                        className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Studio
                      </Link>
                    ) : null}
                    <Link
                      href={`/app/instructors/${row.id}`}
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      Instructor
                    </Link>
                  </div>
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-2">
                  <CredentialList title="Teaching certifications" items={certifications} />
                  <CredentialList title="Titles / achievements" items={titles} />
                </div>

                <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Proof / reference
                  </p>
                  {row.credential_proof_url ? (
                    <a
                      href={row.credential_proof_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex text-sm font-semibold text-[#6B21A8] underline-offset-4 hover:underline"
                    >
                      Open submitted proof
                    </a>
                  ) : (
                    <p className="mt-2 text-sm text-slate-500">No proof URL submitted.</p>
                  )}
                  {row.credentials_review_note ? (
                    <p className="mt-3 rounded-xl bg-white px-3 py-2 text-sm text-slate-600">
                      Review note: {row.credentials_review_note}
                    </p>
                  ) : null}
                </div>

                <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto_auto_auto] lg:items-end">
                  <form action={approveInstructorCredentialAction} className="contents">
                    <input type="hidden" name="instructorId" value={row.id} />
                    <input type="hidden" name="currentStatus" value={statusFilter} />
                    <label className="block text-sm font-semibold text-slate-700 lg:col-span-1">
                      Review note
                      <textarea
                        name="reviewNote"
                        rows={2}
                        defaultValue={row.credentials_review_note ?? ""}
                        className="mt-2 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-[#6B21A8] focus:outline-none focus:ring-2 focus:ring-[#6B21A8]/20"
                        placeholder="Optional note for the credential review."
                      />
                    </label>
                    <button className="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700">
                      Approve
                    </button>
                  </form>

                  <form action={rejectInstructorCredentialAction}>
                    <input type="hidden" name="instructorId" value={row.id} />
                    <input type="hidden" name="currentStatus" value={statusFilter} />
                    <input
                      type="hidden"
                      name="reviewNote"
                      value={
                        row.credentials_review_note ||
                        "Credential could not be verified from the submitted information."
                      }
                    />
                    <button className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-100">
                      Reject
                    </button>
                  </form>

                  {status !== "submitted" ? (
                    <form action={resetInstructorCredentialAction}>
                      <input type="hidden" name="instructorId" value={row.id} />
                      <input type="hidden" name="currentStatus" value={statusFilter} />
                      <button className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                        Send back to queue
                      </button>
                    </form>
                  ) : null}
                </div>
              </article>
            );
          })
        ) : (
          <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center shadow-sm">
            <h2 className="text-xl font-semibold text-slate-950">No credentials in this view</h2>
            <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Submitted instructor credentials will appear here once studios add certifications,
              titles, achievements, or a proof link from their instructor profiles.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
