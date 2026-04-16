import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import ImportUploadForm from "./ImportUploadForm";
import {
  validateAppointmentImportBatchAction,
  validateClientImportBatchAction,
  validateInstructorImportBatchAction,
  validatePaymentImportBatchAction,
} from "./actions";

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

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
  return "bg-slate-100 text-slate-700";
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
    return value > 0 ? "text-green-700" : "text-slate-900";
  }
  if (kind === "warn") {
    return value > 0 ? "text-amber-700" : "text-slate-900";
  }
  return value > 0 ? "text-red-700" : "text-slate-900";
}

function topActionLabel(importType: string) {
  if (importType === "clients") return "Review Clients File";
  if (importType === "instructors") return "Review Instructors File";
  if (importType === "appointments") return "Review Appointments File";
  if (importType === "payments") return "Review Payments File";
  return "Review File";
}

function plainTypeLabel(importType: string) {
  if (importType === "clients") return "Clients";
  if (importType === "instructors") return "Instructors";
  if (importType === "appointments") return "Appointments";
  if (importType === "payments") return "Payments";
  if (importType === "packages") return "Packages";
  if (importType === "memberships") return "Memberships";
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

  const latestReviewableBatch = typedBatches.find((batch) =>
    ["uploaded", "validated", "completed_with_warnings"].includes(batch.status)
  );

  return (
    <div className="space-y-6">
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

      <div className="rounded-2xl border bg-white p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
              Import Studio Data
            </h1>
            <p className="mt-2 text-slate-600">
              Bring over clients, instructors, appointments, and payments from your previous system.
              Start with a file, review what needs attention, then import only the rows that are ready.
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                Step 1: Upload
              </span>
              <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                Step 2: Review
              </span>
              <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                Step 3: Import
              </span>
              <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                Step 4: Fix anything left
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            {latestReviewableBatch ? (
              <Link
                href={`/app/settings/import/${latestReviewableBatch.id}`}
                className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
              >
                Continue Latest Import
              </Link>
            ) : null}

            <Link
              href="/app/settings"
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Back to Settings
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Recommended Order</p>
          <p className="mt-2 text-xl font-semibold text-slate-900">
            Clients → Instructors → Appointments → Payments
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Import people first, then schedules, then payment history.
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Start Safely</p>
          <p className="mt-2 text-xl font-semibold text-slate-900">Use Dry Run First</p>
          <p className="mt-2 text-sm text-slate-600">
            Review the file before making live changes to your data.
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Current Supported Imports</p>
          <p className="mt-2 text-xl font-semibold text-slate-900">
            Clients, Instructors, Appointments, Payments
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Packages and memberships can be added later.
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Source Presets</p>
          <p className="mt-2 text-xl font-semibold text-slate-900">
            Generic CSV, Mindbody, Vagaro
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Pick the closest source and upload one CSV per import.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Total Imports</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{totalImports}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Completed</p>
          <p className={`mt-2 text-2xl font-semibold ${summaryTone(completedImports, "good")}`}>
            {completedImports}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Need Attention</p>
          <p className={`mt-2 text-2xl font-semibold ${summaryTone(importsNeedingAttention, "warn")}`}>
            {importsNeedingAttention}
          </p>
        </div>
      </div>

      {latestBatch ? (
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-medium text-blue-700">Latest Import</p>
              <h2 className="mt-1 text-xl font-semibold text-slate-900">
                {plainTypeLabel(latestBatch.import_type)} from {labelize(latestBatch.source_system)}
              </h2>
              <p className="mt-2 text-sm text-slate-700">
                Created {formatDateTime(latestBatch.created_at)} · Status: {labelize(latestBatch.status)}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href={`/app/settings/import/${latestBatch.id}`}
                className="rounded-xl border border-blue-300 bg-white px-4 py-2 text-blue-700 hover:bg-blue-100"
              >
                Open Import Review
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold text-slate-900">Start a New Import</h2>
          <p className="text-sm text-slate-600">
            Choose the source, pick what you are importing, upload the CSV, and start with a review pass.
          </p>
        </div>

        <div className="mt-5">
          <ImportUploadForm
            helperText="For the smoothest migration, upload one CSV at a time and start with Dry Run."
            submitLabel="Upload and Start Review"
          />
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-6">
        <h2 className="text-xl font-semibold text-slate-900">Quick Start Guides</h2>

        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-900">Clients</p>
            <p className="mt-2 text-sm text-slate-600">
              Best first import. Bring over names, contact info, notes, and studio history.
            </p>
          </div>

          <div className="rounded-xl border bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-900">Instructors</p>
            <p className="mt-2 text-sm text-slate-600">
              Import teaching staff after clients so schedules and ownership are easier to review.
            </p>
          </div>

          <div className="rounded-xl border bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-900">Appointments</p>
            <p className="mt-2 text-sm text-slate-600">
              Review conflict warnings carefully before importing schedules into the app.
            </p>
          </div>

          <div className="rounded-xl border bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-900">Payments</p>
            <p className="mt-2 text-sm text-slate-600">
              Import payment history after clients are in place. The importer will normalize payment methods and statuses for you.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold text-slate-900">Recent Imports</h2>
          <p className="text-sm text-slate-500">{recentBatches.length} shown</p>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr className="text-left text-slate-600">
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
                            : null;

                  const needsReview = ["uploaded"].includes(batch.status);
                  const canOpenReview = ["validated", "completed_with_warnings", "completed", "processing", "uploaded"].includes(batch.status);

                  return (
                    <tr key={batch.id} className="border-t align-top">
                      <td className="px-4 py-3 text-slate-600">
                        <div>{formatDateTime(batch.created_at)}</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <span className="inline-flex rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                            {labelize(batch.mode)}
                          </span>
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

                      <td className="px-4 py-3 text-slate-900">
                        <div className="font-medium">
                          {plainTypeLabel(batch.import_type)}
                        </div>
                        <div className="mt-1 text-slate-600">
                          {labelize(batch.source_system)}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
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

                      <td className="px-4 py-3 text-slate-600">
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

                      <td className="px-4 py-3 text-slate-600">
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
                              className="rounded-xl border px-3 py-2 text-sm hover:bg-slate-50"
                            >
                              Open Review
                            </Link>
                          ) : null}

                          {needsReview && reviewAction ? (
                            <form action={reviewAction}>
                              <input type="hidden" name="batchId" value={batch.id} />
                              <button
                                type="submit"
                                className="rounded-xl border px-3 py-2 text-sm hover:bg-slate-50"
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
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                    No imports yet. Upload your first CSV above to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {rootBatches.length > 0 ? (
        <div className="rounded-2xl border bg-white p-6">
          <h2 className="text-xl font-semibold text-slate-900">Migration Progress</h2>
          <p className="mt-2 text-sm text-slate-600">
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
                <div key={importType} className="rounded-xl border bg-slate-50 p-4">
                  <p className="text-sm font-medium text-slate-900">{plainTypeLabel(importType)}</p>
                  <p className="mt-2 text-sm text-slate-600">
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
                            : "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {done ? "Done" : inProgress ? "In Progress" : "Not Started"}
                    </span>
                  </div>

                  {latestTypeBatch ? (
                    <div className="mt-3 text-xs text-slate-500">
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