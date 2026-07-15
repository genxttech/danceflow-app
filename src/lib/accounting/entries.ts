import type { SupabaseClient } from "@supabase/supabase-js";
import {
  accountingCategoryLabel,
  type AccountingCategoryKey,
} from "@/lib/accounting/categories";

export { accountingCategoryLabel } from "@/lib/accounting/categories";

export type AccountingEntryType =
  | "revenue"
  | "refund"
  | "processing_fee"
  | "platform_fee"
  | "expense"
  | "credit_applied"
  | "adjustment";

export type AccountingEntryStatus = "active" | "voided" | "reversal";

export type AccountingEntry = {
  id: string;
  studioId: string | null;
  organizerId: string | null;
  entryDate: string;
  entryType: AccountingEntryType;
  category: string;
  categoryLabel: string;
  direction: "credit" | "debit";
  grossAmount: number;
  feeAmount: number;
  refundAmount: number;
  netAmount: number;
  currency: string;
  paymentMethod: string | null;
  sourceTable: string;
  sourceId: string;
  clientId: string | null;
  eventId: string | null;
  appointmentId: string | null;
  externalReference: string | null;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
  stripeInvoiceId: string | null;
  description: string;
  status: AccountingEntryStatus;
  createdAt: string;
  postedAt: string | null;
  lockedAt: string | null;
  reversesEntryId: string | null;
  metadata: Record<string, unknown>;
};

