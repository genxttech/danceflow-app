export type CheckoutOutcome = { ok: true; url: string } | { ok: false; message: string };

const FAILED = "We could not start the payment. Nothing was charged.";

/** Calls the checkout route and returns where to send the browser. Only an https URL is ever followed. */
export async function startCreditCheckout(packCents: number, fetchImpl: typeof fetch = fetch): Promise<CheckoutOutcome> {
  try {
    const response = await fetchImpl("/api/billing/sms-credits/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packCents }) });
    const body = (await response.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
    if (!response.ok) {
      if (response.status === 404) return { ok: false, message: "Credit purchases are not open yet." };
      return { ok: false, message: typeof body.error === "string" && body.error ? body.error : FAILED };
    }
    if (typeof body.url !== "string") return { ok: false, message: FAILED };
    let target: URL;
    try {
      target = new URL(body.url);
    } catch {
      return { ok: false, message: FAILED };
    }
    if (target.protocol !== "https:") return { ok: false, message: FAILED };
    return { ok: true, url: target.toString() };
  } catch {
    return { ok: false, message: "We could not reach the payment page. Nothing was charged." };
  }
}
