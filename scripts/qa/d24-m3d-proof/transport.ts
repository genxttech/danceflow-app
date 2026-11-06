// The real (network) transport. It exists so a LIVE run is possible after the owner authorizes it; nothing in this PR calls it.
// It is only ever invoked by the guarded client AFTER the allow-list approved the request, and it can reach exactly one host.

import type { ProofRequest, ProofResponse, Transport } from "./types";

export const STRIPE_API_ORIGIN = "https://api.stripe.com";

export function createFetchTransport(fetchImpl: typeof fetch = fetch): Transport {
  return async (req: ProofRequest, apiKey: string): Promise<ProofResponse> => {
    const url = new URL(req.path, STRIPE_API_ORIGIN);
    if (url.origin !== STRIPE_API_ORIGIN) throw new Error("refusing: URL does not resolve to api.stripe.com");
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (req.stripeAccount) headers["Stripe-Account"] = req.stripeAccount;
    if (req.idempotencyKey) headers["Idempotency-Key"] = req.idempotencyKey;
    let body: string | undefined;
    if (req.method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(req.body ?? {}).toString();
    }
    const res = await fetchImpl(url.toString(), { method: req.method, headers, body, redirect: "error" });
    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return {
      status: res.status,
      requestId: res.headers.get("request-id") ?? undefined,
      replayed: res.headers.get("idempotent-replayed") === "true" ? true : undefined,
      json,
    };
  };
}
