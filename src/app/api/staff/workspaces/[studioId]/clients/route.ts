import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { canEditClients } from "@/lib/auth/permissions";
import {
  requireStaffApi,
  staffApiError,
  staffApiJson,
  staffApiUnavailable,
} from "@/lib/auth/staffApiAuth";
import { clientLookupScope, decodeCursor, searchClients } from "@/lib/staff/clients";
import { quickAddClient } from "@/lib/staff/clientCreate";
import { cleanTextValue, normalizeOptionalEmail, normalizeOptionalPhone } from "@/lib/validation/forms";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const MAX_QUERY = 80;

export async function GET(request: Request, { params }: { params: Promise<{ studioId: string }> }) {
  const { studioId } = await params;
  const guard = await requireStaffApi(request, studioId);
  if (!guard.ok) return guard.response;

  const scope = clientLookupScope(guard.studioRole);
  if (!scope) return staffApiError("role_not_permitted", "Your role cannot look up clients.", 403);

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length > MAX_QUERY) return staffApiError("invalid_request", `q must be at most ${MAX_QUERY} characters.`, 400);

  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return staffApiError("invalid_request", `limit must be an integer from 1 to ${MAX_LIMIT}.`, 400);
  }

  const cursor = decodeCursor(url.searchParams.get("cursor"));
  if (cursor === "invalid") return staffApiError("invalid_request", "cursor is not valid.", 400);

  try {
    return staffApiJson(await searchClients({ supabase: guard.supabase, studioId: guard.studioId, scope, q, cursor, limit }));
  } catch (failure) {
    return staffApiUnavailable(url.pathname, failure);
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_:.-]{8,128}$/;
const BODY_FIELDS = ["firstName", "lastName", "phone", "email", "note", "allowDuplicatePhone"] as const;

/**
 * Quick add (client slice C2). The same create path as the web "New client" action (src/lib/staff/clientCreate.ts) with a minimal field set.
 * Roles: canEditClients (owner, admin, front desk), like the web action. See docs/mobile/Staff_API_Contract.md.
 */
export async function POST(request: Request, { params }: { params: Promise<{ studioId: string }> }) {
  const { studioId } = await params;
  const guard = await requireStaffApi(request, studioId);
  if (!guard.ok) return guard.response;

  if (!canEditClients(guard.studioRole)) {
    return staffApiError("role_not_permitted", "Your role cannot add clients.", 403);
  }

  if (!IDEMPOTENCY_KEY.test(request.headers.get("idempotency-key") ?? "")) {
    return staffApiError("invalid_request", "An Idempotency-Key header (8-128 letters, digits, - _ : .) is required.", 400);
  }

  let payload: Record<string, unknown> | null;
  try {
    payload = (await request.json()) as Record<string, unknown> | null;
  } catch {
    return staffApiError("invalid_request", "The body must be JSON.", 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return staffApiError("invalid_request", "The body must be a JSON object.", 400);
  }

  for (const key of BODY_FIELDS) {
    const value = payload[key];
    const expected = key === "allowDuplicatePhone" ? "boolean" : "string";
    if (value !== undefined && value !== null && typeof value !== expected) {
      return staffApiError("invalid_request", `${key} must be a ${expected}.`, 400);
    }
  }

  // The web action's own validators (same limits and messages), on the fields the quick add accepts.
  const asText = (value: unknown) => (typeof value === "string" ? value : "");
  const firstName = cleanTextValue(asText(payload.firstName), { fieldLabel: "First name", maxLength: 80, required: true });
  const lastName = cleanTextValue(asText(payload.lastName), { fieldLabel: "Last name", maxLength: 80, required: true });
  const email = normalizeOptionalEmail(asText(payload.email));
  const phone = normalizeOptionalPhone(asText(payload.phone));
  const note = cleanTextValue(asText(payload.note), { fieldLabel: "Notes", maxLength: 3000, allowNewlines: true });
  for (const result of [firstName, lastName, email, phone, note]) {
    if (!result.ok) return staffApiError("invalid_request", result.error, 400);
  }
  if (!firstName.ok || !lastName.ok || !email.ok || !phone.ok || !note.ok) return staffApiError("invalid_request", "Invalid client details.", 400);
  if (!email.value && !phone.value) {
    return staffApiError("invalid_request", "A phone number or an email is required.", 400);
  }

  try {
    const result = await quickAddClient({
      supabase: guard.supabase,
      studioId: guard.studioId,
      newClientId: randomUUID(),
      input: {
        firstName: firstName.value,
        lastName: lastName.value,
        email: email.value,
        phone: phone.value,
        note: note.value,
        allowDuplicatePhone: payload.allowDuplicatePhone === true,
      },
    });

    if (!result.ok) {
      if (result.reason === "duplicate_client") {
        return NextResponse.json(
          {
            error: result.matchedOn === "email" ? "A client with this email already exists in this studio." : "A client with this phone number already exists in this studio.",
            code: "duplicate_client",
            existingClientId: result.existingClientId,
            matchedOn: result.matchedOn,
          },
          { status: 409, headers: { "Cache-Control": "private, no-store" } },
        );
      }
      throw new Error("Client creation failed.");
    }

    return NextResponse.json({ client: result.client }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (failure) {
    return staffApiUnavailable(new URL(request.url).pathname, failure);
  }
}
