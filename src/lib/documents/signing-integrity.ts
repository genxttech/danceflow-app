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
