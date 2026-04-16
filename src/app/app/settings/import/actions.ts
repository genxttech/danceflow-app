"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canManageSettings } from "@/lib/auth/permissions";

const IMPORT_BUCKET = "imports";

export type ImportActionState = {
  error: string;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getFile(formData: FormData, key: string) {
  const value = formData.get(key);
  return value instanceof File && value.size > 0 ? value : null;
}

function sanitizeFileName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function splitCsvLine(line: string) {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current.trim());

  return result.map((value) => value.replace(/^"|"$/g, "").trim());
}

function unwrapSingleQuotedCsvCell(line: string) {
  const trimmed = line.trim();

  if (trimmed.length < 2) return line;
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return line;

  const inner = trimmed.slice(1, -1).replace(/""/g, '"');
  if (!inner.includes(",")) return line;

  return inner;
}

function parseCsvHeaders(text: string) {
  const firstLine = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);

  if (!firstLine) return [];

  let headers = splitCsvLine(firstLine);

  if (headers.length === 1 && headers[0].includes(",")) {
    headers = splitCsvLine(unwrapSingleQuotedCsvCell(firstLine));
  }

  return headers.filter(Boolean);
}

function parseCsvRows(text: string) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { headers: [] as string[], rows: [] as Record<string, string>[] };
  }

  let headerLine = lines[0];
  let headers = splitCsvLine(headerLine);

  if (headers.length === 1 && headers[0].includes(",")) {
    headerLine = unwrapSingleQuotedCsvCell(headerLine);
    headers = splitCsvLine(headerLine);
  }

  const rows = lines.slice(1).map((rawLine) => {
    let line = rawLine;
    let values = splitCsvLine(line);

    if (values.length === 1 && headers.length > 1 && values[0].includes(",")) {
      line = unwrapSingleQuotedCsvCell(line);
      values = splitCsvLine(line);
    }

    const row: Record<string, string> = {};

    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });

    return row;
  });

  return { headers, rows };
}

function countCsvRows(text: string) {
  const { rows } = parseCsvRows(text);
  return rows.length;
}

function detectKindFromFilename(filename: string, importType: string) {
  const lower = filename.toLowerCase();

  if (lower.includes("client")) return "clients";
  if (lower.includes("customer")) return "clients";
  if (lower.includes("student")) return "clients";
  if (lower.includes("instructor")) return "instructors";
  if (lower.includes("teacher")) return "instructors";
  if (lower.includes("trainer")) return "instructors";
  if (lower.includes("appointment")) return "appointments";
  if (lower.includes("schedule")) return "appointments";
  if (lower.includes("lesson")) return "appointments";
  if (lower.includes("visit")) return "appointments";
  if (lower.includes("payment")) return "payments";
  if (lower.includes("sale")) return "payments";
  if (lower.includes("transaction")) return "payments";
  if (lower.includes("package")) return "packages";
  if (lower.includes("membership")) return "memberships";

  return importType;
}

function normalizeHeader(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_");
}

function getRowValue(row: Record<string, string>, headerAliases: string[]) {
  const entries = Object.entries(row);

  for (const alias of headerAliases) {
    const match = entries.find(([key]) => normalizeHeader(key) === alias);
    if (match) {
      return match[1].trim();
    }
  }

  return "";
}

function parseMoney(value: string) {
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!cleaned) return NaN;
  return Number(cleaned);
}

function normalizePaymentMethod(value: string | null | undefined) {
  const raw = (value ?? "").trim().toLowerCase();

  if (!raw) return "other";

  if (
    [
      "credit card",
      "card",
      "visa",
      "mastercard",
      "master card",
      "amex",
      "american express",
      "discover",
      "debit",
      "debit card",
    ].includes(raw)
  ) {
    return "card";
  }

  if (raw === "cash") return "cash";
  if (raw === "check" || raw === "cheque") return "check";

  if (
    [
      "ach",
      "bank transfer",
      "bank",
      "echeck",
      "e-check",
      "electronic check",
    ].includes(raw)
  ) {
    return "ach";
  }

  return "other";
}

function normalizePaymentStatus(value: string | null | undefined) {
  const raw = (value ?? "").trim().toLowerCase();

  if (!raw) return "pending";

  if (
    ["paid", "completed", "processed", "succeeded", "success", "settled"].includes(raw)
  ) {
    return "paid";
  }

  if (["pending", "processing", "in progress"].includes(raw)) {
    return "pending";
  }

  if (["refunded", "partial refund", "partially refunded"].includes(raw)) {
    return "refunded";
  }

  if (["failed", "declined", "rejected", "error"].includes(raw)) {
    return "failed";
  }

  if (["voided", "void"].includes(raw)) {
    return "voided";
  }

  return "pending";
}

function buildClientCandidate(row: Record<string, string>) {
  const firstName = getRowValue(row, ["first_name", "firstname", "first"]);
  const lastName = getRowValue(row, ["last_name", "lastname", "last"]);
  const email = getRowValue(row, ["email", "email_address", "emailaddress"]).toLowerCase();
  const phone = getRowValue(row, ["phone", "phone_number", "mobile", "cell"]);
  const danceInterests = getRowValue(row, [
    "dance_interests",
    "interests",
    "dance_styles",
    "styles",
  ]);
  const notes = getRowValue(row, ["notes", "note", "comments"]);
  const skillLevel = getRowValue(row, ["skill_level", "level"]);
  const referralSource = getRowValue(row, ["referral_source", "source", "lead_source"]);
  const externalId = getRowValue(row, [
    "external_id",
    "source_external_id",
    "client_id",
    "customer_id",
    "mindbody_id",
  ]);

  return {
    firstName,
    lastName,
    email,
    phone,
    danceInterests,
    notes,
    skillLevel,
    referralSource,
    externalId,
  };
}

function buildInstructorCandidate(row: Record<string, string>) {
  const firstName = getRowValue(row, ["first_name", "firstname", "first"]);
  const lastName = getRowValue(row, ["last_name", "lastname", "last"]);
  const email = getRowValue(row, ["email", "email_address", "emailaddress"]).toLowerCase();
  const phone = getRowValue(row, ["phone", "phone_number", "mobile", "cell"]);
  const bio = getRowValue(row, ["bio", "description", "notes"]);
  const specialties = getRowValue(row, [
    "specialties",
    "specialty",
    "dance_styles",
    "styles",
    "genres",
  ]);
  const activeRaw = getRowValue(row, ["active", "is_active", "status"]);
  const externalId = getRowValue(row, [
    "external_id",
    "source_external_id",
    "instructor_id",
    "teacher_id",
    "trainer_id",
    "mindbody_id",
  ]);

  const normalizedActive = activeRaw.toLowerCase();
  const active =
    normalizedActive === ""
      ? true
      : ["true", "yes", "1", "active"].includes(normalizedActive);

  return {
    firstName,
    lastName,
    email,
    phone,
    bio,
    specialties,
    active,
    externalId,
  };
}

function buildAppointmentCandidate(row: Record<string, string>) {
  const externalId = getRowValue(row, [
    "external_id",
    "source_external_id",
    "appointment_id",
    "lesson_id",
    "visit_id",
    "mindbody_id",
  ]);

  const clientExternalId = getRowValue(row, [
    "client_external_id",
    "client_id",
    "customer_id",
    "student_id",
  ]);

  const clientEmail = getRowValue(row, [
    "client_email",
    "customer_email",
    "student_email",
    "email",
  ]).toLowerCase();

  const instructorExternalId = getRowValue(row, [
    "instructor_external_id",
    "instructor_id",
    "teacher_id",
    "trainer_id",
  ]);

  const instructorEmail = getRowValue(row, [
    "instructor_email",
    "teacher_email",
    "trainer_email",
  ]).toLowerCase();

  const startsAt = getRowValue(row, [
    "starts_at",
    "start_at",
    "start_time",
    "start",
    "scheduled_start",
    "date_time",
  ]);

  const endsAt = getRowValue(row, [
    "ends_at",
    "end_at",
    "end_time",
    "end",
    "scheduled_end",
  ]);

  const title = getRowValue(row, [
    "title",
    "lesson_type",
    "appointment_type",
    "service",
    "name",
  ]);

  const notes = getRowValue(row, ["notes", "note", "comments"]);
  const status = getRowValue(row, ["status", "appointment_status"]).toLowerCase() || "scheduled";
  const roomName = getRowValue(row, ["room", "room_name", "location", "studio_room"]);

  return {
    externalId,
    clientExternalId,
    clientEmail,
    instructorExternalId,
    instructorEmail,
    startsAt,
    endsAt,
    title,
    notes,
    status,
    roomName,
  };
}

