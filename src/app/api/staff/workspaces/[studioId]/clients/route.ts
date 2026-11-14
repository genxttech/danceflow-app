import {
  requireStaffApi,
  staffApiError,
  staffApiJson,
  staffApiUnavailable,
} from "@/lib/auth/staffApiAuth";
import { clientLookupScope, decodeCursor, searchClients } from "@/lib/staff/clients";

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
