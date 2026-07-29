import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import ImportUploadForm from "./ImportUploadForm";
import SquareMigrationPilotReadiness from "./SquareMigrationPilotReadiness";
import WellnessLivingMigrationPilotReadiness from "./WellnessLivingMigrationPilotReadiness";
import MindbodyMigrationPilotReadiness from "./MindbodyMigrationPilotReadiness";
import {
  archiveUnfinishedImportBatchesAction,
  validateAppointmentImportBatchAction,
  validateClientImportBatchAction,
  validateInstructorImportBatchAction,
  validatePaymentImportBatchAction,
  validateSquareDigitalEntitlementImportBatchAction,
  validateSquareHistoricalOrderImportBatchAction,
  validateSquareInventoryImportBatchAction,
  validateSquareProductImportBatchAction,
  validateWellnessLivingPackageImportBatchAction,
  validateMindbodyPackageImportBatchAction,
  validateWellnessLivingMembershipImportBatchAction,
  validateMindbodyMembershipImportBatchAction,
  validateWellnessLivingAttendanceImportBatchAction,
  validateMindbodyAttendanceImportBatchAction,
  validateWellnessLivingAccountCreditImportBatchAction,
  validateMindbodyAccountCreditImportBatchAction,
} from "./actions";

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

const ACTIVE_IMPORT_STATUSES = new Set(["draft", "uploaded", "validated"]);

const GUIDED_IMPORT_STAGES = [
  { key: "clients", label: "Clients", description: "Start with identity and contact records.", optional: false },
  { key: "instructors", label: "Staff", description: "Add instructors before schedule records.", optional: false },
  { key: "packages", label: "Packages", description: "Preserve remaining visits when packages exist.", optional: true },
  { key: "memberships", label: "Memberships", description: "Preserve contracts, periods, and billing state.", optional: true },
  { key: "appointments", label: "Schedule", description: "Bring over appointments, classes, and enrollments.", optional: false },
  { key: "attendance", label: "Attendance", description: "Add historical visits without reducing balances again.", optional: true },
  { key: "payments", label: "Payments", description: "Import financial history after clients and schedule.", optional: false },
  { key: "account_credits", label: "Credits", description: "Reconcile account credits and debits when present.", optional: true },
] as const;

type ImportBatchSummary = Record<string, unknown> & {
  create_candidates?: number;
  update_candidates?: number;
  ready_rows?: number;
  blocking_row_count?: number;
  warning_row_count?: number;
  dry_run_ready?: boolean;
  client_found_count?: number;
  client_missing_count?: number;
  instructor_found_count?: number;
  instructor_missing_count?: number;
  possible_conflict_warning_count?: number;
  instructor_conflict_warning_count?: number;
  client_conflict_warning_count?: number;
  room_conflict_warning_count?: number;
  refund_warning_count?: number;
  missing_appointment_warning_count?: number;
  payment_method_normalized_warning_count?: number;
  payment_status_normalized_warning_count?: number;
};

type ImportBatchRow = {
  id: string;
  source_system: string;
  import_type: string;
  mode: string;
  status: string;
  total_rows: number;
  processed_rows: number;
  inserted_rows: number;
  updated_rows: number;
  skipped_rows: number;
  failed_rows: number;
  created_at: string;
  parent_batch_id: string | null;
  onboarding_project_id: string | null;
  stage_key: string | null;
  sequence_number: number | null;
  reconciliation_status: string;
  summary: ImportBatchSummary | null;
};