function buildPaymentCandidate(row: Record<string, string>) {
  const externalId = getRowValue(row, [
    "external_id",
    "source_external_id",
    "payment_id",
    "transaction_id",
    "sale_id",
    "mindbody_id",
  ]);

  const clientExternalId = getRowValue(row, [
    "client_external_id",
    "client_id",
    "customer_id",
    "student_id",
  ]);

  const clientEmail = getRowValue(row, [
    "client_email",
    "customer_email",
    "student_email",
    "email",
  ]).toLowerCase();

  const appointmentExternalId = getRowValue(row, [
    "appointment_external_id",
    "appointment_id",
    "lesson_id",
    "visit_id",
  ]);

  const amountRaw = getRowValue(row, [
    "amount",
    "payment_amount",
    "total",
    "sale_total",
    "transaction_amount",
  ]);

  const paymentDate = getRowValue(row, [
    "payment_date",
    "paid_at",
    "date",
    "transaction_date",
    "created_at",
  ]);

  const paymentMethod = getRowValue(row, [
    "payment_method",
    "method",
    "tender_type",
    "tender",
    "type",
  ]);

  const status = getRowValue(row, [
    "status",
    "payment_status",
    "transaction_status",
  ]);

  const notes = getRowValue(row, ["notes", "note", "comments", "memo"]);
  const reference = getRowValue(row, [
    "reference",
    "reference_number",
    "authorization_code",
    "last4",
  ]);

  return {
    externalId,
    clientExternalId,
    clientEmail,
    appointmentExternalId,
    amountRaw,
    amount: parseMoney(amountRaw),
    paymentDate,
    paymentMethod,
    status,
    notes,
    reference,
  };
}

async function getImportContext() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("studio_id, role")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (roleError || !roleRow) {
    redirect("/login");
  }

  if (!canManageSettings(roleRow.role)) {
    redirect("/app");
  }

  return {
    supabase,
    studioId: roleRow.studio_id as string,
    userId: user.id,
  };
}

function validateImportInput(params: {
  sourceSystem: string;
  importType: string;
  mode: string;
  file: File | null;
}) {
  const { sourceSystem, importType, mode, file } = params;

  const allowedSourceSystems = [
    "generic_csv",
    "mindbody",
    "vagaro",
    "studio_director",
    "custom",
  ];

  const allowedImportTypes = [
    "clients",
    "instructors",
    "appointments",
    "payments",
    "packages",
    "memberships",
  ];

  const allowedModes = ["dry_run", "create_only", "create_or_update"];

  if (!allowedSourceSystems.includes(sourceSystem)) {
    return "Invalid source system.";
  }

  if (!allowedImportTypes.includes(importType)) {
    return "Invalid import type.";
  }

  if (!allowedModes.includes(mode)) {
    return "Invalid import mode.";
  }

  if (!file) {
    return "CSV file is required.";
  }

  if (!file.name.toLowerCase().endsWith(".csv")) {
    return "Only CSV files are supported right now.";
  }

  const maxBytes = 25 * 1024 * 1024;
  if (file.size > maxBytes) {
    return "CSV file must be 25 MB or smaller.";
  }

  return null;
}

async function getBatchForStudio(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  batchId: string;
}) {
  const { supabase, studioId, batchId } = params;

  const { data: batch, error } = await supabase
    .from("import_batches")
    .select(`
      id,
      studio_id,
      source_system,
      import_type,
      mode,
      status,
      parent_batch_id
    `)
    .eq("id", batchId)
    .eq("studio_id", studioId)
    .single();

  if (error || !batch) {
    return null;
  }

  return batch;
}

async function getPrimaryBatchFile(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  batchId: string;
}) {
  const { supabase, batchId } = params;

  const { data: fileRow, error } = await supabase
    .from("import_batch_files")
    .select(`
      id,
      original_filename,
      storage_bucket,
      storage_path,
      row_count,
      header_columns
    `)
    .eq("import_batch_id", batchId)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (error || !fileRow) {
    return null;
  }

  return fileRow;
}

async function loadStoredCsvText(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  bucket: string;
  path: string;
}) {
  const { supabase, bucket, path } = params;

  const { data, error } = await supabase.storage.from(bucket).download(path);

  if (error || !data) {
    throw new Error(`Could not download stored CSV: ${error?.message ?? "Missing file."}`);
  }

  return await data.text();
}

async function clearBatchErrors(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  batchId: string;
}) {
  const { supabase, batchId } = params;

  const { error } = await supabase
    .from("import_batch_errors")
    .delete()
    .eq("import_batch_id", batchId);

  if (error) {
    throw new Error(`Could not clear prior batch errors: ${error.message}`);
  }
}

type BatchErrorInsert = {
  import_batch_id: string;
  import_batch_file_id: string | null;
  row_number: number | null;
  field_name: string | null;
  error_code: string;
  error_message: string;
  raw_value: string | null;
  row_data: Record<string, string>;
};

async function writeBatchErrors(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  batchErrors: BatchErrorInsert[];
}) {
  const { supabase, batchErrors } = params;
  if (batchErrors.length === 0) return;

  const { error } = await supabase.from("import_batch_errors").insert(batchErrors);

  if (error) {
    throw new Error(`Could not save import errors: ${error.message}`);
  }
}

