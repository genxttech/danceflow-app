import { evaluateAssurance, type AssuranceRefusal } from "@/lib/auth/platform-assurance";

/**
 * D24 M2-B: framework-free core of the operator workflow (acknowledge anomalies, dismiss unmatched invoices, requeue rejected deferred events, review).
 *
 * Authority is decided in the database (migration 20270205090000): the actor is auth.uid() of the caller's own JWT, the role and tenant are checked in SQL,
 * and SQL requires aal2 itself. This module is the defence-in-depth layer in front of it:
 *   - dark unless D24_OPERATOR_ACTIONS is exactly "enabled";
 *   - the VERIFIED session claims (auth.getClaims) must be aal2 with a TOTP method, belong to the signed-in user, and not be expired;
 *   - inputs are validated before any call; the RPC arguments are built from an allow-list, so no actor / user id / studio id from a caller can reach the database;
 *   - the database error codes are mapped to stable, non-leaking result codes.
 * It must be called with the CALLER's user-scoped Supabase client, never the service-role client (the service role has no auth.uid() and the functions refuse it).
 */

export type OperatorAction = "acknowledge" | "dismiss" | "requeue" | "list_invoices" | "get_invoice" | "list_deferred";

export type OperatorResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      code:
        | "disabled" | "unauthenticated" | "mfa_required" | "invalid_input" | "forbidden" | "not_found" | "not_allowed_state"
        | "limit_reached" | "unavailable";
      assurance?: AssuranceRefusal;
    };

export type OperatorDeps = {
  env: Record<string, string | undefined>;
  nowSeconds: number;
  userId: string | null;
  /** Verified claims from auth.getClaims(); null/undefined when unavailable. */
  claims: Record<string, unknown> | null | undefined;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID = /^evt_[A-Za-z0-9_]{1,200}$/;
const CODE = /^[a-z][a-z0-9_]{1,63}$/;
const STATES = new Set(["unmatched", "anomalous", "resolved", "clear", "out_of_scope"]);
const DEFERRED_STATES = new Set(["pending", "applied", "rejected"]);

export const OPERATOR_REASON_MIN = 10;
export const OPERATOR_REASON_MAX = 1000;

const fail = (code: Exclude<OperatorResult, { ok: true }>["code"], assurance?: AssuranceRefusal): OperatorResult => ({ ok: false, code, ...(assurance ? { assurance } : {}) });

function reasonOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= OPERATOR_REASON_MIN && t.length <= OPERATOR_REASON_MAX ? t : null;
}

function intOf(v: unknown, fallback: number, min: number, max: number): number | null {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** Build the allow-listed RPC call, or null when the input is invalid. */
export function buildOperatorCall(action: OperatorAction, input: Record<string, unknown>): { fn: string; args: Record<string, unknown> } | null {
  switch (action) {
    case "acknowledge": {
      const reason = reasonOf(input.reason);
      const codes = input.codes;
      if (!reason || typeof input.invoiceRowId !== "string" || !UUID.test(input.invoiceRowId)) return null;
      if (!Array.isArray(codes) || codes.length < 1 || codes.length > 20 || !codes.every((c) => typeof c === "string" && CODE.test(c))) return null;
      return { fn: "d24_op_acknowledge_anomalies", args: { p_invoice_row_id: input.invoiceRowId, p_codes: [...new Set(codes as string[])], p_reason: reason } };
    }
    case "dismiss": {
      const reason = reasonOf(input.reason);
      if (!reason || typeof input.invoiceRowId !== "string" || !UUID.test(input.invoiceRowId)) return null;
      return { fn: "d24_op_dismiss_unmatched", args: { p_invoice_row_id: input.invoiceRowId, p_reason: reason } };
    }
    case "requeue": {
      const reason = reasonOf(input.reason);
      if (!reason || typeof input.providerEventId !== "string" || !EVENT_ID.test(input.providerEventId)) return null;
      return { fn: "d24_op_requeue_deferred", args: { p_provider_event_id: input.providerEventId, p_reason: reason } };
    }
    case "get_invoice":
      if (typeof input.invoiceRowId !== "string" || !UUID.test(input.invoiceRowId)) return null;
      return { fn: "d24_op_get_invoice", args: { p_invoice_row_id: input.invoiceRowId } };
    case "list_invoices": {
      const state = input.state ?? null;
      const studio = input.studioId ?? null;
      const limit = intOf(input.limit, 50, 1, 200);
      const offset = intOf(input.offset, 0, 0, 100000);
      if ((state !== null && (typeof state !== "string" || !STATES.has(state))) || (studio !== null && (typeof studio !== "string" || !UUID.test(studio))) || limit === null || offset === null) return null;
      return { fn: "d24_op_list_invoices", args: { p_state: state, p_studio_id: studio, p_include_dismissed: input.includeDismissed === true, p_limit: limit, p_offset: offset } };
    }
    case "list_deferred": {
      const state = input.state === undefined ? "rejected" : input.state;
      const limit = intOf(input.limit, 50, 1, 200);
      const offset = intOf(input.offset, 0, 0, 100000);
      if ((state !== null && (typeof state !== "string" || !DEFERRED_STATES.has(state))) || limit === null || offset === null) return null;
      return { fn: "d24_op_list_deferred", args: { p_state: state, p_limit: limit, p_offset: offset } };
    }
    default:
      return null;
  }
}

/** Database error -> stable code. Unknown errors are "unavailable"; no message text is ever returned. */
function mapError(err: { code?: string; message?: string }): OperatorResult {
  const msg = err.message ?? "";
  if (msg.includes("d24_op_aal2_required")) return fail("mfa_required");
  if (msg.includes("d24_op_authentication_required")) return fail("unauthenticated");
  if (err.code === "42501") return fail("forbidden");
  if (err.code === "P0002") return fail("not_found");
  if (msg.includes("d24_op_requeue_limit_reached")) return fail("limit_reached");
  if (err.code === "55000") return fail("not_allowed_state");
  if (err.code === "22023") return fail("invalid_input");
  return fail("unavailable");
}

export async function runOperatorAction(deps: OperatorDeps, action: OperatorAction, input: Record<string, unknown>): Promise<OperatorResult> {
  if (deps.env.D24_OPERATOR_ACTIONS !== "enabled") return fail("disabled");
  if (!deps.userId) return fail("unauthenticated");
  const decision = evaluateAssurance(deps.claims, deps.nowSeconds, "aal2", deps.userId);
  if (!decision.ok) return fail("mfa_required", decision.reason);
  const call = buildOperatorCall(action, input ?? {});
  if (!call) return fail("invalid_input");
  try {
    const { data, error } = await deps.rpc(call.fn, call.args);
    if (error) return mapError(error);
    return { ok: true, data };
  } catch {
    return fail("unavailable");
  }
}
