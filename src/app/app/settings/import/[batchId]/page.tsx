import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  downloadImportErrorsCsvAction,
  executeAppointmentImportBatchAction,
  executeClientImportBatchAction,
  executeInstructorImportBatchAction,
  executePaymentImportBatchAction,
} from "../actions";
import ImportUploadForm from "../ImportUploadForm";

type Params = Promise<{
  batchId: string;
}>;

type SearchParams = Promise<{
  success?: string;
  error?: string;
  download?: string;
  filename?: string;
}>;

type ImportBatchSummary = Record<string, unknown> & {
  create_candidates?: number;
  update_candidates?: number;
  ready_rows?: number;
  blocking_row_count?: number;
  warning_row_count?: number;
  blocking_error_count?: number;
  warning_count?: number;
  error_count?: number;
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
  executed?: boolean;
  execution_error_count?: number;
  row_count?: number;
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
  summary: ImportBatchSummary | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  parent_batch_id: string | null;
};

type ImportBatchFileRow = {
  id: string;
  original_filename: string;
  storage_bucket: string | null;
  storage_path: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  row_count: number;
  detected_kind: string | null;
  header_columns: string[] | null;
  created_at: string;
};

type ImportBatchErrorRow = {
  id: string;
  row_number: number | null;
  field_name: string | null;
  error_code: string;
  error_message: string;
  raw_value: string | null;
  row_data: Record<string, string> | null;
  created_at: string;
};

type RetryBatchRow = {
  id: string;
  status: string;
  created_at: string;
  mode: string;
  source_system: string;
  import_type: string;
  total_rows: number;
  inserted_rows: number;
  updated_rows: number;
  skipped_rows: number;
  failed_rows: number;
  parent_batch_id: string | null;
};

function labelize(value: string | null | undefined) {
  if (!value) return "—";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function titleForImportType(importType: string) {
  if (importType === "clients") return "Client Import";
  if (importType === "instructors") return "Instructor Import";
  if (importType === "appointments") return "Appointment Import";
  if (importType === "payments") return "Payment Import";
  return "Import Batch";
}

function executeLabelForImportType(importType: string) {
  if (importType === "clients") return "Execute Client Import";
  if (importType === "instructors") return "Execute Instructor Import";
  if (importType === "appointments") return "Confirm and Execute Appointment Import";
  if (importType === "payments") return "Confirm and Execute Payment Import";
  return "Execute Import";
}

function correctionHelperForImportType(importType: string) {
  if (importType === "clients") {
    return "Upload a corrected clients CSV to create a child retry batch linked to this import.";
  }
  if (importType === "instructors") {
    return "Upload a corrected instructors CSV to create a child retry batch linked to this import.";
  }
  if (importType === "appointments") {
    return "Upload a corrected appointments CSV to create a child retry batch linked to this import.";
  }
  if (importType === "payments") {
    return "Upload a corrected payments CSV to create a child retry batch linked to this import.";
  }
  return "Upload a corrected CSV to create a child retry batch linked to this import.";
}

function statusBadgeClass(status: string) {
  if (status === "completed") return "bg-green-50 text-green-700";
  if (status === "completed_with_warnings") return "bg-amber-50 text-amber-700";
  if (status === "uploaded" || status === "validated") return "bg-blue-50 text-blue-700";
  if (status === "processing") return "bg-purple-50 text-purple-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  return "bg-slate-100 text-slate-700";
}

function errorBadgeClass(errorCode: string) {
  if (
    [
      "missing_required_field",
      "invalid_email",
      "duplicate_in_file",
      "missing_header",
      "invalid_datetime",
      "missing_related_record",
      "invalid_amount",
      "execution_failed",
    ].includes(errorCode)
  ) {
    return "bg-red-50 text-red-700";
  }

  return "bg-amber-50 text-amber-700";
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatFileSize(bytes: number | null) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isBlockingErrorCode(errorCode: string) {
  return [
    "missing_required_field",
    "invalid_email",
    "duplicate_in_file",
    "missing_header",
    "invalid_datetime",
    "missing_related_record",
    "invalid_amount",
    "execution_failed",
  ].includes(errorCode);
}

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "executed") {
    return {
      kind: "success" as const,
      message: "Import executed.",
    };
  }

  if (search.success === "retry_created") {
    return {
      kind: "success" as const,
      message: "Corrected retry batch created.",
    };
  }

  if (search.error === "batch_not_ready") {
    return {
      kind: "error" as const,
      message: "Batch is not ready for execution yet.",
    };
  }

  if (search.error === "file_not_found") {
    return {
      kind: "error" as const,
      message: "CSV file for this batch could not be found.",
    };
  }

  if (search.error === "execution_failed") {
    return {
      kind: "error" as const,
      message: "Import execution failed.",
    };
  }

  if (search.error === "download_failed") {
    return {
      kind: "error" as const,
      message: "Could not generate the error CSV download.",
    };
  }

  return null;
}

function SummaryCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-green-700"
      : tone === "warn"
        ? "text-amber-700"
        : tone === "bad"
          ? "text-red-700"
          : "text-slate-900";

  return (
    <div className="rounded-2xl border bg-white p-5">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function ExecutionMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-green-700"
      : tone === "warn"
        ? "text-amber-700"
        : tone === "bad"
          ? "text-red-700"
          : "text-slate-900";

  return (
    <div className="rounded-xl border bg-white p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

export default async function ImportBatchDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { batchId } = await params;
  const search = await searchParams;
  const banner = getBanner(search);

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const { data: batch, error: batchError } = await supabase
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
      summary,
      created_at,
      started_at,
      completed_at,
      parent_batch_id
    `)
    .eq("id", batchId)
    .eq("studio_id", studioId)
    .single();

  if (batchError || !batch) {
    notFound();
  }

  const typedBatch = batch as ImportBatchRow;

  const [
    { data: files, error: filesError },
    { data: errors, error: errorsError },
    { data: parentBatch, error: parentBatchError },
    { data: childBatches, error: childBatchesError },
  ] = await Promise.all([
    supabase
      .from("import_batch_files")
      .select(`
        id,
        original_filename,
        storage_bucket,
        storage_path,
        mime_type,
        file_size_bytes,
        row_count,
        detected_kind,
        header_columns,
        created_at
      `)
      .eq("import_batch_id", batchId)
      .order("created_at", { ascending: true }),

    supabase
      .from("import_batch_errors")
      .select(`
        id,
        row_number,
        field_name,
        error_code,
        error_message,
        raw_value,
        row_data,
        created_at
      `)
      .eq("import_batch_id", batchId)
      .order("row_number", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(200),

    typedBatch.parent_batch_id
      ? supabase
          .from("import_batches")
          .select(`
            id,
            status,
            created_at,
            mode,
            source_system,
            import_type,
            total_rows,
            inserted_rows,
            updated_rows,
            skipped_rows,
            failed_rows,
            parent_batch_id
          `)
          .eq("studio_id", studioId)
          .eq("id", typedBatch.parent_batch_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),

    supabase
      .from("import_batches")
      .select(`
        id,
        status,
        created_at,
        mode,
        source_system,
        import_type,
        total_rows,
        inserted_rows,
        updated_rows,
        skipped_rows,
        failed_rows,
        parent_batch_id
      `)
      .eq("studio_id", studioId)
      .eq("parent_batch_id", batchId)
      .order("created_at", { ascending: false }),
  ]);

  if (filesError) {
    throw new Error(`Failed to load import files: ${filesError.message}`);
  }

  if (errorsError) {
    throw new Error(`Failed to load import errors: ${errorsError.message}`);
  }

  if (parentBatchError) {
    throw new Error(`Failed to load parent batch: ${parentBatchError.message}`);
  }

  if (childBatchesError) {
    throw new Error(`Failed to load retry batches: ${childBatchesError.message}`);
  }

  const typedFiles = (files ?? []) as ImportBatchFileRow[];
  const typedErrors = (errors ?? []) as ImportBatchErrorRow[];
  const typedParentBatch = (parentBatch ?? null) as RetryBatchRow | null;
  const typedChildBatches = (childBatches ?? []) as RetryBatchRow[];
  const firstFile = typedFiles[0] ?? null;

  const summary = typedBatch.summary ?? {};

  const blockingErroredRowNumbers = new Set(
    typedErrors
      .filter((row) => isBlockingErrorCode(row.error_code))
      .map((row) => row.row_number)
      .filter((rowNumber): rowNumber is number => typeof rowNumber === "number")
  );

  const warningErroredRowNumbers = new Set(
    typedErrors
      .filter((row) => !isBlockingErrorCode(row.error_code))
      .map((row) => row.row_number)
      .filter((rowNumber): rowNumber is number => typeof rowNumber === "number")
  );

  const summaryCreateCandidates =
    typeof summary.create_candidates === "number" ? summary.create_candidates : 0;
  const summaryUpdateCandidates =
    typeof summary.update_candidates === "number" ? summary.update_candidates : 0;
  const summaryReadyRows =
    typeof summary.ready_rows === "number" ? summary.ready_rows : 0;

  const summaryBlockingRows =
    typeof summary.blocking_row_count === "number"
      ? summary.blocking_row_count
      : blockingErroredRowNumbers.size;

  const summaryWarningRows =
    typeof summary.warning_row_count === "number"
      ? summary.warning_row_count
      : warningErroredRowNumbers.size;

  const summaryBlockingErrorCount =
    typeof summary.blocking_error_count === "number"
      ? summary.blocking_error_count
      : typedErrors.filter((row) => isBlockingErrorCode(row.error_code)).length;

  const summaryWarningCount =
    typeof summary.warning_count === "number"
      ? summary.warning_count
      : typedErrors.filter((row) => !isBlockingErrorCode(row.error_code)).length;

  const dryRunReady =
    typeof summary.dry_run_ready === "boolean" ? summary.dry_run_ready : false;

  const appointmentClientFound =
    typeof summary.client_found_count === "number" ? summary.client_found_count : 0;
  const appointmentClientMissing =
    typeof summary.client_missing_count === "number" ? summary.client_missing_count : 0;
  const appointmentInstructorFound =
    typeof summary.instructor_found_count === "number" ? summary.instructor_found_count : 0;
  const appointmentInstructorMissing =
    typeof summary.instructor_missing_count === "number" ? summary.instructor_missing_count : 0;
  const appointmentConflictWarnings =
    typeof summary.possible_conflict_warning_count === "number"
      ? summary.possible_conflict_warning_count
      : 0;
  const appointmentInstructorConflictWarnings =
    typeof summary.instructor_conflict_warning_count === "number"
      ? summary.instructor_conflict_warning_count
      : 0;
  const appointmentClientConflictWarnings =
    typeof summary.client_conflict_warning_count === "number"
      ? summary.client_conflict_warning_count
      : 0;
  const appointmentRoomConflictWarnings =
    typeof summary.room_conflict_warning_count === "number"
      ? summary.room_conflict_warning_count
      : 0;

  const paymentClientFound =
    typeof summary.client_found_count === "number" ? summary.client_found_count : 0;
  const paymentClientMissing =
    typeof summary.client_missing_count === "number" ? summary.client_missing_count : 0;
  const paymentRefundWarnings =
    typeof summary.refund_warning_count === "number" ? summary.refund_warning_count : 0;
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

  const canExecute =
    ["clients", "instructors", "appointments", "payments"].includes(typedBatch.import_type) &&
    ["validated", "completed_with_warnings"].includes(typedBatch.status) &&
    (summaryReadyRows > 0 || dryRunReady || summaryBlockingRows === 0);

  const hasErrorsToDownload = typedErrors.length > 0;
  const downloadHref =
    search.download && search.filename
      ? `data:text/csv;base64,${search.download}`
      : null;

  const executeAction =
    typedBatch.import_type === "clients"
      ? executeClientImportBatchAction
      : typedBatch.import_type === "instructors"
        ? executeInstructorImportBatchAction
        : typedBatch.import_type === "appointments"
          ? executeAppointmentImportBatchAction
          : typedBatch.import_type === "payments"
            ? executePaymentImportBatchAction
            : null;

  const showAppointmentExecutionConfirmation =
    typedBatch.import_type === "appointments" && canExecute;
  const showPaymentExecutionConfirmation =
    typedBatch.import_type === "payments" && canExecute;

  const isCompleted = typedBatch.status === "completed";
  const isCompletedWithWarnings = typedBatch.status === "completed_with_warnings";
  const isExecuted = Boolean(summary.executed) || isCompleted || isCompletedWithWarnings;

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

      {downloadHref ? (
        <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">
          Your fix sheet is ready.{" "}
          <a
            href={downloadHref}
            download={search.filename ?? `import-errors-${batchId}.csv`}
            className="font-medium underline"
          >
            Download error CSV
          </a>
        </div>
      ) : null}

      <div className="rounded-2xl border bg-white p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
              {titleForImportType(typedBatch.import_type)}
            </h1>
            <p className="mt-2 text-slate-600">
              Review uploaded file metadata, validation results, preview counts, retry history, and row-level issues.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            {hasErrorsToDownload ? (
              <form action={downloadImportErrorsCsvAction}>
                <input type="hidden" name="batchId" value={typedBatch.id} />
                <button
                  type="submit"
                  className="rounded-xl border px-4 py-2 hover:bg-slate-50"
                >
                  Export Fix Sheet CSV
                </button>
              </form>
            ) : null}

            {!showAppointmentExecutionConfirmation &&
            !showPaymentExecutionConfirmation &&
            canExecute &&
            executeAction ? (
              <form action={executeAction}>
                <input type="hidden" name="batchId" value={typedBatch.id} />
                <button
                  type="submit"
                  className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
                >
                  {executeLabelForImportType(typedBatch.import_type)}
                </button>
              </form>
            ) : null}

            <Link
              href="/app/settings/import"
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Back to Import
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-6">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Type</p>
          <p className="mt-2 text-lg font-semibold text-slate-900">
            {labelize(typedBatch.import_type)}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Source</p>
          <p className="mt-2 text-lg font-semibold text-slate-900">
            {labelize(typedBatch.source_system)}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Mode</p>
          <p className="mt-2 text-lg font-semibold text-slate-900">
            {labelize(typedBatch.mode)}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Status</p>
          <div className="mt-2">
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                typedBatch.status
              )}`}
            >
              {labelize(typedBatch.status)}
            </span>
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Rows</p>
          <p className="mt-2 text-lg font-semibold text-slate-900">
            {typedBatch.total_rows}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Execution Ready</p>
          <p className="mt-2 text-lg font-semibold text-slate-900">
            {canExecute ? "Yes" : "No"}
          </p>
        </div>
      </div>

      {typedBatch.import_type === "payments" && isExecuted ? (
        <div className="rounded-2xl border border-green-200 bg-green-50 p-6">
          <h2 className="text-xl font-semibold text-slate-900">Payment Import Results</h2>
          <p className="mt-2 text-sm text-slate-700">
            This batch has executed. Review the outcome counts below, then use the fix sheet and retry workflow for any remaining issues.
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-4">
            <ExecutionMetric label="Inserted" value={typedBatch.inserted_rows} tone="good" />
            <ExecutionMetric label="Updated" value={typedBatch.updated_rows} tone="good" />
            <ExecutionMetric label="Skipped" value={typedBatch.skipped_rows} tone="warn" />
            <ExecutionMetric label="Failed" value={typedBatch.failed_rows} tone="bad" />
          </div>
        </div>
      ) : null}

      {["clients", "instructors", "appointments", "payments"].includes(typedBatch.import_type) ? (
        <div className="grid gap-4 md:grid-cols-6">
          <SummaryCard label="Create Candidates" value={summaryCreateCandidates} />
          <SummaryCard label="Update Candidates" value={summaryUpdateCandidates} />
          <SummaryCard label="Blocking Rows" value={summaryBlockingRows} tone={summaryBlockingRows > 0 ? "bad" : "good"} />
          <SummaryCard label="Warning Rows" value={summaryWarningRows} tone={summaryWarningRows > 0 ? "warn" : "good"} />
          <SummaryCard label="Ready Rows" value={summaryReadyRows} tone={summaryReadyRows > 0 ? "good" : "default"} />
          <SummaryCard
            label="Total Issues"
            value={summaryBlockingErrorCount + summaryWarningCount}
            tone={summaryBlockingErrorCount > 0 ? "bad" : summaryWarningCount > 0 ? "warn" : "good"}
          />
        </div>
      ) : null}

      {typedBatch.import_type === "appointments" ? (
        <>
          <div className="grid gap-4 md:grid-cols-5">
            <SummaryCard label="Clients Found" value={appointmentClientFound} />
            <SummaryCard label="Clients Missing" value={appointmentClientMissing} tone={appointmentClientMissing > 0 ? "bad" : "good"} />
            <SummaryCard label="Instructors Found" value={appointmentInstructorFound} />
            <SummaryCard label="Instructors Missing" value={appointmentInstructorMissing} tone={appointmentInstructorMissing > 0 ? "bad" : "good"} />
            <SummaryCard label="Total Conflict Warnings" value={appointmentConflictWarnings} tone={appointmentConflictWarnings > 0 ? "warn" : "good"} />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <SummaryCard label="Instructor Conflicts" value={appointmentInstructorConflictWarnings} tone={appointmentInstructorConflictWarnings > 0 ? "warn" : "good"} />
            <SummaryCard label="Client Double-Bookings" value={appointmentClientConflictWarnings} tone={appointmentClientConflictWarnings > 0 ? "warn" : "good"} />
            <SummaryCard label="Room Collisions" value={appointmentRoomConflictWarnings} tone={appointmentRoomConflictWarnings > 0 ? "warn" : "good"} />
          </div>
        </>
      ) : null}

      {typedBatch.import_type === "payments" ? (
        <>
          <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
            <SummaryCard label="Clients Found" value={paymentClientFound} />
            <SummaryCard label="Clients Missing" value={paymentClientMissing} tone={paymentClientMissing > 0 ? "bad" : "good"} />
            <SummaryCard label="Refund Warnings" value={paymentRefundWarnings} tone={paymentRefundWarnings > 0 ? "warn" : "good"} />
            <SummaryCard label="Missing Appointment Refs" value={paymentMissingAppointmentWarnings} tone={paymentMissingAppointmentWarnings > 0 ? "warn" : "good"} />
            <SummaryCard label="Method Normalizations" value={paymentMethodNormalizedWarnings} tone={paymentMethodNormalizedWarnings > 0 ? "warn" : "good"} />
            <SummaryCard label="Status Normalizations" value={paymentStatusNormalizedWarnings} tone={paymentStatusNormalizedWarnings > 0 ? "warn" : "good"} />
          </div>

          <div className="rounded-2xl border bg-white p-6">
            <h2 className="text-xl font-semibold text-slate-900">Payment Import Notes</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border bg-slate-50 p-4 text-sm text-slate-700">
                <p className="font-medium text-slate-900">Normalization behavior</p>
                <p className="mt-2">
                  Imported payment methods are normalized to the app-safe values:
                  <span className="font-medium"> card, cash, check, ach, other</span>.
                </p>
                <p className="mt-2">
                  Imported payment statuses are normalized to:
                  <span className="font-medium"> pending, paid, refunded, failed, voided</span>.
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4 text-sm text-slate-700">
                <p className="font-medium text-slate-900">Traceability</p>
                <p className="mt-2">
                  The original imported payment method, payment status, and any appointment external reference are preserved in payment notes so staff can audit the migration later.
                </p>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {showAppointmentExecutionConfirmation ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
          <h2 className="text-xl font-semibold text-slate-900">Execution Confirmation</h2>
          <p className="mt-2 text-sm text-slate-700">
            Review the appointment import impact before executing. Blocking rows will be skipped. Warning rows should be reviewed carefully.
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-3">
            <ExecutionMetric label="Create Candidates" value={summaryCreateCandidates} />
            <ExecutionMetric label="Update Candidates" value={summaryUpdateCandidates} />
            <ExecutionMetric label="Ready Rows" value={summaryReadyRows} tone={summaryReadyRows > 0 ? "good" : "default"} />
            <ExecutionMetric label="Blocking Rows" value={summaryBlockingRows} tone={summaryBlockingRows > 0 ? "bad" : "good"} />
            <ExecutionMetric label="Warning Rows" value={summaryWarningRows} tone={summaryWarningRows > 0 ? "warn" : "good"} />
            <ExecutionMetric label="Total Conflict Warnings" value={appointmentConflictWarnings} tone={appointmentConflictWarnings > 0 ? "warn" : "good"} />
            <ExecutionMetric label="Clients Missing" value={appointmentClientMissing} tone={appointmentClientMissing > 0 ? "bad" : "good"} />
            <ExecutionMetric label="Instructors Missing" value={appointmentInstructorMissing} tone={appointmentInstructorMissing > 0 ? "bad" : "good"} />
            <ExecutionMetric label="Execution Ready" value={canExecute ? "Yes" : "No"} tone={canExecute ? "good" : "bad"} />
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <ExecutionMetric label="Instructor Conflicts" value={appointmentInstructorConflictWarnings} tone={appointmentInstructorConflictWarnings > 0 ? "warn" : "good"} />
            <ExecutionMetric label="Client Double-Bookings" value={appointmentClientConflictWarnings} tone={appointmentClientConflictWarnings > 0 ? "warn" : "good"} />
            <ExecutionMetric label="Room Collisions" value={appointmentRoomConflictWarnings} tone={appointmentRoomConflictWarnings > 0 ? "warn" : "good"} />
          </div>

          <div className="mt-5 rounded-xl border bg-white p-4 text-sm text-slate-700">
            <p>
              This execution will attempt to import only the rows that passed blocking validation. Existing appointments matched by external ID may be updated unless the batch is in create-only mode.
            </p>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <form action={executeAppointmentImportBatchAction}>
              <input type="hidden" name="batchId" value={typedBatch.id} />
              <button
                type="submit"
                className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
              >
                {executeLabelForImportType(typedBatch.import_type)}
              </button>
            </form>

            <form action={downloadImportErrorsCsvAction}>
              <input type="hidden" name="batchId" value={typedBatch.id} />
              <button
                type="submit"
                className="rounded-xl border px-4 py-2 hover:bg-slate-50"
              >
                Export Fix Sheet CSV
              </button>
            </form>
          </div>
        </div>
      ) : null}

      {showPaymentExecutionConfirmation ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
          <h2 className="text-xl font-semibold text-slate-900">Execution Confirmation</h2>
          <p className="mt-2 text-sm text-slate-700">
            Review the payment import impact before executing. Blocking rows will be skipped. Warning rows should be reviewed carefully.
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-3">
            <ExecutionMetric label="Create Candidates" value={summaryCreateCandidates} />
            <ExecutionMetric label="Update Candidates" value={summaryUpdateCandidates} />
            <ExecutionMetric label="Ready Rows" value={summaryReadyRows} tone={summaryReadyRows > 0 ? "good" : "default"} />
            <ExecutionMetric label="Blocking Rows" value={summaryBlockingRows} tone={summaryBlockingRows > 0 ? "bad" : "good"} />
            <ExecutionMetric label="Warning Rows" value={summaryWarningRows} tone={summaryWarningRows > 0 ? "warn" : "good"} />
            <ExecutionMetric label="Execution Ready" value={canExecute ? "Yes" : "No"} tone={canExecute ? "good" : "bad"} />
            <ExecutionMetric label="Clients Missing" value={paymentClientMissing} tone={paymentClientMissing > 0 ? "bad" : "good"} />
            <ExecutionMetric label="Refund Warnings" value={paymentRefundWarnings} tone={paymentRefundWarnings > 0 ? "warn" : "good"} />
            <ExecutionMetric label="Missing Appointment Refs" value={paymentMissingAppointmentWarnings} tone={paymentMissingAppointmentWarnings > 0 ? "warn" : "good"} />
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <ExecutionMetric label="Method Normalizations" value={paymentMethodNormalizedWarnings} tone={paymentMethodNormalizedWarnings > 0 ? "warn" : "good"} />
            <ExecutionMetric label="Status Normalizations" value={paymentStatusNormalizedWarnings} tone={paymentStatusNormalizedWarnings > 0 ? "warn" : "good"} />
          </div>

          <div className="mt-5 rounded-xl border bg-white p-4 text-sm text-slate-700">
            <p className="font-medium text-slate-900">Before you execute</p>
            <p className="mt-2">
              Imported methods and statuses will be normalized to accepted app values. The original imported values will still be preserved in notes for auditability.
            </p>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <form action={executePaymentImportBatchAction}>
              <input type="hidden" name="batchId" value={typedBatch.id} />
              <button
                type="submit"
                className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
              >
                {executeLabelForImportType(typedBatch.import_type)}
              </button>
            </form>

            <form action={downloadImportErrorsCsvAction}>
              <input type="hidden" name="batchId" value={typedBatch.id} />
              <button
                type="submit"
                className="rounded-xl border px-4 py-2 hover:bg-slate-50"
              >
                Export Fix Sheet CSV
              </button>
            </form>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6">
            <h2 className="text-xl font-semibold text-slate-900">Retry Workflow</h2>

            <div className="mt-5 space-y-4">
              {typedParentBatch ? (
                <div className="rounded-xl border bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">Parent Batch</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <Link
                      href={`/app/settings/import/${typedParentBatch.id}`}
                      className="font-medium text-slate-900 underline"
                    >
                      {typedParentBatch.id}
                    </Link>
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(
                        typedParentBatch.status
                      )}`}
                    >
                      {labelize(typedParentBatch.status)}
                    </span>
                    <span className="text-sm text-slate-500">
                      {formatDateTime(typedParentBatch.created_at)}
                    </span>
                  </div>
                </div>
              ) : null}

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Upload Corrected CSV</p>
                <p className="mt-1 text-sm text-slate-600">
                  Create a new retry batch linked to this one while preserving history.
                </p>

                <div className="mt-4">
                  <ImportUploadForm
                    defaultSourceSystem={typedBatch.source_system}
                    defaultImportType={typedBatch.import_type}
                    defaultMode={typedBatch.mode}
                    parentBatchId={typedBatch.id}
                    submitLabel="Create Corrected Retry Batch"
                    helperText={correctionHelperForImportType(typedBatch.import_type)}
                  />
                </div>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm font-medium text-slate-900">Child Retry Batches</p>
                  <p className="text-xs text-slate-500">{typedChildBatches.length} linked</p>
                </div>

                {typedChildBatches.length > 0 ? (
                  <div className="mt-4 space-y-3">
                    {typedChildBatches.map((child) => (
                      <div
                        key={child.id}
                        className="rounded-lg border bg-white p-3"
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <Link
                            href={`/app/settings/import/${child.id}`}
                            className="font-medium text-slate-900 underline"
                          >
                            {child.id}
                          </Link>
                          <span
                            className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(
                              child.status
                            )}`}
                          >
                            {labelize(child.status)}
                          </span>
                          <span className="text-sm text-slate-500">
                            {formatDateTime(child.created_at)}
                          </span>
                        </div>
                        <div className="mt-2 text-xs text-slate-600">
                          Inserted: {child.inserted_rows} · Updated: {child.updated_rows} ·
                          Skipped: {child.skipped_rows} · Failed: {child.failed_rows}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-slate-500">No retry batches yet.</p>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-6">
            <h2 className="text-xl font-semibold text-slate-900">Batch Summary</h2>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Created</p>
                <p className="mt-1 font-medium text-slate-900">
                  {formatDateTime(typedBatch.created_at)}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Started</p>
                <p className="mt-1 font-medium text-slate-900">
                  {formatDateTime(typedBatch.started_at)}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Completed</p>
                <p className="mt-1 font-medium text-slate-900">
                  {formatDateTime(typedBatch.completed_at)}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Processed Rows</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedBatch.processed_rows}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Inserted</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedBatch.inserted_rows}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Updated</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedBatch.updated_rows}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Skipped</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedBatch.skipped_rows}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Failed</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedBatch.failed_rows}
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-xl border bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Raw Summary</p>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-slate-700">
                {JSON.stringify(typedBatch.summary ?? {}, null, 2)}
              </pre>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-6">
            <h2 className="text-xl font-semibold text-slate-900">Uploaded File</h2>

            {firstFile ? (
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">Filename</p>
                  <p className="mt-1 font-medium text-slate-900">
                    {firstFile.original_filename}
                  </p>
                </div>

                <div className="rounded-xl border bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">Detected Kind</p>
                  <p className="mt-1 font-medium text-slate-900">
                    {labelize(firstFile.detected_kind)}
                  </p>
                </div>

                <div className="rounded-xl border bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">File Size</p>
                  <p className="mt-1 font-medium text-slate-900">
                    {formatFileSize(firstFile.file_size_bytes)}
                  </p>
                </div>

                <div className="rounded-xl border bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">Row Count</p>
                  <p className="mt-1 font-medium text-slate-900">
                    {firstFile.row_count}
                  </p>
                </div>

                <div className="rounded-xl border bg-slate-50 p-4 md:col-span-2">
                  <p className="text-sm text-slate-500">Storage Path</p>
                  <p className="mt-1 break-all font-medium text-slate-900">
                    {firstFile.storage_bucket}/{firstFile.storage_path}
                  </p>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-slate-500">No file metadata found.</p>
            )}
          </div>

          <div className="rounded-2xl border bg-white p-6">
            <h2 className="text-xl font-semibold text-slate-900">Detected Headers</h2>

            {firstFile?.header_columns && firstFile.header_columns.length > 0 ? (
              <div className="mt-5 flex flex-wrap gap-2">
                {firstFile.header_columns.map((header) => (
                  <span
                    key={header}
                    className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700"
                  >
                    {header}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-slate-500">No headers recorded.</p>
            )}
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-6">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-xl font-semibold text-slate-900">Validation / Import Issues</h2>
            <p className="text-sm text-slate-500">{typedErrors.length} shown</p>
          </div>

          <div className="mt-5 space-y-3">
            {typedErrors.length === 0 ? (
              <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">
                No validation or execution issues recorded for this batch.
              </div>
            ) : (
              typedErrors.map((error) => (
                <div
                  key={error.id}
                  className="rounded-xl border bg-slate-50 p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${errorBadgeClass(
                        error.error_code
                      )}`}
                    >
                      {isBlockingErrorCode(error.error_code) ? "Blocking" : "Warning"}
                    </span>

                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${errorBadgeClass(
                        error.error_code
                      )}`}
                    >
                      {labelize(error.error_code)}
                    </span>

                    {error.row_number != null ? (
                      <span className="inline-flex rounded-full bg-slate-200 px-2 py-1 text-xs font-medium text-slate-700">
                        Row {error.row_number}
                      </span>
                    ) : null}

                    {error.field_name ? (
                      <span className="inline-flex rounded-full bg-slate-200 px-2 py-1 text-xs font-medium text-slate-700">
                        {error.field_name}
                      </span>
                    ) : null}
                  </div>

                  <p className="mt-3 text-sm font-medium text-slate-900">
                    {error.error_message}
                  </p>

                  {error.raw_value ? (
                    <p className="mt-2 text-xs text-slate-600">
                      Raw value: {error.raw_value}
                    </p>
                  ) : null}

                  {error.row_data && Object.keys(error.row_data).length > 0 ? (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-medium text-slate-600">
                        View row data
                      </summary>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border bg-white p-3 text-xs text-slate-700">
                        {JSON.stringify(error.row_data, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}