async function finalizeBatch(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  batchId: string;
  status: string;
  totalRows: number;
  processedRows: number;
  insertedRows: number;
  updatedRows: number;
  skippedRows: number;
  failedRows: number;
  summary: Record<string, unknown>;
}) {
  const {
    supabase,
    studioId,
    batchId,
    status,
    totalRows,
    processedRows,
    insertedRows,
    updatedRows,
    skippedRows,
    failedRows,
    summary,
  } = params;

  const { error } = await supabase
    .from("import_batches")
    .update({
      status,
      total_rows: totalRows,
      processed_rows: processedRows,
      inserted_rows: insertedRows,
      updated_rows: updatedRows,
      skipped_rows: skippedRows,
      failed_rows: failedRows,
      summary,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", batchId)
    .eq("studio_id", studioId);

  if (error) {
    throw new Error(`Could not update batch summary: ${error.message}`);
  }
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

export async function createImportBatchAction(
  _prevState: ImportActionState,
  formData: FormData
): Promise<ImportActionState> {
  try {
    const { supabase, studioId, userId } = await getImportContext();

    const sourceSystem = getString(formData, "sourceSystem") || "generic_csv";
    const importType = getString(formData, "importType") || "clients";
    const mode = getString(formData, "mode") || "dry_run";
    const parentBatchId = getString(formData, "parentBatchId") || null;
    const file = getFile(formData, "csvFile");

    const validationError = validateImportInput({
      sourceSystem,
      importType,
      mode,
      file,
    });

    if (validationError) {
      return { error: validationError };
    }

    if (parentBatchId) {
      const parentBatch = await getBatchForStudio({
        supabase,
        studioId,
        batchId: parentBatchId,
      });

      if (!parentBatch) {
        return { error: "Parent batch was not found." };
      }
    }

    const csvText = await file!.text();
    const headerColumns = parseCsvHeaders(csvText);
    const rowCount = countCsvRows(csvText);

    const { data: batch, error: batchError } = await supabase
      .from("import_batches")
      .insert({
        studio_id: studioId,
        created_by: userId,
        source_system: sourceSystem,
        import_type: importType,
        mode,
        status: "draft",
        total_rows: rowCount,
        config: {},
        summary: {},
        parent_batch_id: parentBatchId,
      })
      .select("id")
      .single();

    if (batchError || !batch) {
      return {
        error: `Could not create import batch: ${batchError?.message ?? "Unknown error."}`,
      };
    }

    const safeName = sanitizeFileName(file!.name || "import.csv");
    const storagePath = `${studioId}/${batch.id}/${Date.now()}-${safeName}`;

    const bytes = new Uint8Array(await file!.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from(IMPORT_BUCKET)
      .upload(storagePath, bytes, {
        contentType: file!.type || "text/csv",
        upsert: false,
      });

    if (uploadError) {
      return { error: `Could not upload CSV file: ${uploadError.message}` };
    }

    const { error: fileRowError } = await supabase.from("import_batch_files").insert({
      import_batch_id: batch.id,
      original_filename: file!.name,
      storage_bucket: IMPORT_BUCKET,
      storage_path: storagePath,
      mime_type: file!.type || "text/csv",
      file_size_bytes: file!.size,
      row_count: rowCount,
      detected_kind: detectKindFromFilename(file!.name, importType),
      header_columns: headerColumns,
    });

    if (fileRowError) {
      return { error: `Could not save import file metadata: ${fileRowError.message}` };
    }

    const { error: batchUpdateError } = await supabase
      .from("import_batches")
      .update({
        status: "uploaded",
        updated_at: new Date().toISOString(),
      })
      .eq("id", batch.id)
      .eq("studio_id", studioId);

    if (batchUpdateError) {
      return { error: `Could not update import batch: ${batchUpdateError.message}` };
    }

    if (parentBatchId) {
      redirect(`/app/settings/import/${batch.id}?success=retry_created`);
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/settings/import");
}

async function finalizeValidation(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  batchId: string;
  headers: string[];
  rows: Record<string, string>[];
  batchErrors: BatchErrorInsert[];
  extraSummary?: Record<string, unknown>;
}) {
  const { supabase, studioId, batchId, headers, rows, batchErrors, extraSummary } = params;

  await writeBatchErrors({ supabase, batchErrors });

  const blockingRows = new Set(
    batchErrors
      .filter((error) => isBlockingErrorCode(error.error_code))
      .map((error) => error.row_number)
      .filter((rowNumber): rowNumber is number => typeof rowNumber === "number")
  );

  const warningRows = new Set(
    batchErrors
      .filter((error) => !isBlockingErrorCode(error.error_code))
      .map((error) => error.row_number)
      .filter((rowNumber): rowNumber is number => typeof rowNumber === "number")
  );

  const blockingCount = batchErrors.filter((error) =>
    isBlockingErrorCode(error.error_code)
  ).length;

  const warningCount = batchErrors.filter(
    (error) => !isBlockingErrorCode(error.error_code)
  ).length;

  const summary = {
    headers,
    dry_run_ready: blockingCount === 0,
    row_count: rows.length,
    blocking_row_count: blockingRows.size,
    warning_row_count: warningRows.size,
    blocking_error_count: blockingCount,
    warning_count: warningCount,
    error_count: batchErrors.length,
    ...(extraSummary ?? {}),
  };

  const nextStatus =
    blockingCount === 0
      ? warningCount > 0
        ? "completed_with_warnings"
        : "validated"
      : "completed_with_warnings";

  await finalizeBatch({
    supabase,
    studioId,
    batchId,
    status: nextStatus,
    totalRows: rows.length,
    processedRows: rows.length,
    insertedRows: 0,
    updatedRows: 0,
    skippedRows: blockingRows.size,
    failedRows: blockingRows.size,
    summary,
  });
}

export async function validateClientImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (batch.import_type !== "clients") redirect("/app/settings/import?error=wrong_import_type");

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow || !fileRow.storage_bucket || !fileRow.storage_path) {
      redirect("/app/settings/import?error=file_not_found");
    }

    await clearBatchErrors({ supabase, batchId });

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });

    const { headers, rows } = parseCsvRows(csvText);
    const normalizedHeaders = headers.map(normalizeHeader);
    const hasFirstName = normalizedHeaders.some((h) =>
      ["first_name", "firstname", "first"].includes(h)
    );
    const hasLastName = normalizedHeaders.some((h) =>
      ["last_name", "lastname", "last"].includes(h)
    );

    const batchErrors: BatchErrorInsert[] = [];
    const emailSet = new Set<string>();
    const phoneSet = new Set<string>();
    let createCandidates = 0;
    let updateCandidates = 0;
    let readyRows = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      const candidate = buildClientCandidate(row);
      let rowHasBlockingError = false;

      if (!candidate.firstName) {
        rowHasBlockingError = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "first_name",
          error_code: "missing_required_field",
          error_message: "First name is required.",
          raw_value: "",
          row_data: row,
        });
      }

      if (!candidate.lastName) {
        rowHasBlockingError = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "last_name",
          error_code: "missing_required_field",
          error_message: "Last name is required.",
          raw_value: "",
          row_data: row,
        });
      }

      let existingEmailClient: { id: string } | null = null;

      if (candidate.email) {
        const basicEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!basicEmailRegex.test(candidate.email)) {
          rowHasBlockingError = true;
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: "email",
            error_code: "invalid_email",
            error_message: "Email format looks invalid.",
            raw_value: candidate.email,
            row_data: row,
          });
        }

        if (emailSet.has(candidate.email)) {
          rowHasBlockingError = true;
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: "email",
            error_code: "duplicate_in_file",
            error_message: "Duplicate email found in this CSV batch.",
            raw_value: candidate.email,
            row_data: row,
          });
        } else {
          emailSet.add(candidate.email);
        }

        const { data, error: existingEmailError } = await supabase
          .from("clients")
          .select("id")
          .eq("studio_id", studioId)
          .eq("email", candidate.email)
          .maybeSingle();

        if (existingEmailError) {
          throw new Error(`Client duplicate lookup failed: ${existingEmailError.message}`);
        }

        existingEmailClient = data;

        if (existingEmailClient) {
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: "email",
            error_code: "possible_existing_match",
            error_message: "A client with this email already exists and may be updated.",
            raw_value: candidate.email,
            row_data: row,
          });
        }
      }

      if (candidate.phone) {
        if (phoneSet.has(candidate.phone)) {
          rowHasBlockingError = true;
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: "phone",
            error_code: "duplicate_in_file",
            error_message: "Duplicate phone found in this CSV batch.",
            raw_value: candidate.phone,
            row_data: row,
          });
        } else {
          phoneSet.add(candidate.phone);
        }
      }

      if (!rowHasBlockingError) {
        readyRows += 1;
        if (existingEmailClient) {
          updateCandidates += 1;
        } else {
          createCandidates += 1;
        }
      }
    }

    if (!hasFirstName) {
      batchErrors.push({
        import_batch_id: batchId,
        import_batch_file_id: fileRow.id,
        row_number: null,
        field_name: "first_name",
        error_code: "missing_header",
        error_message: "CSV is missing a first name column.",
        raw_value: null,
        row_data: {},
      });
    }

    if (!hasLastName) {
      batchErrors.push({
        import_batch_id: batchId,
        import_batch_file_id: fileRow.id,
        row_number: null,
        field_name: "last_name",
        error_code: "missing_header",
        error_message: "CSV is missing a last name column.",
        raw_value: null,
        row_data: {},
      });
    }

    await finalizeValidation({
      supabase,
      studioId,
      batchId,
      headers,
      rows,
      batchErrors,
      extraSummary: {
        create_candidates: createCandidates,
        update_candidates: updateCandidates,
        ready_rows: readyRows,
      },
    });
  } catch {
    redirect("/app/settings/import?error=validation_failed");
  }

  redirect("/app/settings/import?success=validated");
}

export async function validateInstructorImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (batch.import_type !== "instructors") redirect("/app/settings/import?error=wrong_import_type");

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow || !fileRow.storage_bucket || !fileRow.storage_path) {
      redirect("/app/settings/import?error=file_not_found");
    }

    await clearBatchErrors({ supabase, batchId });

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });

    const { headers, rows } = parseCsvRows(csvText);
    const normalizedHeaders = headers.map(normalizeHeader);
    const hasFirstName = normalizedHeaders.some((h) =>
      ["first_name", "firstname", "first"].includes(h)
    );
    const hasLastName = normalizedHeaders.some((h) =>
      ["last_name", "lastname", "last"].includes(h)
    );

    const batchErrors: BatchErrorInsert[] = [];
    const emailSet = new Set<string>();
    let createCandidates = 0;
    let updateCandidates = 0;
    let readyRows = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      const candidate = buildInstructorCandidate(row);
      let rowHasBlockingError = false;

      if (!candidate.firstName) {
        rowHasBlockingError = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "first_name",
          error_code: "missing_required_field",
          error_message: "First name is required.",
          raw_value: "",
          row_data: row,
        });
      }

      if (!candidate.lastName) {
        rowHasBlockingError = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "last_name",
          error_code: "missing_required_field",
          error_message: "Last name is required.",
          raw_value: "",
          row_data: row,
        });
      }

      let existingEmailInstructor: { id: string } | null = null;

      if (candidate.email) {
        const basicEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!basicEmailRegex.test(candidate.email)) {
          rowHasBlockingError = true;
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: "email",
            error_code: "invalid_email",
            error_message: "Email format looks invalid.",
            raw_value: candidate.email,
            row_data: row,
          });
        }

        if (emailSet.has(candidate.email)) {
          rowHasBlockingError = true;
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: "email",
            error_code: "duplicate_in_file",
            error_message: "Duplicate email found in this CSV batch.",
            raw_value: candidate.email,
            row_data: row,
          });
        } else {
          emailSet.add(candidate.email);
        }

        const { data, error: existingEmailError } = await supabase
          .from("instructors")
          .select("id")
          .eq("studio_id", studioId)
          .eq("email", candidate.email)
          .maybeSingle();

        if (existingEmailError) {
          throw new Error(`Instructor duplicate lookup failed: ${existingEmailError.message}`);
        }

        existingEmailInstructor = data;

        if (existingEmailInstructor) {
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: "email",
            error_code: "possible_existing_match",
            error_message: "An instructor with this email already exists and may be updated.",
            raw_value: candidate.email,
            row_data: row,
          });
        }
      }

      if (!rowHasBlockingError) {
        readyRows += 1;
        if (existingEmailInstructor) {
          updateCandidates += 1;
        } else {
          createCandidates += 1;
        }
      }
    }

    if (!hasFirstName) {
      batchErrors.push({
        import_batch_id: batchId,
        import_batch_file_id: fileRow.id,
        row_number: null,
        field_name: "first_name",
        error_code: "missing_header",
        error_message: "CSV is missing a first name column.",
        raw_value: null,
        row_data: {},
      });
    }

    if (!hasLastName) {
      batchErrors.push({
        import_batch_id: batchId,
        import_batch_file_id: fileRow.id,
        row_number: null,
        field_name: "last_name",
        error_code: "missing_header",
        error_message: "CSV is missing a last name column.",
        raw_value: null,
        row_data: {},
      });
    }

    await finalizeValidation({
      supabase,
      studioId,
      batchId,
      headers,
      rows,
      batchErrors,
      extraSummary: {
        create_candidates: createCandidates,
        update_candidates: updateCandidates,
        ready_rows: readyRows,
      },
    });
  } catch {
    redirect("/app/settings/import?error=validation_failed");
  }

  redirect("/app/settings/import?success=validated");
}

