"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canManageSettings } from "@/lib/auth/permissions";
import {
  CSV_UPLOAD_MIME_TYPES,
  safeOriginalFileName,
  validateUploadFile,
} from "@/lib/security/uploads";

const IMPORT_BUCKET = "imports";

export type ImportActionState = {
  error: string;
};


const DEFAULT_TIME_ZONE = "America/New_York";

function getStudioTimeZone(value?: string | null) {
  const timeZone = value?.trim() || DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function getZonedDateTimeParts(value: Date | string, timeZone: string) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  const hourValue = Number(lookup.get("hour") ?? "0");

  return {
    year: lookup.get("year") ?? "0000",
    month: lookup.get("month") ?? "01",
    day: lookup.get("day") ?? "01",
    hour: String(hourValue === 24 ? 0 : hourValue).padStart(2, "0"),
    minute: lookup.get("minute") ?? "00",
    second: lookup.get("second") ?? "00",
  };
}

function getZonedOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtcDate(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour = 0, minute = 0, second = 0] = time.split(":").map(Number);

  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);

  for (let i = 0; i < 2; i += 1) {
    const offsetMs = getZonedOffsetMs(new Date(utcMs), timeZone);
    utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0) - offsetMs;
  }

  return new Date(utcMs);
}

function parseImportedDateTime(value: string | null | undefined, timeZone: string) {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const isoLike = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );

  if (isoLike) {
    const [, year, month, day, hour = "00", minute = "00", second = "00"] = isoLike;
    return zonedDateTimeToUtcDate(
      `${year}-${month}-${day}`,
      `${hour.padStart(2, "0")}:${minute}:${second}`,
      timeZone
    );
  }

  const usLike = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[,\s]+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?)?$/i
  );

  if (usLike) {
    const [, monthRaw, dayRaw, yearRaw, hourRaw = "00", minuteRaw = "00", meridiemRaw] = usLike;
    const yearNumber = Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw);
    let hourNumber = Number(hourRaw);
    const meridiem = meridiemRaw?.toUpperCase();

    if (meridiem === "PM" && hourNumber < 12) hourNumber += 12;
    if (meridiem === "AM" && hourNumber === 12) hourNumber = 0;

    return zonedDateTimeToUtcDate(
      `${yearNumber}-${String(Number(monthRaw)).padStart(2, "0")}-${String(Number(dayRaw)).padStart(2, "0")}`,
      `${String(hourNumber).padStart(2, "0")}:${String(Number(minuteRaw)).padStart(2, "0")}:00`,
      timeZone
    );
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function isNextRedirectError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

function importErrorDetail(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 500);
  }

  if (typeof error === "string" && error) {
    return error.slice(0, 500);
  }

  return "Unknown import error.";
}

function redirectImportError(path: string, errorCode: string, error: unknown): never {
  if (isNextRedirectError(error)) {
    throw error;
  }

  const separator = path.includes("?") ? "&" : "?";
  redirect(`${path}${separator}error=${encodeURIComponent(errorCode)}&detail=${encodeURIComponent(importErrorDetail(error))}`);
}

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

function normalizeEmail(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ? normalized.slice(0, 320)
    : "";
}

function normalizeImportPhone(value: string) {
  const raw = value.trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw;
}

function buildSourceRelationshipCandidate(row: Record<string, string>) {
  const householdExternalId = getRowValue(row, [
    "household_id",
    "family_id",
    "family_account_id",
    "account_id",
    "family_account",
    "household_account_id",
  ]);
  const relationshipType = getRowValue(row, [
    "relationship_type",
    "family_relationship",
    "relationship",
    "related_client_type",
    "client_relationship",
  ]).toLowerCase();
  const relatedClientExternalId = getRowValue(row, [
    "related_client_id",
    "guardian_client_id",
    "parent_client_id",
    "primary_client_id",
    "payer_client_id",
    "responsible_party_client_id",
  ]);
  const relatedFirstName = getRowValue(row, [
    "related_first_name",
    "guardian_first_name",
    "parent_first_name",
  ]);
  const relatedLastName = getRowValue(row, [
    "related_last_name",
    "guardian_last_name",
    "parent_last_name",
  ]);
  const relatedEmail = normalizeEmail(
    getRowValue(row, [
      "related_email",
      "guardian_email",
      "parent_email",
      "primary_email",
      "payer_email",
      "responsible_party_email",
    ]),
  );
  const relatedPhone = normalizeImportPhone(
    getRowValue(row, [
      "related_phone",
      "guardian_phone",
      "parent_phone",
      "primary_phone",
      "payer_phone",
      "responsible_party_phone",
    ]),
  );

  const hasRelationship =
    Boolean(householdExternalId) ||
    Boolean(relationshipType) ||
    Boolean(relatedClientExternalId) ||
    Boolean(relatedFirstName) ||
    Boolean(relatedLastName) ||
    Boolean(relatedEmail) ||
    Boolean(relatedPhone);

  return {
    householdExternalId,
    relationshipType: relationshipType || "household_member",
    relatedClientExternalId,
    relatedFirstName,
    relatedLastName,
    relatedEmail,
    relatedPhone,
    hasRelationship,
  };
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
  const phone = normalizeImportPhone(
    getRowValue(row, ["phone", "phone_number", "mobile", "cell", "mobile_phone"]),
  );
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
    "clientid",
    "customer_id",
    "wellnessliving_id",
    "wellness_living_id",
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
  const phone = normalizeImportPhone(
    getRowValue(row, ["phone", "phone_number", "mobile", "cell", "mobile_phone"]),
  );
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
    "staff_id",
    "employee_id",
    "teacher_id",
    "trainer_id",
    "wellnessliving_id",
    "wellness_living_id",
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
    "booking_id",
    "class_id",
    "enrollment_id",
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
    "staff_id",
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
    "service_name",
    "class_name",
    "enrollment_name",
    "service",
    "name",
  ]);

  const notes = getRowValue(row, ["notes", "note", "comments"]);
  const status =
    getRowValue(row, ["status", "appointment_status", "booking_status"])
      .toLowerCase() || "scheduled";
  const roomName = getRowValue(row, [
    "room",
    "room_name",
    "location",
    "location_name",
    "studio_room",
  ]);

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
    "refund_id",
    "chargeback_id",
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
    "refund_status",
    "chargeback_status",
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



type SquareProductCandidate = {
  itemExternalId: string;
  itemName: string;
  description: string;
  itemSku: string;
  variationExternalId: string;
  variationName: string;
  sku: string;
  barcode: string;
  categoryExternalId: string;
  categoryName: string;
  price: number;
  unitCost: number | null;
  size: string;
  color: string;
  active: boolean;
};

function parseBooleanImportValue(value: string, defaultValue = true) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["true", "yes", "1", "active", "enabled"].includes(normalized)) return true;
  if (["false", "no", "0", "inactive", "archived", "deleted"].includes(normalized)) return false;
  return defaultValue;
}




type SquareDigitalEntitlementCandidate = {
  orderExternalId: string;
  lineItemExternalId: string;
  customerExternalId: string;
  customerEmail: string;
  itemExternalId: string;
  danceFlowCatalogItemId: string;
  purchasedAt: string;
  accessStatus: string;
  refundAccessPolicy: string;
};

function buildSquareDigitalEntitlementCandidate(
  row: Record<string, string>,
): SquareDigitalEntitlementCandidate {
  return {
    orderExternalId: getRowValue(row, [
      "order_id",
      "square_order_id",
      "source_order_id",
    ]),
    lineItemExternalId: getRowValue(row, [
      "line_item_id",
      "square_line_item_id",
    ]),
    customerExternalId: getRowValue(row, [
      "customer_id",
      "square_customer_id",
    ]),
    customerEmail: normalizeEmail(
      getRowValue(row, ["customer_email", "email", "buyer_email"]),
    ),
    itemExternalId: getRowValue(row, [
      "item_id",
      "square_item_id",
      "catalog_object_id",
    ]),
    danceFlowCatalogItemId: getRowValue(row, [
      "danceflow_catalog_item_id",
      "catalog_item_id",
    ]),
    purchasedAt: getRowValue(row, [
      "purchased_at",
      "paid_at",
      "closed_at",
      "completed_at",
    ]),
    accessStatus: getRowValue(row, [
      "access_status",
      "entitlement_status",
    ]).toLowerCase(),
    refundAccessPolicy: getRowValue(row, [
      "refund_access_policy",
      "refund_policy",
    ]).toLowerCase(),
  };
}

function normalizeSquareEntitlementStatus(
  accessStatus: string,
  refundAccessPolicy: string,
) {
  if (
    accessStatus === "refunded_access_retained" ||
    refundAccessPolicy === "retain"
  ) {
    return "refunded_access_retained";
  }

  return "active";
}

type SquareHistoricalOrderCandidate = {
  orderExternalId: string;
  orderNumber: string;
  customerExternalId: string;
  customerEmail: string;
  customerFirstName: string;
  customerLastName: string;
  customerPhone: string;
  orderStatus: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  currency: string;
  subtotal: number | null;
  discountTotal: number | null;
  taxTotal: number | null;
  refundTotal: number | null;
  total: number | null;
  completedAt: string;
  lineItemExternalId: string;
  itemExternalId: string;
  variationExternalId: string;
  itemName: string;
  sku: string;
  quantity: number | null;
  unitPrice: number | null;
  lineDiscountTotal: number | null;
  lineTaxTotal: number | null;
  lineTotal: number | null;
  paymentExternalId: string;
  paymentMethod: string;
  paidAt: string;
  notes: string;
};

function parsePositiveInteger(value: string) {
  const normalized = value.replace(/,/g, "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 10000
    ? parsed
    : null;
}

function normalizeSquareOrderStatus(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["refunded"].includes(normalized)) return "refunded";
  if (["completed", "complete", "closed", "fulfilled"].includes(normalized)) {
    return "completed";
  }
  if (["open", "pending"].includes(normalized)) return "open";
  return "completed";
}

function normalizeSquareOrderPaymentStatus(
  value: string,
  refundTotal: number,
  total: number,
) {
  const normalized = value.trim().toLowerCase();

  if (refundTotal > 0 && refundTotal >= total) return "refunded";
  if (refundTotal > 0) return "partially_refunded";
  if (["failed", "declined"].includes(normalized)) return "failed";
  if (["pending", "authorized"].includes(normalized)) return "pending";
  if (["unpaid", "not_paid"].includes(normalized)) return "unpaid";
  if (["refunded"].includes(normalized)) return "refunded";
  if (["partially_refunded", "partial_refund"].includes(normalized)) {
    return "partially_refunded";
  }
  return "paid";
}

function normalizeSquareFulfillmentStatus(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["fulfilled", "completed", "complete"].includes(normalized)) {
    return "fulfilled";
  }
  if (["partially_fulfilled", "partial"].includes(normalized)) {
    return "partially_fulfilled";
  }
  if (["not_required", "digital"].includes(normalized)) return "not_required";
  return "unfulfilled";
}

function buildSquareHistoricalOrderCandidate(
  row: Record<string, string>,
): SquareHistoricalOrderCandidate {
  return {
    orderExternalId: getRowValue(row, [
      "order_id",
      "square_order_id",
      "source_order_id",
    ]),
    orderNumber: getRowValue(row, [
      "reference_id",
      "order_number",
      "receipt_number",
    ]),
    customerExternalId: getRowValue(row, [
      "customer_id",
      "square_customer_id",
      "client_external_id",
    ]),
    customerEmail: normalizeEmail(
      getRowValue(row, ["customer_email", "email", "buyer_email"]),
    ),
    customerFirstName: getRowValue(row, [
      "customer_first_name",
      "first_name",
      "buyer_first_name",
    ]),
    customerLastName: getRowValue(row, [
      "customer_last_name",
      "last_name",
      "buyer_last_name",
    ]),
    customerPhone: getRowValue(row, [
      "customer_phone",
      "phone",
      "phone_number",
    ]),
    orderStatus: getRowValue(row, ["order_status", "state", "status"]),
    paymentStatus: getRowValue(row, [
      "payment_status",
      "tender_status",
    ]),
    fulfillmentStatus: getRowValue(row, [
      "fulfillment_status",
      "fulfillment_state",
    ]),
    currency: getRowValue(row, ["currency", "currency_code"]) || "usd",
    subtotal: parseMoney(
      getRowValue(row, ["subtotal", "order_subtotal", "gross_sales"]),
    ),
    discountTotal: parseMoney(
      getRowValue(row, ["discount_total", "discounts", "discount"]),
    ),
    taxTotal: parseMoney(
      getRowValue(row, ["tax_total", "taxes", "tax"]),
    ),
    refundTotal: parseMoney(
      getRowValue(row, ["refund_total", "refunded_amount", "refund_amount"]),
    ),
    total: parseMoney(
      getRowValue(row, ["total", "order_total", "net_total"]),
    ),
    completedAt: getRowValue(row, [
      "closed_at",
      "completed_at",
      "order_date",
      "created_at",
    ]),
    lineItemExternalId: getRowValue(row, [
      "line_item_id",
      "square_line_item_id",
    ]),
    itemExternalId: getRowValue(row, [
      "catalog_object_id",
      "item_id",
      "square_item_id",
    ]),
    variationExternalId: getRowValue(row, [
      "variation_id",
      "square_variation_id",
    ]),
    itemName: getRowValue(row, [
      "item_name",
      "line_item_name",
      "name",
    ]),
    sku: getRowValue(row, ["sku", "variation_sku"]),
    quantity: parsePositiveInteger(
      getRowValue(row, ["quantity", "line_quantity"]),
    ),
    unitPrice: parseMoney(
      getRowValue(row, ["unit_price", "base_price", "price"]),
    ),
    lineDiscountTotal: parseMoney(
      getRowValue(row, ["line_discount_total", "line_discount"]),
    ),
    lineTaxTotal: parseMoney(
      getRowValue(row, ["line_tax_total", "line_tax"]),
    ),
    lineTotal: parseMoney(
      getRowValue(row, ["line_total", "gross_line_total"]),
    ),
    paymentExternalId: getRowValue(row, [
      "payment_id",
      "square_payment_id",
      "tender_id",
    ]),
    paymentMethod: getRowValue(row, [
      "payment_method",
      "tender_type",
      "card_brand",
    ]),
    paidAt: getRowValue(row, [
      "paid_at",
      "payment_date",
      "closed_at",
      "completed_at",
    ]),
    notes: getRowValue(row, ["notes", "note"]),
  };
}

function isValidImportDate(value: string) {
  return Boolean(value) && !Number.isNaN(new Date(value).getTime());
}

type SquareInventoryCandidate = {
  variationExternalId: string;
  locationExternalId: string;
  locationName: string;
  quantity: number;
  calculatedAt: string;
};

function parseInventoryQuantity(value: string) {
  const normalized = value.replace(/,/g, "").trim();
  if (!/^-?\d+$/.test(normalized)) return NaN;
  return Number(normalized);
}

function buildSquareInventoryCandidate(
  row: Record<string, string>,
): SquareInventoryCandidate {
  const quantityRaw = getRowValue(row, [
    "quantity",
    "quantity_on_hand",
    "count",
    "inventory_count",
    "calculated_quantity",
  ]);

  return {
    variationExternalId: getRowValue(row, [
      "variation_id",
      "square_variation_id",
      "catalog_object_id",
      "variant_id",
    ]),
    locationExternalId: getRowValue(row, [
      "location_id",
      "square_location_id",
    ]),
    locationName: getRowValue(row, [
      "location_name",
      "square_location_name",
    ]),
    quantity: parseInventoryQuantity(quantityRaw),
    calculatedAt: getRowValue(row, [
      "calculated_at",
      "updated_at",
      "counted_at",
    ]),
  };
}

function buildSquareProductCandidate(row: Record<string, string>): SquareProductCandidate {
  const priceRaw = getRowValue(row, [
    "price",
    "variation_price",
    "price_override",
    "base_price",
    "amount",
  ]);
  const unitCostRaw = getRowValue(row, ["unit_cost", "cost", "cost_per_unit"]);
  const parsedUnitCost = unitCostRaw ? parseMoney(unitCostRaw) : NaN;

  return {
    itemExternalId: getRowValue(row, ["item_id", "square_item_id", "catalog_item_id", "product_id"]),
    itemName: getRowValue(row, ["item_name", "product_name", "name"]),
    description: getRowValue(row, ["description", "item_description", "product_description"]),
    itemSku: getRowValue(row, ["item_sku", "parent_sku", "product_sku"]),
    variationExternalId: getRowValue(row, ["variation_id", "square_variation_id", "variant_id"]),
    variationName: getRowValue(row, ["variation_name", "variant_name", "option_name"]),
    sku: getRowValue(row, ["sku", "variation_sku", "variant_sku"]),
    barcode: getRowValue(row, ["barcode", "upc", "gtin"]),
    categoryExternalId: getRowValue(row, ["category_id", "square_category_id"]),
    categoryName: getRowValue(row, ["category_name", "category"]),
    price: parseMoney(priceRaw),
    unitCost: Number.isNaN(parsedUnitCost) ? null : parsedUnitCost,
    size: getRowValue(row, ["size", "variation_size"]),
    color: getRowValue(row, ["color", "colour", "variation_color"]),
    active: parseBooleanImportValue(getRowValue(row, ["active", "is_active", "status"]), true),
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
    "wellnessliving",
    "pike13",
    "square",
    "vagaro",
    "studio_director",
    "spreadsheet",
    "custom",
  ];

  const allowedImportTypes = [
    "clients",
    "instructors",
    "appointments",
    "payments",
    "packages",
    "memberships",
    "attendance",
    "account_credits",
    "products",
    "inventory",
    "retail_orders",
    "digital_entitlements",
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
    "ambiguous_existing_match",
    "duplicate_source_identity",
    "missing_header",
    "invalid_datetime",
    "missing_related_record",
    "invalid_amount",
    "execution_failed",
  ].includes(errorCode);
}

export async function archiveUnfinishedImportBatchesAction() {
  try {
    const { supabase, studioId } = await getImportContext();
    const now = new Date().toISOString();

    const { error } = await supabase
      .from("import_batches")
      .update({
        status: "abandoned",
        updated_at: now,
      })
      .eq("studio_id", studioId)
      .in("status", ["draft", "uploaded", "validated"]);

    if (error) {
      throw new Error(`Could not archive unfinished imports: ${error.message}`);
    }
  } catch (error) {
    if (isNextRedirectError(error)) {
      throw error;
    }

    redirectImportError("/app/settings/import", "archive_failed", error);
  }

  redirect("/app/settings/import?success=drafts_archived");
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

    const uploadValidation = await validateUploadFile(file, {
      fieldLabel: "CSV file",
      maxBytes: 25 * 1024 * 1024,
      allowedMimeTypes: CSV_UPLOAD_MIME_TYPES,
      allowedExtensions: ["csv"],
      kind: "csv",
    });

    if (!uploadValidation.ok) {
      return { error: uploadValidation.error };
    }

    const csvText = await file!.text();
    const headerColumns = parseCsvHeaders(csvText);
    const rowCount = countCsvRows(csvText);

    const { data: onboardingProject } = await supabase
      .from("onboarding_projects")
      .select("id")
      .eq("studio_id", studioId)
      .eq("checklist_type", "studio")
      .maybeSingle<{ id: string }>();

    const stageSequence: Record<string, number> = {
      clients: 10,
      instructors: 20,
      products: 30,
      inventory: 40,
      packages: 50,
      memberships: 60,
      appointments: 70,
      attendance: 75,
      payments: 80,
      account_credits: 85,
      retail_orders: 90,
      digital_entitlements: 100,
    };

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
        onboarding_project_id: onboardingProject?.id ?? null,
        stage_key: importType,
        sequence_number: stageSequence[importType] ?? 999,
        reconciliation_status: "not_started",
      })
      .select("id")
      .single();

    if (batchError || !batch) {
      return {
        error: `Could not create import batch: ${batchError?.message ?? "Unknown error."}`,
      };
    }

    const safeName = sanitizeFileName(safeOriginalFileName(file!.name, "import.csv"));
    const storagePath = `${studioId}/${batch.id}/${Date.now()}-${safeName}`;

    const bytes = new Uint8Array(await file!.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from(IMPORT_BUCKET)
      .upload(storagePath, bytes, {
        contentType: uploadValidation.mimeType,
        upsert: false,
      });

    if (uploadError) {
      return { error: `Could not upload CSV file: ${uploadError.message}` };
    }

    const { error: fileRowError } = await supabase.from("import_batch_files").insert({
      import_batch_id: batch.id,
      original_filename: safeOriginalFileName(file!.name, "import.csv"),
      storage_bucket: IMPORT_BUCKET,
      storage_path: storagePath,
      mime_type: uploadValidation.mimeType,
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
    if (isNextRedirectError(error)) {
      throw error;
    }

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

    const isWellnessLiving = batch.source_system === "wellnessliving";
    const isMindbody = batch.source_system === "mindbody";
    const isSourceSpecificStudioMigration = isWellnessLiving || isMindbody;
    const batchErrors: BatchErrorInsert[] = [];
    const externalIdSet = new Set<string>();
    const emailSet = new Set<string>();
    const phoneSet = new Set<string>();
    let createCandidates = 0;
    let updateCandidates = 0;
    let readyRows = 0;
    let sourceIdMatches = 0;
    let emailMatches = 0;
    let phoneMatches = 0;
    let relationshipRows = 0;
    let relationshipReviewRows = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      const candidate = buildClientCandidate(row);
      const relationship = isSourceSpecificStudioMigration
        ? buildSourceRelationshipCandidate(row)
        : null;
      let rowHasBlockingError = false;
      let existingMatch: { id: string } | null = null;
      let matchMethod = "";

      const addBlocking = (
        fieldName: string,
        errorCode: string,
        errorMessage: string,
        rawValue: string | null,
      ) => {
        rowHasBlockingError = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: fieldName,
          error_code: errorCode,
          error_message: errorMessage,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.firstName) {
        addBlocking("first_name", "missing_required_field", "First name is required.", "");
      }

      if (!candidate.lastName) {
        addBlocking("last_name", "missing_required_field", "Last name is required.", "");
      }

      if (candidate.externalId) {
        if (externalIdSet.has(candidate.externalId)) {
          addBlocking(
            "source_external_id",
            "duplicate_source_identity",
            "The same source client ID appears more than once in this CSV.",
            candidate.externalId,
          );
        } else {
          externalIdSet.add(candidate.externalId);
        }

        const { data: sourceMatches, error: sourceMatchError } = await supabase
          .from("clients")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", batch.source_system)
          .eq("source_external_id", candidate.externalId)
          .limit(2);

        if (sourceMatchError) {
          throw new Error(`Client source-ID lookup failed: ${sourceMatchError.message}`);
        }

        if ((sourceMatches ?? []).length > 1) {
          addBlocking(
            "source_external_id",
            "ambiguous_existing_match",
            "Multiple clients already use this source ID. Resolve the duplicate before importing.",
            candidate.externalId,
          );
        } else if (sourceMatches?.[0]) {
          existingMatch = sourceMatches[0];
          matchMethod = "source_external_id";
          sourceIdMatches += 1;
        }
      }

      if (candidate.email) {
        const basicEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!basicEmailRegex.test(candidate.email)) {
          addBlocking(
            "email",
            "invalid_email",
            "Email format looks invalid.",
            candidate.email,
          );
        }

        if (emailSet.has(candidate.email)) {
          addBlocking(
            "email",
            "duplicate_in_file",
            "Duplicate email found in this CSV batch.",
            candidate.email,
          );
        } else {
          emailSet.add(candidate.email);
        }

        if (!existingMatch) {
          const { data: emailMatchesFound, error: emailMatchError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("email", candidate.email)
            .limit(2);

          if (emailMatchError) {
            throw new Error(`Client email lookup failed: ${emailMatchError.message}`);
          }

          if ((emailMatchesFound ?? []).length > 1) {
            addBlocking(
              "email",
              "ambiguous_existing_match",
              "Multiple clients match this email. Choose the correct client before importing.",
              candidate.email,
            );
          } else if (emailMatchesFound?.[0]) {
            existingMatch = emailMatchesFound[0];
            matchMethod = "normalized_email";
            emailMatches += 1;
          }
        }
      }

      if (candidate.phone) {
        if (phoneSet.has(candidate.phone)) {
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: "phone",
            error_code: "duplicate_phone_in_file",
            error_message:
              "This phone appears more than once in the CSV. It will not be used as an automatic match for this row.",
            raw_value: candidate.phone,
            row_data: row,
          });
        } else {
          phoneSet.add(candidate.phone);
        }

        if (isWellnessLiving && !existingMatch && !phoneSet.has(`matched:${candidate.phone}`)) {
          const { data: phoneMatchesFound, error: phoneMatchError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("phone", candidate.phone)
            .limit(2);

          if (phoneMatchError) {
            throw new Error(`Client phone lookup failed: ${phoneMatchError.message}`);
          }

          if ((phoneMatchesFound ?? []).length > 1) {
            addBlocking(
              "phone",
              "ambiguous_existing_match",
              "Multiple clients match this normalized phone number. Review the client manually.",
              candidate.phone,
            );
          } else if (phoneMatchesFound?.[0]) {
            existingMatch = phoneMatchesFound[0];
            matchMethod = "normalized_phone";
            phoneMatches += 1;
            phoneSet.add(`matched:${candidate.phone}`);
          }
        }
      }

      if (relationship?.hasRelationship) {
        relationshipRows += 1;
        if (
          !relationship.relatedClientExternalId &&
          !relationship.relatedEmail &&
          !relationship.householdExternalId
        ) {
          relationshipReviewRows += 1;
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: "relationship",
            error_code: "relationship_needs_review",
            error_message:
              `${isMindbody ? "A Mindbody" : "A WellnessLiving"} family or payer relationship was found without a stable related client ID, email, or household ID. It will be preserved for review.`,
            raw_value: relationship.relationshipType,
            row_data: row,
          });
        }
      }

      if (!rowHasBlockingError) {
        readyRows += 1;
        if (existingMatch) {
          updateCandidates += 1;
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: matchMethod || "identity",
            error_code: "possible_existing_match",
            error_message: `Existing client match found by ${matchMethod.replaceAll("_", " ")}.`,
            raw_value:
              matchMethod === "source_external_id"
                ? candidate.externalId
                : matchMethod === "normalized_email"
                  ? candidate.email
                  : candidate.phone,
            row_data: row,
          });
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
        source_id_matches: sourceIdMatches,
        email_matches: emailMatches,
        phone_matches: phoneMatches,
        relationship_rows: relationshipRows,
        relationship_review_rows: relationshipReviewRows,
        source_specific_validation: isMindbody
          ? "mindbody_clients_relationships_v1"
          : isWellnessLiving
            ? "wellnessliving_v1"
            : "generic",
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
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

    const isWellnessLiving = batch.source_system === "wellnessliving";
    const isMindbody = batch.source_system === "mindbody";
    const isSourceSpecificStudioMigration = isWellnessLiving || isMindbody;
    const batchErrors: BatchErrorInsert[] = [];
    const externalIdSet = new Set<string>();
    const emailSet = new Set<string>();
    let createCandidates = 0;
    let updateCandidates = 0;
    let readyRows = 0;
    let roleReviewRows = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      const candidate = buildInstructorCandidate(row);
      const sourceRole = getRowValue(row, [
        "role",
        "staff_role",
        "position",
        "job_title",
        "title",
      ]);
      let rowHasBlockingError = false;
      let existingMatch: { id: string } | null = null;

      const addBlocking = (
        fieldName: string,
        errorCode: string,
        errorMessage: string,
        rawValue: string | null,
      ) => {
        rowHasBlockingError = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: fieldName,
          error_code: errorCode,
          error_message: errorMessage,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.firstName) {
        addBlocking("first_name", "missing_required_field", "First name is required.", "");
      }
      if (!candidate.lastName) {
        addBlocking("last_name", "missing_required_field", "Last name is required.", "");
      }

      if (candidate.externalId) {
        if (externalIdSet.has(candidate.externalId)) {
          addBlocking(
            "source_external_id",
            "duplicate_source_identity",
            "The same source staff ID appears more than once in this CSV.",
            candidate.externalId,
          );
        } else {
          externalIdSet.add(candidate.externalId);
        }

        const { data: sourceMatches, error: sourceError } = await supabase
          .from("instructors")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", batch.source_system)
          .eq("source_external_id", candidate.externalId)
          .limit(2);

        if (sourceError) throw new Error(`Instructor source-ID lookup failed: ${sourceError.message}`);

        if ((sourceMatches ?? []).length > 1) {
          addBlocking(
            "source_external_id",
            "ambiguous_existing_match",
            "Multiple instructors already use this source ID.",
            candidate.externalId,
          );
        } else if (sourceMatches?.[0]) {
          existingMatch = sourceMatches[0];
        }
      }

      if (candidate.email) {
        const basicEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!basicEmailRegex.test(candidate.email)) {
          addBlocking("email", "invalid_email", "Email format looks invalid.", candidate.email);
        }

        if (emailSet.has(candidate.email)) {
          addBlocking(
            "email",
            "duplicate_in_file",
            "Duplicate instructor email found in this CSV batch.",
            candidate.email,
          );
        } else {
          emailSet.add(candidate.email);
        }

        if (!existingMatch) {
          const { data: emailMatches, error: emailError } = await supabase
            .from("instructors")
            .select("id")
            .eq("studio_id", studioId)
            .eq("email", candidate.email)
            .limit(2);

          if (emailError) throw new Error(`Instructor email lookup failed: ${emailError.message}`);

          if ((emailMatches ?? []).length > 1) {
            addBlocking(
              "email",
              "ambiguous_existing_match",
              "Multiple instructors match this email. Review the staff record manually.",
              candidate.email,
            );
          } else if (emailMatches?.[0]) {
            existingMatch = emailMatches[0];
          }
        }
      }

      if (isSourceSpecificStudioMigration && sourceRole) {
        const normalizedRole = sourceRole.toLowerCase();
        if (
          !["instructor", "teacher", "coach"].some((role) =>
            normalizedRole.includes(role),
          )
        ) {
          roleReviewRows += 1;
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: "role",
            error_code: "staff_role_requires_review",
            error_message:
              `${isMindbody ? "Mindbody" : "WellnessLiving"} staff roles are not granted automatically. Review this role in DanceFlow after import.`,
            raw_value: sourceRole,
            row_data: row,
          });
        }
      }

      if (!rowHasBlockingError) {
        readyRows += 1;
        if (existingMatch) {
          updateCandidates += 1;
          batchErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: rowNumber,
            field_name: candidate.externalId ? "source_external_id" : "email",
            error_code: "possible_existing_match",
            error_message: "An instructor match already exists and may be updated.",
            raw_value: candidate.externalId || candidate.email,
            row_data: row,
          });
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
        staff_role_review_rows: roleReviewRows,
        source_specific_validation: isMindbody
          ? "mindbody_staff_v1"
          : isWellnessLiving
            ? "wellnessliving_v1"
            : "generic",
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
  }

  redirect("/app/settings/import?success=validated");
}

