/**
 * CF1 Stripe-TEST acceptance: Connect event relay (pure parts).
 *
 * The Competition acceptance harness expects Stripe to deliver authentic Connect events to the local app
 * (`stripe listen --forward-connect-to <app>/api/payments/webhook`). On the GitHub runner there is no Stripe CLI to pin, so a small
 * relay reads the connected account's events with the TEST key (events.list) and POSTs each one, signed with a LOCAL secret the
 * app was started with, to the app's real webhook route. The app's signature verification, claim and handlers run unchanged.
 *
 * Nothing in this file reads the environment, the file system or the network by itself: every effect is injected, so the unit
 * tests need no Stripe account. It never logs a key, a secret, a signature or a body.
 */
import { createHmac } from "node:crypto";

/**
 * Anything that could carry a credential is masked before it is logged, reported or written to a summary (Stripe's own error text can echo a masked key).
 * No word-boundary anchors on purpose: a credential glued to other word characters (an id like req_sk_test_..., a prefix_whsec_...) must still be masked,
 * and a false positive only costs a redacted token.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9*_]+/g, "[redacted-key]")
    .replace(/whsec_[A-Za-z0-9*_]+/g, "[redacted-secret]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted-jwt]");
}

/** Stripe's documented scheme: `t=<unix>,v1=hex(HMAC_SHA256(secret, "<t>.<body>"))`. */
export function signStripePayload(body: string, secret: string, timestampSeconds: number): string {
  const signature = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

export type RelayEvent = { id: string; type: string; created: number; account?: string | null; [key: string]: unknown };

/**
 * The exact body that is delivered for an event. Deterministic for a given event and account, so a second delivery of the same
 * event is byte-identical (the app's claim keys on the event id alone, so any re-delivery is acknowledged as already processed; byte-identity just keeps a replay a faithful copy).
 */
export function buildDeliveryBody(event: RelayEvent, account: string): string {
  return JSON.stringify({ ...event, account: event.account ?? account });
}

/** Oldest first (created, then id), so events are delivered in the order Stripe created them. */
export function oldestFirst<T extends { id: string; created: number }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function selectUnseen<T extends { id: string }>(events: readonly T[], seen: ReadonlySet<string>): T[] {
  return events.filter((event) => !seen.has(event.id));
}

/** The relay only ever talks to a local app and only ever uses a TEST key. */
export function assertRelayTarget(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("relay target is not a URL"); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("refusing: relay target is not loopback");
  if (parsed.protocol !== "http:") throw new Error("refusing: relay target must be plain http on loopback");
  if (parsed.pathname !== "/api/payments/webhook") throw new Error("refusing: relay target path must be /api/payments/webhook");
  return parsed;
}

export function assertTestKey(key: string): void {
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) throw new Error("refusing: not a Stripe TEST key");
}

export type DeliveryResult = { eventId: string; type: string; status: number };

export type DeliverFn = (input: { url: string; body: string; signature: string }) => Promise<number>;

/**
 * The relay's only network write. It re-validates the target on every delivery (loopback, plain http, the webhook path) and NEVER follows a redirect:
 * `redirect: "manual"` returns the 3xx response itself, so a response can not steer the signed body (and its signature) to another host or path.
 * A 3xx is reported to the caller as a non-success status.
 */
export function makePost(fetchImpl: typeof fetch = fetch): DeliverFn {
  return async ({ url, body, signature }) => {
    const target = assertRelayTarget(url).toString();
    const response = await fetchImpl(target, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "stripe-signature": signature }, body });
    await response.text();
    return response.status;
  };
}