export async function validateAppointmentImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (batch.import_type !== "appointments") {
      redirect("/app/settings/import?error=wrong_import_type");
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow || !fileRow.storage_bucket || !fileRow.storage_path) {
      redirect("/app/settings/import?error=file_not_found");
    }

    await clearBatchErrors({ supabase, batchId });

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });

    const { headers, rows } = parseCsvRows(csvText);
    const normalizedHeaders = headers.map(normalizeHeader);

    const hasStartsAt = normalizedHeaders.some((h) =>
      ["starts_at", "start_at", "start_time", "start", "scheduled_start", "date_time"].includes(h)
    );

    const batchErrors: BatchErrorInsert[] = [];

    const appointmentExternalIds = Array.from(
      new Set(
        rows
          .map((row) => buildAppointmentCandidate(row).externalId)
          .filter((value): value is string => Boolean(value))
      )
    );

    const clientExternalIds = Array.from(
      new Set(
        rows
          .map((row) => buildAppointmentCandidate(row).clientExternalId)
          .filter((value): value is string => Boolean(value))
      )
    );

    const clientEmails = Array.from(
      new Set(
        rows
          .map((row) => buildAppointmentCandidate(row).clientEmail)
          .filter((value): value is string => Boolean(value))
      )
    );

    const instructorExternalIds = Array.from(
      new Set(
        rows
          .map((row) => buildAppointmentCandidate(row).instructorExternalId)
          .filter((value): value is string => Boolean(value))
      )
    );

    const instructorEmails = Array.from(
      new Set(
        rows
          .map((row) => buildAppointmentCandidate(row).instructorEmail)
          .filter((value): value is string => Boolean(value))
      )
    );

    let existingAppointmentsByExternalId = new Set<string>();
    let existingClientsByExternalId = new Set<string>();
    let existingClientsByEmail = new Set<string>();
    let existingInstructorsByExternalId = new Set<string>();
    let existingInstructorsByEmail = new Set<string>();

    if (appointmentExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("appointments")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", batch.source_system)
        .in("source_external_id", appointmentExternalIds);

      if (error) {
        throw new Error(`Appointment duplicate lookup failed: ${error.message}`);
      }

      existingAppointmentsByExternalId = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value))
      );
    }

    if (clientExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("clients")
        .select("id, source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", batch.source_system)
        .in("source_external_id", clientExternalIds);

      if (error) {
        throw new Error(`Client external-id lookup failed: ${error.message}`);
      }

      existingClientsByExternalId = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value))
      );
    }

    if (clientEmails.length > 0) {
      const { data, error } = await supabase
        .from("clients")
        .select("id, email")
        .eq("studio_id", studioId)
        .in("email", clientEmails);

      if (error) {
        throw new Error(`Client email lookup failed: ${error.message}`);
      }

      existingClientsByEmail = new Set(
        (data ?? [])
          .map((row) => row.email)
          .filter((value): value is string => Boolean(value))
          .map((value) => value.toLowerCase())
      );
    }

    if (instructorExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("instructors")
        .select("id, source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", batch.source_system)
        .in("source_external_id", instructorExternalIds);

      if (error) {
        throw new Error(`Instructor external-id lookup failed: ${error.message}`);
      }

      existingInstructorsByExternalId = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value))
      );
    }

    if (instructorEmails.length > 0) {
      const { data, error } = await supabase
        .from("instructors")
        .select("id, email")
        .eq("studio_id", studioId)
        .in("email", instructorEmails);

      if (error) {
        throw new Error(`Instructor email lookup failed: ${error.message}`);
      }

      existingInstructorsByEmail = new Set(
        (data ?? [])
          .map((row) => row.email)
          .filter((value): value is string => Boolean(value))
          .map((value) => value.toLowerCase())
      );
    }

    const existingClientsMap = new Map<
      string,
      { id: string; externalId?: string; email?: string }
    >();
    const existingInstructorsMap = new Map<
      string,
      { id: string; externalId?: string; email?: string }
    >();

    if (clientExternalIds.length > 0 || clientEmails.length > 0) {
      let clientQuery = supabase
        .from("clients")
        .select("id, source_external_id, email")
        .eq("studio_id", studioId);

      if (clientExternalIds.length > 0 && clientEmails.length > 0) {
        clientQuery = clientQuery.or(
          `source_external_id.in.(${clientExternalIds.map((v) => `"${v}"`).join(",")}),email.in.(${clientEmails.map((v) => `"${v}"`).join(",")})`
        );
      } else if (clientExternalIds.length > 0) {
        clientQuery = clientQuery.in("source_external_id", clientExternalIds);
      } else {
        clientQuery = clientQuery.in("email", clientEmails);
      }

      const { data, error } = await clientQuery;

      if (error) {
        throw new Error(`Client resolution lookup failed: ${error.message}`);
      }

      for (const row of data ?? []) {
        if (row.source_external_id) {
          existingClientsMap.set(`ext:${row.source_external_id}`, {
            id: row.id,
            externalId: row.source_external_id,
            email: row.email ?? undefined,
          });
        }
        if (row.email) {
          existingClientsMap.set(`email:${String(row.email).toLowerCase()}`, {
            id: row.id,
            externalId: row.source_external_id ?? undefined,
            email: String(row.email).toLowerCase(),
          });
        }
      }
    }

    if (instructorExternalIds.length > 0 || instructorEmails.length > 0) {
      let instructorQuery = supabase
        .from("instructors")
        .select("id, source_external_id, email")
        .eq("studio_id", studioId);

      if (instructorExternalIds.length > 0 && instructorEmails.length > 0) {
        instructorQuery = instructorQuery.or(
          `source_external_id.in.(${instructorExternalIds.map((v) => `"${v}"`).join(",")}),email.in.(${instructorEmails.map((v) => `"${v}"`).join(",")})`
        );
      } else if (instructorExternalIds.length > 0) {
        instructorQuery = instructorQuery.in("source_external_id", instructorExternalIds);
      } else {
        instructorQuery = instructorQuery.in("email", instructorEmails);
      }

      const { data, error } = await instructorQuery;

      if (error) {
        throw new Error(`Instructor resolution lookup failed: ${error.message}`);
      }

      for (const row of data ?? []) {
        if (row.source_external_id) {
          existingInstructorsMap.set(`ext:${row.source_external_id}`, {
            id: row.id,
            externalId: row.source_external_id,
            email: row.email ?? undefined,
          });
        }
        if (row.email) {
          existingInstructorsMap.set(`email:${String(row.email).toLowerCase()}`, {
            id: row.id,
            externalId: row.source_external_id ?? undefined,
            email: String(row.email).toLowerCase(),
          });
        }
      }
    }

    const parsedStartDates = rows
      .map((row) => buildAppointmentCandidate(row).startsAt)
      .filter((value) => value && !Number.isNaN(Date.parse(value)))
      .map((value) => new Date(value));

    const parsedEndDates = rows
      .map((row) => {
        const candidate = buildAppointmentCandidate(row);
        if (candidate.endsAt && !Number.isNaN(Date.parse(candidate.endsAt))) {
          return new Date(candidate.endsAt);
        }
        if (candidate.startsAt && !Number.isNaN(Date.parse(candidate.startsAt))) {
          return new Date(new Date(candidate.startsAt).getTime() + 60 * 60 * 1000);
        }
        return null;
      })
      .filter((value): value is Date => value instanceof Date);

    const minStart =
      parsedStartDates.length > 0
        ? new Date(Math.min(...parsedStartDates.map((d) => d.getTime()))).toISOString()
        : null;
    const maxEnd =
      parsedEndDates.length > 0
        ? new Date(Math.max(...parsedEndDates.map((d) => d.getTime()))).toISOString()
        : null;

    const existingApptCandidates =
      minStart && maxEnd
        ? await supabase
            .from("appointments")
            .select("id, client_id, instructor_id, starts_at, ends_at, room_name")
            .eq("studio_id", studioId)
            .lt("starts_at", maxEnd)
            .gt("ends_at", minStart)
        : { data: [], error: null as { message?: string } | null };

    if (existingApptCandidates.error) {
      throw new Error(
        `Appointment conflict lookup failed: ${existingApptCandidates.error.message}`
      );
    }

    const existingAppointments = existingApptCandidates.data ?? [];

    let createCandidates = 0;
    let updateCandidates = 0;
    let readyRows = 0;
    let clientFoundCount = 0;
    let clientMissingCount = 0;
    let instructorFoundCount = 0;
    let instructorMissingCount = 0;
    let conflictWarningCount = 0;
    let instructorConflictWarningCount = 0;
    let clientConflictWarningCount = 0;
    let roomConflictWarningCount = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      const candidate = buildAppointmentCandidate(row);

      let rowHasBlockingError = false;

      if (!candidate.startsAt) {
        rowHasBlockingError = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "starts_at",
          error_code: "missing_required_field",
          error_message: "Start time is required.",
          raw_value: "",
          row_data: row,
        });
      } else if (Number.isNaN(Date.parse(candidate.startsAt))) {
        rowHasBlockingError = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "starts_at",
          error_code: "invalid_datetime",
          error_message: "Start time format looks invalid.",
          raw_value: candidate.startsAt,
          row_data: row,
        });
      }

      if (candidate.endsAt && Number.isNaN(Date.parse(candidate.endsAt))) {
        rowHasBlockingError = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "ends_at",
          error_code: "invalid_datetime",
          error_message: "End time format looks invalid.",
          raw_value: candidate.endsAt,
          row_data: row,
        });
      }

      let clientFound = false;
      let resolvedClientId: string | null = null;

      if (candidate.clientExternalId) {
        const found = existingClientsMap.get(`ext:${candidate.clientExternalId}`);
        if (found) {
          clientFound = true;
          resolvedClientId = found.id;
        }
      }

      if (!clientFound && candidate.clientEmail) {
        const found = existingClientsMap.get(`email:${candidate.clientEmail}`);
        if (found) {
          clientFound = true;
          resolvedClientId = found.id;
        }
      }

      if (!candidate.clientExternalId && !candidate.clientEmail) {
        rowHasBlockingError = true;
        clientMissingCount += 1;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "client",
          error_code: "missing_related_record",
          error_message: "Appointment row needs a client external ID or client email.",
          raw_value: "",
          row_data: row,
        });
      } else if (!clientFound) {
        rowHasBlockingError = true;
        clientMissingCount += 1;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "client",
          error_code: "missing_related_record",
          error_message: "Related client could not be found for this row.",
          raw_value: candidate.clientExternalId || candidate.clientEmail || "",
          row_data: row,
        });
      } else {
        clientFoundCount += 1;
      }

      let instructorFound = false;
      let resolvedInstructorId: string | null = null;

      if (candidate.instructorExternalId) {
        const found = existingInstructorsMap.get(`ext:${candidate.instructorExternalId}`);
        if (found) {
          instructorFound = true;
          resolvedInstructorId = found.id;
        }
      }

      if (!instructorFound && candidate.instructorEmail) {
        const found = existingInstructorsMap.get(`email:${candidate.instructorEmail}`);
        if (found) {
          instructorFound = true;
          resolvedInstructorId = found.id;
        }
      }

      if (!candidate.instructorExternalId && !candidate.instructorEmail) {
        rowHasBlockingError = true;
        instructorMissingCount += 1;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "instructor",
          error_code: "missing_related_record",
          error_message: "Appointment row needs an instructor external ID or instructor email.",
          raw_value: "",
          row_data: row,
        });
      } else if (!instructorFound) {
        rowHasBlockingError = true;
        instructorMissingCount += 1;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "instructor",
          error_code: "missing_related_record",
          error_message: "Related instructor could not be found for this row.",
          raw_value: candidate.instructorExternalId || candidate.instructorEmail || "",
          row_data: row,
        });
      } else {
        instructorFoundCount += 1;
      }

      const isUpdate =
        !!candidate.externalId && existingAppointmentsByExternalId.has(candidate.externalId);

      if (!rowHasBlockingError) {
        readyRows += 1;

        if (isUpdate) {
          if (batch.mode === "create_only") {
            batchErrors.push({
              import_batch_id: batchId,
              import_batch_file_id: fileRow.id,
              row_number: rowNumber,
              field_name: "external_id",
              error_code: "possible_existing_match",
              error_message: "Matching appointment exists. Create-only mode would skip update.",
              raw_value: candidate.externalId,
              row_data: row,
            });
          }

          updateCandidates += 1;
        } else {
          createCandidates += 1;
        }
      }

      if (!rowHasBlockingError && candidate.startsAt) {
        const rowStart = new Date(candidate.startsAt);
        const rowEnd =
          candidate.endsAt && !Number.isNaN(Date.parse(candidate.endsAt))
            ? new Date(candidate.endsAt)
            : new Date(rowStart.getTime() + 60 * 60 * 1000);

        const overlaps = existingAppointments.filter((appt) => {
          const apptStart = new Date(appt.starts_at);
          const apptEnd = new Date(appt.ends_at);
          return rowStart < apptEnd && rowEnd > apptStart;
        });

        if (resolvedInstructorId) {
          const instructorConflict = overlaps.some(
            (appt) => appt.instructor_id === resolvedInstructorId
          );

          if (instructorConflict) {
            conflictWarningCount += 1;
            instructorConflictWarningCount += 1;
            batchErrors.push({
              import_batch_id: batchId,
              import_batch_file_id: fileRow.id,
              row_number: rowNumber,
              field_name: "instructor",
              error_code: "possible_time_conflict",
              error_message:
                "Possible instructor overlap found with an existing appointment.",
              raw_value: candidate.startsAt,
              row_data: row,
            });
          }
        }

        if (resolvedClientId) {
          const clientConflict = overlaps.some(
            (appt) => appt.client_id === resolvedClientId
          );

          if (clientConflict) {
            conflictWarningCount += 1;
            clientConflictWarningCount += 1;
            batchErrors.push({
              import_batch_id: batchId,
              import_batch_file_id: fileRow.id,
              row_number: rowNumber,
              field_name: "client",
              error_code: "possible_time_conflict",
              error_message:
                "Possible client double-booking found with an existing appointment.",
              raw_value: candidate.startsAt,
              row_data: row,
            });
          }
        }

        if (candidate.roomName) {
          const normalizedRoom = candidate.roomName.trim().toLowerCase();
          const roomConflict = overlaps.some(
            (appt) => (appt.room_name ?? "").trim().toLowerCase() === normalizedRoom
          );

          if (roomConflict) {
            conflictWarningCount += 1;
            roomConflictWarningCount += 1;
            batchErrors.push({
              import_batch_id: batchId,
              import_batch_file_id: fileRow.id,
              row_number: rowNumber,
              field_name: "room_name",
              error_code: "possible_time_conflict",
              error_message:
                "Possible room collision found with an existing appointment.",
              raw_value: candidate.roomName,
              row_data: row,
            });
          }
        }
      }
    }

    if (!hasStartsAt) {
      batchErrors.push({
        import_batch_id: batchId,
        import_batch_file_id: fileRow.id,
        row_number: null,
        field_name: "starts_at",
        error_code: "missing_header",
        error_message: "CSV is missing a start time column.",
        raw_value: null,
        row_data: {},
      });
    }

    await finalizeValidation({
      supabase,
      studioId,
      batchId,
      headers,
      rows,
      batchErrors,
      extraSummary: {
        create_candidates: createCandidates,
        update_candidates: updateCandidates,
        ready_rows: readyRows,
        client_found_count: clientFoundCount,
        client_missing_count: clientMissingCount,
        instructor_found_count: instructorFoundCount,
        instructor_missing_count: instructorMissingCount,
        possible_conflict_warning_count: conflictWarningCount,
        instructor_conflict_warning_count: instructorConflictWarningCount,
        client_conflict_warning_count: clientConflictWarningCount,
        room_conflict_warning_count: roomConflictWarningCount,
      },
    });
  } catch {
    redirect("/app/settings/import?error=validation_failed");
  }

  redirect("/app/settings/import?success=validated");
}