export async function validateAppointmentImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const { data: studioTimeZoneRow } = await supabase
      .from("studios")
      .select("timezone")
      .eq("id", studioId)
      .maybeSingle<{ timezone: string | null }>();
    const studioTimeZone = getStudioTimeZone(studioTimeZoneRow?.timezone);

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
      .map((value) => parseImportedDateTime(value, studioTimeZone))
      .filter((value): value is Date => value instanceof Date);

    const parsedEndDates = rows
      .map((row) => {
        const candidate = buildAppointmentCandidate(row);
        const parsedEnd = parseImportedDateTime(candidate.endsAt, studioTimeZone);
        if (parsedEnd) return parsedEnd;

        const parsedStart = parseImportedDateTime(candidate.startsAt, studioTimeZone);
        if (parsedStart) {
          return new Date(parsedStart.getTime() + 60 * 60 * 1000);
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
      } else if (!parseImportedDateTime(candidate.startsAt, studioTimeZone)) {
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

      if (candidate.endsAt && !parseImportedDateTime(candidate.endsAt, studioTimeZone)) {
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
        const parsedRowStart = parseImportedDateTime(candidate.startsAt, studioTimeZone);
        if (!parsedRowStart) continue;

        const rowStart = parsedRowStart;
        const rowEnd =
          parseImportedDateTime(candidate.endsAt, studioTimeZone) ??
          new Date(rowStart.getTime() + 60 * 60 * 1000);

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
   } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
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
   } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
  }

  redirect("/app/settings/import?success=validated");
}





export async function validateSquareDigitalEntitlementImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "square" ||
      batch.import_type !== "digital_entitlements"
    ) {
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
    const candidates = rows.map(buildSquareDigitalEntitlementCandidate);
    const batchErrors: BatchErrorInsert[] = [];

    const orderIds = Array.from(
      new Set(candidates.map((row) => row.orderExternalId).filter(Boolean)),
    );
    const itemIds = Array.from(
      new Set(candidates.map((row) => row.itemExternalId).filter(Boolean)),
    );
    const directCatalogIds = Array.from(
      new Set(
        candidates.map((row) => row.danceFlowCatalogItemId).filter(Boolean),
      ),
    );
    const customerIds = Array.from(
      new Set(candidates.map((row) => row.customerExternalId).filter(Boolean)),
    );

    const [
      { data: orders, error: ordersError },
      { data: items, error: itemsError },
      { data: directItems, error: directItemsError },
      { data: clients, error: clientsError },
    ] = await Promise.all([
      orderIds.length
        ? supabase
            .from("commerce_orders")
            .select("id, source_external_id, client_id, payment_status")
            .eq("studio_id", studioId)
            .eq("source_system", "square")
            .in("source_external_id", orderIds)
        : Promise.resolve({ data: [], error: null }),
      itemIds.length
        ? supabase
            .from("commerce_catalog_items")
            .select(
              "id, source_external_id, item_type, active, commerce_digital_content(status)",
            )
            .eq("studio_id", studioId)
            .eq("source_system", "square")
            .in("source_external_id", itemIds)
        : Promise.resolve({ data: [], error: null }),
      directCatalogIds.length
        ? supabase
            .from("commerce_catalog_items")
            .select(
              "id, source_external_id, item_type, active, commerce_digital_content(status)",
            )
            .eq("studio_id", studioId)
            .in("id", directCatalogIds)
        : Promise.resolve({ data: [], error: null }),
      customerIds.length
        ? supabase
            .from("clients")
            .select("id, source_external_id")
            .eq("studio_id", studioId)
            .eq("source_system", "square")
            .in("source_external_id", customerIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const firstError =
      ordersError || itemsError || directItemsError || clientsError;
    if (firstError) throw new Error(firstError.message);

    const orderMap = new Map(
      (orders ?? []).map((row) => [String(row.source_external_id), row]),
    );
    const sourceItemMap = new Map(
      (items ?? []).map((row) => [String(row.source_external_id), row]),
    );
    const directItemMap = new Map(
      (directItems ?? []).map((row) => [String(row.id), row]),
    );
    const sourceClientMap = new Map(
      (clients ?? []).map((row) => [String(row.source_external_id), row]),
    );

    const seenPurchaseKeys = new Set<string>();
    let readyRows = 0;
    let linkedUserRows = 0;
    let unresolvedUserRows = 0;
    let unresolvedContentRows = 0;
    let duplicateAccessRows = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const candidate = candidates[index];
      const rowNumber = index + 2;
      let blocked = false;

      const addBlocking = (
        fieldName: string,
        errorCode: string,
        errorMessage: string,
        rawValue: string | null = null,
      ) => {
        blocked = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: fieldName,
          error_code: errorCode,
          error_message: errorMessage,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.orderExternalId) {
        addBlocking(
          "order_id",
          "missing_required_field",
          "Square order ID is required.",
        );
      }

      if (!candidate.lineItemExternalId) {
        addBlocking(
          "line_item_id",
          "missing_required_field",
          "Square line-item ID is required.",
        );
      }

      if (
        !candidate.itemExternalId &&
        !candidate.danceFlowCatalogItemId
      ) {
        addBlocking(
          "item_id",
          "missing_related_record",
          "Provide a Square item ID or a DanceFlow catalog item ID.",
        );
      }

      if (!isValidImportDate(candidate.purchasedAt)) {
        addBlocking(
          "purchased_at",
          "invalid_date",
          "A valid purchase date is required.",
          candidate.purchasedAt,
        );
      }

      const purchaseKey =
        `${candidate.orderExternalId}:${candidate.lineItemExternalId}`;
      if (
        candidate.orderExternalId &&
        candidate.lineItemExternalId &&
        seenPurchaseKeys.has(purchaseKey)
      ) {
        addBlocking(
          "line_item_id",
          "duplicate_in_file",
          "This Square digital purchase appears more than once.",
          candidate.lineItemExternalId,
        );
      }
      seenPurchaseKeys.add(purchaseKey);

      const order = orderMap.get(candidate.orderExternalId);
      if (!order) {
        addBlocking(
          "order_id",
          "missing_related_record",
          "Import the Square historical order before granting digital access.",
          candidate.orderExternalId,
        );
      } else if (
        !["paid", "partially_refunded", "refunded"].includes(
          String(order.payment_status),
        )
      ) {
        addBlocking(
          "order_id",
          "invalid_related_record",
          "Digital access can only be granted from a paid or refunded Square order.",
          candidate.orderExternalId,
        );
      }

      const item =
        directItemMap.get(candidate.danceFlowCatalogItemId) ??
        sourceItemMap.get(candidate.itemExternalId);

      const contentRelation = item
        ? Array.isArray(item.commerce_digital_content)
          ? item.commerce_digital_content[0]
          : item.commerce_digital_content
        : null;

      if (
        !item ||
        !["digital_video", "video_series", "digital_download"].includes(
          String(item.item_type),
        ) ||
        item.active !== true ||
        contentRelation?.status !== "published"
      ) {
        unresolvedContentRows += 1;
        addBlocking(
          "item_id",
          "digital_content_not_configured",
          "Map this Square item to an active, published DanceFlow digital product.",
          candidate.danceFlowCatalogItemId || candidate.itemExternalId,
        );
      }

      let clientId =
        candidate.customerExternalId
          ? sourceClientMap.get(candidate.customerExternalId)?.id ?? null
          : null;

      if (!clientId && order?.client_id) clientId = order.client_id;

      if (!clientId && candidate.customerEmail) {
        const { data: emailClients, error: emailError } = await supabase
          .from("clients")
          .select("id")
          .eq("studio_id", studioId)
          .eq("email", candidate.customerEmail)
          .limit(2);

        if (emailError) throw new Error(emailError.message);
        if ((emailClients ?? []).length > 1) {
          addBlocking(
            "customer_email",
            "multiple_customer_matches",
            "Multiple clients match this email.",
            candidate.customerEmail,
          );
        } else {
          clientId = emailClients?.[0]?.id ?? null;
        }
      }

      if (!clientId) {
        unresolvedUserRows += 1;
        addBlocking(
          "customer_id",
          "missing_related_record",
          "The Square buyer could not be matched to a DanceFlow client.",
          candidate.customerExternalId || candidate.customerEmail,
        );
      } else {
        const { data: links, error: linksError } = await supabase
          .from("client_account_links")
          .select("user_id")
          .eq("studio_id", studioId)
          .eq("client_id", clientId)
          .eq("status", "linked")
          .eq("relationship_type", "self")
          .limit(2);

        if (linksError) throw new Error(linksError.message);

        if ((links ?? []).length !== 1 || !links?.[0]?.user_id) {
          unresolvedUserRows += 1;
          addBlocking(
            "customer_id",
            "digital_buyer_not_linked",
            "The matched client must have exactly one linked self-service student account.",
            candidate.customerExternalId || candidate.customerEmail,
          );
        } else if (item) {
          linkedUserRows += 1;

          const { data: entitlement, error: entitlementError } =
            await supabase
              .from("commerce_entitlements")
              .select("id")
              .eq("user_id", links[0].user_id)
              .eq("catalog_item_id", item.id)
              .in("status", ["active", "refunded_access_retained"])
              .maybeSingle();

          if (entitlementError) throw new Error(entitlementError.message);

          if (entitlement) {
            duplicateAccessRows += 1;
            batchErrors.push({
              import_batch_id: batchId,
              import_batch_file_id: fileRow.id,
              row_number: rowNumber,
              field_name: "item_id",
              error_code: "duplicate_active_entitlement",
              error_message:
                "This student already has access. The row will be skipped safely.",
              raw_value:
                candidate.danceFlowCatalogItemId || candidate.itemExternalId,
              row_data: row,
            });
          }
        }
      }

      if (!blocked) readyRows += 1;
    }

    await finalizeValidation({
      supabase,
      studioId,
      batchId,
      headers,
      rows,
      batchErrors,
      extraSummary: {
        ready_rows: readyRows,
        linked_user_rows: linkedUserRows,
        unresolved_user_rows: unresolvedUserRows,
        unresolved_content_rows: unresolvedContentRows,
        duplicate_access_rows: duplicateAccessRows,
        entitlement_type: "purchase",
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
  }

  redirect("/app/settings/import?success=validated");
}


export async function validateSquareHistoricalOrderImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "square" ||
      batch.import_type !== "retail_orders"
    ) {
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
    const candidates = rows.map(buildSquareHistoricalOrderCandidate);
    const batchErrors: BatchErrorInsert[] = [];

    const orderIds = Array.from(
      new Set(candidates.map((row) => row.orderExternalId).filter(Boolean)),
    );
    const customerIds = Array.from(
      new Set(candidates.map((row) => row.customerExternalId).filter(Boolean)),
    );
    const variationIds = Array.from(
      new Set(candidates.map((row) => row.variationExternalId).filter(Boolean)),
    );
    const itemIds = Array.from(
      new Set(candidates.map((row) => row.itemExternalId).filter(Boolean)),
    );

    const [
      { data: existingOrders, error: existingOrdersError },
      { data: sourceClients, error: sourceClientsError },
      { data: sourceVariants, error: sourceVariantsError },
      { data: sourceItems, error: sourceItemsError },
    ] = await Promise.all([
      orderIds.length
        ? supabase
            .from("commerce_orders")
            .select("id, source_external_id")
            .eq("studio_id", studioId)
            .eq("source_system", "square")
            .in("source_external_id", orderIds)
        : Promise.resolve({ data: [], error: null }),
      customerIds.length
        ? supabase
            .from("clients")
            .select("id, source_external_id")
            .eq("studio_id", studioId)
            .eq("source_system", "square")
            .in("source_external_id", customerIds)
        : Promise.resolve({ data: [], error: null }),
      variationIds.length
        ? supabase
            .from("commerce_product_variants")
            .select("id, catalog_item_id, source_external_id, sku")
            .eq("studio_id", studioId)
            .eq("source_system", "square")
            .in("source_external_id", variationIds)
        : Promise.resolve({ data: [], error: null }),
      itemIds.length
        ? supabase
            .from("commerce_catalog_items")
            .select("id, source_external_id, name, item_type")
            .eq("studio_id", studioId)
            .eq("source_system", "square")
            .in("source_external_id", itemIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const firstError =
      existingOrdersError ||
      sourceClientsError ||
      sourceVariantsError ||
      sourceItemsError;
    if (firstError) throw new Error(firstError.message);

    const existingOrderSet = new Set(
      (existingOrders ?? []).map((row) => String(row.source_external_id)),
    );
    const sourceClientSet = new Set(
      (sourceClients ?? []).map((row) => String(row.source_external_id)),
    );
    const sourceVariantSet = new Set(
      (sourceVariants ?? []).map((row) => String(row.source_external_id)),
    );
    const sourceItemSet = new Set(
      (sourceItems ?? []).map((row) => String(row.source_external_id)),
    );

    const orderLineKeys = new Set<string>();
    const orderTotals = new Map<
      string,
      {
        subtotal: number;
        discount: number;
        tax: number;
        refund: number;
        total: number;
        lineTotal: number;
        paymentIds: Set<string>;
      }
    >();

    let readyRows = 0;
    let createOrderCandidates = 0;
    let updateOrderCandidates = 0;
    let newCustomerCandidates = 0;
    let unmatchedProductRows = 0;

    rows.forEach((row, index) => {
      const candidate = candidates[index];
      const rowNumber = index + 2;
      let blocked = false;

      const addBlocking = (
        fieldName: string,
        errorCode: string,
        errorMessage: string,
        rawValue: string | null = null,
      ) => {
        blocked = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: fieldName,
          error_code: errorCode,
          error_message: errorMessage,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.orderExternalId) {
        addBlocking(
          "order_id",
          "missing_required_field",
          "Square order ID is required.",
        );
      }

      if (!candidate.lineItemExternalId) {
        addBlocking(
          "line_item_id",
          "missing_required_field",
          "Square line-item ID is required.",
        );
      }

      if (!candidate.itemName) {
        addBlocking(
          "item_name",
          "missing_required_field",
          "Line-item name is required.",
        );
      }

      if (candidate.quantity == null) {
        addBlocking(
          "quantity",
          "invalid_amount",
          "Line-item quantity must be a positive whole number.",
        );
      }

      if (candidate.unitPrice == null || candidate.lineTotal == null) {
        addBlocking(
          "line_total",
          "invalid_amount",
          "Unit price and line total must be valid nonnegative amounts.",
        );
      }

      if (
        candidate.total == null ||
        candidate.subtotal == null ||
        candidate.discountTotal == null ||
        candidate.taxTotal == null ||
        candidate.refundTotal == null
      ) {
        addBlocking(
          "total",
          "invalid_amount",
          "Order subtotal, discount, tax, refund, and total must be valid nonnegative amounts.",
        );
      }

      if (!/^[a-zA-Z]{3}$/.test(candidate.currency)) {
        addBlocking(
          "currency",
          "unsupported_currency",
          "Currency must be a three-letter ISO code.",
          candidate.currency,
        );
      }

      if (!isValidImportDate(candidate.completedAt)) {
        addBlocking(
          "completed_at",
          "invalid_date",
          "A valid Square order completion date is required.",
          candidate.completedAt,
        );
      }

      const lineKey = `${candidate.orderExternalId}:${candidate.lineItemExternalId}`;
      if (
        candidate.orderExternalId &&
        candidate.lineItemExternalId &&
        orderLineKeys.has(lineKey)
      ) {
        addBlocking(
          "line_item_id",
          "duplicate_in_file",
          "This Square order line appears more than once.",
          candidate.lineItemExternalId,
        );
      }
      orderLineKeys.add(lineKey);

      const productResolved =
        (candidate.variationExternalId &&
          sourceVariantSet.has(candidate.variationExternalId)) ||
        (candidate.itemExternalId &&
          sourceItemSet.has(candidate.itemExternalId));

      if (!productResolved) {
        unmatchedProductRows += 1;
        addBlocking(
          "variation_id",
          "missing_related_record",
          "Run the Square catalog import before importing this order line.",
          candidate.variationExternalId || candidate.itemExternalId,
        );
      }

      const hasCustomerIdentity =
        Boolean(candidate.customerExternalId) ||
        Boolean(candidate.customerEmail) ||
        Boolean(candidate.customerFirstName) ||
        Boolean(candidate.customerLastName);

      if (!hasCustomerIdentity) {
        addBlocking(
          "customer_id",
          "missing_related_record",
          "A Square customer ID, email, or customer name is required.",
        );
      } else if (
        candidate.customerExternalId &&
        !sourceClientSet.has(candidate.customerExternalId)
      ) {
        newCustomerCandidates += 1;
      }

      if (!blocked) readyRows += 1;

      if (candidate.orderExternalId) {
        if (existingOrderSet.has(candidate.orderExternalId)) {
          updateOrderCandidates += 1;
        } else {
          createOrderCandidates += 1;
        }

        const totals = orderTotals.get(candidate.orderExternalId) ?? {
          subtotal: candidate.subtotal ?? 0,
          discount: candidate.discountTotal ?? 0,
          tax: candidate.taxTotal ?? 0,
          refund: candidate.refundTotal ?? 0,
          total: candidate.total ?? 0,
          lineTotal: 0,
          paymentIds: new Set<string>(),
        };
        totals.lineTotal += candidate.lineTotal ?? 0;
        if (candidate.paymentExternalId) {
          totals.paymentIds.add(candidate.paymentExternalId);
        }
        orderTotals.set(candidate.orderExternalId, totals);
      }
    });

    for (const [orderId, totals] of orderTotals.entries()) {
      const expected =
        Math.round(
          (totals.subtotal - totals.discount + totals.tax) * 100,
        ) / 100;
      const reported = Math.round(totals.total * 100) / 100;

      if (Math.abs(expected - reported) > 0.01) {
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: null,
          field_name: "total",
          error_code: "payment_order_amount_mismatch",
          error_message:
            `Square order ${orderId} does not reconcile: subtotal - discount + tax does not equal total.`,
          raw_value: String(reported),
          row_data: { order_id: orderId },
        });
      }

      if (totals.refund > totals.total) {
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: null,
          field_name: "refund_total",
          error_code: "refund_exceeds_paid_amount",
          error_message:
            `Square order ${orderId} has refunds greater than the order total.`,
          raw_value: String(totals.refund),
          row_data: { order_id: orderId },
        });
      }

      if (Math.abs(totals.lineTotal - totals.total) > 0.01) {
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: null,
          field_name: "line_total",
          error_code: "order_line_total_mismatch",
          error_message:
            `Square order ${orderId} line totals do not equal the reported order total.`,
          raw_value: String(totals.lineTotal),
          row_data: { order_id: orderId },
        });
      }
    }

    await finalizeValidation({
      supabase,
      studioId,
      batchId,
      headers,
      rows,
      batchErrors,
      extraSummary: {
        ready_rows: readyRows,
        square_order_count: orderTotals.size,
        create_order_candidates: new Set(
          candidates
            .filter((row) => !existingOrderSet.has(row.orderExternalId))
            .map((row) => row.orderExternalId)
            .filter(Boolean),
        ).size,
        update_order_candidates: new Set(
          candidates
            .filter((row) => existingOrderSet.has(row.orderExternalId))
            .map((row) => row.orderExternalId)
            .filter(Boolean),
        ).size,
        new_customer_candidates: newCustomerCandidates,
        unmatched_product_rows: unmatchedProductRows,
        historical_accounting_mode: "deferred",
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
  }

  redirect("/app/settings/import?success=validated");
}


export async function validateSquareInventoryImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (batch.source_system !== "square" || batch.import_type !== "inventory") {
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
    const candidates = rows.map(buildSquareInventoryCandidate);
    const batchErrors: BatchErrorInsert[] = [];

    const variationIds = Array.from(
      new Set(candidates.map((candidate) => candidate.variationExternalId).filter(Boolean)),
    );

    const { data: variants, error: variantsError } = variationIds.length
      ? await supabase
          .from("commerce_product_variant_inventory")
          .select(
            "id, catalog_item_id, source_external_id, quantity_on_hand, active",
          )
          .eq("studio_id", studioId)
          .eq("source_system", "square")
          .in("source_external_id", variationIds)
      : { data: [], error: null };

    if (variantsError) throw new Error(variantsError.message);

    const variantMap = new Map(
      (variants ?? []).map((variant) => [
        String(variant.source_external_id),
        {
          id: String(variant.id),
          catalogItemId: String(variant.catalog_item_id),
          quantityOnHand: Number(variant.quantity_on_hand ?? 0),
          active: Boolean(variant.active),
        },
      ]),
    );

    const seenVariationLocation = new Set<string>();
    const locations = new Set<string>();
    let readyRows = 0;
    let adjustmentRows = 0;
    let unchangedRows = 0;
    let positiveDeltaRows = 0;
    let negativeDeltaRows = 0;
    let totalSourceUnits = 0;
    let totalCurrentUnits = 0;
    let totalDeltaUnits = 0;

    rows.forEach((row, index) => {
      const rowNumber = index + 2;
      const candidate = candidates[index];
      let blocked = false;

      const addBlocking = (
        fieldName: string,
        errorCode: string,
        errorMessage: string,
        rawValue: string | null = null,
      ) => {
        blocked = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: fieldName,
          error_code: errorCode,
          error_message: errorMessage,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.variationExternalId) {
        addBlocking(
          "variation_id",
          "missing_required_field",
          "Square variation ID is required.",
        );
      }

      if (!candidate.locationExternalId) {
        addBlocking(
          "location_id",
          "missing_required_field",
          "Square location ID is required.",
        );
      } else {
        locations.add(candidate.locationExternalId);
      }

      if (!Number.isInteger(candidate.quantity)) {
        addBlocking(
          "quantity",
          "invalid_amount",
          "Inventory quantity must be a whole number.",
          getRowValue(row, ["quantity", "quantity_on_hand", "count"]),
        );
      } else if (candidate.quantity < 0) {
        addBlocking(
          "quantity",
          "invalid_amount",
          "Negative Square inventory requires owner review and cannot be imported.",
          String(candidate.quantity),
        );
      }

      const duplicateKey =
        `${candidate.variationExternalId}:${candidate.locationExternalId}`;
      if (
        candidate.variationExternalId &&
        candidate.locationExternalId &&
        seenVariationLocation.has(duplicateKey)
      ) {
        addBlocking(
          "variation_id",
          "duplicate_in_file",
          "This Square variation and location combination appears more than once.",
          candidate.variationExternalId,
        );
      }
      seenVariationLocation.add(duplicateKey);

      const variant = variantMap.get(candidate.variationExternalId);
      if (candidate.variationExternalId && !variant) {
        addBlocking(
          "variation_id",
          "missing_related_record",
          "Run the Square catalog import before importing inventory for this variation.",
          candidate.variationExternalId,
        );
      } else if (variant && !variant.active) {
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "variation_id",
          error_code: "inactive_related_record",
          error_message:
            "This Square variation is archived in DanceFlow. Inventory can still be reconciled, but the product will remain unavailable.",
          raw_value: candidate.variationExternalId,
          row_data: row,
        });
      }

      if (!blocked && variant) {
        const delta = candidate.quantity - variant.quantityOnHand;
        readyRows += 1;
        totalSourceUnits += candidate.quantity;
        totalCurrentUnits += variant.quantityOnHand;
        totalDeltaUnits += delta;
        if (delta === 0) unchangedRows += 1;
        else {
          adjustmentRows += 1;
          if (delta > 0) positiveDeltaRows += 1;
          else negativeDeltaRows += 1;
        }
      }
    });

    if (locations.size > 1) {
      batchErrors.push({
        import_batch_id: batchId,
        import_batch_file_id: fileRow.id,
        row_number: null,
        field_name: "location_id",
        error_code: "multiple_inventory_locations",
        error_message:
          "This file contains multiple Square locations. Select and upload one location at a time so counts are not silently combined.",
        raw_value: Array.from(locations).join(", "),
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
        create_candidates: adjustmentRows,
        update_candidates: adjustmentRows,
        ready_rows: readyRows,
        square_location_count: locations.size,
        square_location_ids: Array.from(locations),
        adjustment_rows: adjustmentRows,
        unchanged_rows: unchangedRows,
        positive_delta_rows: positiveDeltaRows,
        negative_delta_rows: negativeDeltaRows,
        source_unit_total: totalSourceUnits,
        current_unit_total: totalCurrentUnits,
        delta_unit_total: totalDeltaUnits,
        inventory_reconciliation_ready:
          batchErrors.filter((error) =>
            isBlockingErrorCode(error.error_code),
          ).length === 0 && locations.size <= 1,
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
  }

  redirect("/app/settings/import?success=validated");
}


export async function validateSquareProductImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (batch.source_system !== "square" || batch.import_type !== "products") {
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
    const batchErrors: BatchErrorInsert[] = [];
    const seenItemIds = new Set<string>();
    const seenVariationIds = new Set<string>();
    const seenSkus = new Set<string>();
    const seenBarcodes = new Set<string>();

    const candidates = rows.map(buildSquareProductCandidate);
    const itemIds = Array.from(new Set(candidates.map((c) => c.itemExternalId).filter(Boolean)));
    const variationIds = Array.from(new Set(candidates.map((c) => c.variationExternalId).filter(Boolean)));
    const skus = Array.from(new Set(candidates.map((c) => c.sku).filter(Boolean)));
    const barcodes = Array.from(new Set(candidates.map((c) => c.barcode).filter(Boolean)));

    const [existingItemsResult, existingVariantsResult, skuResult, barcodeResult] = await Promise.all([
      itemIds.length
        ? supabase.from("commerce_catalog_items").select("id, source_external_id").eq("studio_id", studioId).eq("source_system", "square").in("source_external_id", itemIds)
        : Promise.resolve({ data: [], error: null }),
      variationIds.length
        ? supabase.from("commerce_product_variants").select("id, source_external_id").eq("studio_id", studioId).eq("source_system", "square").in("source_external_id", variationIds)
        : Promise.resolve({ data: [], error: null }),
      skus.length
        ? supabase.from("commerce_product_variants").select("id, sku, source_external_id").eq("studio_id", studioId).in("sku", skus)
        : Promise.resolve({ data: [], error: null }),
      barcodes.length
        ? supabase.from("commerce_product_variants").select("id, barcode, source_external_id").eq("studio_id", studioId).in("barcode", barcodes)
        : Promise.resolve({ data: [], error: null }),
    ]);

    for (const result of [existingItemsResult, existingVariantsResult, skuResult, barcodeResult]) {
      if (result.error) throw new Error(result.error.message);
    }

    const existingItemIds = new Set((existingItemsResult.data ?? []).map((row) => String(row.source_external_id)));
    const existingVariationIds = new Set((existingVariantsResult.data ?? []).map((row) => String(row.source_external_id)));
    const existingSkuMap = new Map((skuResult.data ?? []).map((row) => [String(row.sku), String(row.source_external_id ?? "")]));
    const existingBarcodeMap = new Map((barcodeResult.data ?? []).map((row) => [String(row.barcode), String(row.source_external_id ?? "")]));

    let readyRows = 0;
    let createCandidates = 0;
    let updateCandidates = 0;
    const categories = new Set<string>();
    const products = new Set<string>();

    rows.forEach((row, index) => {
      const rowNumber = index + 2;
      const candidate = candidates[index];
      let blocked = false;
      const addBlocking = (field: string, code: string, message: string, rawValue = "") => {
        blocked = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: field,
          error_code: code,
          error_message: message,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.itemExternalId) addBlocking("item_id", "missing_required_field", "Square item ID is required.");
      if (!candidate.itemName) addBlocking("item_name", "missing_required_field", "Product name is required.");
      if (!candidate.variationExternalId) addBlocking("variation_id", "missing_required_field", "Square variation ID is required.");
      if (!candidate.variationName) addBlocking("variation_name", "missing_required_field", "Variation name is required.");
      if (!Number.isFinite(candidate.price) || candidate.price < 0) {
        addBlocking("price", "invalid_amount", "Variation price must be a valid non-negative amount.");
      }

      if (candidate.itemExternalId) {
        if (seenItemIds.has(`${candidate.itemExternalId}:${candidate.variationExternalId}`)) {
          addBlocking("variation_id", "duplicate_in_file", "This Square item and variation combination is duplicated in the CSV.", candidate.variationExternalId);
        }
        seenItemIds.add(`${candidate.itemExternalId}:${candidate.variationExternalId}`);
        products.add(candidate.itemExternalId);
      }
      if (candidate.variationExternalId) {
        if (seenVariationIds.has(candidate.variationExternalId)) {
          addBlocking("variation_id", "duplicate_in_file", "Square variation ID is duplicated in the CSV.", candidate.variationExternalId);
        }
        seenVariationIds.add(candidate.variationExternalId);
      }
      if (candidate.sku) {
        if (seenSkus.has(candidate.sku)) addBlocking("sku", "duplicate_in_file", "SKU is duplicated in the CSV.", candidate.sku);
        seenSkus.add(candidate.sku);
        const existingSourceId = existingSkuMap.get(candidate.sku);
        if (existingSourceId !== undefined && existingSourceId !== candidate.variationExternalId) {
          addBlocking("sku", "source_identity_conflict", "SKU already belongs to a different catalog variation.", candidate.sku);
        }
      }
      if (candidate.barcode) {
        if (seenBarcodes.has(candidate.barcode)) addBlocking("barcode", "duplicate_in_file", "Barcode is duplicated in the CSV.", candidate.barcode);
        seenBarcodes.add(candidate.barcode);
        const existingSourceId = existingBarcodeMap.get(candidate.barcode);
        if (existingSourceId !== undefined && existingSourceId !== candidate.variationExternalId) {
          addBlocking("barcode", "source_identity_conflict", "Barcode already belongs to a different catalog variation.", candidate.barcode);
        }
      }

      if (candidate.categoryExternalId || candidate.categoryName) {
        categories.add(candidate.categoryExternalId || candidate.categoryName.toLowerCase());
      }

      if (!blocked) {
        readyRows += 1;
        if (existingVariationIds.has(candidate.variationExternalId) || existingItemIds.has(candidate.itemExternalId)) {
          updateCandidates += 1;
        } else {
          createCandidates += 1;
        }
      }
    });

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
        product_count: products.size,
        variant_count: seenVariationIds.size,
        category_count: categories.size,
        square_catalog_ready: batchErrors.filter((error) => isBlockingErrorCode(error.error_code)).length === 0,
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
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

    const isWellnessLiving = batch.source_system === "wellnessliving";
    const isMindbody = batch.source_system === "mindbody";
    const isSourceSpecificStudioMigration = isWellnessLiving || isMindbody;
    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = 0;
    let failedRows = 0;
    let relationshipRows = 0;
    let resolvedRelationships = 0;
    let reviewRelationships = 0;
    const executionErrors: BatchErrorInsert[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;

      if (blockingErroredRowNumbers.has(rowNumber)) {
        skippedRows += 1;
        continue;
      }

      const candidate = buildClientCandidate(row);
      const relationship = isSourceSpecificStudioMigration
        ? buildSourceRelationshipCandidate(row)
        : null;

      try {
        let matchedClientId: string | null = null;

        if (candidate.externalId) {
          const { data: sourceMatches, error: sourceError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", batch.source_system)
            .eq("source_external_id", candidate.externalId)
            .limit(2);

          if (sourceError) throw new Error(sourceError.message);
          if ((sourceMatches ?? []).length > 1) {
            throw new Error("Multiple clients use the same source external ID.");
          }
          matchedClientId = sourceMatches?.[0]?.id ?? null;
        }

        if (!matchedClientId && candidate.email) {
          const { data: emailMatches, error: emailError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("email", candidate.email)
            .limit(2);

          if (emailError) throw new Error(emailError.message);
          if ((emailMatches ?? []).length > 1) {
            throw new Error("Multiple clients match this email.");
          }
          matchedClientId = emailMatches?.[0]?.id ?? null;
        }

        if (!matchedClientId && isSourceSpecificStudioMigration && candidate.phone) {
          const { data: phoneMatches, error: phoneError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("phone", candidate.phone)
            .limit(2);

          if (phoneError) throw new Error(phoneError.message);
          if ((phoneMatches ?? []).length > 1) {
            throw new Error("Multiple clients match this normalized phone number.");
          }
          matchedClientId = phoneMatches?.[0]?.id ?? null;
        }

        const importedAt = new Date().toISOString();
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
          imported_at: importedAt,
        };

        if (!matchedClientId) {
          const { data: insertedClient, error: insertError } = await supabase
            .from("clients")
            .insert({
              ...clientPayload,
              created_by: userId,
            })
            .select("id")
            .single();

          if (insertError || !insertedClient) {
            throw new Error(insertError?.message ?? "Client insert failed.");
          }

          matchedClientId = insertedClient.id;
          insertedRows += 1;
        } else if (batch.mode === "create_only") {
          skippedRows += 1;
        } else {
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

          if (updateError) throw new Error(updateError.message);
          updatedRows += 1;
        }

        if (relationship?.hasRelationship && matchedClientId) {
          relationshipRows += 1;
          let relatedClientId: string | null = null;

          if (relationship.relatedClientExternalId) {
            const { data: relatedSourceMatches, error: relatedSourceError } =
              await supabase
                .from("clients")
                .select("id")
                .eq("studio_id", studioId)
                .eq("source_system", batch.source_system)
                .eq("source_external_id", relationship.relatedClientExternalId)
                .limit(2);

            if (relatedSourceError) throw new Error(relatedSourceError.message);
            if ((relatedSourceMatches ?? []).length === 1) {
              relatedClientId = relatedSourceMatches?.[0]?.id ?? null;
            }
          }

          if (!relatedClientId && relationship.relatedEmail) {
            const { data: relatedEmailMatches, error: relatedEmailError } =
              await supabase
                .from("clients")
                .select("id")
                .eq("studio_id", studioId)
                .eq("email", relationship.relatedEmail)
                .limit(2);

            if (relatedEmailError) throw new Error(relatedEmailError.message);
            if ((relatedEmailMatches ?? []).length === 1) {
              relatedClientId = relatedEmailMatches?.[0]?.id ?? null;
            }
          }

          const resolutionStatus =
            relatedClientId && relatedClientId !== matchedClientId
              ? "resolved"
              : "needs_review";

          const { error: relationshipError } = await supabase
            .from("client_source_relationships")
            .upsert(
              {
                studio_id: studioId,
                source_system: batch.source_system,
                source_relationship_id:
                  getRowValue(row, [
                    "relationship_id",
                    "family_relationship_id",
                    "client_relationship_id",
                    "responsible_party_relationship_id",
                  ]) ||
                  `${candidate.externalId || matchedClientId}:${relationship.relationshipType}:${relationship.relatedClientExternalId || relationship.relatedEmail || relationship.householdExternalId || rowNumber}`,
                client_id: matchedClientId,
                source_client_external_id: candidate.externalId || null,
                related_client_id:
                  relatedClientId && relatedClientId !== matchedClientId
                    ? relatedClientId
                    : null,
                related_source_external_id:
                  relationship.relatedClientExternalId || null,
                household_external_id: relationship.householdExternalId || null,
                relationship_type: relationship.relationshipType,
                related_first_name: relationship.relatedFirstName || null,
                related_last_name: relationship.relatedLastName || null,
                related_email: relationship.relatedEmail || null,
                related_phone: relationship.relatedPhone || null,
                resolution_status: resolutionStatus,
                import_batch_id: batchId,
                imported_at: importedAt,
                updated_at: importedAt,
              },
              {
                onConflict: "studio_id,source_system,source_relationship_id",
              },
            );

          if (relationshipError) throw new Error(relationshipError.message);

          if (resolutionStatus === "resolved") {
            resolvedRelationships += 1;
          } else {
            reviewRelationships += 1;
          }
        }
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
        relationship_rows: relationshipRows,
        relationships_resolved: resolvedRelationships,
        relationships_needing_review: reviewRelationships,
        source_specific_execution: isMindbody
          ? "mindbody_clients_relationships_v1"
          : isWellnessLiving
            ? "wellnessliving_v1"
            : "generic",
      },
    });
  } catch (error) {
    redirectImportError(`/app/settings/import/${batchId}`, "execution_failed", error);
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
          const { data: externalMatches, error: externalMatchError } = await supabase
            .from("instructors")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", batch.source_system)
            .eq("source_external_id", candidate.externalId)
            .limit(2);

          if (externalMatchError) {
            throw new Error(externalMatchError.message);
          }
          if ((externalMatches ?? []).length > 1) {
            throw new Error("Multiple instructors use the same source external ID.");
          }

          matchedInstructorId = externalMatches?.[0]?.id ?? null;
        }

        if (!matchedInstructorId && candidate.email) {
          const { data: emailMatches, error: emailMatchError } = await supabase
            .from("instructors")
            .select("id")
            .eq("studio_id", studioId)
            .eq("email", candidate.email)
            .limit(2);

          if (emailMatchError) {
            throw new Error(emailMatchError.message);
          }
          if ((emailMatches ?? []).length > 1) {
            throw new Error("Multiple instructors match this email.");
          }

          matchedInstructorId = emailMatches?.[0]?.id ?? null;
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
   } catch (error) {
    redirectImportError(`/app/settings/import/${batchId}`, "execution_failed", error);
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}

export async function executeAppointmentImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const { data: studioTimeZoneRow } = await supabase
      .from("studios")
      .select("timezone")
      .eq("id", studioId)
      .maybeSingle<{ timezone: string | null }>();
    const studioTimeZone = getStudioTimeZone(studioTimeZoneRow?.timezone);

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

        const parsedStartsAt = parseImportedDateTime(candidate.startsAt, studioTimeZone);
        if (!parsedStartsAt) {
          throw new Error("Imported appointment start time is invalid.");
        }

        const parsedEndsAt =
          parseImportedDateTime(candidate.endsAt, studioTimeZone) ??
          new Date(parsedStartsAt.getTime() + 60 * 60 * 1000);

        const startsAtIso = parsedStartsAt.toISOString();
        const endsAtIso = parsedEndsAt.toISOString();

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
   } catch (error) {
    redirectImportError(`/app/settings/import/${batchId}`, "execution_failed", error);
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
   } catch (error) {
    redirectImportError(`/app/settings/import/${batchId}`, "execution_failed", error);
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}





export async function executeSquareDigitalEntitlementImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId, userId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "square" ||
      batch.import_type !== "digital_entitlements"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }
    if (batch.mode === "dry_run") {
      redirect(`/app/settings/import/${batchId}?error=dry_run_cannot_execute`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow || !fileRow.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const { data: validationErrors, error: validationErrorsError } =
      await supabase
        .from("import_batch_errors")
        .select("row_number, error_code")
        .eq("import_batch_id", batchId);

    if (validationErrorsError) {
      throw new Error(validationErrorsError.message);
    }

    const blockedRows = new Set(
      (validationErrors ?? [])
        .filter(
          (row) =>
            isBlockingErrorCode(row.error_code) &&
            row.error_code !== "duplicate_active_entitlement",
        )
        .map((row) => row.row_number)
        .filter((row): row is number => typeof row === "number"),
    );

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const candidates = rows.map(buildSquareDigitalEntitlementCandidate);
    const executionErrors: BatchErrorInsert[] = [];

    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = 0;
    let failedRows = 0;
    let retainedAfterRefundRows = 0;
    const now = new Date().toISOString();

    for (let index = 0; index < rows.length; index += 1) {
      const rowNumber = index + 2;
      const row = rows[index];
      const candidate = candidates[index];

      if (blockedRows.has(rowNumber)) {
        skippedRows += 1;
        continue;
      }

      try {
        const { data: order, error: orderError } = await supabase
          .from("commerce_orders")
          .select("id, client_id, payment_status")
          .eq("studio_id", studioId)
          .eq("source_system", "square")
          .eq("source_external_id", candidate.orderExternalId)
          .single();

        if (orderError || !order) {
          throw new Error(
            orderError?.message ?? "Square order could not be resolved.",
          );
        }

        const { data: orderItems, error: orderItemsError } = await supabase
          .from("commerce_order_items")
          .select("id, catalog_item_id, metadata")
          .eq("studio_id", studioId)
          .eq("order_id", order.id);

        if (orderItemsError) throw new Error(orderItemsError.message);

        const orderItem = (orderItems ?? []).find((item) => {
          const metadata =
            item.metadata && typeof item.metadata === "object"
              ? (item.metadata as Record<string, unknown>)
              : {};
          return metadata.square_line_item_id === candidate.lineItemExternalId;
        });

        let catalogItemId =
          candidate.danceFlowCatalogItemId ||
          orderItem?.catalog_item_id ||
          null;

        if (!catalogItemId && candidate.itemExternalId) {
          const { data: item, error: itemError } = await supabase
            .from("commerce_catalog_items")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", "square")
            .eq("source_external_id", candidate.itemExternalId)
            .single();

          if (itemError || !item) {
            throw new Error(
              itemError?.message ?? "Digital catalog item could not be resolved.",
            );
          }
          catalogItemId = item.id;
        }

        if (!catalogItemId) {
          throw new Error("Digital catalog item could not be resolved.");
        }

        let clientId = order.client_id;

        if (!clientId && candidate.customerExternalId) {
          const { data: client, error: clientError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", "square")
            .eq("source_external_id", candidate.customerExternalId)
            .single();

          if (clientError || !client) {
            throw new Error(
              clientError?.message ?? "Square customer could not be resolved.",
            );
          }
          clientId = client.id;
        }

        if (!clientId) {
          throw new Error("The Square buyer could not be resolved.");
        }

        const { data: links, error: linksError } = await supabase
          .from("client_account_links")
          .select("user_id")
          .eq("studio_id", studioId)
          .eq("client_id", clientId)
          .eq("status", "linked")
          .eq("relationship_type", "self")
          .limit(2);

        if (linksError) throw new Error(linksError.message);
        if ((links ?? []).length !== 1 || !links?.[0]?.user_id) {
          throw new Error(
            "The client does not have exactly one linked student account.",
          );
        }

        const linkedUserId = links[0].user_id;
        const entitlementStatus = normalizeSquareEntitlementStatus(
          candidate.accessStatus,
          candidate.refundAccessPolicy,
        );

        const { data: existingEntitlement, error: existingEntitlementError } =
          await supabase
            .from("commerce_entitlements")
            .select("id, status")
            .eq("user_id", linkedUserId)
            .eq("catalog_item_id", catalogItemId)
            .in("status", ["active", "refunded_access_retained"])
            .maybeSingle();

        if (existingEntitlementError) {
          throw new Error(existingEntitlementError.message);
        }

        if (existingEntitlement) {
          if (
            existingEntitlement.status !== entitlementStatus &&
            batch.mode === "create_or_update"
          ) {
            const { error: updateError } = await supabase
              .from("commerce_entitlements")
              .update({
                status: entitlementStatus,
                updated_by: userId,
                updated_at: now,
                metadata: {
                  source: "square_import",
                  historical_import: true,
                  square_order_id: candidate.orderExternalId,
                  square_line_item_id: candidate.lineItemExternalId,
                  import_batch_id: batchId,
                  refund_access_policy:
                    candidate.refundAccessPolicy || null,
                },
              })
              .eq("id", existingEntitlement.id)
              .eq("studio_id", studioId);

            if (updateError) throw new Error(updateError.message);
            updatedRows += 1;
            if (entitlementStatus === "refunded_access_retained") {
              retainedAfterRefundRows += 1;
            }
          } else {
            skippedRows += 1;
          }
          continue;
        }

        const { error: insertError } = await supabase
          .from("commerce_entitlements")
          .insert({
            studio_id: studioId,
            catalog_item_id: catalogItemId,
            client_id: clientId,
            user_id: linkedUserId,
            order_id: order.id,
            order_item_id: orderItem?.id ?? null,
            entitlement_type: "purchase",
            status: entitlementStatus,
            granted_at: new Date(candidate.purchasedAt).toISOString(),
            starts_at: new Date(candidate.purchasedAt).toISOString(),
            created_by: userId,
            updated_by: userId,
            metadata: {
              source: "square_import",
              historical_import: true,
              square_order_id: candidate.orderExternalId,
              square_line_item_id: candidate.lineItemExternalId,
              square_item_id: candidate.itemExternalId || null,
              import_batch_id: batchId,
              refund_access_policy:
                candidate.refundAccessPolicy || null,
            },
          });

        if (insertError) throw new Error(insertError.message);

        insertedRows += 1;
        if (entitlementStatus === "refunded_access_retained") {
          retainedAfterRefundRows += 1;
        }
      } catch (error) {
        failedRows += 1;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: null,
          error_code: "execution_failed",
          error_message:
            error instanceof Error
              ? error.message
              : "Square digital entitlement import failed.",
          raw_value:
            candidate.danceFlowCatalogItemId || candidate.itemExternalId,
          row_data: row,
        });
      }
    }

    await writeBatchErrors({ supabase, batchErrors: executionErrors });

    const reconciliationStatus =
      failedRows > 0 ? "needs_review" : "reconciled";

    await supabase
      .from("import_batches")
      .update({
        reconciliation_status: reconciliationStatus,
        updated_at: now,
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);

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
        source_system: "square",
        import_type: "digital_entitlements",
        entitlement_type: "purchase",
        active_access_created: insertedRows,
        existing_access_updated: updatedRows,
        retained_after_refund: retainedAfterRefundRows,
        reconciliation_status: reconciliationStatus,
        execution_error_count: executionErrors.length,
      },
    });
  } catch (error) {
    redirectImportError(
      `/app/settings/import/${batchId}`,
      "execution_failed",
      error,
    );
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}


export async function executeSquareHistoricalOrderImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId, userId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "square" ||
      batch.import_type !== "retail_orders"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }
    if (batch.mode === "dry_run") {
      redirect(`/app/settings/import/${batchId}?error=dry_run_cannot_execute`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow || !fileRow.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const { data: existingErrors, error: existingErrorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);

    if (existingErrorsError) throw new Error(existingErrorsError.message);

    const blockingRows = new Set(
      (existingErrors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((row): row is number => typeof row === "number"),
    );

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const grouped = new Map<
      string,
      Array<{
        row: Record<string, string>;
        rowNumber: number;
        candidate: SquareHistoricalOrderCandidate;
      }>
    >();

    rows.forEach((row, index) => {
      const candidate = buildSquareHistoricalOrderCandidate(row);
      if (!candidate.orderExternalId) return;
      const entries = grouped.get(candidate.orderExternalId) ?? [];
      entries.push({ row, rowNumber: index + 2, candidate });
      grouped.set(candidate.orderExternalId, entries);
    });

    const now = new Date().toISOString();
    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = 0;
    let failedRows = 0;
    let createdClients = 0;
    let createdPayments = 0;
    let importedGross = 0;
    let importedRefunds = 0;
    const executionErrors: BatchErrorInsert[] = [];

    for (const [orderExternalId, entries] of grouped.entries()) {
      if (entries.some((entry) => blockingRows.has(entry.rowNumber))) {
        skippedRows += entries.length;
        continue;
      }

      const first = entries[0].candidate;

      try {
        let clientId: string | null = null;

        if (first.customerExternalId) {
          const { data: sourceClient, error: sourceClientError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", "square")
            .eq("source_external_id", first.customerExternalId)
            .maybeSingle();

          if (sourceClientError) throw new Error(sourceClientError.message);
          clientId = sourceClient?.id ?? null;
        }

        if (!clientId && first.customerEmail) {
          const { data: emailClients, error: emailClientsError } = await supabase
            .from("clients")
            .select("id")
            .eq("studio_id", studioId)
            .eq("email", first.customerEmail)
            .limit(2);

          if (emailClientsError) throw new Error(emailClientsError.message);
          if ((emailClients ?? []).length > 1) {
            throw new Error(
              "Multiple DanceFlow clients match this Square customer email.",
            );
          }
          clientId = emailClients?.[0]?.id ?? null;
        }

        if (!clientId) {
          const firstName = first.customerFirstName || "Square";
          const lastName = first.customerLastName || "Customer";

          const { data: createdClient, error: createClientError } = await supabase
            .from("clients")
            .insert({
              studio_id: studioId,
              first_name: firstName,
              last_name: lastName,
              email: first.customerEmail || null,
              phone: first.customerPhone || null,
              status: "active",
              source_system: "square",
              source_external_id: first.customerExternalId || null,
              imported_at: now,
              notes: "Imported with Square historical commerce.",
            })
            .select("id")
            .single();

          if (createClientError || !createdClient) {
            throw new Error(
              createClientError?.message ?? "Square customer could not be created.",
            );
          }

          clientId = createdClient.id;
          createdClients += 1;
        } else if (first.customerExternalId) {
          await supabase
            .from("clients")
            .update({
              source_system: "square",
              source_external_id: first.customerExternalId,
              imported_at: now,
            })
            .eq("id", clientId)
            .eq("studio_id", studioId);
        }

        const { data: existingOrder, error: existingOrderError } = await supabase
          .from("commerce_orders")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "square")
          .eq("source_external_id", orderExternalId)
          .maybeSingle();

        if (existingOrderError) throw new Error(existingOrderError.message);

        if (existingOrder && batch.mode === "create_only") {
          skippedRows += entries.length;
          continue;
        }

        const subtotal = first.subtotal ?? 0;
        const discountTotal = first.discountTotal ?? 0;
        const taxTotal = first.taxTotal ?? 0;
        const refundTotal = first.refundTotal ?? 0;
        const total = first.total ?? 0;
        const orderStatus = normalizeSquareOrderStatus(first.orderStatus);
        const paymentStatus = normalizeSquareOrderPaymentStatus(
          first.paymentStatus,
          refundTotal,
          total,
        );
        const fulfillmentStatus = normalizeSquareFulfillmentStatus(
          first.fulfillmentStatus,
        );
        const orderNumber =
          first.orderNumber ||
          `SQ-${orderExternalId.replace(/[^a-zA-Z0-9]/g, "").slice(-18)}`;

        const orderPayload = {
          studio_id: studioId,
          order_number: orderNumber,
          client_id: clientId,
          customer_type: "client",
          status: orderStatus,
          payment_status: paymentStatus,
          fulfillment_status: fulfillmentStatus,
          subtotal,
          discount_total: discountTotal,
          tax_total: taxTotal,
          refund_total: refundTotal,
          total,
          currency: first.currency.toLowerCase(),
          notes: first.notes || "Imported Square historical order",
          source_system: "square",
          source_external_id: orderExternalId,
          imported_at: now,
          accounting_sync_mode: "deferred",
          accounting_sync_suppressed_at: now,
          completed_at:
            orderStatus === "completed" || orderStatus === "refunded"
              ? new Date(first.completedAt).toISOString()
              : null,
          cancelled_at:
            orderStatus === "cancelled"
              ? new Date(first.completedAt).toISOString()
              : null,
          metadata: {
            source: "square_import",
            historical_import: true,
            accounting_sync_mode: "deferred",
            square_order_id: orderExternalId,
            import_batch_id: batchId,
          },
          updated_by: userId,
          updated_at: now,
        };

        let orderId: string;

        if (!existingOrder) {
          const { data: insertedOrder, error: insertedOrderError } = await supabase
            .from("commerce_orders")
            .insert({
              ...orderPayload,
              created_by: userId,
              created_at: new Date(first.completedAt).toISOString(),
            })
            .select("id")
            .single();

          if (insertedOrderError || !insertedOrder) {
            throw new Error(
              insertedOrderError?.message ?? "Square order could not be created.",
            );
          }
          orderId = insertedOrder.id;
          insertedRows += entries.length;
        } else {
          const { error: updateOrderError } = await supabase
            .from("commerce_orders")
            .update(orderPayload)
            .eq("id", existingOrder.id)
            .eq("studio_id", studioId);

          if (updateOrderError) throw new Error(updateOrderError.message);
          orderId = existingOrder.id;
          updatedRows += entries.length;

          const { error: deleteItemsError } = await supabase
            .from("commerce_order_items")
            .delete()
            .eq("order_id", orderId)
            .eq("studio_id", studioId);

          if (deleteItemsError) throw new Error(deleteItemsError.message);
        }

        for (const entry of entries) {
          const candidate = entry.candidate;

          let variantId: string | null = null;
          let catalogItemId: string | null = null;
          let itemType = "physical_product";
          let itemName = candidate.itemName;
          let sku = candidate.sku || null;
          let unitCost: number | null = null;

          if (candidate.variationExternalId) {
            const { data: variant, error: variantError } = await supabase
              .from("commerce_product_variants")
              .select(
                "id, catalog_item_id, sku, unit_cost, commerce_catalog_items(name, item_type)",
              )
              .eq("studio_id", studioId)
              .eq("source_system", "square")
              .eq("source_external_id", candidate.variationExternalId)
              .maybeSingle();

            if (variantError) throw new Error(variantError.message);
            if (variant) {
              variantId = variant.id;
              catalogItemId = variant.catalog_item_id;
              sku = variant.sku || sku;
              unitCost =
                variant.unit_cost == null ? null : Number(variant.unit_cost);
              const relatedItem = Array.isArray(
                variant.commerce_catalog_items,
              )
                ? variant.commerce_catalog_items[0]
                : variant.commerce_catalog_items;
              itemName = relatedItem?.name || itemName;
              itemType = relatedItem?.item_type || itemType;
            }
          }

          if (!catalogItemId && candidate.itemExternalId) {
            const { data: item, error: itemError } = await supabase
              .from("commerce_catalog_items")
              .select("id, name, item_type, sku")
              .eq("studio_id", studioId)
              .eq("source_system", "square")
              .eq("source_external_id", candidate.itemExternalId)
              .maybeSingle();

            if (itemError) throw new Error(itemError.message);
            if (item) {
              catalogItemId = item.id;
              itemName = item.name || itemName;
              itemType = item.item_type || itemType;
              sku = item.sku || sku;
            }
          }

          if (!catalogItemId) {
            throw new Error(
              `Square catalog item was not resolved for line ${entry.rowNumber}.`,
            );
          }

          const quantity = candidate.quantity ?? 1;
          const unitPrice = candidate.unitPrice ?? 0;
          const lineDiscount = candidate.lineDiscountTotal ?? 0;
          const lineTax = candidate.lineTaxTotal ?? 0;
          const lineTotal = candidate.lineTotal ?? 0;
          const cogsTotal =
            unitCost == null ? 0 : Math.round(unitCost * quantity * 100) / 100;

          const { error: itemInsertError } = await supabase
            .from("commerce_order_items")
            .insert({
              order_id: orderId,
              studio_id: studioId,
              catalog_item_id: catalogItemId,
              variant_id: variantId,
              item_type: itemType,
              name_snapshot: itemName,
              sku_snapshot: sku,
              quantity,
              unit_price: unitPrice,
              discount_total: lineDiscount,
              tax_total: lineTax,
              line_total: lineTotal,
              fulfillment_status: fulfillmentStatus,
              unit_cost_snapshot: unitCost,
              cogs_total: cogsTotal,
              metadata: {
                source: "square_import",
                square_line_item_id: candidate.lineItemExternalId,
                square_item_id: candidate.itemExternalId || null,
                square_variation_id:
                  candidate.variationExternalId || null,
                import_batch_id: batchId,
              },
            });

          if (itemInsertError) throw new Error(itemInsertError.message);
        }

        if (first.paymentExternalId && paymentStatus !== "unpaid") {
          const { data: existingPayment, error: existingPaymentError } =
            await supabase
              .from("payments")
              .select("id")
              .eq("studio_id", studioId)
              .eq("source_system", "square")
              .eq("source_external_id", first.paymentExternalId)
              .maybeSingle();

          if (existingPaymentError) {
            throw new Error(existingPaymentError.message);
          }

          const paymentPayload = {
            studio_id: studioId,
            client_id: clientId,
            commerce_order_id: orderId,
            amount: total,
            paid_at: isValidImportDate(first.paidAt)
              ? new Date(first.paidAt).toISOString()
              : new Date(first.completedAt).toISOString(),
            payment_method: normalizePaymentMethod(first.paymentMethod),
            status: normalizePaymentStatus(first.paymentStatus || "paid"),
            notes: [
              "Imported Square historical payment.",
              refundTotal > 0
                ? `Square refund total: ${refundTotal.toFixed(2)}`
                : null,
            ]
              .filter(Boolean)
              .join("\n"),
            external_reference: first.paymentExternalId,
            source_system: "square",
            source_external_id: first.paymentExternalId,
            imported_at: now,
          };

          let paymentId: string;

          if (!existingPayment) {
            const { data: insertedPayment, error: insertPaymentError } =
              await supabase
                .from("payments")
                .insert(paymentPayload)
                .select("id")
                .single();

            if (insertPaymentError || !insertedPayment) {
              throw new Error(
                insertPaymentError?.message ??
                  "Square payment could not be created.",
              );
            }
            paymentId = insertedPayment.id;
            createdPayments += 1;
          } else {
            const { error: updatePaymentError } = await supabase
              .from("payments")
              .update(paymentPayload)
              .eq("id", existingPayment.id)
              .eq("studio_id", studioId);

            if (updatePaymentError) {
              throw new Error(updatePaymentError.message);
            }
            paymentId = existingPayment.id;
          }

          const { error: linkPaymentError } = await supabase
            .from("commerce_orders")
            .update({ payment_id: paymentId, updated_at: now })
            .eq("id", orderId)
            .eq("studio_id", studioId);

          if (linkPaymentError) throw new Error(linkPaymentError.message);
        }

        importedGross += total;
        importedRefunds += refundTotal;
      } catch (error) {
        failedRows += entries.length;
        for (const entry of entries) {
          executionErrors.push({
            import_batch_id: batchId,
            import_batch_file_id: fileRow.id,
            row_number: entry.rowNumber,
            field_name: null,
            error_code: "execution_failed",
            error_message:
              error instanceof Error
                ? error.message
                : "Square historical order import failed.",
            raw_value: orderExternalId,
            row_data: entry.row,
          });
        }
      }
    }

    await writeBatchErrors({ supabase, batchErrors: executionErrors });

    const status = failedRows > 0 ? "completed_with_warnings" : "completed";
    const reconciliationStatus =
      failedRows > 0 ? "needs_review" : "reconciled";

    await supabase
      .from("import_batches")
      .update({
        reconciliation_status: reconciliationStatus,
        updated_at: now,
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);

    await finalizeBatch({
      supabase,
      studioId,
      batchId,
      status,
      totalRows: rows.length,
      processedRows: rows.length,
      insertedRows,
      updatedRows,
      skippedRows,
      failedRows,
      summary: {
        headers,
        executed: true,
        source_system: "square",
        import_type: "retail_orders",
        square_order_count: grouped.size,
        created_clients: createdClients,
        created_payments: createdPayments,
        imported_gross: Math.round(importedGross * 100) / 100,
        imported_refunds: Math.round(importedRefunds * 100) / 100,
        accounting_sync_mode: "deferred",
        reconciliation_status: reconciliationStatus,
        execution_error_count: executionErrors.length,
      },
    });
  } catch (error) {
    redirectImportError(
      `/app/settings/import/${batchId}`,
      "execution_failed",
      error,
    );
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}


export async function executeSquareInventoryImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId, userId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (batch.source_system !== "square" || batch.import_type !== "inventory") {
      redirect("/app/settings/import?error=wrong_import_type");
    }
    if (batch.mode === "dry_run") {
      redirect(`/app/settings/import/${batchId}?error=dry_run_cannot_execute`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow || !fileRow.storage_bucket || !fileRow.storage_path) {
      redirect("/app/settings/import?error=file_not_found");
    }

    const { data: validationErrors, error: validationErrorsError } =
      await supabase
        .from("import_batch_errors")
        .select("row_number, error_code")
        .eq("import_batch_id", batchId);

    if (validationErrorsError) {
      throw new Error(validationErrorsError.message);
    }

    const blockedRows = new Set(
      (validationErrors ?? [])
        .filter((error) => isBlockingErrorCode(error.error_code))
        .map((error) => error.row_number)
        .filter((rowNumber): rowNumber is number => typeof rowNumber === "number"),
    );

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const candidates = rows.map(buildSquareInventoryCandidate);
    const variationIds = Array.from(
      new Set(candidates.map((candidate) => candidate.variationExternalId).filter(Boolean)),
    );

    const { data: variants, error: variantsError } = variationIds.length
      ? await supabase
          .from("commerce_product_variant_inventory")
          .select(
            "id, catalog_item_id, source_external_id, quantity_on_hand",
          )
          .eq("studio_id", studioId)
          .eq("source_system", "square")
          .in("source_external_id", variationIds)
      : { data: [], error: null };

    if (variantsError) throw new Error(variantsError.message);

    const variantMap = new Map(
      (variants ?? []).map((variant) => [
        String(variant.source_external_id),
        {
          id: String(variant.id),
          catalogItemId: String(variant.catalog_item_id),
          quantityOnHand: Number(variant.quantity_on_hand ?? 0),
        },
      ]),
    );

    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = 0;
    let failedRows = 0;
    let sourceUnitTotal = 0;
    let beforeUnitTotal = 0;
    let afterUnitTotal = 0;
    const executionErrors: BatchErrorInsert[] = [];
    const now = new Date().toISOString();

    for (let index = 0; index < rows.length; index += 1) {
      const rowNumber = index + 2;
      const row = rows[index];

      if (blockedRows.has(rowNumber)) {
        skippedRows += 1;
        continue;
      }

      const candidate = candidates[index];
      const variant = variantMap.get(candidate.variationExternalId);

      if (!variant) {
        failedRows += 1;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "variation_id",
          error_code: "execution_failed",
          error_message:
            "The Square variation could not be resolved during execution.",
          raw_value: candidate.variationExternalId,
          row_data: row,
        });
        continue;
      }

      const quantityDelta = candidate.quantity - variant.quantityOnHand;
      sourceUnitTotal += candidate.quantity;
      beforeUnitTotal += variant.quantityOnHand;

      if (quantityDelta === 0) {
        skippedRows += 1;
        afterUnitTotal += variant.quantityOnHand;
        continue;
      }

      try {
        const { error: adjustmentError } = await supabase.rpc(
          "commerce_adjust_inventory",
          {
            p_studio_id: studioId,
            p_catalog_item_id: variant.catalogItemId,
            p_variant_id: variant.id,
            p_quantity_delta: quantityDelta,
            p_reason:
              variant.quantityOnHand === 0 ? "opening_balance" : "correction",
            p_notes: [
              "Square inventory import",
              candidate.locationExternalId
                ? `location ${candidate.locationExternalId}`
                : null,
              candidate.calculatedAt
                ? `source count ${candidate.calculatedAt}`
                : null,
              `batch ${batchId}`,
            ]
              .filter(Boolean)
              .join(" · "),
            p_actor_user_id: userId,
          },
        );

        if (adjustmentError) throw new Error(adjustmentError.message);

        await supabase
          .from("commerce_product_variants")
          .update({
            imported_at: now,
            updated_by: userId,
            updated_at: now,
            metadata: {
              source: "square_import",
              square_location_id: candidate.locationExternalId || null,
              square_location_name: candidate.locationName || null,
              square_inventory_calculated_at: candidate.calculatedAt || null,
              square_inventory_batch_id: batchId,
            },
          })
          .eq("id", variant.id)
          .eq("studio_id", studioId);

        variant.quantityOnHand = candidate.quantity;
        afterUnitTotal += candidate.quantity;

        if (quantityDelta > 0) insertedRows += 1;
        else updatedRows += 1;
      } catch (error) {
        failedRows += 1;
        afterUnitTotal += variant.quantityOnHand;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "quantity",
          error_code: "execution_failed",
          error_message:
            error instanceof Error
              ? error.message
              : "Square inventory adjustment failed.",
          raw_value: String(candidate.quantity),
          row_data: row,
        });
      }
    }

    await writeBatchErrors({ supabase, batchErrors: executionErrors });

    const reconciliationStatus =
      failedRows > 0 || afterUnitTotal !== sourceUnitTotal
        ? "needs_review"
        : "reconciled";

    await supabase
      .from("import_batches")
      .update({
        reconciliation_status: reconciliationStatus,
        updated_at: now,
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);

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
        source_system: "square",
        import_type: "inventory",
        row_count: rows.length,
        execution_error_count: executionErrors.length,
        source_unit_total: sourceUnitTotal,
        before_unit_total: beforeUnitTotal,
        after_unit_total: afterUnitTotal,
        reconciliation_difference: sourceUnitTotal - afterUnitTotal,
        reconciliation_status: reconciliationStatus,
      },
    });
  } catch (error) {
    redirectImportError(
      `/app/settings/import/${batchId}`,
      "execution_failed",
      error,
    );
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}


export async function executeSquareProductImportBatchAction(formData: FormData) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId, userId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (batch.source_system !== "square" || batch.import_type !== "products") {
      redirect("/app/settings/import?error=wrong_import_type");
    }
    if (batch.mode === "dry_run" || !["validated", "completed_with_warnings"].includes(batch.status)) {
      redirect(`/app/settings/import/${batchId}?error=batch_not_ready`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow || !fileRow.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }
    const csvText = await loadStoredCsvText({ supabase, bucket: fileRow.storage_bucket, path: fileRow.storage_path });
    const { headers, rows } = parseCsvRows(csvText);
    const { data: existingErrors, error: errorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);
    if (errorsError) throw new Error(errorsError.message);

    const blockedRows = new Set(
      (existingErrors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((value): value is number => typeof value === "number"),
    );

    await supabase.from("import_batches").update({
      status: "processing",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", batchId).eq("studio_id", studioId);

    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = 0;
    let failedRows = 0;
    const executionErrors: BatchErrorInsert[] = [];
    const now = new Date().toISOString();

    for (let index = 0; index < rows.length; index += 1) {
      const rowNumber = index + 2;
      const row = rows[index];
      if (blockedRows.has(rowNumber)) {
        skippedRows += 1;
        continue;
      }

      const candidate = buildSquareProductCandidate(row);
      try {
        let categoryId: string | null = null;
        if (candidate.categoryExternalId || candidate.categoryName) {
          let categoryQuery = supabase
            .from("commerce_catalog_categories")
            .select("id")
            .eq("studio_id", studioId);
          categoryQuery = candidate.categoryExternalId
            ? categoryQuery.eq("source_system", "square").eq("source_external_id", candidate.categoryExternalId)
            : categoryQuery.ilike("name", candidate.categoryName);
          const { data: existingCategory, error: categoryLookupError } = await categoryQuery.maybeSingle();
          if (categoryLookupError) throw new Error(categoryLookupError.message);
          if (existingCategory) {
            categoryId = existingCategory.id;
          } else {
            const { data: insertedCategory, error: categoryInsertError } = await supabase
              .from("commerce_catalog_categories")
              .insert({
                studio_id: studioId,
                name: candidate.categoryName || "Imported Square Category",
                source_system: "square",
                source_external_id: candidate.categoryExternalId || null,
                active: true,
                imported_at: now,
                created_by: userId,
                updated_by: userId,
                metadata: { source: "square_import" },
              })
              .select("id")
              .single();
            if (categoryInsertError || !insertedCategory) throw new Error(categoryInsertError?.message ?? "Category could not be created.");
            categoryId = insertedCategory.id;
          }
        }

        const { data: existingItem, error: itemLookupError } = await supabase
          .from("commerce_catalog_items")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "square")
          .eq("source_external_id", candidate.itemExternalId)
          .maybeSingle();
        if (itemLookupError) throw new Error(itemLookupError.message);

        let catalogItemId = existingItem?.id ?? null;
        if (!catalogItemId) {
          const { data: insertedItem, error: itemInsertError } = await supabase
            .from("commerce_catalog_items")
            .insert({
              studio_id: studioId,
              name: candidate.itemName,
              description: candidate.description || null,
              item_type: "physical_product",
              sku: candidate.itemSku || null,
              price: candidate.price,
              currency: "usd",
              taxable: true,
              active: candidate.active,
              published: false,
              marketplace_visible: false,
              source_system: "square",
              source_external_id: candidate.itemExternalId,
              imported_at: now,
              created_by: userId,
              updated_by: userId,
              metadata: { source: "square_import", historical_import: true },
            })
            .select("id")
            .single();
          if (itemInsertError || !insertedItem) throw new Error(itemInsertError?.message ?? "Catalog item could not be created.");
          catalogItemId = insertedItem.id;
        } else if (batch.mode !== "create_only") {
          const { error: itemUpdateError } = await supabase
            .from("commerce_catalog_items")
            .update({
              name: candidate.itemName,
              description: candidate.description || null,
              sku: candidate.itemSku || null,
              price: candidate.price,
              active: candidate.active,
              imported_at: now,
              updated_by: userId,
              updated_at: now,
            })
            .eq("id", catalogItemId)
            .eq("studio_id", studioId);
          if (itemUpdateError) throw new Error(itemUpdateError.message);
        }

        const { data: existingVariant, error: variantLookupError } = await supabase
          .from("commerce_product_variants")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "square")
          .eq("source_external_id", candidate.variationExternalId)
          .maybeSingle();
        if (variantLookupError) throw new Error(variantLookupError.message);

        if (!existingVariant) {
          const { error: variantInsertError } = await supabase
            .from("commerce_product_variants")
            .insert({
              studio_id: studioId,
              catalog_item_id: catalogItemId,
              name: candidate.variationName,
              sku: candidate.sku || null,
              barcode: candidate.barcode || null,
              size: candidate.size || null,
              color: candidate.color || null,
              unit_cost: candidate.unitCost,
              price_override: candidate.price,
              reorder_threshold: 0,
              active: candidate.active,
              source_system: "square",
              source_external_id: candidate.variationExternalId,
              imported_at: now,
              created_by: userId,
              updated_by: userId,
              metadata: { source: "square_import", historical_import: true },
            });
          if (variantInsertError) throw new Error(variantInsertError.message);
          insertedRows += 1;
        } else if (batch.mode === "create_only") {
          skippedRows += 1;
        } else {
          const { error: variantUpdateError } = await supabase
            .from("commerce_product_variants")
            .update({
              catalog_item_id: catalogItemId,
              name: candidate.variationName,
              sku: candidate.sku || null,
              barcode: candidate.barcode || null,
              size: candidate.size || null,
              color: candidate.color || null,
              unit_cost: candidate.unitCost,
              price_override: candidate.price,
              active: candidate.active,
              imported_at: now,
              updated_by: userId,
              updated_at: now,
            })
            .eq("id", existingVariant.id)
            .eq("studio_id", studioId);
          if (variantUpdateError) throw new Error(variantUpdateError.message);
          updatedRows += 1;
        }

        if (categoryId) {
          const { error: clearPrimaryCategoryError } = await supabase
            .from("commerce_catalog_item_categories")
            .update({ is_primary: false })
            .eq("studio_id", studioId)
            .eq("catalog_item_id", catalogItemId)
            .eq("is_primary", true)
            .neq("category_id", categoryId);
          if (clearPrimaryCategoryError) throw new Error(clearPrimaryCategoryError.message);

          const { error: categoryLinkError } = await supabase
            .from("commerce_catalog_item_categories")
            .upsert({
              studio_id: studioId,
              catalog_item_id: catalogItemId,
              category_id: categoryId,
              is_primary: true,
              source_system: "square",
              source_external_id: `${candidate.itemExternalId}:${candidate.categoryExternalId || categoryId}`,
              created_by: userId,
              metadata: { source: "square_import" },
            }, { onConflict: "catalog_item_id,category_id" });
          if (categoryLinkError) throw new Error(categoryLinkError.message);
        }
      } catch (error) {
        failedRows += 1;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: null,
          error_code: "execution_failed",
          error_message: error instanceof Error ? error.message : "Square catalog import failed.",
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
        source_system: "square",
        import_type: "products",
        execution_error_count: executionErrors.length,
        row_count: rows.length,
      },
    });
  } catch (error) {
    redirectImportError(`/app/settings/import/${batchId}`, "execution_failed", error);
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

type WellnessLivingPackageCandidate = {
  templateExternalId: string;
  clientPackageExternalId: string;
  clientExternalId: string;
  name: string;
  price: number;
  purchaseDate: string;
  expirationDate: string;
  usageType: "private_lesson" | "group_class" | "practice_party" | "";
  quantityTotal: number | null;
  quantityRemaining: number | null;
  isUnlimited: boolean;
};

function parseWellnessLivingWholeNumber(value: string) {
  const normalized = value.replace(/,/g, "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeWellnessLivingPackageUsage(
  value: string,
): WellnessLivingPackageCandidate["usageType"] {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");

  if (["private_lesson", "private", "private_session", "appointment"].includes(normalized)) {
    return "private_lesson";
  }
  if (["group_class", "class", "group", "group_session"].includes(normalized)) {
    return "group_class";
  }
  if (["practice_party", "party", "practice", "social", "social_dance"].includes(normalized)) {
    return "practice_party";
  }
  return "";
}

function buildWellnessLivingPackageCandidate(
  row: Record<string, string>,
): WellnessLivingPackageCandidate {
  const totalRaw = getRowValue(row, [
    "visits_total",
    "quantity_total",
    "sessions_total",
    "credits_total",
    "total_visits",
  ]);
  const remainingRaw = getRowValue(row, [
    "visits_remaining",
    "quantity_remaining",
    "sessions_remaining",
    "credits_remaining",
    "remaining_visits",
  ]);
  const unlimitedRaw = getRowValue(row, [
    "is_unlimited",
    "unlimited",
    "unlimited_visits",
  ]).toLowerCase();
  const isUnlimited =
    ["1", "true", "yes", "y", "unlimited"].includes(unlimitedRaw) ||
    totalRaw.toLowerCase() === "unlimited" ||
    remainingRaw.toLowerCase() === "unlimited";

  const parsedPrice = parseMoney(
    getRowValue(row, ["price", "amount", "sale_price"]),
  );

  return {
    templateExternalId: getRowValue(row, [
      "pricing_option_id",
      "package_template_id",
      "pricing_id",
      "product_id",
    ]),
    clientPackageExternalId: getRowValue(row, [
      "client_pricing_option_id",
      "client_package_id",
      "package_id",
      "purchase_id",
      "pass_id",
    ]),
    clientExternalId: getRowValue(row, [
      "client_id",
      "customer_id",
      "member_id",
    ]),
    name: getRowValue(row, [
      "pricing_option_name",
      "package_name",
      "name",
      "pricing_option",
    ]),
    price: Number.isFinite(parsedPrice) && parsedPrice >= 0 ? parsedPrice : 0,
    purchaseDate: getRowValue(row, [
      "purchase_date",
      "purchased_on",
      "start_date",
      "date_purchased",
    ]),
    expirationDate: getRowValue(row, [
      "expiration_date",
      "expires_on",
      "expiry_date",
      "end_date",
    ]),
    usageType: normalizeWellnessLivingPackageUsage(
      getRowValue(row, [
        "usage_type",
        "service_type",
        "visit_type",
        "session_type",
        "category",
      ]),
    ),
    quantityTotal: isUnlimited ? null : parseWellnessLivingWholeNumber(totalRaw),
    quantityRemaining: isUnlimited
      ? null
      : parseWellnessLivingWholeNumber(remainingRaw),
    isUnlimited,
  };
}

function isValidWellnessLivingDate(value: string) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.getTime());
}

export async function validateWellnessLivingPackageImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "wellnessliving" ||
      batch.import_type !== "packages"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect("/app/settings/import?error=file_not_found");
    }

    await clearBatchErrors({ supabase, batchId });

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const candidates = rows.map(buildWellnessLivingPackageCandidate);
    const batchErrors: BatchErrorInsert[] = [];
    const duplicateIds = new Set<string>();

    const clientExternalIds = Array.from(
      new Set(candidates.map((row) => row.clientExternalId).filter(Boolean)),
    );
    const packageExternalIds = Array.from(
      new Set(
        candidates
          .map((row) => row.clientPackageExternalId)
          .filter(Boolean),
      ),
    );
    const templateExternalIds = Array.from(
      new Set(candidates.map((row) => row.templateExternalId).filter(Boolean)),
    );

    let existingClientIds = new Set<string>();
    let existingPackageIds = new Set<string>();
    let existingTemplateIds = new Set<string>();

    if (clientExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("clients")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "wellnessliving")
        .in("source_external_id", clientExternalIds);
      if (error) throw new Error(error.message);
      existingClientIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    if (packageExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("client_packages")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "wellnessliving")
        .in("source_external_id", packageExternalIds);
      if (error) throw new Error(error.message);
      existingPackageIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    if (templateExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("package_templates")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "wellnessliving")
        .in("source_external_id", templateExternalIds);
      if (error) throw new Error(error.message);
      existingTemplateIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    let readyRows = 0;
    let createCandidates = 0;
    let updateCandidates = 0;
    let createTemplateCandidates = 0;
    let currentBalanceUnits = 0;
    let historicalUsedUnits = 0;

    rows.forEach((row, index) => {
      const candidate = candidates[index];
      const rowNumber = index + 2;
      let blocked = false;

      const addBlocking = (
        fieldName: string,
        errorCode: string,
        errorMessage: string,
        rawValue: string | null = null,
      ) => {
        blocked = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: fieldName,
          error_code: errorCode,
          error_message: errorMessage,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.clientExternalId) {
        addBlocking("client_id", "missing_required_field", "WellnessLiving client ID is required.");
      } else if (!existingClientIds.has(candidate.clientExternalId)) {
        addBlocking(
          "client_id",
          "missing_related_record",
          "Import the WellnessLiving client before importing package balances.",
          candidate.clientExternalId,
        );
      }

      if (!candidate.templateExternalId) {
        addBlocking(
          "pricing_option_id",
          "missing_required_field",
          "WellnessLiving pricing option ID is required.",
        );
      }

      if (!candidate.clientPackageExternalId) {
        addBlocking(
          "client_pricing_option_id",
          "missing_required_field",
          "WellnessLiving client package/pass ID is required.",
        );
      } else if (duplicateIds.has(candidate.clientPackageExternalId)) {
        const samePackageRows = candidates.filter(
          (item) => item.clientPackageExternalId === candidate.clientPackageExternalId,
        );
        const duplicateUsage = samePackageRows.filter(
          (item) => item.usageType === candidate.usageType,
        ).length > 1;
        if (duplicateUsage) {
          addBlocking(
            "client_pricing_option_id",
            "duplicate_source_identity",
            "The same client package and usage type appear more than once.",
            candidate.clientPackageExternalId,
          );
        }
      } else {
        duplicateIds.add(candidate.clientPackageExternalId);
      }

      if (!candidate.name) {
        addBlocking(
          "pricing_option_name",
          "missing_required_field",
          "Package name is required.",
        );
      }

      if (!candidate.usageType) {
        addBlocking(
          "usage_type",
          "unsupported_package_usage",
          "Map the visit type to private_lesson, group_class, or practice_party.",
          getRowValue(row, ["usage_type", "service_type", "visit_type", "category"]),
        );
      }

      if (!isValidWellnessLivingDate(candidate.purchaseDate)) {
        addBlocking(
          "purchase_date",
          "invalid_datetime",
          "Purchase date must use YYYY-MM-DD.",
          candidate.purchaseDate,
        );
      }

      if (!isValidWellnessLivingDate(candidate.expirationDate)) {
        addBlocking(
          "expiration_date",
          "invalid_datetime",
          "Expiration date must use YYYY-MM-DD.",
          candidate.expirationDate,
        );
      }

      if (!candidate.isUnlimited) {
        if (candidate.quantityTotal === null) {
          addBlocking(
            "visits_total",
            "invalid_amount",
            "Total visits must be a whole number.",
            getRowValue(row, ["visits_total", "quantity_total", "sessions_total"]),
          );
        }
        if (candidate.quantityRemaining === null) {
          addBlocking(
            "visits_remaining",
            "invalid_amount",
            "Visits remaining must be a whole number.",
            getRowValue(row, ["visits_remaining", "quantity_remaining", "sessions_remaining"]),
          );
        }
        if (
          candidate.quantityTotal !== null &&
          candidate.quantityRemaining !== null &&
          candidate.quantityRemaining > candidate.quantityTotal
        ) {
          addBlocking(
            "visits_remaining",
            "invalid_amount",
            "Visits remaining cannot exceed total visits.",
            String(candidate.quantityRemaining),
          );
        }
      }

      if (!blocked) {
        readyRows += 1;
        if (existingPackageIds.has(candidate.clientPackageExternalId)) {
          updateCandidates += 1;
        } else {
          createCandidates += 1;
        }
        if (!existingTemplateIds.has(candidate.templateExternalId)) {
          createTemplateCandidates += 1;
          existingTemplateIds.add(candidate.templateExternalId);
        }
        if (
          !candidate.isUnlimited &&
          candidate.quantityTotal !== null &&
          candidate.quantityRemaining !== null
        ) {
          currentBalanceUnits += candidate.quantityRemaining;
          historicalUsedUnits +=
            candidate.quantityTotal - candidate.quantityRemaining;
        }
      }
    });

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
        create_template_candidates: createTemplateCandidates,
        ready_rows: readyRows,
        current_balance_units: currentBalanceUnits,
        historical_used_units: historicalUsedUnits,
        historical_attendance_deduction: false,
        source_specific_validation: "wellnessliving_packages_v1",
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
  }

  redirect("/app/settings/import?success=validated");
}

export async function executeWellnessLivingPackageImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "wellnessliving" ||
      batch.import_type !== "packages"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }
    if (
      batch.mode === "dry_run" ||
      !["validated", "completed_with_warnings"].includes(batch.status)
    ) {
      redirect(`/app/settings/import/${batchId}?error=batch_not_ready`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const { data: errors, error: errorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);
    if (errorsError) throw new Error(errorsError.message);

    const blockedRows = new Set(
      (errors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((value): value is number => typeof value === "number"),
    );

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);

    const grouped = new Map<
      string,
      { firstRow: number; rows: Record<string, string>[]; items: WellnessLivingPackageCandidate[] }
    >();

    rows.forEach((row, index) => {
      const rowNumber = index + 2;
      if (blockedRows.has(rowNumber)) return;
      const candidate = buildWellnessLivingPackageCandidate(row);
      if (!candidate.clientPackageExternalId) return;
      const group = grouped.get(candidate.clientPackageExternalId) ?? {
        firstRow: rowNumber,
        rows: [],
        items: [],
      };
      group.rows.push(row);
      group.items.push(candidate);
      grouped.set(candidate.clientPackageExternalId, group);
    });

    const executionErrors: BatchErrorInsert[] = [];
    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = blockedRows.size;
    let failedRows = 0;
    let templatesCreated = 0;
    let templatesUpdated = 0;
    let packageItemsCreated = 0;
    let currentBalanceUnits = 0;
    let historicalUsedUnits = 0;
    const importedAt = new Date().toISOString();

    for (const [clientPackageExternalId, group] of grouped) {
      const first = group.items[0];

      try {
        const { data: client, error: clientError } = await supabase
          .from("clients")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "wellnessliving")
          .eq("source_external_id", first.clientExternalId)
          .single();
        if (clientError || !client) {
          throw new Error(clientError?.message ?? "Client could not be resolved.");
        }

        const { data: existingTemplate, error: templateLookupError } =
          await supabase
            .from("package_templates")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", "wellnessliving")
            .eq("source_external_id", first.templateExternalId)
            .maybeSingle();
        if (templateLookupError) throw new Error(templateLookupError.message);

        let templateId = existingTemplate?.id ?? null;

        if (!templateId) {
          const { data: insertedTemplate, error: insertTemplateError } =
            await supabase
              .from("package_templates")
              .insert({
                studio_id: studioId,
                name: first.name,
                description: "Imported from WellnessLiving.",
                price: first.price,
                expiration_days: null,
                active: true,
                source_system: "wellnessliving",
                source_external_id: first.templateExternalId,
                imported_at: importedAt,
              })
              .select("id")
              .single();
          if (insertTemplateError || !insertedTemplate) {
            throw new Error(insertTemplateError?.message ?? "Package template insert failed.");
          }
          templateId = insertedTemplate.id;
          templatesCreated += 1;
        } else if (batch.mode === "create_or_update") {
          const { error: updateTemplateError } = await supabase
            .from("package_templates")
            .update({
              name: first.name,
              price: first.price,
              active: true,
              imported_at: importedAt,
            })
            .eq("id", templateId)
            .eq("studio_id", studioId);
          if (updateTemplateError) throw new Error(updateTemplateError.message);

          const { error: deleteTemplateItemsError } = await supabase
            .from("package_template_items")
            .delete()
            .eq("studio_id", studioId)
            .eq("package_template_id", templateId);
          if (deleteTemplateItemsError) {
            throw new Error(deleteTemplateItemsError.message);
          }
          templatesUpdated += 1;
        }

        if (!existingTemplate || batch.mode === "create_or_update") {
          const templateItems = group.items.map((item) => ({
            studio_id: studioId,
            package_template_id: templateId,
            usage_type: item.usageType,
            quantity: item.isUnlimited ? null : item.quantityTotal,
            is_unlimited: item.isUnlimited,
          }));
          const { error: templateItemsError } = await supabase
            .from("package_template_items")
            .insert(templateItems);
          if (templateItemsError) throw new Error(templateItemsError.message);
        }

        const { data: existingPackage, error: packageLookupError } =
          await supabase
            .from("client_packages")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", "wellnessliving")
            .eq("source_external_id", clientPackageExternalId)
            .maybeSingle();
        if (packageLookupError) throw new Error(packageLookupError.message);

        let clientPackageId = existingPackage?.id ?? null;

        if (clientPackageId && batch.mode === "create_only") {
          skippedRows += group.rows.length;
          continue;
        }

        const active =
          !first.expirationDate ||
          new Date(`${first.expirationDate}T23:59:59.999Z`).getTime() >= Date.now();

        if (!clientPackageId) {
          const { data: insertedPackage, error: insertPackageError } =
            await supabase
              .from("client_packages")
              .insert({
                studio_id: studioId,
                client_id: client.id,
                package_template_id: templateId,
                name_snapshot: first.name,
                price_snapshot: first.price,
                purchase_date: first.purchaseDate || null,
                expiration_date: first.expirationDate || null,
                active,
                source_system: "wellnessliving",
                source_external_id: clientPackageExternalId,
                imported_at: importedAt,
              })
              .select("id")
              .single();
          if (insertPackageError || !insertedPackage) {
            throw new Error(insertPackageError?.message ?? "Client package insert failed.");
          }
          clientPackageId = insertedPackage.id;
          insertedRows += group.rows.length;
        } else {
          const { error: updatePackageError } = await supabase
            .from("client_packages")
            .update({
              client_id: client.id,
              package_template_id: templateId,
              name_snapshot: first.name,
              price_snapshot: first.price,
              purchase_date: first.purchaseDate || null,
              expiration_date: first.expirationDate || null,
              active,
              imported_at: importedAt,
            })
            .eq("id", clientPackageId)
            .eq("studio_id", studioId);
          if (updatePackageError) throw new Error(updatePackageError.message);

          const { error: deleteItemsError } = await supabase
            .from("client_package_items")
            .delete()
            .eq("studio_id", studioId)
            .eq("client_package_id", clientPackageId);
          if (deleteItemsError) throw new Error(deleteItemsError.message);
          updatedRows += group.rows.length;
        }

        const packageItems = group.items.map((item) => {
          const used =
            item.isUnlimited ||
            item.quantityTotal === null ||
            item.quantityRemaining === null
              ? 0
              : item.quantityTotal - item.quantityRemaining;

          if (!item.isUnlimited && item.quantityRemaining !== null) {
            currentBalanceUnits += item.quantityRemaining;
            historicalUsedUnits += used;
          }

          return {
            studio_id: studioId,
            client_package_id: clientPackageId,
            usage_type: item.usageType,
            quantity_total: item.isUnlimited ? null : item.quantityTotal,
            quantity_used: used,
            quantity_remaining: item.isUnlimited ? null : item.quantityRemaining,
            is_unlimited: item.isUnlimited,
          };
        });

        const { error: packageItemsError } = await supabase
          .from("client_package_items")
          .insert(packageItems);
        if (packageItemsError) throw new Error(packageItemsError.message);
        packageItemsCreated += packageItems.length;
      } catch (error) {
        failedRows += group.rows.length;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: group.firstRow,
          field_name: "client_pricing_option_id",
          error_code: "execution_failed",
          error_message:
            error instanceof Error ? error.message : "Package import failed.",
          raw_value: clientPackageExternalId,
          row_data: group.rows[0] ?? {},
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
        row_count: rows.length,
        templates_created: templatesCreated,
        templates_updated: templatesUpdated,
        package_items_created: packageItemsCreated,
        current_balance_units: currentBalanceUnits,
        historical_used_units: historicalUsedUnits,
        historical_attendance_deduction: false,
        source_specific_execution: "wellnessliving_packages_v1",
      },
    });

    const { error: reconciliationError } = await supabase
      .from("import_batches")
      .update({
        reconciliation_status: failedRows > 0 ? "needs_review" : "reconciled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);
    if (reconciliationError) throw new Error(reconciliationError.message);
  } catch (error) {
    redirectImportError(
      `/app/settings/import/${batchId}`,
      "execution_failed",
      error,
    );
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}


type MindbodyPackageCandidate = {
  templateExternalId: string;
  clientPackageExternalId: string;
  clientExternalId: string;
  name: string;
  price: number;
  purchaseDate: string;
  expirationDate: string;
  usageType: "private_lesson" | "group_class" | "practice_party" | "";
  quantityTotal: number | null;
  quantityRemaining: number | null;
  isUnlimited: boolean;
};

function parseMindbodyWholeNumber(value: string) {
  const normalized = value.replace(/,/g, "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeMindbodyPackageUsage(
  value: string,
): MindbodyPackageCandidate["usageType"] {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");

  if (["private_lesson", "private", "private_session", "appointment"].includes(normalized)) {
    return "private_lesson";
  }
  if (["group_class", "class", "group", "group_session"].includes(normalized)) {
    return "group_class";
  }
  if (["practice_party", "party", "practice", "social", "social_dance"].includes(normalized)) {
    return "practice_party";
  }
  return "";
}

function buildMindbodyPackageCandidate(
  row: Record<string, string>,
): MindbodyPackageCandidate {
  const totalRaw = getRowValue(row, [
    "visits_total",
    "quantity_total",
    "sessions_total",
    "credits_total",
    "total_visits",
  ]);
  const remainingRaw = getRowValue(row, [
    "visits_remaining",
    "quantity_remaining",
    "sessions_remaining",
    "credits_remaining",
    "remaining_visits",
  ]);
  const unlimitedRaw = getRowValue(row, [
    "is_unlimited",
    "unlimited",
    "unlimited_visits",
  ]).toLowerCase();
  const isUnlimited =
    ["1", "true", "yes", "y", "unlimited"].includes(unlimitedRaw) ||
    totalRaw.toLowerCase() === "unlimited" ||
    remainingRaw.toLowerCase() === "unlimited";

  const parsedPrice = parseMoney(
    getRowValue(row, ["price", "amount", "sale_price"]),
  );

  return {
    templateExternalId: getRowValue(row, [
      "pricing_option_id",
      "package_template_id",
      "pricing_id",
      "product_id",
    ]),
    clientPackageExternalId: getRowValue(row, [
      "client_pricing_option_id",
      "client_service_id",
      "client_package_id",
      "package_id",
      "purchase_id",
      "pass_id",
    ]),
    clientExternalId: getRowValue(row, [
      "client_id",
      "customer_id",
      "member_id",
    ]),
    name: getRowValue(row, [
      "pricing_option_name",
      "client_service_name",
      "service_name",
      "package_name",
      "name",
      "pricing_option",
    ]),
    price: Number.isFinite(parsedPrice) && parsedPrice >= 0 ? parsedPrice : 0,
    purchaseDate: getRowValue(row, [
      "purchase_date",
      "activation_date",
      "purchased_on",
      "start_date",
      "date_purchased",
    ]),
    expirationDate: getRowValue(row, [
      "expiration_date",
      "expiration",
      "expires_on",
      "expiry_date",
      "end_date",
    ]),
    usageType: normalizeMindbodyPackageUsage(
      getRowValue(row, [
        "usage_type",
        "service_type",
        "program_type",
        "visit_type",
        "session_type",
        "category",
      ]),
    ),
    quantityTotal: isUnlimited ? null : parseMindbodyWholeNumber(totalRaw),
    quantityRemaining: isUnlimited
      ? null
      : parseMindbodyWholeNumber(remainingRaw),
    isUnlimited,
  };
}

function isValidMindbodyDate(value: string) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.getTime());
}

export async function validateMindbodyPackageImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "mindbody" ||
      batch.import_type !== "packages"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect("/app/settings/import?error=file_not_found");
    }

    await clearBatchErrors({ supabase, batchId });

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const candidates = rows.map(buildMindbodyPackageCandidate);
    const batchErrors: BatchErrorInsert[] = [];
    const duplicateIds = new Set<string>();

    const clientExternalIds = Array.from(
      new Set(candidates.map((row) => row.clientExternalId).filter(Boolean)),
    );
    const packageExternalIds = Array.from(
      new Set(
        candidates
          .map((row) => row.clientPackageExternalId)
          .filter(Boolean),
      ),
    );
    const templateExternalIds = Array.from(
      new Set(candidates.map((row) => row.templateExternalId).filter(Boolean)),
    );

    let existingClientIds = new Set<string>();
    let existingPackageIds = new Set<string>();
    let existingTemplateIds = new Set<string>();

    if (clientExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("clients")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "mindbody")
        .in("source_external_id", clientExternalIds);
      if (error) throw new Error(error.message);
      existingClientIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    if (packageExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("client_packages")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "mindbody")
        .in("source_external_id", packageExternalIds);
      if (error) throw new Error(error.message);
      existingPackageIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    if (templateExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("package_templates")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "mindbody")
        .in("source_external_id", templateExternalIds);
      if (error) throw new Error(error.message);
      existingTemplateIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    let readyRows = 0;
    let createCandidates = 0;
    let updateCandidates = 0;
    let createTemplateCandidates = 0;
    let currentBalanceUnits = 0;
    let historicalUsedUnits = 0;

    rows.forEach((row, index) => {
      const candidate = candidates[index];
      const rowNumber = index + 2;
      let blocked = false;

      const addBlocking = (
        fieldName: string,
        errorCode: string,
        errorMessage: string,
        rawValue: string | null = null,
      ) => {
        blocked = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: fieldName,
          error_code: errorCode,
          error_message: errorMessage,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.clientExternalId) {
        addBlocking("client_id", "missing_required_field", "Mindbody client ID is required.");
      } else if (!existingClientIds.has(candidate.clientExternalId)) {
        addBlocking(
          "client_id",
          "missing_related_record",
          "Import the Mindbody client before importing package balances.",
          candidate.clientExternalId,
        );
      }

      if (!candidate.templateExternalId) {
        addBlocking(
          "pricing_option_id",
          "missing_required_field",
          "Mindbody pricing option ID is required.",
        );
      }

      if (!candidate.clientPackageExternalId) {
        addBlocking(
          "client_pricing_option_id",
          "missing_required_field",
          "Mindbody client package/pass ID is required.",
        );
      } else if (duplicateIds.has(candidate.clientPackageExternalId)) {
        const samePackageRows = candidates.filter(
          (item) => item.clientPackageExternalId === candidate.clientPackageExternalId,
        );
        const duplicateUsage = samePackageRows.filter(
          (item) => item.usageType === candidate.usageType,
        ).length > 1;
        if (duplicateUsage) {
          addBlocking(
            "client_pricing_option_id",
            "duplicate_source_identity",
            "The same client package and usage type appear more than once.",
            candidate.clientPackageExternalId,
          );
        }
      } else {
        duplicateIds.add(candidate.clientPackageExternalId);
      }

      if (!candidate.name) {
        addBlocking(
          "pricing_option_name",
          "missing_required_field",
          "Package name is required.",
        );
      }

      if (!candidate.usageType) {
        addBlocking(
          "usage_type",
          "unsupported_package_usage",
          "Map the visit type to private_lesson, group_class, or practice_party.",
          getRowValue(row, ["usage_type", "service_type", "visit_type", "category"]),
        );
      }

      if (!isValidMindbodyDate(candidate.purchaseDate)) {
        addBlocking(
          "purchase_date",
          "invalid_datetime",
          "Purchase date must use YYYY-MM-DD.",
          candidate.purchaseDate,
        );
      }

      if (!isValidMindbodyDate(candidate.expirationDate)) {
        addBlocking(
          "expiration_date",
          "invalid_datetime",
          "Expiration date must use YYYY-MM-DD.",
          candidate.expirationDate,
        );
      }

      if (!candidate.isUnlimited) {
        if (candidate.quantityTotal === null) {
          addBlocking(
            "visits_total",
            "invalid_amount",
            "Total visits must be a whole number.",
            getRowValue(row, ["visits_total", "quantity_total", "sessions_total"]),
          );
        }
        if (candidate.quantityRemaining === null) {
          addBlocking(
            "visits_remaining",
            "invalid_amount",
            "Visits remaining must be a whole number.",
            getRowValue(row, ["visits_remaining", "quantity_remaining", "sessions_remaining"]),
          );
        }
        if (
          candidate.quantityTotal !== null &&
          candidate.quantityRemaining !== null &&
          candidate.quantityRemaining > candidate.quantityTotal
        ) {
          addBlocking(
            "visits_remaining",
            "invalid_amount",
            "Visits remaining cannot exceed total visits.",
            String(candidate.quantityRemaining),
          );
        }
      }

      if (!blocked) {
        readyRows += 1;
        if (existingPackageIds.has(candidate.clientPackageExternalId)) {
          updateCandidates += 1;
        } else {
          createCandidates += 1;
        }
        if (!existingTemplateIds.has(candidate.templateExternalId)) {
          createTemplateCandidates += 1;
          existingTemplateIds.add(candidate.templateExternalId);
        }
        if (
          !candidate.isUnlimited &&
          candidate.quantityTotal !== null &&
          candidate.quantityRemaining !== null
        ) {
          currentBalanceUnits += candidate.quantityRemaining;
          historicalUsedUnits +=
            candidate.quantityTotal - candidate.quantityRemaining;
        }
      }
    });

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
        create_template_candidates: createTemplateCandidates,
        ready_rows: readyRows,
        current_balance_units: currentBalanceUnits,
        historical_used_units: historicalUsedUnits,
        historical_attendance_deduction: false,
        source_specific_validation: "mindbody_packages_v1",
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
  }

  redirect("/app/settings/import?success=validated");
}

export async function executeMindbodyPackageImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "mindbody" ||
      batch.import_type !== "packages"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }
    if (
      batch.mode === "dry_run" ||
      !["validated", "completed_with_warnings"].includes(batch.status)
    ) {
      redirect(`/app/settings/import/${batchId}?error=batch_not_ready`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const { data: errors, error: errorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);
    if (errorsError) throw new Error(errorsError.message);

    const blockedRows = new Set(
      (errors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((value): value is number => typeof value === "number"),
    );

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);

    const grouped = new Map<
      string,
      { firstRow: number; rows: Record<string, string>[]; items: MindbodyPackageCandidate[] }
    >();

    rows.forEach((row, index) => {
      const rowNumber = index + 2;
      if (blockedRows.has(rowNumber)) return;
      const candidate = buildMindbodyPackageCandidate(row);
      if (!candidate.clientPackageExternalId) return;
      const group = grouped.get(candidate.clientPackageExternalId) ?? {
        firstRow: rowNumber,
        rows: [],
        items: [],
      };
      group.rows.push(row);
      group.items.push(candidate);
      grouped.set(candidate.clientPackageExternalId, group);
    });

    const executionErrors: BatchErrorInsert[] = [];
    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = blockedRows.size;
    let failedRows = 0;
    let templatesCreated = 0;
    let templatesUpdated = 0;
    let packageItemsCreated = 0;
    let currentBalanceUnits = 0;
    let historicalUsedUnits = 0;
    const importedAt = new Date().toISOString();

    for (const [clientPackageExternalId, group] of grouped) {
      const first = group.items[0];

      try {
        const { data: client, error: clientError } = await supabase
          .from("clients")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "mindbody")
          .eq("source_external_id", first.clientExternalId)
          .single();
        if (clientError || !client) {
          throw new Error(clientError?.message ?? "Client could not be resolved.");
        }

        const { data: existingTemplate, error: templateLookupError } =
          await supabase
            .from("package_templates")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", "mindbody")
            .eq("source_external_id", first.templateExternalId)
            .maybeSingle();
        if (templateLookupError) throw new Error(templateLookupError.message);

        let templateId = existingTemplate?.id ?? null;

        if (!templateId) {
          const { data: insertedTemplate, error: insertTemplateError } =
            await supabase
              .from("package_templates")
              .insert({
                studio_id: studioId,
                name: first.name,
                description: "Imported from Mindbody.",
                price: first.price,
                expiration_days: null,
                active: true,
                source_system: "mindbody",
                source_external_id: first.templateExternalId,
                imported_at: importedAt,
              })
              .select("id")
              .single();
          if (insertTemplateError || !insertedTemplate) {
            throw new Error(insertTemplateError?.message ?? "Package template insert failed.");
          }
          templateId = insertedTemplate.id;
          templatesCreated += 1;
        } else if (batch.mode === "create_or_update") {
          const { error: updateTemplateError } = await supabase
            .from("package_templates")
            .update({
              name: first.name,
              price: first.price,
              active: true,
              imported_at: importedAt,
            })
            .eq("id", templateId)
            .eq("studio_id", studioId);
          if (updateTemplateError) throw new Error(updateTemplateError.message);

          const { error: deleteTemplateItemsError } = await supabase
            .from("package_template_items")
            .delete()
            .eq("studio_id", studioId)
            .eq("package_template_id", templateId);
          if (deleteTemplateItemsError) {
            throw new Error(deleteTemplateItemsError.message);
          }
          templatesUpdated += 1;
        }

        if (!existingTemplate || batch.mode === "create_or_update") {
          const templateItems = group.items.map((item) => ({
            studio_id: studioId,
            package_template_id: templateId,
            usage_type: item.usageType,
            quantity: item.isUnlimited ? null : item.quantityTotal,
            is_unlimited: item.isUnlimited,
          }));
          const { error: templateItemsError } = await supabase
            .from("package_template_items")
            .insert(templateItems);
          if (templateItemsError) throw new Error(templateItemsError.message);
        }

        const { data: existingPackage, error: packageLookupError } =
          await supabase
            .from("client_packages")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", "mindbody")
            .eq("source_external_id", clientPackageExternalId)
            .maybeSingle();
        if (packageLookupError) throw new Error(packageLookupError.message);

        let clientPackageId = existingPackage?.id ?? null;

        if (clientPackageId && batch.mode === "create_only") {
          skippedRows += group.rows.length;
          continue;
        }

        const active =
          !first.expirationDate ||
          new Date(`${first.expirationDate}T23:59:59.999Z`).getTime() >= Date.now();

        if (!clientPackageId) {
          const { data: insertedPackage, error: insertPackageError } =
            await supabase
              .from("client_packages")
              .insert({
                studio_id: studioId,
                client_id: client.id,
                package_template_id: templateId,
                name_snapshot: first.name,
                price_snapshot: first.price,
                purchase_date: first.purchaseDate || null,
                expiration_date: first.expirationDate || null,
                active,
                source_system: "mindbody",
                source_external_id: clientPackageExternalId,
                imported_at: importedAt,
              })
              .select("id")
              .single();
          if (insertPackageError || !insertedPackage) {
            throw new Error(insertPackageError?.message ?? "Client package insert failed.");
          }
          clientPackageId = insertedPackage.id;
          insertedRows += group.rows.length;
        } else {
          const { error: updatePackageError } = await supabase
            .from("client_packages")
            .update({
              client_id: client.id,
              package_template_id: templateId,
              name_snapshot: first.name,
              price_snapshot: first.price,
              purchase_date: first.purchaseDate || null,
              expiration_date: first.expirationDate || null,
              active,
              imported_at: importedAt,
            })
            .eq("id", clientPackageId)
            .eq("studio_id", studioId);
          if (updatePackageError) throw new Error(updatePackageError.message);

          const { error: deleteItemsError } = await supabase
            .from("client_package_items")
            .delete()
            .eq("studio_id", studioId)
            .eq("client_package_id", clientPackageId);
          if (deleteItemsError) throw new Error(deleteItemsError.message);
          updatedRows += group.rows.length;
        }

        const packageItems = group.items.map((item) => {
          const used =
            item.isUnlimited ||
            item.quantityTotal === null ||
            item.quantityRemaining === null
              ? 0
              : item.quantityTotal - item.quantityRemaining;

          if (!item.isUnlimited && item.quantityRemaining !== null) {
            currentBalanceUnits += item.quantityRemaining;
            historicalUsedUnits += used;
          }

          return {
            studio_id: studioId,
            client_package_id: clientPackageId,
            usage_type: item.usageType,
            quantity_total: item.isUnlimited ? null : item.quantityTotal,
            quantity_used: used,
            quantity_remaining: item.isUnlimited ? null : item.quantityRemaining,
            is_unlimited: item.isUnlimited,
          };
        });

        const { error: packageItemsError } = await supabase
          .from("client_package_items")
          .insert(packageItems);
        if (packageItemsError) throw new Error(packageItemsError.message);
        packageItemsCreated += packageItems.length;
      } catch (error) {
        failedRows += group.rows.length;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: group.firstRow,
          field_name: "client_pricing_option_id",
          error_code: "execution_failed",
          error_message:
            error instanceof Error ? error.message : "Package import failed.",
          raw_value: clientPackageExternalId,
          row_data: group.rows[0] ?? {},
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
        row_count: rows.length,
        templates_created: templatesCreated,
        templates_updated: templatesUpdated,
        package_items_created: packageItemsCreated,
        current_balance_units: currentBalanceUnits,
        historical_used_units: historicalUsedUnits,
        historical_attendance_deduction: false,
        source_specific_execution: "mindbody_packages_v1",
      },
    });

    const { error: reconciliationError } = await supabase
      .from("import_batches")
      .update({
        reconciliation_status: failedRows > 0 ? "needs_review" : "reconciled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);
    if (reconciliationError) throw new Error(reconciliationError.message);
  } catch (error) {
    redirectImportError(
      `/app/settings/import/${batchId}`,
      "execution_failed",
      error,
    );
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}



type WellnessLivingMembershipCandidate = {
  planExternalId: string;
  clientMembershipExternalId: string;
  periodExternalId: string;
  clientExternalId: string;
  name: string;
  status: "active" | "paused" | "cancelled" | "expired" | "pending" | "past_due" | "unpaid";
  billingInterval: "monthly" | "quarterly" | "yearly" | "";
  price: number;
  startsOn: string;
  periodStart: string;
  periodEnd: string;
  amountDue: number;
  amountPaid: number;
  paymentStatus: "due" | "paid" | "partial" | "past_due" | "waived" | "void";
  autoRenew: boolean;
  includedPrivateLessons: number | null;
  includedGroupClasses: number | null;
};

function normalizeWellnessLivingMembershipStatus(value: string): WellnessLivingMembershipCandidate["status"] {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["active", "paused", "cancelled", "expired", "pending", "past_due", "unpaid"].includes(normalized)) {
    return normalized as WellnessLivingMembershipCandidate["status"];
  }
  if (normalized === "canceled") return "cancelled";
  return "pending";
}