function labelize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string) {
  if (status === "completed") return "bg-green-50 text-green-700";
  if (status === "completed_with_warnings") return "bg-amber-50 text-amber-700";
  if (status === "uploaded" || status === "validated") return "bg-blue-50 text-blue-700";
  if (status === "processing") return "bg-purple-50 text-purple-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  return "bg-slate-100 text-[#5A4567]";
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "validated") {
    return {
      kind: "success" as const,
      message: "Import file reviewed successfully.",
    };
  }

  if (search.success === "retry_created") {
    return {
      kind: "success" as const,
      message: "Corrected retry file uploaded successfully.",
    };
  }

  if (search.success === "drafts_archived") {
    return {
      kind: "success" as const,
      message: "Unfinished import drafts were archived. Completed imports and imported clients were not changed.",
    };
  }

  if (search.error === "batch_not_found") {
    return {
      kind: "error" as const,
      message: "That import could not be found.",
    };
  }

  if (search.error === "wrong_import_type") {
    return {
      kind: "error" as const,
      message: "That review action does not match the selected import type.",
    };
  }

  if (search.error === "file_not_found") {
    return {
      kind: "error" as const,
      message: "The uploaded CSV file could not be found.",
    };
  }

  if (search.error === "validation_failed") {
    return {
      kind: "error" as const,
      message: "We could not review that CSV file.",
    };
  }

  if (search.error === "execution_failed") {
    return {
      kind: "error" as const,
      message: "Import execution failed.",
    };
  }

  if (search.error === "archive_failed") {
    return {
      kind: "error" as const,
      message: "We could not archive unfinished import drafts. Try again or refresh the page.",
    };
  }

  return null;
}