export async function validatePaymentImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (batch.import_type !== "payments") {
      redirect("/app/settings/import?error=wrong_import_type");
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow || !fileRow.storage_bucket || !fileRow.storage_path) {
      redirect("/app/settings/import?error=file_not_found");
    }

    await clearBatchErrors({ supabase, batchId });

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });

    const { headers, rows } = parseCsvRows(csvText);
    const normalizedHeaders = headers.map(normalizeHeader);

    const hasAmount = normalizedHeaders.some((h) =>
      ["amount", "payment_amount", "total", "sale_total", "transaction_amount"].includes(h)
    );
    const hasPaymentDate = normalizedHeaders.some((h) =>
      ["payment_date", "paid_at", "date", "transaction_date", "created_at"].includes(h)
    );

    const batchErrors: BatchErrorInsert[] = [];
    const paymentExternalIdSet = new Set<string>();

    const paymentExternalIds = Array.from(
      new Set(
        rows
          .map((row) => buildPaymentCandidate(row).externalId)
          .filter((value): value is string => Boolean(value))
      )
    );

    const clientExternalIds = Array.from(
      new Set(
        rows
          .map((row) => buildPaymentCandidate(row).clientExternalId)
          .filter((value): value is string => Boolean(value))
      )
    );

    const clientEmails = Array.from(
      new Set(
        rows
          .map((row) => buildPaymentCandidate(row).clientEmail)
          .filter((value): value is string => Boolean(value))
      )
    );

    const appointmentExternalIds = Array.from(
      new Set(
        rows
          .map((row) => buildPaymentCandidate(row).appointmentExternalId)
          .filter((value): value is string => Boolean(value))
      )
    );

    let existingPaymentsByExternalId = new Set<string>();
    let existingClientsByExternalId = new Set<string>();
    let existingClientsByEmail = new Set<string>();
    let existingAppointmentsByExternalId = new Set<string>();

    if (paymentExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("payments")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", batch.source_system)
        .in("source_external_id", paymentExternalIds);

      if (error) {
        throw new Error(`Payment duplicate lookup failed: ${error.message}`);
      }

      existingPaymentsByExternalId = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value))
      );
    }

    if (clientExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("clients")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", batch.source_system)
        .in("source_external_id", clientExternalIds);

      if (error) {
        throw new Error(`Client external-id lookup failed: ${error.message}`);
      }

      existingClientsByExternalId = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value))
      );
    }

    if (clientEmails.length > 0) {
      const { data, error } = await supabase
        .from("clients")
        .select("email")
        .eq("studio_id", studioId)
        .in("email", clientEmails);

      if (error) {
        throw new Error(`Client email lookup failed: ${error.message}`);
      }

      existingClientsByEmail = new Set(
        (data ?? [])
          .map((row) => row.email)
          .filter((value): value is string => Boolean(value))
          .map((value) => value.toLowerCase())
      );
    }

    if (appointmentExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("appointments")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", batch.source_system)
        .in("source_external_id", appointmentExternalIds);

      if (error) {
        throw new Error(`Appointment external-id lookup failed: ${error.message}`);
      }

      existingAppointmentsByExternalId = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value))
      );
    }

    let createCandidates = 0;
    let updateCandidates = 0;
    let readyRows = 0;
    let clientFoundCount = 0;
    let clientMissingCount = 0;
    let refundWarningCount = 0;
    let missingAppointmentWarningCount = 0;
    let paymentMethodNormalizedWarningCount = 0;
    let paymentStatusNormalizedWarningCount = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      const candidate = buildPaymentCandidate(row);

      let rowHasBlockingError = false;

      if (!candidate.amountRaw) {
        rowHasBlockingError = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "amount",
          error_code: "missing_required_field",
          error_message: "Payment amount is required.",
          raw_value: "",
          row_data: row,
        });
      } else if (Number.isNaN(candidate.amount)) {
        rowHasBlockingError = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "amount",
          error_code: "invalid_amount",
          error_message: "Payment amount is not a valid number.",
          raw_value: candidate.amountRaw,
          row_data: row,
        });
      }

      if (!candidate.paymentDate) {
        rowHasBlockingError = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "payment_date",
          error_code: "missing_required_field",
          error_message: "Payment date is required.",
          raw_value: "",
          row_data: row,
        });
      } else if (Number.isNaN(Date.parse(candidate.paymentDate))) {
        rowHasBlockingError = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "payment_date",
          error_code: "invalid_datetime",
          error_message: "Payment date format looks invalid.",
          raw_value: candidate.paymentDate,
          row_data: row,
        });
      }

      let clientFound = false;
      if (candidate.clientExternalId && existingClientsByExternalId.has(candidate.clientExternalId)) {
        clientFound = true;
      } else if (candidate.clientEmail && existingClientsByEmail.has(candidate.clientEmail)) {
        clientFound = true;
      }

      if (!candidate.clientExternalId && !candidate.clientEmail) {
        rowHasBlockingError = true;
        clientMissingCount += 1;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "client",
          error_code: "missing_related_record",
          error_message: "Payment row needs a client external ID or client email.",
          raw_value: "",
          row_data: row,
        });
      } else if (!clientFound) {
        rowHasBlockingError = true;
        clientMissingCount += 1;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "client",
          error_code: "missing_related_record",
          error_message: "Related client could not be found for this row.",
          raw_value: candidate.clientExternalId || candidate.clientEmail || "",
          row_data: row,
        });
      } else {
        clientFoundCount += 1;
      }

      if (candidate.externalId) {
        if (paymentExternalIdSet.has(candidate.externalId)) {
          rowHasBlockingError = true;
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: "external_id",
            error_code: "duplicate_in_file",
            error_message: "Duplicate payment external ID found in this CSV batch.",
            raw_value: candidate.externalId,
            row_data: row,
          });
        } else {
          paymentExternalIdSet.add(candidate.externalId);
        }

        if (existingPaymentsByExternalId.has(candidate.externalId)) {
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: "external_id",
            error_code: "possible_existing_match",
            error_message: "A payment with this external ID already exists and may be updated.",
            raw_value: candidate.externalId,
            row_data: row,
          });
        }
      }

      if (!Number.isNaN(candidate.amount) && candidate.amount < 0) {
        refundWarningCount += 1;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "amount",
          error_code: "refund_or_negative_amount",
          error_message: "Negative payment amount detected. Review as refund/chargeback.",
          raw_value: candidate.amountRaw,
          row_data: row,
        });
      }

      if (
        candidate.appointmentExternalId &&
        !existingAppointmentsByExternalId.has(candidate.appointmentExternalId)
      ) {
        missingAppointmentWarningCount += 1;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "appointment_external_id",
          error_code: "missing_optional_reference",
          error_message:
            "Referenced appointment was not found. Payment can still import without appointment link.",
          raw_value: candidate.appointmentExternalId,
          row_data: row,
        });
      }

      const normalizedMethod = normalizePaymentMethod(candidate.paymentMethod);
      const normalizedStatus = normalizePaymentStatus(candidate.status);

      if (candidate.paymentMethod && normalizedMethod === "other") {
        paymentMethodNormalizedWarningCount += 1;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "payment_method",
          error_code: "payment_method_normalized",
          error_message:
            "Payment method will be normalized to 'other' during import.",
          raw_value: candidate.paymentMethod,
          row_data: row,
        });
      }

      if (
        candidate.status &&
        normalizedStatus === "pending" &&
        !["pending", "processing", "in progress"].includes(candidate.status.trim().toLowerCase())
      ) {
        paymentStatusNormalizedWarningCount += 1;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "payment_status",
          error_code: "payment_status_normalized",
          error_message:
            "Payment status will be normalized to 'pending' during import.",
          raw_value: candidate.status,
          row_data: row,
        });
      }

      const isUpdate =
        !!candidate.externalId && existingPaymentsByExternalId.has(candidate.externalId);

      if (!rowHasBlockingError) {
        readyRows += 1;
        if (isUpdate) {
          updateCandidates += 1;
        } else {
          createCandidates += 1;
        }
      }
    }

    if (!hasAmount) {
      batchErrors.push({
        import_batch_id: batchId,
        import_batch_file_id: fileRow.id,
        row_number: null,
        field_name: "amount",
        error_code: "missing_header",
        error_message: "CSV is missing an amount column.",
        raw_value: null,
        row_data: {},
      });
    }

    if (!hasPaymentDate) {
      batchErrors.push({
        import_batch_id: batchId,
        import_batch_file_id: fileRow.id,
        row_number: null,
        field_name: "payment_date",
        error_code: "missing_header",
        error_message: "CSV is missing a payment date column.",
        raw_value: null,
        row_data: {},
      });
    }

    await finalizeValidation({
      supabase,
      studioId,
      batchId,
      headers,
      rows,
      batchErrors,
      extraSummary: {
        create_candidates: createCandidates,
        update_candidates: updateCandidates,
        ready_rows: readyRows,
        client_found_count: clientFoundCount,
        client_missing_count: clientMissingCount,
        refund_warning_count: refundWarningCount,
        missing_appointment_warning_count: missingAppointmentWarningCount,
        payment_method_normalized_warning_count: paymentMethodNormalizedWarningCount,
        payment_status_normalized_warning_count: paymentStatusNormalizedWarningCount,
      },
    });
  } catch {
    redirect("/app/settings/import?error=validation_failed");
  }

  redirect("/app/settings/import?success=validated");
}