type AccountingEntryDbRow = {
  id: string;
  studio_id: string | null;
  organizer_id: string | null;
  entry_date: string;
  entry_type: AccountingEntryType;
  category: string;
  direction: "credit" | "debit";
  gross_amount: number | string | null;
  fee_amount: number | string | null;
  refund_amount: number | string | null;
  net_amount: number | string | null;
  currency: string | null;
  payment_method: string | null;
  source_table: string;
  source_id: string;
  client_id: string | null;
  event_id: string | null;
  appointment_id: string | null;
  external_reference: string | null;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  stripe_invoice_id: string | null;
  description: string | null;
  entry_status: AccountingEntryStatus | null;
  posted_at: string | null;
  locked_at: string | null;
  reverses_entry_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

function toNumber(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toCurrency(value: string | null | undefined) {
  return (value || "USD").toUpperCase();
}

function signedNetAmount(row: AccountingEntryDbRow) {
  const amount = Math.abs(toNumber(row.net_amount));
  return row.direction === "debit" ? -amount : amount;
}

function dbAccountingEntryToEntry(row: AccountingEntryDbRow): AccountingEntry {
  return {
    id: row.id,
    studioId: row.studio_id,
    organizerId: row.organizer_id,
    entryDate: row.entry_date,
    entryType: row.entry_type,
    category: row.category,
    categoryLabel: accountingCategoryLabel(row.category),
    direction: row.direction,
    grossAmount: Math.abs(toNumber(row.gross_amount)),
    feeAmount: Math.abs(toNumber(row.fee_amount)),
    refundAmount: Math.abs(toNumber(row.refund_amount)),
    netAmount: signedNetAmount(row),
    currency: toCurrency(row.currency),
    paymentMethod: row.payment_method,
    sourceTable: row.source_table,
    sourceId: row.source_id,
    clientId: row.client_id,
    eventId: row.event_id,
    appointmentId: row.appointment_id,
    externalReference: row.external_reference,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    stripeChargeId: row.stripe_charge_id,
    stripeInvoiceId: row.stripe_invoice_id,
    description: row.description || accountingCategoryLabel(row.category),
    status: row.entry_status ?? "active",
    createdAt: row.created_at,
    postedAt: row.posted_at,
    lockedAt: row.locked_at,
    reversesEntryId: row.reverses_entry_id,
    metadata: row.metadata ?? {},
  };
}

export async function getStudioAccountingEntries({
  supabase,
  studioId,
  startDate,
  endDate,
}: {
  supabase: SupabaseClient;
  studioId: string;
  startDate: string;
  endDate: string;
}) {
  const rangeStartDate = startDate.slice(0, 10);
  const rangeEndDate = endDate.slice(0, 10);

  const { data, error } = await supabase
    .from("accounting_entries")
    .select(
      [
        "id",
        "studio_id",
        "organizer_id",
        "entry_date",
        "entry_type",
        "category",
        "direction",
        "gross_amount",
        "fee_amount",
        "refund_amount",
        "net_amount",
        "currency",
        "payment_method",
        "source_table",
        "source_id",
        "client_id",
        "event_id",
        "appointment_id",
        "external_reference",
        "stripe_payment_intent_id",
        "stripe_charge_id",
        "stripe_invoice_id",
        "description",
        "entry_status",
        "posted_at",
        "locked_at",
        "reverses_entry_id",
        "metadata",
        "created_at",
      ].join(", "),
    )
    .eq("studio_id", studioId)
    .in("entry_status", ["active", "reversal"])
    .gte("entry_date", rangeStartDate)
    .lte("entry_date", rangeEndDate)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(10000);

  if (error) {
    throw new Error(`Accounting ledger lookup failed: ${error.message}`);
  }

  return ((data ?? []) as unknown as AccountingEntryDbRow[]).map(
  dbAccountingEntryToEntry,
);
}

export async function getOrganizerAccountingEntries({
  supabase,
  organizerId,
  startDate,
  endDate,
}: {
  supabase: SupabaseClient;
  organizerId: string;
  startDate: string;
  endDate: string;
}) {
  const rangeStartDate = startDate.slice(0, 10);
  const rangeEndDate = endDate.slice(0, 10);

  const { data, error } = await supabase
    .from("accounting_entries")
    .select(
      [
        "id",
        "studio_id",
        "organizer_id",
        "entry_date",
        "entry_type",
        "category",
        "direction",
        "gross_amount",
        "fee_amount",
        "refund_amount",
        "net_amount",
        "currency",
        "payment_method",
        "source_table",
        "source_id",
        "client_id",
        "event_id",
        "appointment_id",
        "external_reference",
        "stripe_payment_intent_id",
        "stripe_charge_id",
        "stripe_invoice_id",
        "description",
        "entry_status",
        "posted_at",
        "locked_at",
        "reverses_entry_id",
        "metadata",
        "created_at",
      ].join(", "),
    )
    .eq("organizer_id", organizerId)
    .in("entry_status", ["active", "reversal"])
    .gte("entry_date", rangeStartDate)
    .lte("entry_date", rangeEndDate)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(10000);

  if (error) {
    throw new Error(`Organizer accounting ledger lookup failed: ${error.message}`);
  }

  return ((data ?? []) as unknown as AccountingEntryDbRow[]).map(
  dbAccountingEntryToEntry,
);
}

export function summarizeAccountingEntries(entries: AccountingEntry[]) {
  const summary = entries.reduce(
    (current, entry) => {
      if (entry.status === "voided") return current;

      if (entry.entryType === "revenue") {
        current.revenue += entry.grossAmount;

        // Event payment rows currently retain fee/refund components on the
        // persisted revenue row. Standard payments use separate ledger rows.
        current.refunds += Math.abs(entry.refundAmount);

        const embeddedFeeAmount = Math.abs(entry.feeAmount);
        current.fees += embeddedFeeAmount;

        if (embeddedFeeAmount > 0 && entry.sourceTable === "event_payments") {
          current.processingFees += embeddedFeeAmount;
          current.stripeProcessingFees += embeddedFeeAmount;
        }
      }

      if (entry.entryType === "refund") {
        current.refunds += Math.abs(entry.refundAmount || entry.netAmount);
      }

      if (entry.entryType === "expense") {
        current.expenses += Math.abs(entry.netAmount);
      }

      if (entry.entryType === "processing_fee") {
        const amount = Math.abs(entry.netAmount || entry.feeAmount);
        current.fees += amount;
        current.processingFees += amount;

        if (entry.category === "stripe_processing_fee") {
          current.stripeProcessingFees += amount;
        }
      }

      if (entry.entryType === "platform_fee") {
        const amount = Math.abs(entry.netAmount || entry.feeAmount);
        current.fees += amount;
        current.platformFees += amount;

        if (entry.category === "danceflow_platform_fee") {
          current.danceflowPlatformFees += amount;
        }

        if (entry.category === "organizer_platform_fee") {
          current.organizerPlatformFees += amount;
        }
      }

      return current;
    },
    {
      revenue: 0,
      refunds: 0,
      expenses: 0,
      fees: 0,
      processingFees: 0,
      stripeProcessingFees: 0,
      platformFees: 0,
      danceflowPlatformFees: 0,
      organizerPlatformFees: 0,
      deductions: 0,
      netBeforeExpenses: 0,
      net: 0,
    },
  );

  summary.deductions = summary.refunds + summary.fees;
  summary.netBeforeExpenses =
    summary.revenue - summary.refunds - summary.fees;
  summary.net = summary.netBeforeExpenses - summary.expenses;

  return summary;
}

export function accountingEntryCategory(
  entry: AccountingEntry,
): AccountingCategoryKey | string {
  return entry.category;
}