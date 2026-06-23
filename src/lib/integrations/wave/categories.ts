import "server-only";
import { accountingCategoryLabel, type AccountingEntry } from "@/lib/accounting/entries";

export const WAVE_ACCOUNTING_CATEGORIES = [
  "private_lesson_revenue", "group_class_revenue", "package_revenue", "membership_revenue",
  "event_ticket_revenue", "coach_private_lesson_revenue", "floor_rental_revenue", "practice_party_revenue",
  "other_income", "other_revenue", "refund", "client_payment_refund", "package_refund",
  "membership_refund", "floor_rental_refund", "event_ticket_refund", "other_refund",
  "stripe_processing_fee", "danceflow_platform_fee", "organizer_platform_fee", "floor_fee_expense",
  "rent_expense", "instructor_pay_expense", "marketing_expense", "software_expense", "supplies_expense",
  "event_expense", "event_labor_expense", "travel_expense", "other_expense", "account_credit", "manual_adjustment",
] as const;

export const WAVE_PAYMENT_METHODS = [
  { key: "stripe", label: "Stripe", help: "Stripe Clearing" },
  { key: "cash", label: "Cash", help: "Cash on Hand" },
  { key: "check", label: "Checks", help: "Undeposited Funds" },
  { key: "bank", label: "Bank / ACH", help: "Operating checking" },
  { key: "card", label: "Other card processor", help: "Processor clearing" },
  { key: "other", label: "Other / unknown", help: "Fallback payment account" },
] as const;

export type WavePaymentMethodKey = (typeof WAVE_PAYMENT_METHODS)[number]["key"];
type AccountMapping = { waveAccountId: string; waveAccountName: string };

export type WavePostingLine = {
  key: string;
  entryDate: string;
  paymentMethodKey: WavePaymentMethodKey;
  category: string;
  categoryLabel: string;
  direction: "debit" | "credit";
  amount: number;
  currency: string;
  sourceKeys: string[];
  categoryAccount: AccountMapping | null;
  anchorAccount: AccountMapping | null;
  mappingStatus: "ready" | "unmapped" | "unsupported";
};

export function normalizeWavePaymentMethod(entry: AccountingEntry): WavePaymentMethodKey {
  if (entry.stripePaymentIntentId || entry.stripeChargeId || entry.stripeInvoiceId) return "stripe";
  const value = (entry.paymentMethod ?? "").toLowerCase();
  if (value.includes("stripe")) return "stripe";
  if (value.includes("cash")) return "cash";
  if (value.includes("check") || value.includes("cheque")) return "check";
  if (value.includes("ach") || value.includes("bank") || value.includes("transfer")) return "bank";
  if (value.includes("card") || value.includes("credit") || value.includes("debit")) return "card";
  return "other";
}

function refundCategory(category: string) {
  if (category === "event_ticket_revenue") return "event_ticket_refund";
  if (category === "package_revenue") return "package_refund";
  if (category === "membership_revenue") return "membership_refund";
  if (category === "floor_rental_revenue") return "floor_rental_refund";
  return "client_payment_refund";
}

export function buildWavePostingLines(
  entries: AccountingEntry[],
  categoryMappings: Map<string, AccountMapping>,
  anchorMappings: Map<WavePaymentMethodKey, AccountMapping>,
) {
  type WorkingLine = Omit<WavePostingLine, "sourceKeys" | "categoryAccount" | "anchorAccount" | "mappingStatus"> & { sourceKeys: Set<string> };
  const grouped = new Map<string, WorkingLine>();
  const add = (entry: AccountingEntry, component: string, category: string, direction: "debit" | "credit", rawAmount: number) => {
    const amount = Math.round(Math.abs(rawAmount) * 100) / 100;
    if (!amount) return;
    const paymentMethodKey = normalizeWavePaymentMethod(entry);
    const key = [entry.entryDate, paymentMethodKey, category, entry.currency, direction].join("|");
    const sourceKey = `${entry.id}:${component}`;
    const current = grouped.get(key);
    if (current) { current.amount = Math.round((current.amount + amount) * 100) / 100; current.sourceKeys.add(sourceKey); return; }
    grouped.set(key, { key, entryDate: entry.entryDate, paymentMethodKey, category,
      categoryLabel: accountingCategoryLabel(category), direction, amount, currency: entry.currency, sourceKeys: new Set([sourceKey]) });
  };

  for (const entry of entries) {
    if (entry.entryType === "revenue") {
      add(entry, "gross", entry.category, "credit", entry.grossAmount || entry.netAmount);
      add(entry, "embedded_refund", refundCategory(entry.category), "debit", entry.refundAmount);
      add(entry, "embedded_fee", "stripe_processing_fee", "debit", entry.feeAmount);
    } else {
      add(entry, entry.entryType, entry.category, entry.direction,
        entry.netAmount || entry.refundAmount || entry.feeAmount || entry.grossAmount);
    }
  }

  return Array.from(grouped.values()).map((line): WavePostingLine => {
    const categoryAccount = categoryMappings.get(line.category) ?? null;
    const anchorAccount = anchorMappings.get(line.paymentMethodKey) ?? null;
    const supported = WAVE_ACCOUNTING_CATEGORIES.includes(line.category as never);
    return { ...line, sourceKeys: Array.from(line.sourceKeys).sort(), categoryAccount, anchorAccount,
      mappingStatus: !supported ? "unsupported" : categoryAccount && anchorAccount ? "ready" : "unmapped" };
  }).sort((a, b) => b.entryDate.localeCompare(a.entryDate) || a.paymentMethodKey.localeCompare(b.paymentMethodKey) || a.category.localeCompare(b.category));
}