function normalizeWellnessLivingBillingInterval(
  value: string,
): WellnessLivingMembershipCandidate["billingInterval"] {
  const normalized = value.trim().toLowerCase();
  if (["monthly", "month"].includes(normalized)) return "monthly";
  if (["quarterly", "quarter", "3_months", "three_months"].includes(normalized)) return "quarterly";
  if (["yearly", "annual", "annually", "year"].includes(normalized)) return "yearly";
  return "";
}

function normalizeWellnessLivingPaymentStatus(
  value: string,
  amountDue: number,
  amountPaid: number,
): WellnessLivingMembershipCandidate["paymentStatus"] {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["due", "paid", "partial", "past_due", "waived", "void"].includes(normalized)) {
    return normalized as WellnessLivingMembershipCandidate["paymentStatus"];
  }
  if (amountPaid >= amountDue && amountDue > 0) return "paid";
  if (amountPaid > 0 && amountPaid < amountDue) return "partial";
  return "due";
}

function parseWellnessLivingBoolean(value: string) {
  return ["1", "true", "yes", "y", "active", "enabled"].includes(
    value.trim().toLowerCase(),
  );
}

function parseWellnessLivingCount(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function buildWellnessLivingMembershipCandidate(
  row: Record<string, string>,
): WellnessLivingMembershipCandidate {
  const amountDueRaw = parseMoney(
    getRowValue(row, ["amount_due", "period_amount_due", "balance_due", "price"]),
  );
  const amountPaidRaw = parseMoney(
    getRowValue(row, ["amount_paid", "period_amount_paid", "paid_amount"]),
  );
  const amountDue =
    Number.isFinite(amountDueRaw) && amountDueRaw >= 0 ? amountDueRaw : 0;
  const amountPaid =
    Number.isFinite(amountPaidRaw) && amountPaidRaw >= 0 ? amountPaidRaw : 0;
  const paymentStatus = normalizeWellnessLivingPaymentStatus(
    getRowValue(row, ["payment_status", "billing_status", "period_status"]),
    amountDue,
    amountPaid,
  );

  const priceRaw = parseMoney(
    getRowValue(row, ["price", "membership_price", "amount"]),
  );

  return {
    planExternalId: getRowValue(row, [
      "pricing_option_id",
      "membership_plan_id",
      "plan_id",
      "pricing_id",
    ]),
    clientMembershipExternalId: getRowValue(row, [
      "client_membership_id",
      "membership_id",
      "client_pricing_option_id",
      "subscription_id",
    ]),
    periodExternalId: getRowValue(row, [
      "billing_period_id",
      "period_id",
      "membership_period_id",
      "invoice_id",
    ]),
    clientExternalId: getRowValue(row, [
      "client_id",
      "customer_id",
      "member_id",
    ]),
    name: getRowValue(row, [
      "membership_name",
      "pricing_option_name",
      "plan_name",
      "name",
    ]),
    status: normalizeWellnessLivingMembershipStatus(
      getRowValue(row, ["status", "membership_status"]),
    ),
    billingInterval: normalizeWellnessLivingBillingInterval(
      getRowValue(row, ["billing_interval", "interval", "billing_frequency"]),
    ),
    price: Number.isFinite(priceRaw) && priceRaw >= 0 ? priceRaw : 0,
    startsOn: getRowValue(row, [
      "start_date",
      "starts_on",
      "membership_start",
    ]),
    periodStart: getRowValue(row, [
      "period_start",
      "current_period_start",
      "billing_period_start",
    ]),
    periodEnd: getRowValue(row, [
      "period_end",
      "current_period_end",
      "billing_period_end",
    ]),
    amountDue,
    amountPaid,
    paymentStatus,
    autoRenew: parseWellnessLivingBoolean(
      getRowValue(row, ["auto_renew", "autopay", "renewal_enabled"]),
    ),
    includedPrivateLessons: parseWellnessLivingCount(
      getRowValue(row, [
        "included_private_lessons",
        "private_lessons_included",
        "private_lesson_quantity",
      ]),
    ),
    includedGroupClasses: parseWellnessLivingCount(
      getRowValue(row, [
        "included_group_classes",
        "group_classes_included",
        "group_class_quantity",
      ]),
    ),
  };
}

function isValidWellnessLivingMembershipDate(value: string) {
  if (!value) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.getTime());
}

export async function validateWellnessLivingMembershipImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "wellnessliving" ||
      batch.import_type !== "memberships"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect("/app/settings/import?error=file_not_found");
    }

    await clearBatchErrors({ supabase, batchId });

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const candidates = rows.map(buildWellnessLivingMembershipCandidate);
    const batchErrors: BatchErrorInsert[] = [];

    const clientExternalIds = Array.from(
      new Set(candidates.map((row) => row.clientExternalId).filter(Boolean)),
    );
    const membershipExternalIds = Array.from(
      new Set(
        candidates.map((row) => row.clientMembershipExternalId).filter(Boolean),
      ),
    );
    const planExternalIds = Array.from(
      new Set(candidates.map((row) => row.planExternalId).filter(Boolean)),
    );
    const periodExternalIds = Array.from(
      new Set(candidates.map((row) => row.periodExternalId).filter(Boolean)),
    );

    let clientIds = new Set<string>();
    let membershipIds = new Set<string>();
    let planIds = new Set<string>();
    let periodIds = new Set<string>();

    if (clientExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("clients")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "wellnessliving")
        .in("source_external_id", clientExternalIds);
      if (error) throw new Error(error.message);
      clientIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    if (membershipExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("client_memberships")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "wellnessliving")
        .in("source_external_id", membershipExternalIds);
      if (error) throw new Error(error.message);
      membershipIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    if (planExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("membership_plans")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "wellnessliving")
        .in("source_external_id", planExternalIds);
      if (error) throw new Error(error.message);
      planIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    if (periodExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("client_membership_periods")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "wellnessliving")
        .in("source_external_id", periodExternalIds);
      if (error) throw new Error(error.message);
      periodIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    const seenMemberships = new Set<string>();
    const seenPeriods = new Set<string>();
    let readyRows = 0;
    let createCandidates = 0;
    let updateCandidates = 0;
    let createPlanCandidates = 0;
    let createPeriodCandidates = 0;
    let updatePeriodCandidates = 0;
    let paidPeriods = 0;
    let partialPeriods = 0;
    let pastDuePeriods = 0;
    let futureBillingSetupRequired = 0;

    rows.forEach((row, index) => {
      const candidate = candidates[index];
      const rowNumber = index + 2;
      let blocked = false;

      const addBlocking = (
        fieldName: string,
        errorCode: string,
        errorMessage: string,
        rawValue: string | null = null,
      ) => {
        blocked = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: fieldName,
          error_code: errorCode,
          error_message: errorMessage,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.clientExternalId) {
        addBlocking("client_id", "missing_required_field", "WellnessLiving client ID is required.");
      } else if (!clientIds.has(candidate.clientExternalId)) {
        addBlocking(
          "client_id",
          "missing_related_record",
          "Import the WellnessLiving client before importing memberships.",
          candidate.clientExternalId,
        );
      }

      if (!candidate.planExternalId) {
        addBlocking(
          "pricing_option_id",
          "missing_required_field",
          "WellnessLiving pricing option ID is required.",
        );
      }

      if (!candidate.clientMembershipExternalId) {
        addBlocking(
          "client_membership_id",
          "missing_required_field",
          "WellnessLiving client membership ID is required.",
        );
      } else if (seenMemberships.has(candidate.clientMembershipExternalId)) {
        addBlocking(
          "client_membership_id",
          "duplicate_source_identity",
          "The same client membership appears more than once in the CSV.",
          candidate.clientMembershipExternalId,
        );
      } else {
        seenMemberships.add(candidate.clientMembershipExternalId);
      }

      if (!candidate.periodExternalId) {
        addBlocking(
          "billing_period_id",
          "missing_required_field",
          "WellnessLiving billing period ID is required.",
        );
      } else if (seenPeriods.has(candidate.periodExternalId)) {
        addBlocking(
          "billing_period_id",
          "duplicate_source_identity",
          "The same billing period appears more than once in the CSV.",
          candidate.periodExternalId,
        );
      } else {
        seenPeriods.add(candidate.periodExternalId);
      }

      if (!candidate.name) {
        addBlocking(
          "membership_name",
          "missing_required_field",
          "Membership name is required.",
        );
      }

      if (!candidate.billingInterval) {
        addBlocking(
          "billing_interval",
          "invalid_amount",
          "Billing interval must be monthly, quarterly, or yearly.",
          getRowValue(row, ["billing_interval", "interval", "billing_frequency"]),
        );
      }

      if (!isValidWellnessLivingMembershipDate(candidate.startsOn)) {
        addBlocking(
          "start_date",
          "invalid_datetime",
          "Membership start date must use YYYY-MM-DD.",
          candidate.startsOn,
        );
      }

      if (!isValidWellnessLivingMembershipDate(candidate.periodStart)) {
        addBlocking(
          "period_start",
          "invalid_datetime",
          "Billing period start must use YYYY-MM-DD.",
          candidate.periodStart,
        );
      }

      if (!isValidWellnessLivingMembershipDate(candidate.periodEnd)) {
        addBlocking(
          "period_end",
          "invalid_datetime",
          "Billing period end must use YYYY-MM-DD.",
          candidate.periodEnd,
        );
      }

      if (
        candidate.periodStart &&
        candidate.periodEnd &&
        candidate.periodEnd < candidate.periodStart
      ) {
        addBlocking(
          "period_end",
          "invalid_datetime",
          "Billing period end cannot be before its start.",
          candidate.periodEnd,
        );
      }

      if (candidate.amountPaid > candidate.amountDue && candidate.paymentStatus !== "waived") {
        addBlocking(
          "amount_paid",
          "invalid_amount",
          "Amount paid cannot exceed amount due.",
          String(candidate.amountPaid),
        );
      }

      if (candidate.autoRenew) {
        futureBillingSetupRequired += 1;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "auto_renew",
          error_code: "external_billing_setup_required",
          error_message:
            "WellnessLiving AutoPay credentials are not imported. The studio must intentionally set up future DanceFlow billing.",
          raw_value: "true",
          row_data: row,
        });
      }

      if (!blocked) {
        readyRows += 1;
        if (membershipIds.has(candidate.clientMembershipExternalId)) {
          updateCandidates += 1;
        } else {
          createCandidates += 1;
        }
        if (!planIds.has(candidate.planExternalId)) {
          createPlanCandidates += 1;
          planIds.add(candidate.planExternalId);
        }
        if (periodIds.has(candidate.periodExternalId)) {
          updatePeriodCandidates += 1;
        } else {
          createPeriodCandidates += 1;
        }
        if (candidate.paymentStatus === "paid") paidPeriods += 1;
        if (candidate.paymentStatus === "partial") partialPeriods += 1;
        if (candidate.paymentStatus === "past_due") pastDuePeriods += 1;
      }
    });

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
        create_plan_candidates: createPlanCandidates,
        create_period_candidates: createPeriodCandidates,
        update_period_candidates: updatePeriodCandidates,
        ready_rows: readyRows,
        paid_periods: paidPeriods,
        partial_periods: partialPeriods,
        past_due_periods: pastDuePeriods,
        future_billing_setup_required: futureBillingSetupRequired,
        autopay_credentials_imported: false,
        source_specific_validation: "wellnessliving_memberships_v1",
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
  }

  redirect("/app/settings/import?success=validated");
}

export async function executeWellnessLivingMembershipImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "wellnessliving" ||
      batch.import_type !== "memberships"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }
    if (
      batch.mode === "dry_run" ||
      !["validated", "completed_with_warnings"].includes(batch.status)
    ) {
      redirect(`/app/settings/import/${batchId}?error=batch_not_ready`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const { data: errors, error: errorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);
    if (errorsError) throw new Error(errorsError.message);

    const blockedRows = new Set(
      (errors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((value): value is number => typeof value === "number"),
    );

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const executionErrors: BatchErrorInsert[] = [];
    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = blockedRows.size;
    let failedRows = 0;
    let plansCreated = 0;
    let plansUpdated = 0;
    let periodsCreated = 0;
    let periodsUpdated = 0;
    let benefitRowsCreated = 0;
    let futureBillingSetupRequired = 0;
    const importedAt = new Date().toISOString();

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      if (blockedRows.has(rowNumber)) continue;

      const candidate = buildWellnessLivingMembershipCandidate(row);

      try {
        const { data: client, error: clientError } = await supabase
          .from("clients")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "wellnessliving")
          .eq("source_external_id", candidate.clientExternalId)
          .single();
        if (clientError || !client) {
          throw new Error(clientError?.message ?? "Client could not be resolved.");
        }

        const { data: existingPlan, error: planLookupError } = await supabase
          .from("membership_plans")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "wellnessliving")
          .eq("source_external_id", candidate.planExternalId)
          .maybeSingle();
        if (planLookupError) throw new Error(planLookupError.message);

        let planId = existingPlan?.id ?? null;

        if (!planId) {
          const { data: insertedPlan, error: insertPlanError } = await supabase
            .from("membership_plans")
            .insert({
              studio_id: studioId,
              name: candidate.name,
              description: "Imported from WellnessLiving.",
              active: true,
              billing_interval: candidate.billingInterval,
              price: candidate.price,
              signup_fee: 0,
              auto_renew_default: false,
              visibility: "private",
              sort_order: 0,
              source_system: "wellnessliving",
              source_external_id: candidate.planExternalId,
              imported_at: importedAt,
            })
            .select("id")
            .single();
          if (insertPlanError || !insertedPlan) {
            throw new Error(insertPlanError?.message ?? "Membership plan insert failed.");
          }
          planId = insertedPlan.id;
          plansCreated += 1;
        } else if (batch.mode === "create_or_update") {
          const { error: updatePlanError } = await supabase
            .from("membership_plans")
            .update({
              name: candidate.name,
              active: true,
              billing_interval: candidate.billingInterval,
              price: candidate.price,
              auto_renew_default: false,
              imported_at: importedAt,
            })
            .eq("id", planId)
            .eq("studio_id", studioId);
          if (updatePlanError) throw new Error(updatePlanError.message);
          plansUpdated += 1;
        }

        if (!existingPlan || batch.mode === "create_or_update") {
          const { error: deleteBenefitsError } = await supabase
            .from("membership_plan_benefits")
            .delete()
            .eq("membership_plan_id", planId);
          if (deleteBenefitsError) throw new Error(deleteBenefitsError.message);

          const benefitRows = [];
          if (
            candidate.includedPrivateLessons !== null &&
            candidate.includedPrivateLessons > 0
          ) {
            benefitRows.push({
              membership_plan_id: planId,
              benefit_type: "included_private_lessons",
              quantity: candidate.includedPrivateLessons,
              discount_percent: null,
              discount_amount: null,
              usage_period: "billing_cycle",
              applies_to: null,
              sort_order: 0,
            });
          }
          if (
            candidate.includedGroupClasses !== null &&
            candidate.includedGroupClasses > 0
          ) {
            benefitRows.push({
              membership_plan_id: planId,
              benefit_type: "included_group_classes",
              quantity: candidate.includedGroupClasses,
              discount_percent: null,
              discount_amount: null,
              usage_period: "billing_cycle",
              applies_to: null,
              sort_order: 1,
            });
          }

          if (benefitRows.length > 0) {
            const { error: benefitsError } = await supabase
              .from("membership_plan_benefits")
              .insert(benefitRows);
            if (benefitsError) throw new Error(benefitsError.message);
            benefitRowsCreated += benefitRows.length;
          }
        }

        const { data: existingMembership, error: membershipLookupError } =
          await supabase
            .from("client_memberships")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", "wellnessliving")
            .eq("source_external_id", candidate.clientMembershipExternalId)
            .maybeSingle();
        if (membershipLookupError) throw new Error(membershipLookupError.message);

        let membershipId = existingMembership?.id ?? null;

        if (membershipId && batch.mode === "create_only") {
          skippedRows += 1;
          continue;
        }

        const membershipPayload = {
          client_id: client.id,
          membership_plan_id: planId,
          status: candidate.status,
          starts_on: candidate.startsOn,
          ends_on:
            ["cancelled", "expired"].includes(candidate.status)
              ? candidate.periodEnd
              : null,
          current_period_start: candidate.periodStart,
          current_period_end: candidate.periodEnd,
          auto_renew: false,
          cancel_at_period_end:
            candidate.status === "cancelled" || candidate.status === "expired",
          name_snapshot: candidate.name,
          price_snapshot: candidate.price,
          billing_interval_snapshot: candidate.billingInterval,
          imported_at: importedAt,
        };

        if (!membershipId) {
          const { data: insertedMembership, error: insertMembershipError } =
            await supabase
              .from("client_memberships")
              .insert({
                studio_id: studioId,
                ...membershipPayload,
                source_system: "wellnessliving",
                source_external_id: candidate.clientMembershipExternalId,
              })
              .select("id")
              .single();
          if (insertMembershipError || !insertedMembership) {
            throw new Error(
              insertMembershipError?.message ?? "Client membership insert failed.",
            );
          }
          membershipId = insertedMembership.id;
          insertedRows += 1;
        } else {
          const { error: updateMembershipError } = await supabase
            .from("client_memberships")
            .update(membershipPayload)
            .eq("id", membershipId)
            .eq("studio_id", studioId);
          if (updateMembershipError) throw new Error(updateMembershipError.message);
          updatedRows += 1;
        }

        const periodPayload = {
          studio_id: studioId,
          client_id: client.id,
          client_membership_id: membershipId,
          period_start: candidate.periodStart,
          period_end: candidate.periodEnd,
          amount_due: candidate.amountDue,
          amount_paid: candidate.amountPaid,
          currency: "usd",
          payment_status: candidate.paymentStatus,
          payment_due_at: `${candidate.periodStart}T12:00:00.000Z`,
          paid_at:
            candidate.paymentStatus === "paid"
              ? `${candidate.periodStart}T12:00:00.000Z`
              : null,
          source_system: "wellnessliving",
          source_external_id: candidate.periodExternalId,
          imported_at: importedAt,
        };

        const { data: existingPeriod, error: periodLookupError } = await supabase
          .from("client_membership_periods")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "wellnessliving")
          .eq("source_external_id", candidate.periodExternalId)
          .maybeSingle();
        if (periodLookupError) throw new Error(periodLookupError.message);

        if (!existingPeriod) {
          const { error: insertPeriodError } = await supabase
            .from("client_membership_periods")
            .insert(periodPayload);
          if (insertPeriodError) throw new Error(insertPeriodError.message);
          periodsCreated += 1;
        } else if (batch.mode === "create_or_update") {
          const { error: updatePeriodError } = await supabase
            .from("client_membership_periods")
            .update(periodPayload)
            .eq("id", existingPeriod.id)
            .eq("studio_id", studioId);
          if (updatePeriodError) throw new Error(updatePeriodError.message);
          periodsUpdated += 1;
        }

        if (candidate.autoRenew) {
          futureBillingSetupRequired += 1;
        }
      } catch (error) {
        failedRows += 1;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "client_membership_id",
          error_code: "execution_failed",
          error_message:
            error instanceof Error ? error.message : "Membership import failed.",
          raw_value: candidate.clientMembershipExternalId,
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
        row_count: rows.length,
        plans_created: plansCreated,
        plans_updated: plansUpdated,
        periods_created: periodsCreated,
        periods_updated: periodsUpdated,
        benefit_rows_created: benefitRowsCreated,
        future_billing_setup_required: futureBillingSetupRequired,
        autopay_credentials_imported: false,
        recurring_billing_recreated: false,
        source_specific_execution: "wellnessliving_memberships_v1",
      },
    });

    const { error: reconciliationError } = await supabase
      .from("import_batches")
      .update({
        reconciliation_status: failedRows > 0 ? "needs_review" : "reconciled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);
    if (reconciliationError) throw new Error(reconciliationError.message);
  } catch (error) {
    redirectImportError(
      `/app/settings/import/${batchId}`,
      "execution_failed",
      error,
    );
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}


type MindbodyMembershipCandidate = {
  planExternalId: string;
  clientMembershipExternalId: string;
  periodExternalId: string;
  clientExternalId: string;
  name: string;
  status: "active" | "paused" | "frozen" | "cancelled" | "expired" | "pending" | "past_due" | "unpaid";
  billingInterval: "monthly" | "quarterly" | "yearly" | "";
  price: number;
  startsOn: string;
  periodStart: string;
  periodEnd: string;
  amountDue: number;
  amountPaid: number;
  paymentStatus: "due" | "paid" | "partial" | "past_due" | "waived" | "void";
  autoRenew: boolean;
  includedPrivateLessons: number | null;
  includedGroupClasses: number | null;
};

function normalizeMindbodyMembershipStatus(value: string): MindbodyMembershipCandidate["status"] {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["active", "paused", "frozen", "cancelled", "expired", "pending", "past_due", "unpaid"].includes(normalized)) {
    return normalized as MindbodyMembershipCandidate["status"];
  }
  if (normalized === "canceled") return "cancelled";
  return "pending";
}

function normalizeMindbodyBillingInterval(
  value: string,
): MindbodyMembershipCandidate["billingInterval"] {
  const normalized = value.trim().toLowerCase();
  if (["monthly", "month"].includes(normalized)) return "monthly";
  if (["quarterly", "quarter", "3_months", "three_months"].includes(normalized)) return "quarterly";
  if (["yearly", "annual", "annually", "year"].includes(normalized)) return "yearly";
  return "";
}

function normalizeMindbodyPaymentStatus(
  value: string,
  amountDue: number,
  amountPaid: number,
): MindbodyMembershipCandidate["paymentStatus"] {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["due", "paid", "partial", "past_due", "waived", "void"].includes(normalized)) {
    return normalized as MindbodyMembershipCandidate["paymentStatus"];
  }
  if (amountPaid >= amountDue && amountDue > 0) return "paid";
  if (amountPaid > 0 && amountPaid < amountDue) return "partial";
  return "due";
}

function parseMindbodyBoolean(value: string) {
  return ["1", "true", "yes", "y", "active", "enabled"].includes(
    value.trim().toLowerCase(),
  );
}

function parseMindbodyCount(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function buildMindbodyMembershipCandidate(
  row: Record<string, string>,
): MindbodyMembershipCandidate {
  const amountDueRaw = parseMoney(
    getRowValue(row, ["amount_due", "period_amount_due", "balance_due", "price"]),
  );
  const amountPaidRaw = parseMoney(
    getRowValue(row, ["amount_paid", "period_amount_paid", "paid_amount"]),
  );
  const amountDue =
    Number.isFinite(amountDueRaw) && amountDueRaw >= 0 ? amountDueRaw : 0;
  const amountPaid =
    Number.isFinite(amountPaidRaw) && amountPaidRaw >= 0 ? amountPaidRaw : 0;
  const paymentStatus = normalizeMindbodyPaymentStatus(
    getRowValue(row, ["payment_status", "billing_status", "period_status"]),
    amountDue,
    amountPaid,
  );

  const priceRaw = parseMoney(
    getRowValue(row, ["price", "membership_price", "recurring_amount", "amount"]),
  );

  return {
    planExternalId: getRowValue(row, [
      "pricing_option_id",
      "contract_template_id",
      "membership_plan_id",
      "plan_id",
      "pricing_id",
    ]),
    clientMembershipExternalId: getRowValue(row, [
      "client_membership_id",
      "client_contract_id",
      "membership_id",
      "client_pricing_option_id",
      "subscription_id",
    ]),
    periodExternalId: getRowValue(row, [
      "billing_period_id",
      "autopay_schedule_id",
      "period_id",
      "membership_period_id",
      "invoice_id",
    ]),
    clientExternalId: getRowValue(row, [
      "client_id",
      "customer_id",
      "member_id",
    ]),
    name: getRowValue(row, [
      "membership_name",
      "contract_name",
      "autopay_name",
      "pricing_option_name",
      "plan_name",
      "name",
    ]),
    status: normalizeMindbodyMembershipStatus(
      getRowValue(row, ["status", "membership_status", "contract_status"]),
    ),
    billingInterval: normalizeMindbodyBillingInterval(
      getRowValue(row, ["billing_interval", "interval", "billing_frequency", "autopay_frequency"]),
    ),
    price: Number.isFinite(priceRaw) && priceRaw >= 0 ? priceRaw : 0,
    startsOn: getRowValue(row, [
      "start_date",
      "contract_start_date",
      "starts_on",
      "membership_start",
    ]),
    periodStart: getRowValue(row, [
      "period_start",
      "autopay_period_start",
      "current_period_start",
      "billing_period_start",
    ]),
    periodEnd: getRowValue(row, [
      "period_end",
      "autopay_period_end",
      "current_period_end",
      "billing_period_end",
    ]),
    amountDue,
    amountPaid,
    paymentStatus,
    autoRenew: parseMindbodyBoolean(
      getRowValue(row, ["auto_renew", "autopay", "autopay_active", "renewal_enabled"]),
    ),
    includedPrivateLessons: parseMindbodyCount(
      getRowValue(row, [
        "included_private_lessons",
        "private_lessons_included",
        "private_lesson_quantity",
      ]),
    ),
    includedGroupClasses: parseMindbodyCount(
      getRowValue(row, [
        "included_group_classes",
        "group_classes_included",
        "group_class_quantity",
      ]),
    ),
  };
}

function isValidMindbodyMembershipDate(value: string) {
  if (!value) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.getTime());
}

