// The real (network) transport. It exists so a LIVE run is possible after the owner authorizes it; nothing in this PR calls it against Stripe.
// It is only ever invoked by the guarded client AFTER the allow-list approved the request, and it can reach exactly one host.
//
// Why node:https and not fetch: Node's global fetch is undici with a keep-alive connection pool and does not let a caller force connection-close. This transport uses
// `agent: false` and `Connection: close`, i.e. ONE fresh connection per request, no pooling, no pipelining, no redirects, and no library-level retry (node:http has none).
// A reset mid-flight therefore surfaces as an error exactly once, and the guard records a lost POST as unverifiable. transport.test.ts proves it against a loopback
// server that counts the requests it receives.

import http from "node:http";
import https from "node:https";
import type { ProofRequest, ProofResponse, Transport } from "./types";

export const STRIPE_API_ORIGIN = "https://api.stripe.com";
/** Tests may point the transport at a loopback server and nowhere else. */
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;
const MAX_BODY_BYTES = 1_000_000;

export type NodeTransportOptions = { origin?: string; timeoutMs?: number };

export function createNodeTransport(opts: NodeTransportOptions = {}): Transport {
  const origin = opts.origin ?? STRIPE_API_ORIGIN;
  if (origin !== STRIPE_API_ORIGIN && !LOOPBACK_ORIGIN.test(origin)) throw new Error("refusing: the transport may only reach api.stripe.com (or a 127.0.0.1 test server)");
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const lib = origin.startsWith("https:") ? https : http;

  return (req: ProofRequest, apiKey: string): Promise<ProofResponse> =>
    new Promise<ProofResponse>((resolve, reject) => {
      const url = new URL(req.path, origin);
      if (url.origin !== origin) return reject(new Error("refusing: URL does not resolve to the pinned origin"));
      for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
      const body = req.method === "POST" ? new URLSearchParams(req.body ?? {}).toString() : undefined;
      const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: "application/json", Connection: "close" };
      if (req.stripeAccount) headers["Stripe-Account"] = req.stripeAccount;
      if (req.stripeVersion) headers["Stripe-Version"] = req.stripeVersion;
      if (req.idempotencyKey) headers["Idempotency-Key"] = req.idempotencyKey;
      if (body !== undefined) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        headers["Content-Length"] = String(Buffer.byteLength(body));
      }
      const r = lib.request(url, { method: req.method, headers, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) return r.destroy(new Error("response body too large"));
          chunks.push(c);
        });
        res.on("error", reject);
        res.on("end", () => {
          let json: Record<string, unknown> | null = null;
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const parsed: unknown = JSON.parse(raw);
            // only a plain JSON object is a usable body; a scalar or an array is treated like an unparseable one
            json = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
            // duplicate keys: JSON.parse keeps the LAST one, which could hide an earlier "livemode":true. Scan the raw text and force the flag so the guard sees it.
            if (json && /"livemode"\s*:\s*true/.test(raw)) json = { ...json, livemode: true };
          } catch {
            json = null;
          }
          const one = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h);
          resolve({
            status: res.statusCode ?? 0,
            requestId: one(res.headers["request-id"]),
            stripeVersion: one(res.headers["stripe-version"]),
            replayed: one(res.headers["idempotent-replayed"]) === "true" ? true : undefined,
            json,
          });
        });
      });
      // two clocks: an idle timeout (nothing arrives for timeoutMs) AND an absolute deadline for the whole exchange, so a slow-drip response cannot hold the run (and its cleanup) for long
      r.setTimeout(timeoutMs, () => r.destroy(new Error("request timed out")));
      const deadline = setTimeout(() => r.destroy(new Error("request timed out (deadline)")), timeoutMs);
      r.on("close", () => clearTimeout(deadline));
      r.on("error", (e) => { clearTimeout(deadline); reject(e); });
      r.end(body);
    });
}