export async function executeClientImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId, userId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (batch.import_type !== "clients") redirect("/app/settings/import?error=wrong_import_type");
    if (!["validated", "completed_with_warnings"].includes(batch.status)) {
      redirect(`/app/settings/import/${batchId}?error=batch_not_ready`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow || !fileRow.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });

    const { rows, headers } = parseCsvRows(csvText);

    const { data: existingErrors, error: existingErrorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);

    if (existingErrorsError) {
      throw new Error(`Could not load batch errors: ${existingErrorsError.message}`);
    }

    const blockingErroredRowNumbers = new Set(
      (existingErrors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((rowNumber): rowNumber is number => typeof rowNumber === "number")
    );

    const { error: processingError } = await supabase
      .from("import_batches")
      .update({
        status: "processing",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);

    if (processingError) {
      throw new Error(`Could not mark batch processing: ${processingError.message}`);
    }

    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = 0;
    let failedRows = 0;
    const executionErrors: BatchErrorInsert[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;

      if (blockingErroredRowNumbers.has(rowNumber)) {
        skippedRows += 1;
        continue;
      }

      const candidate = buildClientCandidate(row);

      try {
        let matchedClientId: string | null = null;

        if (candidate.externalId) {
          const { data: externalMatch, error: externalMatchError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", batch.source_system)
            .eq("source_external_id", candidate.externalId)
            .maybeSingle();

          if (externalMatchError) {
            throw new Error(externalMatchError.message);
          }

          matchedClientId = externalMatch?.id ?? null;
        }

        if (!matchedClientId && candidate.email) {
          const { data: emailMatch, error: emailMatchError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("email", candidate.email)
            .maybeSingle();

          if (emailMatchError) {
            throw new Error(emailMatchError.message);
          }

          matchedClientId = emailMatch?.id ?? null;
        }

        const clientPayload = {
          studio_id: studioId,
          first_name: candidate.firstName,
          last_name: candidate.lastName,
          email: candidate.email || null,
          phone: candidate.phone || null,
          dance_interests: candidate.danceInterests || null,
          notes: candidate.notes || null,
          skill_level: candidate.skillLevel || null,
          referral_source: candidate.referralSource || null,
          status: "active",
          source_system: batch.source_system,
          source_external_id: candidate.externalId || null,
          imported_at: new Date().toISOString(),
        };

        if (!matchedClientId) {
          const { error: insertError } = await supabase.from("clients").insert({
            ...clientPayload,
            created_by: userId,
          });

          if (insertError) {
            throw new Error(insertError.message);
          }

          insertedRows += 1;
          continue;
        }

        if (batch.mode === "create_only") {
          skippedRows += 1;
          continue;
        }

        const { error: updateError } = await supabase
          .from("clients")
          .update({
            first_name: clientPayload.first_name,
            last_name: clientPayload.last_name,
            email: clientPayload.email,
            phone: clientPayload.phone,
            dance_interests: clientPayload.dance_interests,
            notes: clientPayload.notes,
            skill_level: clientPayload.skill_level,
            referral_source: clientPayload.referral_source,
            source_system: clientPayload.source_system,
            source_external_id: clientPayload.source_external_id,
            imported_at: clientPayload.imported_at,
          })
          .eq("id", matchedClientId)
          .eq("studio_id", studioId);

        if (updateError) {
          throw new Error(updateError.message);
        }

        updatedRows += 1;
      } catch (error) {
        failedRows += 1;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: null,
          error_code: "execution_failed",
          error_message:
            error instanceof Error ? error.message : "Import execution failed.",
          raw_value: null,
          row_data: row,
        });
      }
    }

    await writeBatchErrors({ supabase, batchErrors: executionErrors });

    await finalizeBatch({
      supabase,
      studioId,
      batchId,
      status: failedRows > 0 ? "completed_with_warnings" : "completed",
      totalRows: rows.length,
      processedRows: rows.length,
      insertedRows,
      updatedRows,
      skippedRows,
      failedRows,
      summary: {
        headers,
        executed: true,
        execution_error_count: executionErrors.length,
        row_count: rows.length,
      },
    });
  } catch {
    redirect(`/app/settings/import/${batchId}?error=execution_failed`);
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}

export async function executeInstructorImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (batch.import_type !== "instructors") redirect("/app/settings/import?error=wrong_import_type");
    if (!["validated", "completed_with_warnings"].includes(batch.status)) {
      redirect(`/app/settings/import/${batchId}?error=batch_not_ready`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow || !fileRow.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });

    const { rows, headers } = parseCsvRows(csvText);

    const { data: existingErrors, error: existingErrorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);

    if (existingErrorsError) {
      throw new Error(`Could not load batch errors: ${existingErrorsError.message}`);
    }

    const blockingErroredRowNumbers = new Set(
      (existingErrors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((rowNumber): rowNumber is number => typeof rowNumber === "number")
    );

    const { error: processingError } = await supabase
      .from("import_batches")
      .update({
        status: "processing",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);

    if (processingError) {
      throw new Error(`Could not mark batch processing: ${processingError.message}`);
    }

    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = 0;
    let failedRows = 0;
    const executionErrors: BatchErrorInsert[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;

      if (blockingErroredRowNumbers.has(rowNumber)) {
        skippedRows += 1;
        continue;
      }

      const candidate = buildInstructorCandidate(row);

      try {
        let matchedInstructorId: string | null = null;

        if (candidate.externalId) {
          const { data: externalMatch, error: externalMatchError } = await supabase
            .from("instructors")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", batch.source_system)
            .eq("source_external_id", candidate.externalId)
            .maybeSingle();

          if (externalMatchError) {
            throw new Error(externalMatchError.message);
          }

          matchedInstructorId = externalMatch?.id ?? null;
        }

        if (!matchedInstructorId && candidate.email) {
          const { data: emailMatch, error: emailMatchError } = await supabase
            .from("instructors")
            .select("id")
            .eq("studio_id", studioId)
            .eq("email", candidate.email)
            .maybeSingle();

          if (emailMatchError) {
            throw new Error(emailMatchError.message);
          }

          matchedInstructorId = emailMatch?.id ?? null;
        }

        const instructorPayload = {
          studio_id: studioId,
          first_name: candidate.firstName,
          last_name: candidate.lastName,
          email: candidate.email || null,
          phone: candidate.phone || null,
          bio: candidate.bio || null,
          specialties: candidate.specialties || null,
          active: candidate.active,
          source_system: batch.source_system,
          source_external_id: candidate.externalId || null,
          imported_at: new Date().toISOString(),
        };

        if (!matchedInstructorId) {
          const { error: insertError } = await supabase
            .from("instructors")
            .insert(instructorPayload);

          if (insertError) {
            throw new Error(insertError.message);
          }

          insertedRows += 1;
          continue;
        }

        if (batch.mode === "create_only") {
          skippedRows += 1;
          continue;
        }

        const { error: updateError } = await supabase
          .from("instructors")
          .update({
            first_name: instructorPayload.first_name,
            last_name: instructorPayload.last_name,
            email: instructorPayload.email,
            phone: instructorPayload.phone,
            bio: instructorPayload.bio,
            specialties: instructorPayload.specialties,
            active: instructorPayload.active,
            source_system: instructorPayload.source_system,
            source_external_id: instructorPayload.source_external_id,
            imported_at: instructorPayload.imported_at,
          })
          .eq("id", matchedInstructorId)
          .eq("studio_id", studioId);

        if (updateError) {
          throw new Error(updateError.message);
        }

        updatedRows += 1;
      } catch (error) {
        failedRows += 1;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: null,
          error_code: "execution_failed",
          error_message:
            error instanceof Error ? error.message : "Import execution failed.",
          raw_value: null,
          row_data: row,
        });
      }
    }

    await writeBatchErrors({ supabase, batchErrors: executionErrors });

    await finalizeBatch({
      supabase,
      studioId,
      batchId,
      status: failedRows > 0 ? "completed_with_warnings" : "completed",
      totalRows: rows.length,
      processedRows: rows.length,
      insertedRows,
      updatedRows,
      skippedRows,
      failedRows,
      summary: {
        headers,
        executed: true,
        execution_error_count: executionErrors.length,
        row_count: rows.length,
      },
    });
  } catch {
    redirect(`/app/settings/import/${batchId}?error=execution_failed`);
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}

