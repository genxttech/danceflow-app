import { deriveSignEnvelopeLifecycle } from "@/lib/documents/signing-integrity";

/*
  Phase 8C -- one truthful presentation contract for a client's document assignment, used by the web portal, the
  student API / app and any "needs your action" count. It is derived from authoritative state only: the assignment
  status plus the current envelope's derived lifecycle (Phase 8B). No database status exists for display alone.

  Only "needs_signature" and "overdue" are actionable (sign CTA / needs-your-action). Waived, void, signed,
  expired, declined, preparing (draft) and unavailable (withdrawn / missing request) never show a sign CTA.
*/

export type DocumentPresentationState =
  | "needs_signature"
  | "overdue"
  | "preparing"
  | "signed"
  | "waived"
  | "void"
  | "expired"
  | "declined"
  | "unavailable"
  | "reference";

export type DocumentPresentation = {
  state: DocumentPresentationState;
  needsAction: boolean;
  label: string;
};

const LABELS: Record<DocumentPresentationState, string> = {
  needs_signature: "Needs signature",
  overdue: "Past due",
  preparing: "Being prepared",
  signed: "Signed",
  waived: "Waived",
  void: "Voided",
  expired: "Expired",
  declined: "Declined",
  unavailable: "Unavailable",
  reference: "For reference",
};

function presentation(state: DocumentPresentationState): DocumentPresentation {
  return { state, needsAction: state === "needs_signature" || state === "overdue", label: LABELS[state] };
}

function pendingState(dueAt: string | null | undefined, nowMs: number): DocumentPresentationState {
  const due = dueAt ? new Date(dueAt).getTime() : Number.NaN;
  return Number.isFinite(due) && due < nowMs ? "overdue" : "needs_signature";
}

/**
 * @param hasEnvelope the assignment is envelope-backed (sign_envelope_id set) -- then only the envelope can prove a
 *   signature; a legacy typed signature never does.
 * @param legacySignature a legacy document_signatures row bound to THIS assignment (assignment_id match). Never pass
 *   a signature matched only by template / version: an older signature does not sign a newer request.
 */
export function presentDocumentAssignment(
  input: {
    assignmentStatus: string | null | undefined;
    dueAt: string | null | undefined;
    hasEnvelope: boolean;
    envelope: { status?: string | null; expires_at?: string | null } | null | undefined;
    legacySignature?: boolean;
  },
  nowMs = Date.now(),
): DocumentPresentation {
  const status = input.assignmentStatus ?? "pending";
  if (status === "signed") return presentation("signed");
  if (status === "waived") return presentation("waived");
  if (status === "void") return presentation("void");

  if (input.hasEnvelope) {
    if (!input.envelope) return presentation("unavailable");
    const lifecycle = deriveSignEnvelopeLifecycle(input.envelope, nowMs);
    if (lifecycle === "completed") return presentation("signed");
    if (lifecycle === "open") return presentation(pendingState(input.dueAt, nowMs));
    if (lifecycle === "draft") return presentation("preparing");
    if (lifecycle === "expired") return presentation("expired");
    if (lifecycle === "declined") return presentation("declined");
    return presentation("unavailable");
  }

  if (input.legacySignature) return presentation("signed");
  return presentation(pendingState(input.dueAt, nowMs));
}

/**
 * An unassigned studio-wide template (portal legacy typed signature): signed when a signature for it exists;
 * actionable only when it asks for a signature or is required, otherwise reference material.
 */
export function presentPortalTemplate(input: { signed: boolean; requiresSignature: boolean; isRequired: boolean }): DocumentPresentation {
  if (input.signed) return presentation("signed");
  return presentation(input.requiresSignature || input.isRequired ? "needs_signature" : "reference");
}

/** Count of documents that need the client's action -- the single definition behind every badge / count. */
export function countDocumentsNeedingAction(items: Array<{ needsAction: boolean }>) {
  return items.filter((item) => item.needsAction).length;
}

/**
 * Signed records per template for staff counts: every signed assignment (envelope completions included) plus every
 * legacy typed signature that is not already represented by its own signed assignment -- each record counted once.
 */
export function countSignedRecordsByTemplate(
  assignments: Array<{ id: string; template_id: string; status: string | null }>,
  signatures: Array<{ template_id: string; assignment_id?: string | null }>,
) {
  const counts = new Map<string, number>();
  const signedAssignmentIds = new Set<string>();
  for (const assignment of assignments) {
    if (assignment.status !== "signed") continue;
    signedAssignmentIds.add(assignment.id);
    counts.set(assignment.template_id, (counts.get(assignment.template_id) ?? 0) + 1);
  }
  for (const signature of signatures) {
    if (signature.assignment_id && signedAssignmentIds.has(signature.assignment_id)) continue;
    counts.set(signature.template_id, (counts.get(signature.template_id) ?? 0) + 1);
  }
  return counts;
}
