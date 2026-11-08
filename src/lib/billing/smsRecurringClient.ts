export type RecurringCallOutcome = { ok: true } | { ok: false; message: string };

const FAILED = "We could not save that. Nothing was charged.";

async function post(path: string, body: unknown, fetchImpl: typeof fetch): Promise<RecurringCallOutcome> {
  try {
    const response = await fetchImpl(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (response.ok) return { ok: true };
    if (response.status === 404) return { ok: false, message: "Recurring charges are not open yet." };
    return { ok: false, message: typeof json.error === "string" && json.error ? json.error : FAILED };
  } catch {
    return { ok: false, message: "We could not reach the server. Nothing was charged." };
  }
}

export const authorizeRecurringCall = (input: { kind: string; acknowledgedPriceCents: number; termMonths: number; totalLimitCents: number }, fetchImpl: typeof fetch = fetch) =>
  post("/api/billing/sms-recurring/authorize", input, fetchImpl);
export const revokeRecurringCall = (authorizationId: string, fetchImpl: typeof fetch = fetch) => post("/api/billing/sms-recurring/revoke", { authorizationId }, fetchImpl);