export async function validateMindbodyMembershipImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "mindbody" ||
      batch.import_type !== "memberships"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect("/app/settings/import?error=file_not_found");
    }

    await clearBatchErrors({ supabase, batchId });

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const candidates = rows.map(buildMindbodyMembershipCandidate);
    const batchErrors: BatchErrorInsert[] = [];

    const clientExternalIds = Array.from(
      new Set(candidates.map((row) => row.clientExternalId).filter(Boolean)),
    );
    const membershipExternalIds = Array.from(
      new Set(
        candidates.map((row) => row.clientMembershipExternalId).filter(Boolean),
      ),
    );
    const planExternalIds = Array.from(
      new Set(candidates.map((row) => row.planExternalId).filter(Boolean)),
    );
    const periodExternalIds = Array.from(
      new Set(candidates.map((row) => row.periodExternalId).filter(Boolean)),
    );

    let clientIds = new Set<string>();
    let membershipIds = new Set<string>();
    let planIds = new Set<string>();
    let periodIds = new Set<string>();

    if (clientExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("clients")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "mindbody")
        .in("source_external_id", clientExternalIds);
      if (error) throw new Error(error.message);
      clientIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    if (membershipExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("client_memberships")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "mindbody")
        .in("source_external_id", membershipExternalIds);
      if (error) throw new Error(error.message);
      membershipIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    if (planExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("membership_plans")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "mindbody")
        .in("source_external_id", planExternalIds);
      if (error) throw new Error(error.message);
      planIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    if (periodExternalIds.length > 0) {
      const { data, error } = await supabase
        .from("client_membership_periods")
        .select("source_external_id")
        .eq("studio_id", studioId)
        .eq("source_system", "mindbody")
        .in("source_external_id", periodExternalIds);
      if (error) throw new Error(error.message);
      periodIds = new Set(
        (data ?? [])
          .map((row) => row.source_external_id)
          .filter((value): value is string => Boolean(value)),
      );
    }

    const seenMemberships = new Set<string>();
    const seenPeriods = new Set<string>();
    let readyRows = 0;
    let createCandidates = 0;
    let updateCandidates = 0;
    let createPlanCandidates = 0;
    let createPeriodCandidates = 0;
    let updatePeriodCandidates = 0;
    let paidPeriods = 0;
    let partialPeriods = 0;
    let pastDuePeriods = 0;
    let futureBillingSetupRequired = 0;

    rows.forEach((row, index) => {
      const candidate = candidates[index];
      const rowNumber = index + 2;
      let blocked = false;

      const addBlocking = (
        fieldName: string,
        errorCode: string,
        errorMessage: string,
        rawValue: string | null = null,
      ) => {
        blocked = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: fieldName,
          error_code: errorCode,
          error_message: errorMessage,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.clientExternalId) {
        addBlocking("client_id", "missing_required_field", "Mindbody client ID is required.");
      } else if (!clientIds.has(candidate.clientExternalId)) {
        addBlocking(
          "client_id",
          "missing_related_record",
          "Import the Mindbody client before importing memberships.",
          candidate.clientExternalId,
        );
      }

      if (!candidate.planExternalId) {
        addBlocking(
          "pricing_option_id",
          "missing_required_field",
          "Mindbody pricing option ID is required.",
        );
      }

      if (!candidate.clientMembershipExternalId) {
        addBlocking(
          "client_membership_id",
          "missing_required_field",
          "Mindbody client membership ID is required.",
        );
      } else if (seenMemberships.has(candidate.clientMembershipExternalId)) {
        addBlocking(
          "client_membership_id",
          "duplicate_source_identity",
          "The same client membership appears more than once in the CSV.",
          candidate.clientMembershipExternalId,
        );
      } else {
        seenMemberships.add(candidate.clientMembershipExternalId);
      }

      if (!candidate.periodExternalId) {
        addBlocking(
          "billing_period_id",
          "missing_required_field",
          "Mindbody billing period ID is required.",
        );
      } else if (seenPeriods.has(candidate.periodExternalId)) {
        addBlocking(
          "billing_period_id",
          "duplicate_source_identity",
          "The same billing period appears more than once in the CSV.",
          candidate.periodExternalId,
        );
      } else {
        seenPeriods.add(candidate.periodExternalId);
      }

      if (!candidate.name) {
        addBlocking(
          "membership_name",
          "missing_required_field",
          "Membership name is required.",
        );
      }

      if (!candidate.billingInterval) {
        addBlocking(
          "billing_interval",
          "invalid_amount",
          "Billing interval must be monthly, quarterly, or yearly.",
          getRowValue(row, ["billing_interval", "interval", "billing_frequency", "autopay_frequency"]),
        );
      }

      if (!isValidMindbodyMembershipDate(candidate.startsOn)) {
        addBlocking(
          "start_date",
          "invalid_datetime",
          "Membership start date must use YYYY-MM-DD.",
          candidate.startsOn,
        );
      }

      if (!isValidMindbodyMembershipDate(candidate.periodStart)) {
        addBlocking(
          "period_start",
          "invalid_datetime",
          "Billing period start must use YYYY-MM-DD.",
          candidate.periodStart,
        );
      }

      if (!isValidMindbodyMembershipDate(candidate.periodEnd)) {
        addBlocking(
          "period_end",
          "invalid_datetime",
          "Billing period end must use YYYY-MM-DD.",
          candidate.periodEnd,
        );
      }

      if (
        candidate.periodStart &&
        candidate.periodEnd &&
        candidate.periodEnd < candidate.periodStart
      ) {
        addBlocking(
          "period_end",
          "invalid_datetime",
          "Billing period end cannot be before its start.",
          candidate.periodEnd,
        );
      }

      if (candidate.amountPaid > candidate.amountDue && candidate.paymentStatus !== "waived") {
        addBlocking(
          "amount_paid",
          "invalid_amount",
          "Amount paid cannot exceed amount due.",
          String(candidate.amountPaid),
        );
      }

      if (candidate.autoRenew) {
        futureBillingSetupRequired += 1;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "auto_renew",
          error_code: "external_billing_setup_required",
          error_message:
            "Mindbody AutoPay credentials are not imported. The studio must intentionally set up future DanceFlow billing.",
          raw_value: "true",
          row_data: row,
        });
      }

      if (!blocked) {
        readyRows += 1;
        if (membershipIds.has(candidate.clientMembershipExternalId)) {
          updateCandidates += 1;
        } else {
          createCandidates += 1;
        }
        if (!planIds.has(candidate.planExternalId)) {
          createPlanCandidates += 1;
          planIds.add(candidate.planExternalId);
        }
        if (periodIds.has(candidate.periodExternalId)) {
          updatePeriodCandidates += 1;
        } else {
          createPeriodCandidates += 1;
        }
        if (candidate.paymentStatus === "paid") paidPeriods += 1;
        if (candidate.paymentStatus === "partial") partialPeriods += 1;
        if (candidate.paymentStatus === "past_due") pastDuePeriods += 1;
      }
    });

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
        create_plan_candidates: createPlanCandidates,
        create_period_candidates: createPeriodCandidates,
        update_period_candidates: updatePeriodCandidates,
        ready_rows: readyRows,
        paid_periods: paidPeriods,
        partial_periods: partialPeriods,
        past_due_periods: pastDuePeriods,
        future_billing_setup_required: futureBillingSetupRequired,
        autopay_credentials_imported: false,
        source_specific_validation: "mindbody_memberships_v1",
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
  }

  redirect("/app/settings/import?success=validated");
}

