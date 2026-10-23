import {
  netRefundableCaps,
  participationClass,
  refundedCents,
  remainingRefundableCents,
  type DiscountLine,
  type ParticipationClass,
  type Placement,
  type RefundableLine,
} from "@/lib/payments/competitionRefundRules";

/**
 * CI-D / Competition R2: display summary for the staff refund page. Uses the same rules as the SQL authority
 * (`_r2_order_line_caps`, `_r2_entry_participation_class`); the RPC re-validates everything on submit.
 */

export type SummaryOrderItem = {
  id: string;
  item_type: string;
  description: string;
  total_price: number | string;
  metadata: Record<string, unknown> | null;
};
export type SummaryEntry = {
  id: string;
  order_item_id: string | null;
  display_name: string;
  status: string;
  sort_order: number | null;
  program_id: string | null;
  division_id: string | null;
};
export type SummaryPlacement = Placement & { entryId: string };
export type SummaryAllocation = { order_item_id: string; amount_cents: number; refund_status: string };

export type RefundSummaryLine = {
  orderItemId: string;
  kind: "entry" | "fee";
  label: string;
  entryId: string | null;
  entryStatus: string | null;
  grossCents: number;
  capCents: number;
  refundedCents: number;
  remainingCents: number;
  participation: ParticipationClass | null;
  /** Owner policy 2 + Q1: withdrawal with a refund is automatic only for unplaced / open-heat entries still active. */
  canWithdraw: boolean;
  /**
   * Any still-active entry may ask for a scratch. For a locked / danced / certified entry the request never scratches
   * it automatically: it raises the E-L / E-C exception, so an official decides (owner policy 3, 4, 7).
   */
  canRequestScratch: boolean;
};

const toCents = (value: number | string | null | undefined) => Math.round(Number(value ?? 0) * 100);

function lineType(item: SummaryOrderItem) {
  return typeof item.metadata?.line_type === "string" ? item.metadata.line_type : "fee";
}

function discountScope(item: SummaryOrderItem): string[] {
  const priceLine = item.metadata?.price_line as { metadata?: { scope?: Record<string, unknown> } } | undefined;
  const scope = priceLine?.metadata?.scope ?? {};
  return ["programId", "contestId", "divisionId"]
    .map((key) => scope[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function buildRefundSummary(input: {
  items: SummaryOrderItem[];
  entries: SummaryEntry[];
  placements: SummaryPlacement[];
  allocations: SummaryAllocation[];
}): RefundSummaryLine[] {
  const entryByItem = new Map(input.entries.filter((e) => e.order_item_id).map((e) => [e.order_item_id as string, e]));
  const refundable: RefundableLine[] = [];
  const discounts: DiscountLine[] = [];
  for (const item of input.items) {
    if (item.item_type === "competition_entry") {
      const entry = entryByItem.get(item.id);
      const contestId = typeof item.metadata?.contest_id === "string" ? item.metadata.contest_id : null;
      refundable.push({
        id: item.id,
        kind: "entry",
        grossCents: toCents(item.total_price),
        sortOrder: entry?.sort_order ?? 0,
        scopeKeys: [entry?.program_id, contestId, entry?.division_id].filter((key): key is string => Boolean(key)),
      });
    } else if (item.item_type === "add_on" && lineType(item) === "discount") {
      discounts.push({ id: item.id, amountCents: toCents(item.metadata?.discount_amount as number | string | undefined), scopeKeys: discountScope(item) });
    } else if (item.item_type === "add_on") {
      refundable.push({ id: item.id, kind: "fee", grossCents: toCents(item.total_price), sortOrder: 1000000 });
    }
  }
  const caps = netRefundableCaps(refundable, discounts.filter((d) => d.amountCents > 0));
  return refundable.map((line) => {
    const item = input.items.find((candidate) => candidate.id === line.id)!;
    const entry = entryByItem.get(line.id) ?? null;
    const allocations = input.allocations
      .filter((a) => a.order_item_id === line.id)
      .map((a) => ({ amountCents: Number(a.amount_cents), refundStatus: a.refund_status }));
    const participation = entry ? participationClass(input.placements.filter((p) => p.entryId === entry.id)) : null;
    const active = entry ? !["withdrawn", "disqualified", "complete", "scratched"].includes(entry.status) : false;
    return {
      orderItemId: line.id,
      kind: line.kind,
      label: entry?.display_name ?? item.description,
      entryId: entry?.id ?? null,
      entryStatus: entry?.status ?? null,
      grossCents: line.grossCents,
      capCents: caps.get(line.id) ?? 0,
      refundedCents: refundedCents(allocations),
      remainingCents: remainingRefundableCents(caps.get(line.id) ?? 0, allocations),
      participation,
      canWithdraw: line.kind === "entry" && active && (participation === "unplaced" || participation === "open"),
      canRequestScratch: line.kind === "entry" && active,
    };
  });
}

/** Parse a staff-entered dollar amount ("22.72") into integer cents; null when blank, NaN-free, max two decimals. */
export function parseDollarsToCents(value: string | null | undefined): number | null {
  const text = (value ?? "").trim();
  if (text === "") return null;
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error("Amounts must be dollars with at most two decimals.");
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