function smallBadge(
  label: string,
  value: number,
  tone: "green" | "amber" | "red" | "blue" = "amber"
) {
  const toneClass =
    tone === "green"
      ? "bg-green-50 text-green-700"
      : tone === "red"
        ? "bg-red-50 text-red-700"
        : tone === "blue"
          ? "bg-blue-50 text-blue-700"
          : "bg-amber-50 text-amber-700";

  return (
    <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${toneClass}`}>
      {label}: {value}
    </span>
  );
}

function summaryTone(value: number, kind: "good" | "warn" | "bad") {
  if (kind === "good") {
    return value > 0 ? "text-green-700" : "text-[#2C1838]";
  }
  if (kind === "warn") {
    return value > 0 ? "text-amber-700" : "text-[#2C1838]";
  }
  return value > 0 ? "text-red-700" : "text-[#2C1838]";
}

function topActionLabel(importType: string) {
  if (importType === "clients") return "Review Clients File";
  if (importType === "instructors") return "Review Instructors File";
  if (importType === "appointments") return "Review Appointments File";
  if (importType === "payments") return "Review Payments File";
  if (importType === "packages") return "Review Package Balance File";
  if (importType === "memberships") return "Review Membership File";
  if (importType === "attendance") return "Review Attendance File";
  if (importType === "account_credits") return "Review Account Credits File";
  if (importType === "products") return "Review Square Catalog File";
  return "Review File";
}

function plainTypeLabel(importType: string) {
  if (importType === "clients") return "Clients";
  if (importType === "instructors") return "Instructors";
  if (importType === "appointments") return "Appointments";
  if (importType === "payments") return "Payments";
  if (importType === "packages") return "Packages";
  if (importType === "memberships") return "Memberships";
  if (importType === "products") return "Retail Products";
  return labelize(importType);
}

export default async function ImportSettingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const search = await searchParams;
  const banner = getBanner(search);

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const { data: batches, error: batchesError } = await supabase
    .from("import_batches")
    .select(`
      id,
      source_system,
      import_type,
      mode,
      status,
      total_rows,
      processed_rows,
      inserted_rows,
      updated_rows,
      skipped_rows,
      failed_rows,
      created_at,
      parent_batch_id,
      onboarding_project_id,
      stage_key,
      sequence_number,
      reconciliation_status,
      summary
    `)
    .eq("studio_id", studioId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (batchesError) {
    throw new Error(`Failed to load import batches: ${batchesError.message}`);
  }

  const typedBatches = (batches ?? []) as ImportBatchRow[];

  const childCountByParent = new Map<string, number>();
  for (const batch of typedBatches) {
    if (batch.parent_batch_id) {
      childCountByParent.set(
        batch.parent_batch_id,
        (childCountByParent.get(batch.parent_batch_id) ?? 0) + 1
      );
    }
  }

  const rootBatches = typedBatches.filter((batch) => !batch.parent_batch_id);
  const recentBatches = typedBatches.slice(0, 8);

  const latestBatch = typedBatches[0] ?? null;
  const totalImports = typedBatches.length;
  const completedImports = typedBatches.filter((batch) => batch.status === "completed").length;
  const importsNeedingAttention = typedBatches.filter(
    (batch) =>
      batch.status === "completed_with_warnings" ||
      batch.status === "failed" ||
      batch.failed_rows > 0
  ).length;

  const unfinishedImportCount = typedBatches.filter((batch) =>
    ACTIVE_IMPORT_STATUSES.has(batch.status)
  ).length;

  const latestReviewableBatch = typedBatches.find((batch) =>
    ACTIVE_IMPORT_STATUSES.has(batch.status)
  );

  const completedStageKeys = new Set(
    typedBatches
      .filter(
        (batch) =>
          batch.status === "completed" &&
          batch.reconciliation_status === "reconciled"
      )
      .map((batch) => batch.import_type)
  );

  const activeStageKey =
    latestReviewableBatch?.import_type ??
    GUIDED_IMPORT_STAGES.find((stage) => !completedStageKeys.has(stage.key))?.key ??
    "clients";

  const activeStage =
    GUIDED_IMPORT_STAGES.find((stage) => stage.key === activeStageKey) ??
    GUIDED_IMPORT_STAGES[0];

  const activeStageNumber =
    GUIDED_IMPORT_STAGES.findIndex((stage) => stage.key === activeStage.key) + 1;

  const preferredSourceSystem =
    latestReviewableBatch?.source_system ??
    latestBatch?.source_system ??
    "generic_csv";

  return (
    <div className="min-h-[calc(100vh-4rem)] space-y-6 bg-[#F8F5FC] px-4 py-5 sm:px-6 lg:px-8">
      {banner ? (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            banner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {banner.message}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-3xl border border-[#E9D5FF] bg-white shadow-sm">
        <div className="bg-gradient-to-r from-violet-700 via-fuchsia-600 to-pink-500 p-6 text-white">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold uppercase tracking-[0.25em] text-white/80">
                DanceFlow Import Center
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Import client data without guessing the next step
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/90 md:text-base">
                Bring over clients, instructors, appointments, and payments from your previous system. Uploading creates a review batch first; clients are only added after you review the file and execute the import.
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
              <span className="inline-flex rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white ring-1 ring-white/25">
                Step 1: Upload
              </span>
              <span className="inline-flex rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white ring-1 ring-white/25">
                Step 2: Review
              </span>
              <span className="inline-flex rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white ring-1 ring-white/25">
                Step 3: Import
              </span>
              <span className="inline-flex rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white ring-1 ring-white/25">
                Step 4: Fix anything left
              </span>
            </div>
            </div>

            <div className="flex flex-wrap gap-3">
              {latestReviewableBatch ? (
                <>
                  <Link
                    href={`/app/settings/import/${latestReviewableBatch.id}`}
                    className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-violet-700 shadow-sm hover:bg-violet-50"
                  >
                    Continue Latest Import
                  </Link>
                  <form action={archiveUnfinishedImportBatchesAction}>
                    <button
                      type="submit"
                      className="rounded-xl border border-white/40 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20"
                      title="Archives unfinished import drafts. Completed imports and imported clients are not changed."
                    >
                      Start Over
                    </button>
                  </form>
                  <p className="basis-full text-xs text-white/80">
                    {unfinishedImportCount} unfinished import draft{unfinishedImportCount === 1 ? "" : "s"}. Start Over archives drafts only; completed imports and imported clients stay unchanged.
                  </p>
                </>
              ) : null}

              <Link
                href="/app/settings"
                className="rounded-xl border border-white/40 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20"
              >
                Back to Settings
              </Link>
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-3">
          <div className="rounded-2xl border bg-[#FCF8FF] p-4">
            <p className="text-sm font-semibold text-[#2C1838]">1. Upload the CSV</p>
            <p className="mt-1 text-sm text-[#6F5A7A]">Choose the import type and upload one file at a time.</p>
          </div>
          <div className="rounded-2xl border bg-[#FCF8FF] p-4">
            <p className="text-sm font-semibold text-[#2C1838]">2. Review row issues</p>
            <p className="mt-1 text-sm text-[#6F5A7A]">Fix missing fields, duplicates, and invalid values before importing.</p>
          </div>
          <div className="rounded-2xl border bg-[#FCF8FF] p-4">
            <p className="text-sm font-semibold text-[#2C1838]">3. Execute import</p>
            <p className="mt-1 text-sm text-[#6F5A7A]">Only reviewed and ready rows are added to your studio.</p>
          </div>
        </div>
      </div>

      <section className="overflow-hidden rounded-3xl border border-[#E9D5FF] bg-white shadow-sm">
        <div className="border-b border-[#E9D5FF] bg-gradient-to-r from-[#FCF8FF] via-white to-[#FFF7ED] p-5 md:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-violet-700">
                Current migration step
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-[#22152E]">
                Step {activeStageNumber} of {GUIDED_IMPORT_STAGES.length}: {activeStage.label}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[#6F5A7A]">
                {activeStage.description}
              </p>
            </div>

            {latestReviewableBatch ? (
              <Link
                href={`/app/settings/import/${latestReviewableBatch.id}`}
                className="inline-flex w-fit items-center justify-center rounded-xl bg-[#5B197A] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[#491362]"
              >
                Continue current review
              </Link>
            ) : null}
          </div>

          <div className="mt-5 flex snap-x gap-2 overflow-x-auto pb-2">
            {GUIDED_IMPORT_STAGES.map((stage, index) => {
              const completed = completedStageKeys.has(stage.key);
              const current = stage.key === activeStage.key;

              return (
                <div
                  key={stage.key}
                  className={`min-w-[9.5rem] snap-start rounded-2xl border px-3 py-3 ${
                    current
                      ? "border-violet-400 bg-violet-100"
                      : completed
                        ? "border-green-200 bg-green-50"
                        : "border-[#E9D5FF] bg-white"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                        current
                          ? "bg-violet-700 text-white"
                          : completed
                            ? "bg-green-600 text-white"
                            : "bg-[#F2E8F8] text-[#5B197A]"
                      }`}
                    >
                      {completed ? "✓" : index + 1}
                    </span>
                    <p className="text-sm font-semibold text-[#2C1838]">{stage.label}</p>
                  </div>
                  <p className="mt-2 text-xs text-[#806F89]">
                    {completed
                      ? "Completed"
                      : current
                        ? "Current step"
                        : stage.optional
                          ? "Optional"
                          : "Upcoming"}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid gap-5 p-5 md:p-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div>
            <div className="rounded-2xl border border-violet-200 bg-[#FCF8FF] p-4">
              <p className="text-sm font-semibold text-[#2C1838]">
                {latestReviewableBatch
                  ? "Finish the current review before starting another file."
                  : `Upload the ${activeStage.label.toLowerCase()} file next.`}
              </p>
              <p className="mt-1 text-sm leading-6 text-[#6F5A7A]">
                Uploading creates a review batch first. Nothing is added until the file is reviewed and executed.
              </p>
            </div>

            {!latestReviewableBatch ? (
              <div className="mt-4">
                <ImportUploadForm
                  defaultSourceSystem={preferredSourceSystem}
                  defaultImportType={activeStage.key}
                  defaultMode="dry_run"
                  helperText="Upload one CSV. DanceFlow will review it before any live changes are made."
                  submitLabel={`Review ${activeStage.label} File`}
                />
              </div>
            ) : (
              <div className="mt-4 rounded-2xl border border-blue-200 bg-blue-50 p-5">
                <p className="text-sm font-semibold text-blue-800">
                  {plainTypeLabel(latestReviewableBatch.import_type)} review is in progress
                </p>
                <p className="mt-2 text-sm text-blue-700">
                  Resolve only the rows that need attention, then execute the ready records.
                </p>
                <Link
                  href={`/app/settings/import/${latestReviewableBatch.id}`}
                  className="mt-4 inline-flex rounded-xl bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
                >
                  Open review
                </Link>
              </div>
            )}
          </div>

          <aside className="space-y-3">
            <div className="rounded-2xl border border-[#E9D5FF] bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#806F89]">
                Overall progress
              </p>
              <p className="mt-2 text-2xl font-semibold text-[#2C1838]">
                {completedStageKeys.size}/{GUIDED_IMPORT_STAGES.length}
              </p>
              <p className="mt-1 text-sm text-[#6F5A7A]">stages completed</p>
            </div>

            <div className="rounded-2xl border border-[#E9D5FF] bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#806F89]">
                Needs attention
              </p>
              <p className={`mt-2 text-2xl font-semibold ${summaryTone(importsNeedingAttention, "warn")}`}>
                {importsNeedingAttention}
              </p>
              <p className="mt-1 text-sm text-[#6F5A7A]">
                import batch{importsNeedingAttention === 1 ? "" : "es"}
              </p>
            </div>

            {latestBatch ? (
              <Link
                href={`/app/settings/import/${latestBatch.id}`}
                className="block rounded-2xl border border-[#E9D5FF] bg-white p-4 hover:bg-[#FCF8FF]"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-[#806F89]">
                  Latest activity
                </p>
                <p className="mt-2 text-sm font-semibold text-[#2C1838]">
                  {plainTypeLabel(latestBatch.import_type)}
                </p>
                <p className="mt-1 text-xs text-[#6F5A7A]">
                  {labelize(latestBatch.status)} · {formatDateTime(latestBatch.created_at)}
                </p>
              </Link>
            ) : null}
          </aside>
        </div>
      </section>

      <details className="group overflow-hidden rounded-3xl border border-[#E9D5FF] bg-white shadow-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 md:p-6">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
              Migration health
            </p>
            <h2 className="mt-1 text-xl font-semibold text-[#2C1838]">
              Readiness, reconciliation, and source details
            </h2>
            <p className="mt-1 text-sm text-[#6F5A7A]">
              Open this only for migration health or final activation review.
            </p>
          </div>
          <span className="rounded-full bg-violet-100 px-3 py-1 text-sm font-semibold text-violet-700 group-open:hidden">
            Show details
          </span>
          <span className="hidden rounded-full bg-violet-100 px-3 py-1 text-sm font-semibold text-violet-700 group-open:inline-flex">
            Hide details
          </span>
        </summary>

        <div className="space-y-5 border-t border-[#E9D5FF] bg-[#FBF9FD] p-5 md:p-6">
          <MindbodyMigrationPilotReadiness
            supabase={supabase}
            studioId={context.studioId}
          />
          <WellnessLivingMigrationPilotReadiness
            supabase={supabase}
            studioId={context.studioId}
          />
          <SquareMigrationPilotReadiness
            supabase={supabase}
            studioId={context.studioId}
          />
        </div>
      </details>

      <div className="rounded-2xl border border-[#E9D5FF] bg-white shadow-sm p-6 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold text-[#2C1838]">Recent Imports</h2>
          <p className="text-sm text-[#806F89]">{recentBatches.length} shown</p>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border">
          <table className="min-w-full text-sm">
            <thead className="bg-[#FCF8FF]">
              <tr className="text-left text-[#6F5A7A]">
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Import</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Review Summary</th>
                <th className="px-4 py-3 font-medium">Results</th>
                <th className="px-4 py-3 font-medium">Next Step</th>
              </tr>
            </thead>
            <tbody>
              {recentBatches.length > 0 ? (
                recentBatches.map((batch) => {
                  const childCount = childCountByParent.get(batch.id) ?? 0;
                  const isChild = Boolean(batch.parent_batch_id);
                  const summary = batch.summary ?? {};

                  const readyRows =
                    typeof summary.ready_rows === "number" ? summary.ready_rows : 0;
                  const blockingRows =
                    typeof summary.blocking_row_count === "number"
                      ? summary.blocking_row_count
                      : 0;
                  const warningRows =
                    typeof summary.warning_row_count === "number"
                      ? summary.warning_row_count
                      : 0;
                  const totalConflicts =
                    typeof summary.possible_conflict_warning_count === "number"
                      ? summary.possible_conflict_warning_count
                      : 0;
                  const missingClients =
                    typeof summary.client_missing_count === "number"
                      ? summary.client_missing_count
                      : 0;
                  const missingInstructors =
                    typeof summary.instructor_missing_count === "number"
                      ? summary.instructor_missing_count
                      : 0;
                  const paymentRefundWarnings =
                    typeof summary.refund_warning_count === "number"
                      ? summary.refund_warning_count
                      : 0;
                  const paymentMissingAppointmentWarnings =
                    typeof summary.missing_appointment_warning_count === "number"
                      ? summary.missing_appointment_warning_count
                      : 0;
                  const paymentMethodNormalizedWarnings =
                    typeof summary.payment_method_normalized_warning_count === "number"
                      ? summary.payment_method_normalized_warning_count
                      : 0;
                  const paymentStatusNormalizedWarnings =
                    typeof summary.payment_status_normalized_warning_count === "number"
                      ? summary.payment_status_normalized_warning_count
                      : 0;

                  const reviewAction =
                    batch.import_type === "clients"
                      ? validateClientImportBatchAction
                      : batch.import_type === "instructors"
                        ? validateInstructorImportBatchAction
                        : batch.import_type === "appointments"
                          ? validateAppointmentImportBatchAction
                          : batch.import_type === "payments"
                            ? validatePaymentImportBatchAction
                            : batch.import_type === "packages" && batch.source_system === "wellnessliving"
                              ? validateWellnessLivingPackageImportBatchAction
                              : batch.import_type === "packages" && batch.source_system === "mindbody"
                                ? validateMindbodyPackageImportBatchAction
                              : batch.import_type === "memberships" && batch.source_system === "wellnessliving"
                                ? validateWellnessLivingMembershipImportBatchAction
                                : batch.import_type === "memberships" && batch.source_system === "mindbody"
                                  ? validateMindbodyMembershipImportBatchAction
                                : batch.import_type === "attendance" && batch.source_system === "wellnessliving"
                                  ? validateWellnessLivingAttendanceImportBatchAction
                                  : batch.import_type === "attendance" && batch.source_system === "mindbody"
                                    ? validateMindbodyAttendanceImportBatchAction
                                  : batch.import_type === "account_credits" && batch.source_system === "wellnessliving"
                                    ? validateWellnessLivingAccountCreditImportBatchAction
                                    : batch.import_type === "account_credits" && batch.source_system === "mindbody"
                                      ? validateMindbodyAccountCreditImportBatchAction
                              : batch.import_type === "products" && batch.source_system === "square"
                                ? validateSquareProductImportBatchAction
                                : null;

                  const needsReview = ["uploaded"].includes(batch.status);
                  const canOpenReview = ["validated", "completed_with_warnings", "completed", "processing", "uploaded"].includes(batch.status);

                  return (
                    <tr key={batch.id} className="border-t align-top">
                      <td className="px-4 py-3 text-[#6F5A7A]">
                        <div>{formatDateTime(batch.created_at)}</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <span className="inline-flex rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-[#5A4567]">
                            {labelize(batch.mode)}
                          </span>
                          {batch.stage_key ? (
                            <span className="inline-flex rounded-full bg-violet-50 px-2 py-1 text-xs font-medium text-violet-700">
                              Stage {batch.sequence_number ?? "—"}: {labelize(batch.stage_key)}
                            </span>
                          ) : null}
                          {batch.onboarding_project_id ? (
                            <span className="inline-flex rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                              Onboarding linked
                            </span>
                          ) : null}
                          {isChild ? (
                            <span className="inline-flex rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                              Retry
                            </span>
                          ) : null}
                          {childCount > 0 ? (
                            <span className="inline-flex rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                              {childCount} linked
                            </span>
                          ) : null}
                        </div>
                      </td>

                      <td className="px-4 py-3 text-[#2C1838]">
                        <div className="font-medium">
                          {plainTypeLabel(batch.import_type)}
                        </div>
                        <div className="mt-1 text-[#6F5A7A]">
                          {labelize(batch.source_system)}
                        </div>
                        <div className="mt-1 text-xs text-[#806F89]">
                          {batch.total_rows} rows
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(
                            batch.status
                          )}`}
                        >
                          {labelize(batch.status)}
                        </span>
                      </td>

                      <td className="px-4 py-3 text-[#6F5A7A]">
                        <div className="flex flex-wrap gap-2">
                          {readyRows > 0 ? smallBadge("Ready", readyRows, "green") : null}
                          {blockingRows > 0 ? smallBadge("Must Fix", blockingRows, "red") : null}
                          {warningRows > 0 ? smallBadge("Warnings", warningRows, "amber") : null}
                          {batch.import_type === "appointments" && totalConflicts > 0
                            ? smallBadge("Conflicts", totalConflicts, "amber")
                            : null}
                          {batch.import_type === "appointments" && missingClients > 0
                            ? smallBadge("Missing Clients", missingClients, "red")
                            : null}
                          {batch.import_type === "appointments" && missingInstructors > 0
                            ? smallBadge("Missing Instructors", missingInstructors, "red")
                            : null}
                          {batch.import_type === "payments" && paymentRefundWarnings > 0
                            ? smallBadge("Refund Warnings", paymentRefundWarnings, "amber")
                            : null}
                          {batch.import_type === "payments" && paymentMissingAppointmentWarnings > 0
                            ? smallBadge("Missing Appt Ref", paymentMissingAppointmentWarnings, "blue")
                            : null}
                          {batch.import_type === "payments" && paymentMethodNormalizedWarnings > 0
                            ? smallBadge("Method Normalized", paymentMethodNormalizedWarnings, "amber")
                            : null}
                          {batch.import_type === "payments" && paymentStatusNormalizedWarnings > 0
                            ? smallBadge("Status Normalized", paymentStatusNormalizedWarnings, "amber")
                            : null}
                        </div>
                      </td>

                      <td className="px-4 py-3 text-[#6F5A7A]">
                        <div>Inserted: {batch.inserted_rows}</div>
                        <div>Updated: {batch.updated_rows}</div>
                        <div>Skipped: {batch.skipped_rows}</div>
                        <div>Failed: {batch.failed_rows}</div>
                      </td>

                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          {canOpenReview ? (
                            <Link
                              href={`/app/settings/import/${batch.id}`}
                              className="rounded-xl border border-[#D8B4FE] bg-white px-3 py-2 text-sm font-semibold text-[#6B21A8] hover:bg-[#FCF8FF]"
                            >
                              Open Review
                            </Link>
                          ) : null}

                          {needsReview && reviewAction ? (
                            <form action={reviewAction}>
                              <input type="hidden" name="batchId" value={batch.id} />
                              <button
                                type="submit"
                                className="rounded-xl border border-[#D8B4FE] bg-white px-3 py-2 text-sm font-semibold text-[#6B21A8] hover:bg-[#FCF8FF]"
                              >
                                {topActionLabel(batch.import_type)}
                              </button>
                            </form>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-[#806F89]">
                    No imports yet. Upload your first CSV above to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {rootBatches.length > 0 ? (
        <div className="rounded-2xl border border-[#E9D5FF] bg-white shadow-sm p-6">
          <h2 className="text-xl font-semibold text-[#2C1838]">Migration Progress</h2>
          <p className="mt-2 text-sm text-[#6F5A7A]">
            Use this as a simple checklist while moving studios over.
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-4">
            {["clients", "instructors", "appointments", "payments"].map((importType) => {
              const typeBatches = typedBatches.filter((batch) => batch.import_type === importType);
              const latestTypeBatch = typeBatches[0] ?? null;
              const done = typeBatches.some((batch) => batch.status === "completed");
              const inProgress = typeBatches.some((batch) =>
                ["uploaded", "validated", "processing", "completed_with_warnings"].includes(batch.status)
              );

              return (
                <div key={importType} className="rounded-xl border bg-[#FCF8FF] p-4">
                  <p className="text-sm font-medium text-[#2C1838]">{plainTypeLabel(importType)}</p>
                  <p className="mt-2 text-sm text-[#6F5A7A]">
                    {done
                      ? "Completed"
                      : inProgress
                        ? "In progress"
                        : "Not started"}
                  </p>

                  <div className="mt-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                        done
                          ? "bg-green-50 text-green-700"
                          : inProgress
                            ? "bg-blue-50 text-blue-700"
                            : "bg-slate-100 text-[#5A4567]"
                      }`}
                    >
                      {done ? "Done" : inProgress ? "In Progress" : "Not Started"}
                    </span>
                  </div>

                  {latestTypeBatch ? (
                    <div className="mt-3 text-xs text-[#806F89]">
                      Latest: {formatDateTime(latestTypeBatch.created_at)}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}