export type LimitCallOutcome = { ok: true } | { ok: false; message: string; code?: string };

const FAILED = "We could not save that. Nothing was changed.";

async function post(path: string, body: unknown, fetchImpl: typeof fetch): Promise<LimitCallOutcome> {
  try {
    const response = await fetchImpl(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    if (response.ok) return { ok: true };
    if (response.status === 404) return { ok: false, message: "Spending limits are not open yet." };
    return { ok: false, message: typeof json.error === "string" && json.error ? json.error : FAILED, code: typeof json.code === "string" ? json.code : undefined };
  } catch {
    return { ok: false, message: "We could not reach the server. Nothing was changed." };
  }
}

export const saveMonthlyLimitCall = (input: { limitCents: number; effectiveMonth?: string | null; reason?: string }, fetchImpl: typeof fetch = fetch) =>
  post("/api/billing/sms-limits/set", { limitCents: input.limitCents, confirmed: true, effectiveMonth: input.effectiveMonth ?? null, reason: input.reason ?? null }, fetchImpl);
export const saveTimezoneCall = (input: { timezone: string; reason: string }, fetchImpl: typeof fetch = fetch) => post("/api/billing/sms-limits/timezone", input, fetchImpl);
