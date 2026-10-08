/*
  Phase 8A -- document signing integrity contract.

  - A document assignment becomes `signed` only through an authoritative signing workflow. For an envelope-backed
    assignment that is the completion of its envelope (the database trigger syncs the assignment); a typed legacy
    signature never proves an envelope-backed assignment signed.
  - Only `pending` assignments are actionable. `waived` and `void` are final and never become `signed`.
  - Only open envelopes (`sent` / `viewed` / `started`) can be completed; `expired`, `declined`, `void` and
    `completed` envelopes never complete (again).
  - Every lifecycle write is conditional on the state it was read in, so a concurrent completion or staff action wins
    cleanly instead of being overwritten; a write that changed nothing is reported as a conflict, never forced.
*/

/** Envelope statuses a signer can still complete. */
export const OPEN_SIGN_ENVELOPE_STATUSES = ["sent", "viewed", "started"] as const;

/** Envelope statuses that are still live (not yet completed / declined / expired / void) -- includes unsent drafts. */
export const LIVE_SIGN_ENVELOPE_STATUSES = ["draft", "sent", "viewed", "started"] as const;

/** The only assignment status that can still be signed, waived or voided. */
export const ACTIONABLE_ASSIGNMENT_STATUS = "pending";

export function isSignableAssignmentStatus(status: string | null | undefined) {
  return status === ACTIONABLE_ASSIGNMENT_STATUS;
}

export function isOpenSignEnvelopeStatus(status: string | null | undefined) {
  return (OPEN_SIGN_ENVELOPE_STATUSES as readonly string[]).includes(status ?? "");
}

/*
  Phase 8B -- lifecycle derivation.

  - An expired or declined envelope leaves its assignment `pending` (it can still be reissued through a revision, and
    `void` is reserved for a staff / checkout closure). The request's real state is derived from its envelope.
  - A signing link stays usable for a grace window after the due date, so an overdue reminder never points at a dead
    request.
*/

/**
 * How long a signing link stays usable after the assignment's due date (and the minimum life of a new link).
 * This is the chosen Phase 8B grace-window rule, an application policy -- not a database requirement. The due date
 * (`document_assignments.due_at`) and the link expiry (`document_sign_envelopes.expires_at`) remain separate values.
 */
export const SIGN_LINK_GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

/** Link expiry for a request with an optional due date: due date + grace, never sooner than now + grace. */
export function signLinkExpiryForDueDate(dueAt: string | null | undefined, nowMs = Date.now()) {
  const floor = nowMs + SIGN_LINK_GRACE_DAYS * DAY_MS;
  const due = dueAt ? new Date(dueAt).getTime() : Number.NaN;
  if (!Number.isFinite(due)) return new Date(floor).toISOString();
  return new Date(Math.max(floor, due + SIGN_LINK_GRACE_DAYS * DAY_MS)).toISOString();
}

export type SignEnvelopeLifecycle = "open" | "draft" | "completed" | "declined" | "expired" | "void" | "unknown";

/**
 * The effective state of a signing request. An open envelope past its `expires_at` is `expired` even before the
 * persisted status catches up (the cron persists it; signing paths already refuse it).
 */
export function deriveSignEnvelopeLifecycle(
  envelope: { status?: string | null; expires_at?: string | null } | null | undefined,
  nowMs = Date.now(),
): SignEnvelopeLifecycle {
  const status = envelope?.status ?? null;
  if (isOpenSignEnvelopeStatus(status)) {
    const expires = envelope?.expires_at ? new Date(envelope.expires_at).getTime() : Number.NaN;
    return Number.isFinite(expires) && expires <= nowMs ? "expired" : "open";
  }
  if (status === "draft" || status === "completed" || status === "declined" || status === "expired" || status === "void") {
    return status;
  }
  return "unknown";
}
