/**
 * CI-D / Competition R2: pure refund rules (docs/competition/r2-entry-refunds.md §4, §4.0, §4.1).
 *
 * Decision math only — no Stripe call, no database write, no money movement. The SQL RPCs (not yet authorized)
 * must implement the same rules; the unit tests here are the shared specification for both.
 *
 * D1 (b) / D2 (a), PROVISIONAL: refundable caps are NET of discounts. Each discount line is split across the
 * lines it priced (scoped discounts: the matching entries; unscoped: every entry and fee line) in proportion to
 * their gross cents, by largest remainder; ties go to the earlier `sortOrder`, then the smaller id. Caps therefore
 * always sum to the captured amount.
 * Q1 (decided): a `danced` placement counts as locked. Q2 (decided): only scopes with a competitive effect block
 * publication of their own round.
 */

export type RefundableLine = {
  id: string;
  kind: "entry" | "fee";
  grossCents: number;
  sortOrder: number;
  /** Scope keys the line matches (program/contest/division ids for entries); fee lines match only unscoped discounts. */
  scopeKeys?: readonly string[];
};

export type DiscountLine = {
  id: string;
  amountCents: number;
  /** Absent or empty = unscoped (applies to every entry and fee line). */
  scopeKeys?: readonly string[];
};

function assertCents(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer number of cents.`);
  }
}

function compareLines(a: RefundableLine, b: RefundableLine) {
  return a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Largest-remainder split of `amountCents` across `lines` in proportion to gross cents. */
export function splitByLargestRemainder(amountCents: number, lines: readonly RefundableLine[]): Map<string, number> {
  assertCents(amountCents, "Discount amount");
  const ordered = [...lines].sort(compareLines);
  const base = ordered.reduce((sum, line) => sum + line.grossCents, 0);
  const shares = new Map<string, number>(ordered.map((line) => [line.id, 0]));
  if (amountCents === 0 || ordered.length === 0) return shares;
  if (amountCents > base) throw new Error("A discount cannot exceed the lines it applies to.");

  const raw = ordered.map((line) => {
    const exact = BigInt(amountCents) * BigInt(line.grossCents);
    return { line, floor: Number(exact / BigInt(base)), remainder: exact % BigInt(base) };
  });
  let left = amountCents - raw.reduce((sum, r) => sum + r.floor, 0);
  const byRemainder = [...raw].sort((a, b) =>
    a.remainder === b.remainder ? compareLines(a.line, b.line) : a.remainder > b.remainder ? -1 : 1,
  );
  for (const r of byRemainder) {
    shares.set(r.line.id, r.floor + (left > 0 ? 1 : 0));
    if (left > 0) left -= 1;
  }
  return shares;
}

/** A scoped discount (program AND contest AND division, as priced) applies only to entries matching every key. */
function discountApplies(discount: DiscountLine, line: RefundableLine) {
  const keys = discount.scopeKeys ?? [];
  if (keys.length === 0) return true;
  return line.kind === "entry" && keys.every((key) => (line.scopeKeys ?? []).includes(key));
}

/** Net refundable cap per line (D1/D2): gross minus every discount share. */
export function netRefundableCaps(lines: readonly RefundableLine[], discounts: readonly DiscountLine[]): Map<string, number> {
  const ids = new Set<string>();
  for (const line of lines) {
    assertCents(line.grossCents, `Line ${line.id}`);
    if (ids.has(line.id)) throw new Error(`Duplicate line ${line.id}.`);
    ids.add(line.id);
  }
  const caps = new Map<string, number>(lines.map((line) => [line.id, line.grossCents]));
  for (const discount of [...discounts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const targets = lines.filter((line) => discountApplies(discount, line));
    // Earlier discounts may already have reduced a line; split over the remaining net so no cap goes negative.
    const current = targets.map((line) => ({ ...line, grossCents: caps.get(line.id)! }));
    for (const [id, share] of splitByLargestRemainder(discount.amountCents, current)) {
      caps.set(id, caps.get(id)! - share);
    }
  }
  return caps;
}

/** Refund statuses that hold cap (reservation) vs count as money actually returned (REFUND-RECON-1). */
export const CAP_HOLDING_REFUND_STATUSES = ["requested", "pending", "requires_action", "succeeded"] as const;
export const REFUNDED_STATUSES = ["succeeded"] as const;

export type RefundAllocation = { amountCents: number; refundStatus: string };

export function remainingRefundableCents(capCents: number, allocations: readonly RefundAllocation[]): number {
  const held = allocations
    .filter((a) => (CAP_HOLDING_REFUND_STATUSES as readonly string[]).includes(a.refundStatus))
    .reduce((sum, a) => sum + a.amountCents, 0);
  return Math.max(0, capCents - held);
}

export function refundedCents(allocations: readonly RefundAllocation[]): number {
  return allocations
    .filter((a) => (REFUNDED_STATUSES as readonly string[]).includes(a.refundStatus))
    .reduce((sum, a) => sum + a.amountCents, 0);
}

export type HeatLockState = "open" | "locked" | "certified";
export type Placement = {
  heatId: string;
  roundId: string | null;
  lockState: HeatLockState;
  status: "scheduled" | "checked_in" | "scratched" | "danced" | "disqualified";
  /** Heat status; a heat on the floor (active / complete) counts as danced for its unscratched placements (SC1 rule). */
  heatStatus?: string | null;
};

/** Q1 + SC1: a placement has danced when marked danced, or when its heat is on the floor and it was not scratched. */
export function hasDanced(p: Placement): boolean {
  return p.status === "danced" || ((p.heatStatus === "active" || p.heatStatus === "complete") && p.status !== "scratched");
}

/** Participation class of an entry (§4.1 P): the most restrictive of its placements. Q1: danced = locked. */
export type ParticipationClass = "unplaced" | "open" | "locked" | "certified";

export function participationClass(placements: readonly Placement[]): ParticipationClass {
  if (placements.some((p) => p.lockState === "certified")) return "certified";
  if (placements.some((p) => p.lockState === "locked" || hasDanced(p))) return "locked";
  return placements.length > 0 ? "open" : "unplaced";
}

/** May a succeeded refund withdraw this entry automatically (§4.1 P, owner points 2–4)? */
export function mayWithdrawAutomatically(placements: readonly Placement[]): boolean {
  const cls = participationClass(placements);
  return cls === "unplaced" || cls === "open";
}

export type CompetitionRefundExceptionKind =
  | "competition_refund_entry_locked_heat"
  | "competition_refund_entry_certified_heat"
  | "competition_refund_unattributed"
  | "competition_refund_reversed";

export type ExceptionScope = { entryId: string; heatId: string; roundId: string | null; competitiveEffect: boolean };

/** The heats that hold an entry's competitive state: certified, locked or danced placements. */
function heldPlacements(placements: readonly Placement[]) {
  return placements.filter((p) => p.lockState !== "open" || hasDanced(p));
}

/**
 * Q2 scope rows for one entry under one exception kind. E-L / E-C always affect competition; unattributed and
 * reversed refunds affect competition only for entries held in a locked/danced/certified heat.
 */
export function exceptionScopes(
  kind: CompetitionRefundExceptionKind,
  entryId: string,
  placements: readonly Placement[],
): ExceptionScope[] {
  const held = heldPlacements(placements);
  const cls = participationClass(placements);
  if (kind === "competition_refund_entry_certified_heat") {
    if (cls !== "certified") throw new Error("E-C applies only to an entry placed in a certified heat.");
    return held.filter((p) => p.lockState === "certified").map((p) => ({ entryId, heatId: p.heatId, roundId: p.roundId, competitiveEffect: true }));
  }
  if (kind === "competition_refund_entry_locked_heat") {
    if (cls !== "locked") throw new Error("E-L applies only to an entry placed in a locked or danced heat.");
    return held.map((p) => ({ entryId, heatId: p.heatId, roundId: p.roundId, competitiveEffect: true }));
  }
  return held.map((p) => ({ entryId, heatId: p.heatId, roundId: p.roundId, competitiveEffect: true }));
}

/** K0 publish precondition (Q2): does any unresolved competitive scope block this round? */
export function roundPublicationBlocked(
  roundId: string,
  scopes: readonly (ExceptionScope & { resolvedAt: string | null })[],
): boolean {
  return scopes.some((s) => s.roundId === roundId && s.competitiveEffect && s.resolvedAt === null);
}