/** Sign and POST one event. `now` is injected for tests. */
export async function deliverEvent(input: {
  url: string; secret: string; event: RelayEvent; account: string; post: DeliverFn; nowSeconds?: () => number;
}): Promise<DeliveryResult> {
  const body = buildDeliveryBody(input.event, input.account);
  const timestamp = (input.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const status = await input.post({ url: input.url, body, signature: signStripePayload(body, input.secret, timestamp) });
  return { eventId: input.event.id, type: input.event.type, status };
}

export type RelayStats = {
  polls: number; listed: number; delivered: number; okResponses: number; clientErrors: number; serverErrors: number; paused: number; retried: number; gaveUp: number; stoppedBy: "maxPolls" | "signal";
};

export type RelayDeps = {
  /** One page-set of the connected account's events created at or after `sinceSeconds`, any order. */
  listEvents: (sinceSeconds: number) => Promise<RelayEvent[]>;
  post: DeliverFn;
  isPaused: () => Promise<boolean> | boolean;
  sleep: (ms: number) => Promise<void>;
  shouldStop: () => boolean;
  log: (line: string) => void;
  nowSeconds?: () => number;
};

/**
 * Poll, then deliver unseen events oldest first. A 5xx response leaves the event unseen so the next poll retries it (Stripe
 * retries too); a 2xx or 4xx marks it seen (a 4xx will not change on retry and is counted for the evidence). While paused nothing
 * is listed or delivered and nothing is marked seen, so the paused window's events are delivered afterwards, in order, unless a
 * test delivered them first (the app acknowledges a processed event idempotently).
 */
export async function runRelay(input: {
  url: string; secret: string; account: string; startedAtSeconds: number; pollMs: number; maxPolls: number; deps: RelayDeps;
}): Promise<RelayStats> {
  const { deps } = input;
  const seen = new Set<string>();
  const attempts = new Map<string, number>();
  // A poison event must not stall every later event for the rest of the run: after this many failed deliveries it is given up on, counted and logged (the test that needed it fails on its own evidence).
  const maxAttemptsPerEvent = 5;
  const failed = (event: RelayEvent) => {
    const n = (attempts.get(event.id) ?? 0) + 1;
    attempts.set(event.id, n);
    stats.retried += 1;
    if (n >= maxAttemptsPerEvent) { seen.add(event.id); stats.gaveUp += 1; deps.log(`relay: giving up on ${event.type} ${event.id} after ${n} failed deliveries`); }
  };
  const stats: RelayStats = { polls: 0, listed: 0, delivered: 0, okResponses: 0, clientErrors: 0, serverErrors: 0, paused: 0, retried: 0, gaveUp: 0, stoppedBy: "maxPolls" };
  // Stripe's `created` has one-second resolution and delivery is not instantaneous: look back a little, `seen` removes duplicates.
  const lookbackSeconds = 30;
  let newestSeen = input.startedAtSeconds;
  while (stats.polls < input.maxPolls) {
    if (deps.shouldStop()) { stats.stoppedBy = "signal"; break; }
    if (await deps.isPaused()) { stats.paused += 1; await deps.sleep(input.pollMs); continue; }
    stats.polls += 1;
    let events: RelayEvent[] = [];
    try {
      events = await deps.listEvents(Math.max(0, newestSeen - lookbackSeconds));
    } catch (error) {
      deps.log(`relay: events.list failed (${redactSecrets(error instanceof Error ? error.message : "error").slice(0, 120)}); will retry`);
    }
    stats.listed += events.length;
    for (const event of oldestFirst(selectUnseen(events, seen))) {
      if (await deps.isPaused()) break;
      let result: DeliveryResult;
      try {
        result = await deliverEvent({ url: input.url, secret: input.secret, event, account: input.account, post: deps.post, nowSeconds: deps.nowSeconds });
      } catch (error) {
        deps.log(`relay: delivery of ${event.type} failed (${redactSecrets(error instanceof Error ? error.message : "error").slice(0, 120)}); will retry`);
        failed(event);
        break;
      }
      stats.delivered += 1;
      if (result.status >= 500) { stats.serverErrors += 1; failed(event); deps.log(`relay: ${event.type} ${event.id} -> ${result.status} (will retry)`); break; }
      seen.add(event.id);
      if (event.created > newestSeen) newestSeen = event.created;
      // 3xx is a failure too: redirects are never followed (makePost), and the app's webhook route does not redirect. Counted, logged, not retried.
      if (result.status >= 300) { stats.clientErrors += 1; deps.log(`relay: ${event.type} ${event.id} -> ${result.status}${result.status < 400 ? " (redirect not followed)" : ""}`); } else stats.okResponses += 1;
    }
    await deps.sleep(input.pollMs);
  }
  return stats;
}
