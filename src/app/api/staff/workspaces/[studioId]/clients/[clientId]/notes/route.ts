import { NextResponse } from "next/server";
import { canEditClients } from "@/lib/auth/permissions";
import { normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import { staffApiError, staffApiJson, staffApiUnavailable } from "@/lib/auth/staffApiAuth";
import { requireStaffWrite } from "@/lib/staff/writeGuard";
import { addClientActivityNote, validateClientNoteInput } from "@/lib/staff/clientNotes";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_\-:.]{8,128}$/;
/** API-only cap; the web form has none. */
const MAX_NOTE_LENGTH = 5000;
/** The server keeps no idempotency keys, so an identical note by the same author inside this window is a retry, not a new note. */
const DEDUPE_WINDOW_SECONDS = 120;

export async function POST(request: Request, { params }: { params: Promise<{ studioId: string; clientId: string }> }) {
  const { studioId, clientId } = await params;
  const guard = await requireStaffWrite(request, studioId, "clientNotes");
  if (!guard.ok) return guard.response;

  // Same roles as the web "add note" action (canEditClients): owners, admins and front desk. Instructors are refused.
  if (!canEditClients(guard.studioRole)) {
    return staffApiError("role_not_permitted", "Your role cannot add client notes.", 403);
  }

  const normalizedClientId = normalizeStudentApiUuid(clientId);
  if (!normalizedClientId) return staffApiError("invalid_request", "A valid client id is required.", 400);

  if (!IDEMPOTENCY_KEY.test(request.headers.get("idempotency-key") ?? "")) {
    return staffApiError("invalid_request", "An Idempotency-Key header (8-128 letters, digits, - _ : .) is required.", 400);
  }

  let payload: { noteType?: unknown; body?: unknown; occurredAt?: unknown } | null;
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return staffApiError("invalid_request", "The body must be JSON.", 400);
  }
  if (!payload || typeof payload !== "object") return staffApiError("invalid_request", "The body must be a JSON object.", 400);

  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  for (const key of ["noteType", "body", "occurredAt"] as const) {
    if (payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== "string") {
      return staffApiError("invalid_request", `${key} must be a string.`, 400);
    }
  }
  const body = text(payload.body);
  if (body.length > MAX_NOTE_LENGTH) {
    return staffApiError("invalid_request", `body must be at most ${MAX_NOTE_LENGTH} characters.`, 400);
  }

  const parsed = validateClientNoteInput({
    clientId: normalizedClientId,
    noteType: text(payload.noteType),
    body,
    occurredAt: text(payload.occurredAt),
  });
  if (!parsed.ok) {
    return staffApiError(
      "invalid_request",
      parsed.reason === "missing_fields"
        ? "body is required."
        : parsed.reason === "invalid_type"
          ? "noteType is not one of general, follow_up, sales, lesson, billing, concern."
          : "occurredAt must be an ISO 8601 date-time.",
      400,
    );
  }

  try {
    const result = await addClientActivityNote({
      supabase: guard.supabase,
      studioId: guard.studioId,
      clientId: normalizedClientId.toLowerCase(),
      userId: guard.user.id,
      input: parsed.input,
      dedupeWithinSeconds: DEDUPE_WINDOW_SECONDS,
    });

    if (!result.ok) {
      if (result.reason === "client_not_found") return staffApiError("not_found", "Client not found.", 404);
      throw new Error("Client note save failed.");
    }

    // staffApiJson always answers 200 (and lives under src/lib/auth, owner-gated), so the 201 is built here with the same headers.
    const ok = staffApiJson({ note: result.note });
    return result.created ? NextResponse.json({ note: result.note }, { status: 201, headers: ok.headers }) : ok;
  } catch (failure) {
    return staffApiUnavailable(new URL(request.url).pathname, failure);
  }
}