export async function executeMindbodyMembershipImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "mindbody" ||
      batch.import_type !== "memberships"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }
    if (
      batch.mode === "dry_run" ||
      !["validated", "completed_with_warnings"].includes(batch.status)
    ) {
      redirect(`/app/settings/import/${batchId}?error=batch_not_ready`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const { data: errors, error: errorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);
    if (errorsError) throw new Error(errorsError.message);

    const blockedRows = new Set(
      (errors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((value): value is number => typeof value === "number"),
    );

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const executionErrors: BatchErrorInsert[] = [];
    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = blockedRows.size;
    let failedRows = 0;
    let plansCreated = 0;
    let plansUpdated = 0;
    let periodsCreated = 0;
    let periodsUpdated = 0;
    let benefitRowsCreated = 0;
    let futureBillingSetupRequired = 0;
    const importedAt = new Date().toISOString();

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      if (blockedRows.has(rowNumber)) continue;

      const candidate = buildMindbodyMembershipCandidate(row);

      try {
        const { data: client, error: clientError } = await supabase
          .from("clients")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "mindbody")
          .eq("source_external_id", candidate.clientExternalId)
          .single();
        if (clientError || !client) {
          throw new Error(clientError?.message ?? "Client could not be resolved.");
        }

        const { data: existingPlan, error: planLookupError } = await supabase
          .from("membership_plans")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "mindbody")
          .eq("source_external_id", candidate.planExternalId)
          .maybeSingle();
        if (planLookupError) throw new Error(planLookupError.message);

        let planId = existingPlan?.id ?? null;

        if (!planId) {
          const { data: insertedPlan, error: insertPlanError } = await supabase
            .from("membership_plans")
            .insert({
              studio_id: studioId,
              name: candidate.name,
              description: "Imported from Mindbody.",
              active: true,
              billing_interval: candidate.billingInterval,
              price: candidate.price,
              signup_fee: 0,
              auto_renew_default: false,
              visibility: "private",
              sort_order: 0,
              source_system: "mindbody",
              source_external_id: candidate.planExternalId,
              imported_at: importedAt,
            })
            .select("id")
            .single();
          if (insertPlanError || !insertedPlan) {
            throw new Error(insertPlanError?.message ?? "Membership plan insert failed.");
          }
          planId = insertedPlan.id;
          plansCreated += 1;
        } else if (batch.mode === "create_or_update") {
          const { error: updatePlanError } = await supabase
            .from("membership_plans")
            .update({
              name: candidate.name,
              active: true,
              billing_interval: candidate.billingInterval,
              price: candidate.price,
              auto_renew_default: false,
              imported_at: importedAt,
            })
            .eq("id", planId)
            .eq("studio_id", studioId);
          if (updatePlanError) throw new Error(updatePlanError.message);
          plansUpdated += 1;
        }

        if (!existingPlan || batch.mode === "create_or_update") {
          const { error: deleteBenefitsError } = await supabase
            .from("membership_plan_benefits")
            .delete()
            .eq("membership_plan_id", planId);
          if (deleteBenefitsError) throw new Error(deleteBenefitsError.message);

          const benefitRows = [];
          if (
            candidate.includedPrivateLessons !== null &&
            candidate.includedPrivateLessons > 0
          ) {
            benefitRows.push({
              membership_plan_id: planId,
              benefit_type: "included_private_lessons",
              quantity: candidate.includedPrivateLessons,
              discount_percent: null,
              discount_amount: null,
              usage_period: "billing_cycle",
              applies_to: null,
              sort_order: 0,
            });
          }
          if (
            candidate.includedGroupClasses !== null &&
            candidate.includedGroupClasses > 0
          ) {
            benefitRows.push({
              membership_plan_id: planId,
              benefit_type: "included_group_classes",
              quantity: candidate.includedGroupClasses,
              discount_percent: null,
              discount_amount: null,
              usage_period: "billing_cycle",
              applies_to: null,
              sort_order: 1,
            });
          }

          if (benefitRows.length > 0) {
            const { error: benefitsError } = await supabase
              .from("membership_plan_benefits")
              .insert(benefitRows);
            if (benefitsError) throw new Error(benefitsError.message);
            benefitRowsCreated += benefitRows.length;
          }
        }

        const { data: existingMembership, error: membershipLookupError } =
          await supabase
            .from("client_memberships")
            .select("id")
            .eq("studio_id", studioId)
            .eq("source_system", "mindbody")
            .eq("source_external_id", candidate.clientMembershipExternalId)
            .maybeSingle();
        if (membershipLookupError) throw new Error(membershipLookupError.message);

        let membershipId = existingMembership?.id ?? null;

        if (membershipId && batch.mode === "create_only") {
          skippedRows += 1;
          continue;
        }

        const membershipPayload = {
          client_id: client.id,
          membership_plan_id: planId,
          status: candidate.status,
          starts_on: candidate.startsOn,
          ends_on:
            ["cancelled", "expired"].includes(candidate.status)
              ? candidate.periodEnd
              : null,
          current_period_start: candidate.periodStart,
          current_period_end: candidate.periodEnd,
          auto_renew: false,
          cancel_at_period_end:
            candidate.status === "cancelled" || candidate.status === "expired",
          name_snapshot: candidate.name,
          price_snapshot: candidate.price,
          billing_interval_snapshot: candidate.billingInterval,
          imported_at: importedAt,
        };

        if (!membershipId) {
          const { data: insertedMembership, error: insertMembershipError } =
            await supabase
              .from("client_memberships")
              .insert({
                studio_id: studioId,
                ...membershipPayload,
                source_system: "mindbody",
                source_external_id: candidate.clientMembershipExternalId,
              })
              .select("id")
              .single();
          if (insertMembershipError || !insertedMembership) {
            throw new Error(
              insertMembershipError?.message ?? "Client membership insert failed.",
            );
          }
          membershipId = insertedMembership.id;
          insertedRows += 1;
        } else {
          const { error: updateMembershipError } = await supabase
            .from("client_memberships")
            .update(membershipPayload)
            .eq("id", membershipId)
            .eq("studio_id", studioId);
          if (updateMembershipError) throw new Error(updateMembershipError.message);
          updatedRows += 1;
        }

        const periodPayload = {
          studio_id: studioId,
          client_id: client.id,
          client_membership_id: membershipId,
          period_start: candidate.periodStart,
          period_end: candidate.periodEnd,
          amount_due: candidate.amountDue,
          amount_paid: candidate.amountPaid,
          currency: "usd",
          payment_status: candidate.paymentStatus,
          payment_due_at: `${candidate.periodStart}T12:00:00.000Z`,
          paid_at:
            candidate.paymentStatus === "paid"
              ? `${candidate.periodStart}T12:00:00.000Z`
              : null,
          source_system: "mindbody",
          source_external_id: candidate.periodExternalId,
          imported_at: importedAt,
        };

        const { data: existingPeriod, error: periodLookupError } = await supabase
          .from("client_membership_periods")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "mindbody")
          .eq("source_external_id", candidate.periodExternalId)
          .maybeSingle();
        if (periodLookupError) throw new Error(periodLookupError.message);

        if (!existingPeriod) {
          const { error: insertPeriodError } = await supabase
            .from("client_membership_periods")
            .insert(periodPayload);
          if (insertPeriodError) throw new Error(insertPeriodError.message);
          periodsCreated += 1;
        } else if (batch.mode === "create_or_update") {
          const { error: updatePeriodError } = await supabase
            .from("client_membership_periods")
            .update(periodPayload)
            .eq("id", existingPeriod.id)
            .eq("studio_id", studioId);
          if (updatePeriodError) throw new Error(updatePeriodError.message);
          periodsUpdated += 1;
        }

        if (candidate.autoRenew) {
          futureBillingSetupRequired += 1;
        }
      } catch (error) {
        failedRows += 1;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "client_membership_id",
          error_code: "execution_failed",
          error_message:
            error instanceof Error ? error.message : "Membership import failed.",
          raw_value: candidate.clientMembershipExternalId,
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
        row_count: rows.length,
        plans_created: plansCreated,
        plans_updated: plansUpdated,
        periods_created: periodsCreated,
        periods_updated: periodsUpdated,
        benefit_rows_created: benefitRowsCreated,
        future_billing_setup_required: futureBillingSetupRequired,
        autopay_credentials_imported: false,
        recurring_billing_recreated: false,
        source_specific_execution: "mindbody_memberships_v1",
      },
    });

    const { error: reconciliationError } = await supabase
      .from("import_batches")
      .update({
        reconciliation_status: failedRows > 0 ? "needs_review" : "reconciled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);
    if (reconciliationError) throw new Error(reconciliationError.message);
  } catch (error) {
    redirectImportError(
      `/app/settings/import/${batchId}`,
      "execution_failed",
      error,
    );
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}



type WellnessLivingAttendanceCandidate = {
  appointmentExternalId: string;
  status: "attended" | "no_show" | "cancelled" | "";
  markedAt: string;
};

function buildWellnessLivingAttendanceCandidate(
  row: Record<string, string>,
): WellnessLivingAttendanceCandidate {
  const rawStatus = getRowValue(row, [
    "attendance_status",
    "visit_status",
    "status",
  ])
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  const status =
    rawStatus === "attended" || rawStatus === "completed" || rawStatus === "present"
      ? "attended"
      : rawStatus === "no_show" || rawStatus === "noshow" || rawStatus === "absent"
        ? "no_show"
        : rawStatus === "cancelled" || rawStatus === "canceled"
          ? "cancelled"
          : "";

  return {
    appointmentExternalId: getRowValue(row, [
      "appointment_id",
      "visit_id",
      "booking_id",
      "source_external_id",
    ]),
    status,
    markedAt: getRowValue(row, [
      "attendance_marked_at",
      "attended_at",
      "visit_date",
      "completed_at",
    ]),
  };
}

export async function validateWellnessLivingAttendanceImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "wellnessliving" ||
      batch.import_type !== "attendance"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect("/app/settings/import?error=file_not_found");
    }

    await clearBatchErrors({ supabase, batchId });
    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const candidates = rows.map(buildWellnessLivingAttendanceCandidate);
    const externalIds = Array.from(
      new Set(candidates.map((row) => row.appointmentExternalId).filter(Boolean)),
    );

    const { data: appointments, error: appointmentsError } = externalIds.length
      ? await supabase
          .from("appointments")
          .select("id, source_external_id, status")
          .eq("studio_id", studioId)
          .eq("source_system", "wellnessliving")
          .in("source_external_id", externalIds)
      : { data: [], error: null };

    if (appointmentsError) throw new Error(appointmentsError.message);

    const appointmentMap = new Map(
      (appointments ?? []).map((row) => [String(row.source_external_id), row]),
    );
    const seen = new Set<string>();
    const batchErrors: BatchErrorInsert[] = [];
    let readyRows = 0;
    let attendedRows = 0;
    let noShowRows = 0;
    let cancelledRows = 0;
    let alreadyMatchedRows = 0;

    rows.forEach((row, index) => {
      const candidate = candidates[index];
      const rowNumber = index + 2;
      let blocked = false;

      const addBlocking = (
        fieldName: string,
        errorCode: string,
        errorMessage: string,
        rawValue: string | null = null,
      ) => {
        blocked = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: fieldName,
          error_code: errorCode,
          error_message: errorMessage,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.appointmentExternalId) {
        addBlocking(
          "appointment_id",
          "missing_required_field",
          "WellnessLiving appointment ID is required.",
        );
      } else if (seen.has(candidate.appointmentExternalId)) {
        addBlocking(
          "appointment_id",
          "duplicate_source_identity",
          "The same appointment appears more than once in the attendance CSV.",
          candidate.appointmentExternalId,
        );
      } else {
        seen.add(candidate.appointmentExternalId);
      }

      const appointment = appointmentMap.get(candidate.appointmentExternalId);
      if (candidate.appointmentExternalId && !appointment) {
        addBlocking(
          "appointment_id",
          "missing_related_record",
          "Import the WellnessLiving appointment before importing attendance.",
          candidate.appointmentExternalId,
        );
      }

      if (!candidate.status) {
        addBlocking(
          "attendance_status",
          "missing_required_field",
          "Attendance status must be attended, no_show, or cancelled.",
          getRowValue(row, ["attendance_status", "visit_status", "status"]),
        );
      }

      if (candidate.markedAt && Number.isNaN(Date.parse(candidate.markedAt))) {
        addBlocking(
          "attendance_marked_at",
          "invalid_datetime",
          "Attendance timestamp is invalid.",
          candidate.markedAt,
        );
      }

      if (!blocked) {
        readyRows += 1;
        if (candidate.status === "attended") attendedRows += 1;
        if (candidate.status === "no_show") noShowRows += 1;
        if (candidate.status === "cancelled") cancelledRows += 1;
        if (appointment?.status === candidate.status) alreadyMatchedRows += 1;

        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "attendance_status",
          error_code: "historical_balance_preserved",
          error_message:
            "Historical attendance updates appointment status only. It will not deduct package or membership balances again.",
          raw_value: candidate.status,
          row_data: row,
        });
      }
    });

    await finalizeValidation({
      supabase,
      studioId,
      batchId,
      headers,
      rows,
      batchErrors,
      extraSummary: {
        create_candidates: 0,
        update_candidates: readyRows,
        ready_rows: readyRows,
        attended_rows: attendedRows,
        no_show_rows: noShowRows,
        cancelled_rows: cancelledRows,
        already_matched_rows: alreadyMatchedRows,
        usage_deduction_enabled: false,
        source_specific_validation: "wellnessliving_attendance_v1",
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
  }

  redirect("/app/settings/import?success=validated");
}

export async function executeWellnessLivingAttendanceImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "wellnessliving" ||
      batch.import_type !== "attendance"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }
    if (
      batch.mode === "dry_run" ||
      !["validated", "completed_with_warnings"].includes(batch.status)
    ) {
      redirect(`/app/settings/import/${batchId}?error=batch_not_ready`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const { data: errors, error: errorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);
    if (errorsError) throw new Error(errorsError.message);

    const blockedRows = new Set(
      (errors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((value): value is number => typeof value === "number"),
    );

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const executionErrors: BatchErrorInsert[] = [];
    let updatedRows = 0;
    let skippedRows = blockedRows.size;
    let failedRows = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const rowNumber = index + 2;
      if (blockedRows.has(rowNumber)) continue;
      const candidate = buildWellnessLivingAttendanceCandidate(rows[index]);

      try {
        const markedAt =
          candidate.markedAt && !Number.isNaN(Date.parse(candidate.markedAt))
            ? new Date(candidate.markedAt).toISOString()
            : new Date().toISOString();

        const { data: appointment, error: lookupError } = await supabase
          .from("appointments")
          .select("id, status")
          .eq("studio_id", studioId)
          .eq("source_system", "wellnessliving")
          .eq("source_external_id", candidate.appointmentExternalId)
          .single();
        if (lookupError || !appointment) {
          throw new Error(lookupError?.message ?? "Appointment could not be resolved.");
        }

        if (appointment.status === candidate.status && batch.mode === "create_only") {
          skippedRows += 1;
          continue;
        }

        const { error: updateError } = await supabase
          .from("appointments")
          .update({
            status: candidate.status,
            attendance_marked_at:
              candidate.status === "attended" || candidate.status === "no_show"
                ? markedAt
                : null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", appointment.id)
          .eq("studio_id", studioId);
        if (updateError) throw new Error(updateError.message);

        updatedRows += 1;
      } catch (error) {
        failedRows += 1;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "appointment_id",
          error_code: "execution_failed",
          error_message:
            error instanceof Error ? error.message : "Attendance import failed.",
          raw_value: candidate.appointmentExternalId,
          row_data: rows[index],
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
      insertedRows: 0,
      updatedRows,
      skippedRows,
      failedRows,
      summary: {
        headers,
        executed: true,
        row_count: rows.length,
        attendance_rows_updated: updatedRows,
        usage_deduction_enabled: false,
        package_balances_preserved: true,
        membership_entitlements_preserved: true,
        source_specific_execution: "wellnessliving_attendance_v1",
      },
    });

    const { error: reconciliationError } = await supabase
      .from("import_batches")
      .update({
        reconciliation_status: failedRows > 0 ? "needs_review" : "reconciled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);
    if (reconciliationError) throw new Error(reconciliationError.message);
  } catch (error) {
    redirectImportError(`/app/settings/import/${batchId}`, "execution_failed", error);
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}

type MindbodyAttendanceCandidate = {
  appointmentExternalId: string;
  status: "attended" | "no_show" | "cancelled" | "waitlisted" | "";
  sourceStatus: string;
  markedAt: string;
};

function buildMindbodyAttendanceCandidate(
  row: Record<string, string>,
): MindbodyAttendanceCandidate {
  const rawStatus = getRowValue(row, [
    "attendance_status",
    "visit_status",
    "status",
  ])
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  const status =
    rawStatus === "attended" || rawStatus === "completed" || rawStatus === "present"
      ? "attended"
      : rawStatus === "no_show" || rawStatus === "noshow" || rawStatus === "absent"
        ? "no_show"
        : rawStatus === "cancelled" ||
            rawStatus === "canceled" ||
            rawStatus === "late_cancel"
          ? "cancelled"
          : rawStatus === "waitlisted" || rawStatus === "waitlist"
            ? "waitlisted"
            : "";

  return {
    appointmentExternalId: getRowValue(row, [
      "appointment_id",
      "visit_id",
      "booking_id",
      "class_id",
      "enrollment_id",
      "source_external_id",
    ]),
    status,
    sourceStatus: rawStatus,
    markedAt: getRowValue(row, [
      "attendance_marked_at",
      "attended_at",
      "visit_date",
      "completed_at",
    ]),
  };
}

export async function validateMindbodyAttendanceImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "mindbody" ||
      batch.import_type !== "attendance"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect("/app/settings/import?error=file_not_found");
    }

    await clearBatchErrors({ supabase, batchId });
    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const candidates = rows.map(buildMindbodyAttendanceCandidate);
    const externalIds = Array.from(
      new Set(candidates.map((row) => row.appointmentExternalId).filter(Boolean)),
    );

    const { data: appointments, error: appointmentsError } = externalIds.length
      ? await supabase
          .from("appointments")
          .select("id, source_external_id, status")
          .eq("studio_id", studioId)
          .eq("source_system", "mindbody")
          .in("source_external_id", externalIds)
      : { data: [], error: null };

    if (appointmentsError) throw new Error(appointmentsError.message);

    const appointmentMap = new Map(
      (appointments ?? []).map((row) => [String(row.source_external_id), row]),
    );
    const seen = new Set<string>();
    const batchErrors: BatchErrorInsert[] = [];
    let readyRows = 0;
    let attendedRows = 0;
    let noShowRows = 0;
    let cancelledRows = 0;
    let lateCancelRows = 0;
    let waitlistRows = 0;
    let alreadyMatchedRows = 0;

    rows.forEach((row, index) => {
      const candidate = candidates[index];
      const rowNumber = index + 2;
      let blocked = false;

      const addBlocking = (
        fieldName: string,
        errorCode: string,
        errorMessage: string,
        rawValue: string | null = null,
      ) => {
        blocked = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: fieldName,
          error_code: errorCode,
          error_message: errorMessage,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.appointmentExternalId) {
        addBlocking(
          "appointment_id",
          "missing_required_field",
          "Mindbody appointment ID is required.",
        );
      } else if (seen.has(candidate.appointmentExternalId)) {
        addBlocking(
          "appointment_id",
          "duplicate_source_identity",
          "The same appointment appears more than once in the attendance CSV.",
          candidate.appointmentExternalId,
        );
      } else {
        seen.add(candidate.appointmentExternalId);
      }

      const appointment = appointmentMap.get(candidate.appointmentExternalId);
      if (candidate.appointmentExternalId && !appointment) {
        addBlocking(
          "appointment_id",
          "missing_related_record",
          "Import the Mindbody appointment before importing attendance.",
          candidate.appointmentExternalId,
        );
      }

      if (!candidate.status) {
        addBlocking(
          "attendance_status",
          "missing_required_field",
          "Attendance status must be attended, no_show, late_cancel, cancelled, or waitlisted.",
          getRowValue(row, ["attendance_status", "visit_status", "status"]),
        );
      }

      if (candidate.status === "waitlisted") {
        addBlocking(
          "attendance_status",
          "mindbody_unresolved_class_roster",
          "Waitlist state requires class-roster review and cannot be written as appointment attendance.",
          candidate.sourceStatus,
        );
      }

      if (candidate.markedAt && Number.isNaN(Date.parse(candidate.markedAt))) {
        addBlocking(
          "attendance_marked_at",
          "invalid_datetime",
          "Attendance timestamp is invalid.",
          candidate.markedAt,
        );
      }

      if (!blocked) {
        readyRows += 1;
        if (candidate.status === "attended") attendedRows += 1;
        if (candidate.status === "no_show") noShowRows += 1;
        if (candidate.status === "cancelled") cancelledRows += 1;
        if (candidate.sourceStatus === "late_cancel") lateCancelRows += 1;
        if (candidate.status === "waitlisted") waitlistRows += 1;
        if (appointment?.status === candidate.status) alreadyMatchedRows += 1;

        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "attendance_status",
          error_code: "historical_balance_preserved",
          error_message:
            "Historical attendance updates appointment status only. It will not deduct package or membership balances again.",
          raw_value: candidate.status,
          row_data: row,
        });
      }
    });

    await finalizeValidation({
      supabase,
      studioId,
      batchId,
      headers,
      rows,
      batchErrors,
      extraSummary: {
        create_candidates: 0,
        update_candidates: readyRows,
        ready_rows: readyRows,
        attended_rows: attendedRows,
        no_show_rows: noShowRows,
        cancelled_rows: cancelledRows,
        late_cancel_rows: lateCancelRows,
        waitlist_rows: waitlistRows,
        already_matched_rows: alreadyMatchedRows,
        usage_deduction_enabled: false,
        source_specific_validation: "mindbody_attendance_v1",
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
  }

  redirect("/app/settings/import?success=validated");
}

export async function executeMindbodyAttendanceImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "mindbody" ||
      batch.import_type !== "attendance"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }
    if (
      batch.mode === "dry_run" ||
      !["validated", "completed_with_warnings"].includes(batch.status)
    ) {
      redirect(`/app/settings/import/${batchId}?error=batch_not_ready`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const { data: errors, error: errorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);
    if (errorsError) throw new Error(errorsError.message);

    const blockedRows = new Set(
      (errors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((value): value is number => typeof value === "number"),
    );

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const executionErrors: BatchErrorInsert[] = [];
    let updatedRows = 0;
    let skippedRows = blockedRows.size;
    let failedRows = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const rowNumber = index + 2;
      if (blockedRows.has(rowNumber)) continue;
      const candidate = buildMindbodyAttendanceCandidate(rows[index]);

      try {
        const markedAt =
          candidate.markedAt && !Number.isNaN(Date.parse(candidate.markedAt))
            ? new Date(candidate.markedAt).toISOString()
            : new Date().toISOString();

        const { data: appointment, error: lookupError } = await supabase
          .from("appointments")
          .select("id, status")
          .eq("studio_id", studioId)
          .eq("source_system", "mindbody")
          .eq("source_external_id", candidate.appointmentExternalId)
          .single();
        if (lookupError || !appointment) {
          throw new Error(lookupError?.message ?? "Appointment could not be resolved.");
        }

        if (appointment.status === candidate.status && batch.mode === "create_only") {
          skippedRows += 1;
          continue;
        }

        const { error: updateError } = await supabase
          .from("appointments")
          .update({
            status: candidate.status,
            attendance_marked_at:
              candidate.status === "attended" || candidate.status === "no_show"
                ? markedAt
                : null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", appointment.id)
          .eq("studio_id", studioId);
        if (updateError) throw new Error(updateError.message);

        updatedRows += 1;
      } catch (error) {
        failedRows += 1;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "appointment_id",
          error_code: "execution_failed",
          error_message:
            error instanceof Error ? error.message : "Attendance import failed.",
          raw_value: candidate.appointmentExternalId,
          row_data: rows[index],
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
      insertedRows: 0,
      updatedRows,
      skippedRows,
      failedRows,
      summary: {
        headers,
        executed: true,
        row_count: rows.length,
        attendance_rows_updated: updatedRows,
        usage_deduction_enabled: false,
        package_balances_preserved: true,
        membership_entitlements_preserved: true,
        source_specific_execution: "mindbody_attendance_v1",
      },
    });

    const { error: reconciliationError } = await supabase
      .from("import_batches")
      .update({
        reconciliation_status: failedRows > 0 ? "needs_review" : "reconciled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);
    if (reconciliationError) throw new Error(reconciliationError.message);
  } catch (error) {
    redirectImportError(`/app/settings/import/${batchId}`, "execution_failed", error);
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}


type WellnessLivingCreditCandidate = {
  externalId: string;
  clientExternalId: string;
  entryDate: string;
  direction: "credit" | "debit" | "";
  amount: number;
  entryType:
    | "credit_added"
    | "credit_applied"
    | "payment_received"
    | "refund_credit"
    | "manual_adjustment"
    | "reversal";
  description: string;
};

function buildWellnessLivingCreditCandidate(
  row: Record<string, string>,
): WellnessLivingCreditCandidate {
  const directionRaw = getRowValue(row, ["direction", "credit_debit"])
    .trim()
    .toLowerCase();
  const direction =
    directionRaw === "credit" || directionRaw === "debit" ? directionRaw : "";
  const entryTypeRaw = getRowValue(row, [
    "entry_type",
    "transaction_type",
    "credit_type",
  ])
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  const allowedTypes = new Set([
    "credit_added",
    "credit_applied",
    "payment_received",
    "refund_credit",
    "manual_adjustment",
    "reversal",
  ]);

  const parsedAmount = parseMoney(
    getRowValue(row, ["amount", "credit_amount", "transaction_amount"]),
  );

  return {
    externalId: getRowValue(row, [
      "ledger_entry_id",
      "transaction_id",
      "credit_id",
      "source_external_id",
    ]),
    clientExternalId: getRowValue(row, [
      "client_id",
      "customer_id",
      "member_id",
    ]),
    entryDate: getRowValue(row, [
      "entry_date",
      "transaction_date",
      "date",
    ]),
    direction,
    amount: Number.isFinite(parsedAmount) ? Math.abs(parsedAmount) : Number.NaN,
    entryType: allowedTypes.has(entryTypeRaw)
      ? (entryTypeRaw as WellnessLivingCreditCandidate["entryType"])
      : direction === "debit"
        ? "credit_applied"
        : "credit_added",
    description:
      getRowValue(row, ["description", "notes", "memo"]) ||
      "Imported WellnessLiving account credit activity.",
  };
}

export async function validateWellnessLivingAccountCreditImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "wellnessliving" ||
      batch.import_type !== "account_credits"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect("/app/settings/import?error=file_not_found");
    }

    await clearBatchErrors({ supabase, batchId });
    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const candidates = rows.map(buildWellnessLivingCreditCandidate);
    const clientExternalIds = Array.from(
      new Set(candidates.map((row) => row.clientExternalId).filter(Boolean)),
    );
    const entryExternalIds = Array.from(
      new Set(candidates.map((row) => row.externalId).filter(Boolean)),
    );

    const [{ data: clients, error: clientsError }, { data: entries, error: entriesError }] =
      await Promise.all([
        clientExternalIds.length
          ? supabase
              .from("clients")
              .select("source_external_id")
              .eq("studio_id", studioId)
              .eq("source_system", "wellnessliving")
              .in("source_external_id", clientExternalIds)
          : Promise.resolve({ data: [], error: null }),
        entryExternalIds.length
          ? supabase
              .from("client_account_ledger")
              .select("source_external_id")
              .eq("studio_id", studioId)
              .eq("source_system", "wellnessliving")
              .in("source_external_id", entryExternalIds)
          : Promise.resolve({ data: [], error: null }),
      ]);

    const firstError = clientsError || entriesError;
    if (firstError) throw new Error(firstError.message);

    const clientIds = new Set(
      (clients ?? []).map((row) => String(row.source_external_id)),
    );
    const existingEntryIds = new Set(
      (entries ?? []).map((row) => String(row.source_external_id)),
    );
    const seen = new Set<string>();
    const batchErrors: BatchErrorInsert[] = [];
    let readyRows = 0;
    let createCandidates = 0;
    let updateCandidates = 0;
    let creditTotal = 0;
    let debitTotal = 0;

    rows.forEach((row, index) => {
      const candidate = candidates[index];
      const rowNumber = index + 2;
      let blocked = false;

      const addBlocking = (
        fieldName: string,
        errorCode: string,
        errorMessage: string,
        rawValue: string | null = null,
      ) => {
        blocked = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: fieldName,
          error_code: errorCode,
          error_message: errorMessage,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.externalId) {
        addBlocking(
          "ledger_entry_id",
          "missing_required_field",
          "WellnessLiving ledger entry ID is required.",
        );
      } else if (seen.has(candidate.externalId)) {
        addBlocking(
          "ledger_entry_id",
          "duplicate_source_identity",
          "The same ledger entry appears more than once.",
          candidate.externalId,
        );
      } else {
        seen.add(candidate.externalId);
      }

      if (!candidate.clientExternalId) {
        addBlocking("client_id", "missing_required_field", "WellnessLiving client ID is required.");
      } else if (!clientIds.has(candidate.clientExternalId)) {
        addBlocking(
          "client_id",
          "missing_related_record",
          "Import the WellnessLiving client before account credits.",
          candidate.clientExternalId,
        );
      }

      if (!candidate.direction) {
        addBlocking(
          "direction",
          "missing_required_field",
          "Direction must be credit or debit.",
          getRowValue(row, ["direction", "credit_debit"]),
        );
      }

      if (!Number.isFinite(candidate.amount) || candidate.amount <= 0) {
        addBlocking(
          "amount",
          "invalid_amount",
          "Account-credit amount must be greater than zero.",
          getRowValue(row, ["amount", "credit_amount", "transaction_amount"]),
        );
      }

      if (!candidate.entryDate || Number.isNaN(Date.parse(candidate.entryDate))) {
        addBlocking(
          "entry_date",
          "invalid_datetime",
          "Entry date is required and must be valid.",
          candidate.entryDate,
        );
      }

      if (!blocked) {
        readyRows += 1;
        if (existingEntryIds.has(candidate.externalId)) updateCandidates += 1;
        else createCandidates += 1;
        if (candidate.direction === "credit") creditTotal += candidate.amount;
        else debitTotal += candidate.amount;
      }
    });

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
        credit_total: Number(creditTotal.toFixed(2)),
        debit_total: Number(debitTotal.toFixed(2)),
        net_credit_change: Number((creditTotal - debitTotal).toFixed(2)),
        source_specific_validation: "wellnessliving_account_credits_v1",
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
  }

  redirect("/app/settings/import?success=validated");
}

export async function executeWellnessLivingAccountCreditImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId, userId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "wellnessliving" ||
      batch.import_type !== "account_credits"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }
    if (
      batch.mode === "dry_run" ||
      !["validated", "completed_with_warnings"].includes(batch.status)
    ) {
      redirect(`/app/settings/import/${batchId}?error=batch_not_ready`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const { data: errors, error: errorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);
    if (errorsError) throw new Error(errorsError.message);

    const blockedRows = new Set(
      (errors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((value): value is number => typeof value === "number"),
    );

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const executionErrors: BatchErrorInsert[] = [];
    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = blockedRows.size;
    let failedRows = 0;
    let creditTotal = 0;
    let debitTotal = 0;
    const importedAt = new Date().toISOString();

    for (let index = 0; index < rows.length; index += 1) {
      const rowNumber = index + 2;
      if (blockedRows.has(rowNumber)) continue;
      const candidate = buildWellnessLivingCreditCandidate(rows[index]);

      try {
        const { data: client, error: clientError } = await supabase
          .from("clients")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "wellnessliving")
          .eq("source_external_id", candidate.clientExternalId)
          .single();
        if (clientError || !client) {
          throw new Error(clientError?.message ?? "Client could not be resolved.");
        }

        const { data: existing, error: existingError } = await supabase
          .from("client_account_ledger")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "wellnessliving")
          .eq("source_external_id", candidate.externalId)
          .maybeSingle();
        if (existingError) throw new Error(existingError.message);

        if (existing && batch.mode === "create_only") {
          skippedRows += 1;
          continue;
        }

        const payload = {
          client_id: client.id,
          entry_date: candidate.entryDate.slice(0, 10),
          entry_type: candidate.entryType,
          direction: candidate.direction,
          amount: candidate.amount,
          description: candidate.description,
          reference_type: "wellnessliving_import",
          reference_id: null,
          source_system: "wellnessliving",
          source_external_id: candidate.externalId,
          imported_at: importedAt,
          updated_at: importedAt,
        };

        if (existing) {
          const { error: updateError } = await supabase
            .from("client_account_ledger")
            .update(payload)
            .eq("id", existing.id)
            .eq("studio_id", studioId);
          if (updateError) throw new Error(updateError.message);
          updatedRows += 1;
        } else {
          const { error: insertError } = await supabase
            .from("client_account_ledger")
            .insert({
              studio_id: studioId,
              ...payload,
              created_by: userId,
            });
          if (insertError) throw new Error(insertError.message);
          insertedRows += 1;
        }

        if (candidate.direction === "credit") creditTotal += candidate.amount;
        else debitTotal += candidate.amount;
      } catch (error) {
        failedRows += 1;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "ledger_entry_id",
          error_code: "execution_failed",
          error_message:
            error instanceof Error ? error.message : "Account-credit import failed.",
          raw_value: candidate.externalId,
          row_data: rows[index],
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
        row_count: rows.length,
        credit_total: Number(creditTotal.toFixed(2)),
        debit_total: Number(debitTotal.toFixed(2)),
        net_credit_change: Number((creditTotal - debitTotal).toFixed(2)),
        source_specific_execution: "wellnessliving_account_credits_v1",
      },
    });

    const { error: reconciliationError } = await supabase
      .from("import_batches")
      .update({
        reconciliation_status: failedRows > 0 ? "needs_review" : "reconciled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);
    if (reconciliationError) throw new Error(reconciliationError.message);
  } catch (error) {
    redirectImportError(`/app/settings/import/${batchId}`, "execution_failed", error);
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}

type MindbodyCreditCandidate = {
  externalId: string;
  clientExternalId: string;
  entryDate: string;
  direction: "credit" | "debit" | "";
  amount: number;
  entryType:
    | "credit_added"
    | "credit_applied"
    | "payment_received"
    | "refund_credit"
    | "manual_adjustment"
    | "reversal";
  description: string;
};

function buildMindbodyCreditCandidate(
  row: Record<string, string>,
): MindbodyCreditCandidate {
  const directionRaw = getRowValue(row, ["direction", "credit_debit", "balance_direction"])
    .trim()
    .toLowerCase();
  const direction =
    directionRaw === "credit" || directionRaw === "debit" ? directionRaw : "";
  const entryTypeRaw = getRowValue(row, [
    "entry_type",
    "account_activity_type",
    "transaction_type",
    "credit_type",
  ])
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  const allowedTypes = new Set([
    "credit_added",
    "credit_applied",
    "payment_received",
    "refund_credit",
    "manual_adjustment",
    "reversal",
  ]);

  const parsedAmount = parseMoney(
    getRowValue(row, ["amount", "credit_amount", "account_amount", "gift_card_amount", "transaction_amount"]),
  );

  return {
    externalId: getRowValue(row, [
      "ledger_entry_id",
      "client_account_entry_id",
      "gift_card_transaction_id",
      "transaction_id",
      "credit_id",
      "source_external_id",
    ]),
    clientExternalId: getRowValue(row, [
      "client_id",
      "client_unique_id",
      "customer_id",
      "member_id",
    ]),
    entryDate: getRowValue(row, [
      "entry_date",
      "balance_date",
      "transaction_date",
      "date",
    ]),
    direction,
    amount: Number.isFinite(parsedAmount) ? Math.abs(parsedAmount) : Number.NaN,
    entryType: allowedTypes.has(entryTypeRaw)
      ? (entryTypeRaw as MindbodyCreditCandidate["entryType"])
      : direction === "debit"
        ? "credit_applied"
        : "credit_added",
    description:
      getRowValue(row, ["description", "notes", "memo"]) ||
      "Imported Mindbody account credit activity.",
  };
}

export async function validateMindbodyAccountCreditImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "mindbody" ||
      batch.import_type !== "account_credits"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect("/app/settings/import?error=file_not_found");
    }

    await clearBatchErrors({ supabase, batchId });
    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const candidates = rows.map(buildMindbodyCreditCandidate);
    const clientExternalIds = Array.from(
      new Set(candidates.map((row) => row.clientExternalId).filter(Boolean)),
    );
    const entryExternalIds = Array.from(
      new Set(candidates.map((row) => row.externalId).filter(Boolean)),
    );

    const [{ data: clients, error: clientsError }, { data: entries, error: entriesError }] =
      await Promise.all([
        clientExternalIds.length
          ? supabase
              .from("clients")
              .select("source_external_id")
              .eq("studio_id", studioId)
              .eq("source_system", "mindbody")
              .in("source_external_id", clientExternalIds)
          : Promise.resolve({ data: [], error: null }),
        entryExternalIds.length
          ? supabase
              .from("client_account_ledger")
              .select("source_external_id")
              .eq("studio_id", studioId)
              .eq("source_system", "mindbody")
              .in("source_external_id", entryExternalIds)
          : Promise.resolve({ data: [], error: null }),
      ]);

    const firstError = clientsError || entriesError;
    if (firstError) throw new Error(firstError.message);

    const clientIds = new Set(
      (clients ?? []).map((row) => String(row.source_external_id)),
    );
    const existingEntryIds = new Set(
      (entries ?? []).map((row) => String(row.source_external_id)),
    );
    const seen = new Set<string>();
    const batchErrors: BatchErrorInsert[] = [];
    let readyRows = 0;
    let createCandidates = 0;
    let updateCandidates = 0;
    let creditTotal = 0;
    let debitTotal = 0;

    rows.forEach((row, index) => {
      const candidate = candidates[index];
      const rowNumber = index + 2;
      let blocked = false;

      const addBlocking = (
        fieldName: string,
        errorCode: string,
        errorMessage: string,
        rawValue: string | null = null,
      ) => {
        blocked = true;
        batchErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: fieldName,
          error_code: errorCode,
          error_message: errorMessage,
          raw_value: rawValue,
          row_data: row,
        });
      };

      if (!candidate.externalId) {
        addBlocking(
          "ledger_entry_id",
          "missing_required_field",
          "Mindbody ledger entry ID is required.",
        );
      } else if (seen.has(candidate.externalId)) {
        addBlocking(
          "ledger_entry_id",
          "duplicate_source_identity",
          "The same ledger entry appears more than once.",
          candidate.externalId,
        );
      } else {
        seen.add(candidate.externalId);
      }

      if (!candidate.clientExternalId) {
        addBlocking("client_id", "missing_required_field", "Mindbody client ID is required.");
      } else if (!clientIds.has(candidate.clientExternalId)) {
        addBlocking(
          "client_id",
          "missing_related_record",
          "Import the Mindbody client before account credits.",
          candidate.clientExternalId,
        );
      }

      if (!candidate.direction) {
        addBlocking(
          "direction",
          "missing_required_field",
          "Direction must be credit or debit.",
          getRowValue(row, ["direction", "credit_debit", "balance_direction"]),
        );
      }

      if (!Number.isFinite(candidate.amount) || candidate.amount <= 0) {
        addBlocking(
          "amount",
          "invalid_amount",
          "Account-credit amount must be greater than zero.",
          getRowValue(row, ["amount", "credit_amount", "account_amount", "gift_card_amount", "transaction_amount"]),
        );
      }

      if (!candidate.entryDate || Number.isNaN(Date.parse(candidate.entryDate))) {
        addBlocking(
          "entry_date",
          "invalid_datetime",
          "Entry date is required and must be valid.",
          candidate.entryDate,
        );
      }

      if (!blocked) {
        readyRows += 1;
        if (existingEntryIds.has(candidate.externalId)) updateCandidates += 1;
        else createCandidates += 1;
        if (candidate.direction === "credit") creditTotal += candidate.amount;
        else debitTotal += candidate.amount;
      }
    });

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
        credit_total: Number(creditTotal.toFixed(2)),
        debit_total: Number(debitTotal.toFixed(2)),
        net_credit_change: Number((creditTotal - debitTotal).toFixed(2)),
        source_specific_validation: "mindbody_account_credits_v1",
      },
    });
  } catch (error) {
    redirectImportError("/app/settings/import", "validation_failed", error);
  }

  redirect("/app/settings/import?success=validated");
}

export async function executeMindbodyAccountCreditImportBatchAction(
  formData: FormData,
) {
  const batchId = getString(formData, "batchId");
  if (!batchId) redirect("/app/settings/import");

  try {
    const { supabase, studioId, userId } = await getImportContext();
    const batch = await getBatchForStudio({ supabase, studioId, batchId });
    if (!batch) redirect("/app/settings/import?error=batch_not_found");
    if (
      batch.source_system !== "mindbody" ||
      batch.import_type !== "account_credits"
    ) {
      redirect("/app/settings/import?error=wrong_import_type");
    }
    if (
      batch.mode === "dry_run" ||
      !["validated", "completed_with_warnings"].includes(batch.status)
    ) {
      redirect(`/app/settings/import/${batchId}?error=batch_not_ready`);
    }

    const fileRow = await getPrimaryBatchFile({ supabase, batchId });
    if (!fileRow?.storage_bucket || !fileRow.storage_path) {
      redirect(`/app/settings/import/${batchId}?error=file_not_found`);
    }

    const { data: errors, error: errorsError } = await supabase
      .from("import_batch_errors")
      .select("row_number, error_code")
      .eq("import_batch_id", batchId);
    if (errorsError) throw new Error(errorsError.message);

    const blockedRows = new Set(
      (errors ?? [])
        .filter((row) => isBlockingErrorCode(row.error_code))
        .map((row) => row.row_number)
        .filter((value): value is number => typeof value === "number"),
    );

    const csvText = await loadStoredCsvText({
      supabase,
      bucket: fileRow.storage_bucket,
      path: fileRow.storage_path,
    });
    const { headers, rows } = parseCsvRows(csvText);
    const executionErrors: BatchErrorInsert[] = [];
    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = blockedRows.size;
    let failedRows = 0;
    let creditTotal = 0;
    let debitTotal = 0;
    const importedAt = new Date().toISOString();

    for (let index = 0; index < rows.length; index += 1) {
      const rowNumber = index + 2;
      if (blockedRows.has(rowNumber)) continue;
      const candidate = buildMindbodyCreditCandidate(rows[index]);

      try {
        const { data: client, error: clientError } = await supabase
          .from("clients")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "mindbody")
          .eq("source_external_id", candidate.clientExternalId)
          .single();
        if (clientError || !client) {
          throw new Error(clientError?.message ?? "Client could not be resolved.");
        }

        const { data: existing, error: existingError } = await supabase
          .from("client_account_ledger")
          .select("id")
          .eq("studio_id", studioId)
          .eq("source_system", "mindbody")
          .eq("source_external_id", candidate.externalId)
          .maybeSingle();
        if (existingError) throw new Error(existingError.message);

        if (existing && batch.mode === "create_only") {
          skippedRows += 1;
          continue;
        }

        const payload = {
          client_id: client.id,
          entry_date: candidate.entryDate.slice(0, 10),
          entry_type: candidate.entryType,
          direction: candidate.direction,
          amount: candidate.amount,
          description: candidate.description,
          reference_type: "mindbody_import",
          reference_id: null,
          source_system: "mindbody",
          source_external_id: candidate.externalId,
          imported_at: importedAt,
          updated_at: importedAt,
        };

        if (existing) {
          const { error: updateError } = await supabase
            .from("client_account_ledger")
            .update(payload)
            .eq("id", existing.id)
            .eq("studio_id", studioId);
          if (updateError) throw new Error(updateError.message);
          updatedRows += 1;
        } else {
          const { error: insertError } = await supabase
            .from("client_account_ledger")
            .insert({
              studio_id: studioId,
              ...payload,
              created_by: userId,
            });
          if (insertError) throw new Error(insertError.message);
          insertedRows += 1;
        }

        if (candidate.direction === "credit") creditTotal += candidate.amount;
        else debitTotal += candidate.amount;
      } catch (error) {
        failedRows += 1;
        executionErrors.push({
          import_batch_id: batchId,
          import_batch_file_id: fileRow.id,
          row_number: rowNumber,
          field_name: "ledger_entry_id",
          error_code: "execution_failed",
          error_message:
            error instanceof Error ? error.message : "Account-credit import failed.",
          raw_value: candidate.externalId,
          row_data: rows[index],
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
        row_count: rows.length,
        credit_total: Number(creditTotal.toFixed(2)),
        debit_total: Number(debitTotal.toFixed(2)),
        net_credit_change: Number((creditTotal - debitTotal).toFixed(2)),
        source_specific_execution: "mindbody_account_credits_v1",
      },
    });

    const { error: reconciliationError } = await supabase
      .from("import_batches")
      .update({
        reconciliation_status: failedRows > 0 ? "needs_review" : "reconciled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("studio_id", studioId);
    if (reconciliationError) throw new Error(reconciliationError.message);
  } catch (error) {
    redirectImportError(`/app/settings/import/${batchId}`, "execution_failed", error);
  }

  redirect(`/app/settings/import/${batchId}?success=executed`);
}