export async function executeAppointmentImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (batch.import_type !== "appointments") redirect("/app/settings/import?error=wrong_import_type");
    if (!["validated", "completed_with_warnings"].includes(batch.status)) {
      redirect(`/app/settings/import/${batchId}?error=batch_not_ready`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow || !fileRow.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });

    const { rows, headers } = parseCsvRows(csvText);

    const { data: existingErrors, error: existingErrorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);

    if (existingErrorsError) {
      throw new Error(`Could not load batch errors: ${existingErrorsError.message}`);
    }

    const blockingErroredRowNumbers = new Set(
      (existingErrors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((rowNumber): rowNumber is number => typeof rowNumber === "number")
    );

    const { error: processingError } = await supabase
      .from("import_batches")
      .update({
        status: "processing",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);

    if (processingError) {
      throw new Error(`Could not mark batch processing: ${processingError.message}`);
    }

    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = 0;
    let failedRows = 0;
    const executionErrors: BatchErrorInsert[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;

      if (blockingErroredRowNumbers.has(rowNumber)) {
        skippedRows += 1;
        continue;
      }

      const candidate = buildAppointmentCandidate(row);

      try {
        let clientId: string | null = null;
        let instructorId: string | null = null;

        if (candidate.clientExternalId) {
          const { data: clientMatch, error: clientMatchError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", batch.source_system)
            .eq("source_external_id", candidate.clientExternalId)
            .maybeSingle();

          if (clientMatchError) {
            throw new Error(clientMatchError.message);
          }

          clientId = clientMatch?.id ?? null;
        }

        if (!clientId && candidate.clientEmail) {
          const { data: clientEmailMatch, error: clientEmailMatchError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("email", candidate.clientEmail)
            .maybeSingle();

          if (clientEmailMatchError) {
            throw new Error(clientEmailMatchError.message);
          }

          clientId = clientEmailMatch?.id ?? null;
        }

        if (!clientId) {
          throw new Error("Related client could not be found.");
        }

        if (candidate.instructorExternalId) {
          const { data: instructorMatch, error: instructorMatchError } = await supabase
            .from("instructors")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", batch.source_system)
            .eq("source_external_id", candidate.instructorExternalId)
            .maybeSingle();

          if (instructorMatchError) {
            throw new Error(instructorMatchError.message);
          }

          instructorId = instructorMatch?.id ?? null;
        }

        if (!instructorId && candidate.instructorEmail) {
          const { data: instructorEmailMatch, error: instructorEmailMatchError } = await supabase
            .from("instructors")
            .select("id")
            .eq("studio_id", studioId)
            .eq("email", candidate.instructorEmail)
            .maybeSingle();

          if (instructorEmailMatchError) {
            throw new Error(instructorEmailMatchError.message);
          }

          instructorId = instructorEmailMatch?.id ?? null;
        }

        if (!instructorId) {
          throw new Error("Related instructor could not be found.");
        }

        let matchedAppointmentId: string | null = null;

        if (candidate.externalId) {
          const { data: appointmentMatch, error: appointmentMatchError } = await supabase
            .from("appointments")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", batch.source_system)
            .eq("source_external_id", candidate.externalId)
            .maybeSingle();

          if (appointmentMatchError) {
            throw new Error(appointmentMatchError.message);
          }

          matchedAppointmentId = appointmentMatch?.id ?? null;
        }

        const startsAtIso = new Date(candidate.startsAt).toISOString();
        const endsAtIso = candidate.endsAt
          ? new Date(candidate.endsAt).toISOString()
          : new Date(new Date(candidate.startsAt).getTime() + 60 * 60 * 1000).toISOString();

        const appointmentPayload = {
          studio_id: studioId,
          client_id: clientId,
          instructor_id: instructorId,
          starts_at: startsAtIso,
          ends_at: endsAtIso,
          title: candidate.title || "Imported Appointment",
          notes: candidate.notes || null,
          status: candidate.status || "scheduled",
          room_name: candidate.roomName || null,
          source_system: batch.source_system,
          source_external_id: candidate.externalId || null,
          imported_at: new Date().toISOString(),
        };

        if (!matchedAppointmentId) {
          const { error: insertError } = await supabase
            .from("appointments")
            .insert(appointmentPayload);

          if (insertError) {
            throw new Error(insertError.message);
          }

          insertedRows += 1;
          continue;
        }

        if (batch.mode === "create_only") {
          skippedRows += 1;
          continue;
        }

        const { error: updateError } = await supabase
          .from("appointments")
          .update({
            client_id: appointmentPayload.client_id,
            instructor_id: appointmentPayload.instructor_id,
            starts_at: appointmentPayload.starts_at,
            ends_at: appointmentPayload.ends_at,
            title: appointmentPayload.title,
            notes: appointmentPayload.notes,
            status: appointmentPayload.status,
            room_name: appointmentPayload.room_name,
            source_system: appointmentPayload.source_system,
            source_external_id: appointmentPayload.source_external_id,
            imported_at: appointmentPayload.imported_at,
          })
          .eq("id", matchedAppointmentId)
          .eq("studio_id", studioId);

        if (updateError) {
          throw new Error(updateError.message);
        }

        updatedRows += 1;
      } catch (error) {
        failedRows += 1;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: null,
          error_code: "execution_failed",
          error_message:
            error instanceof Error ? error.message : "Import execution failed.",
          raw_value: null,
          row_data: row,
        });
      }
    }

    await writeBatchErrors({ supabase, batchErrors: executionErrors });

    await finalizeBatch({
      supabase,
      studioId,
      batchId,
      status: failedRows > 0 ? "completed_with_warnings" : "completed",
      totalRows: rows.length,
      processedRows: rows.length,
      insertedRows,
      updatedRows,
      skippedRows,
      failedRows,
      summary: {
        headers,
        executed: true,
        execution_error_count: executionErrors.length,
        row_count: rows.length,
      },
    });
  } catch {
    redirect(`/app/settings/import/${batchId}?error=execution_failed`);
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}

export async function executePaymentImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (batch.import_type !== "payments") redirect("/app/settings/import?error=wrong_import_type");
    if (!["validated", "completed_with_warnings"].includes(batch.status)) {
      redirect(`/app/settings/import/${batchId}?error=batch_not_ready`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow || !fileRow.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });

    const { rows, headers } = parseCsvRows(csvText);

    const { data: existingErrors, error: existingErrorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);

    if (existingErrorsError) {
      throw new Error(`Could not load batch errors: ${existingErrorsError.message}`);
    }

    const blockingErroredRowNumbers = new Set(
      (existingErrors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((rowNumber): rowNumber is number => typeof rowNumber === "number")
    );

    const { error: processingError } = await supabase
      .from("import_batches")
      .update({
        status: "processing",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);

    if (processingError) {
      throw new Error(`Could not mark batch processing: ${processingError.message}`);
    }

    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = 0;
    let failedRows = 0;
    const executionErrors: BatchErrorInsert[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;

      if (blockingErroredRowNumbers.has(rowNumber)) {
        skippedRows += 1;
        continue;
      }

      const candidate = buildPaymentCandidate(row);

      try {
        let clientId: string | null = null;

        if (candidate.clientExternalId) {
          const { data: clientMatch, error: clientMatchError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", batch.source_system)
            .eq("source_external_id", candidate.clientExternalId)
            .maybeSingle();

          if (clientMatchError) {
            throw new Error(clientMatchError.message);
          }

          clientId = clientMatch?.id ?? null;
        }

        if (!clientId && candidate.clientEmail) {
          const { data: clientEmailMatch, error: clientEmailMatchError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("email", candidate.clientEmail)
            .maybeSingle();

          if (clientEmailMatchError) {
            throw new Error(clientEmailMatchError.message);
          }

          clientId = clientEmailMatch?.id ?? null;
        }

        if (!clientId) {
          throw new Error("Related client could not be found.");
        }

        let matchedPaymentId: string | null = null;

        if (candidate.externalId) {
          const { data: paymentMatch, error: paymentMatchError } = await supabase
            .from("payments")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", batch.source_system)
            .eq("source_external_id", candidate.externalId)
            .maybeSingle();

          if (paymentMatchError) {
            throw new Error(paymentMatchError.message);
          }

          matchedPaymentId = paymentMatch?.id ?? null;
        }

        const normalizedMethod = normalizePaymentMethod(candidate.paymentMethod);
        const normalizedStatus = normalizePaymentStatus(candidate.status);

        const importedNotes: string[] = [];

        if (candidate.notes) {
          importedNotes.push(candidate.notes);
        }

        if (candidate.appointmentExternalId) {
          importedNotes.push(`Appointment External ID: ${candidate.appointmentExternalId}`);
        }

        if (candidate.paymentMethod) {
          importedNotes.push(`Imported Payment Method: ${candidate.paymentMethod}`);
        }

        if (candidate.status) {
          importedNotes.push(`Imported Payment Status: ${candidate.status}`);
        }

        const paymentPayload = {
          studio_id: studioId,
          client_id: clientId,
          amount: candidate.amount,
          paid_at: new Date(candidate.paymentDate).toISOString(),
          payment_method: normalizedMethod,
          status: normalizedStatus,
          notes: importedNotes.join("\n") || null,
          external_reference: candidate.reference || null,
          source_system: batch.source_system,
          source_external_id: candidate.externalId || null,
          imported_at: new Date().toISOString(),
        };

        if (!matchedPaymentId) {
          const { error: insertError } = await supabase
            .from("payments")
            .insert(paymentPayload);

          if (insertError) {
            throw new Error(insertError.message);
          }

          insertedRows += 1;
          continue;
        }

        if (batch.mode === "create_only") {
          skippedRows += 1;
          continue;
        }

        const { error: updateError } = await supabase
          .from("payments")
          .update({
            client_id: paymentPayload.client_id,
            amount: paymentPayload.amount,
            paid_at: paymentPayload.paid_at,
            payment_method: paymentPayload.payment_method,
            status: paymentPayload.status,
            notes: paymentPayload.notes,
            external_reference: paymentPayload.external_reference,
            source_system: paymentPayload.source_system,
            source_external_id: paymentPayload.source_external_id,
            imported_at: paymentPayload.imported_at,
          })
          .eq("id", matchedPaymentId)
          .eq("studio_id", studioId);

        if (updateError) {
          throw new Error(updateError.message);
        }

        updatedRows += 1;
      } catch (error) {
        failedRows += 1;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: null,
          error_code: "execution_failed",
          error_message:
            error instanceof Error ? error.message : "Import execution failed.",
          raw_value: null,
          row_data: row,
        });
      }
    }

    await writeBatchErrors({ supabase, batchErrors: executionErrors });

    await finalizeBatch({
      supabase,
      studioId,
      batchId,
      status: failedRows > 0 ? "completed_with_warnings" : "completed",
      totalRows: rows.length,
      processedRows: rows.length,
      insertedRows,
      updatedRows,
      skippedRows,
      failedRows,
      summary: {
        headers,
        executed: true,
        execution_error_count: executionErrors.length,
        row_count: rows.length,
      },
    });
  } catch {
    redirect(`/app/settings/import/${batchId}?error=execution_failed`);
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}

export async function downloadImportErrorsCsvAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  const { supabase, studioId } = await getImportContext();
  const batch = await getBatchForStudio({ supabase, studioId, batchId });
  if (!batch) redirect("/app/settings/import?error=batch_not_found");

  const { data: errors, error: errorsError } = await supabase
    .from("import_batch_errors")
    .select(`
      row_number,
      field_name,
      error_code,
      error_message,
      raw_value,
      row_data
    `)
    .eq("import_batch_id", batchId)
    .order("row_number", { ascending: true })
    .order("created_at", { ascending: true });

  if (errorsError) {
    redirect(`/app/settings/import/${batchId}?error=download_failed`);
  }

  const typedErrors = (errors ?? []).map((item) => ({
    row_number: item.row_number ?? "",
    field_name: item.field_name ?? "",
    error_type: isBlockingErrorCode(item.error_code) ? "blocking" : "warning",
    error_code: item.error_code ?? "",
    error_message: item.error_message ?? "",
    raw_value: item.raw_value ?? "",
    row_data:
      item.row_data && typeof item.row_data === "object"
        ? (item.row_data as Record<string, string>)
        : {},
  }));

  const rowDataHeaders = Array.from(
    new Set(typedErrors.flatMap((item) => Object.keys(item.row_data ?? {})))
  );

  const baseHeaders = [
    "row_number",
    "field_name",
    "error_type",
    "error_code",
    "error_message",
    "raw_value",
  ];

  const flattenedHeaders = rowDataHeaders.map((header) => `source_${header}`);
  const headers = [...baseHeaders, ...flattenedHeaders];

  function csvEscape(value: string | number) {
    const stringValue = String(value ?? "");
    if (
      stringValue.includes(",") ||
      stringValue.includes('"') ||
      stringValue.includes("\n")
    ) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  }

  const csvRows = typedErrors.map((item) => {
    const baseValues = [
      item.row_number,
      item.field_name,
      item.error_type,
      item.error_code,
      item.error_message,
      item.raw_value,
    ];

    const flattenedValues = rowDataHeaders.map(
      (header) => item.row_data?.[header] ?? ""
    );

    return [...baseValues, ...flattenedValues];
  });

  const csv = [
    headers.map(csvEscape).join(","),
    ...csvRows.map((row) => row.map(csvEscape).join(",")),
  ].join("\n");

  const encoded = Buffer.from(csv, "utf-8").toString("base64");
  const fileName = `import-errors-${batchId}.csv`;

  redirect(
    `/app/settings/import/${batchId}?download=${encodeURIComponent(
      encoded
    )}&filename=${encodeURIComponent(fileName)}`
  );
}