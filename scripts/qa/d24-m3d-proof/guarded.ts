// The guarded client: the ONLY way scenarios talk to Stripe. Order of every call:
//   1. allow-list (refuses finalize/send/pay/void/mark_uncollectible and everything unlisted) -> ProofAbort("blocked_request"), no I/O
//   2. DELETE-invoice-only-if-seen-as-draft check
//   3. hard call budget (40 total; the last CLEANUP_RESERVE are only usable by cleanup) -> ProofAbort("budget_exceeded"), no I/O
//   4. transport (the network) with the key
//   5. response checks: livemode:true anywhere, non-draft invoice, 429, 5xx streak, unexpected 4xx streak
// Every step is appended to a redacted transcript.

import { evaluateRequest } from "./allowlist";
import { maskIdempotencyKey, redactText, summarizeBody } from "./redact";
import { CLEANUP_RESERVE, HARD_CALL_CAP, STRIPE_API_VERSION } from "./config";
import { ProofAbort, type ProofRequest, type ProofResponse, type Transport, type TranscriptEntry } from "./types";

export { CLEANUP_RESERVE, HARD_CALL_CAP };

export type GuardedOptions = {
  transport: Transport;
  apiKey: string;
  connectedAcct: string;
  budget?: number;
  cleanupReserve?: number;
  paceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Polled before every call; true = the operator interrupted (Ctrl-C). Scenarios stop, cleanup still runs. */
  shouldStop?: () => boolean;
};

export type CallOptions = {
  /** Statuses that count as the expected outcome (default: any 2xx). */
  expectStatus?: number[];
  /** Cleanup calls may use the reserved tail of the budget. */
  phase?: "scenario" | "cleanup";
  note?: string;
};

export type GuardedClient = {
  call(req: ProofRequest, opts?: CallOptions): Promise<ProofResponse>;
  transcript: TranscriptEntry[];
  stats(): { used: number; blocked: number; budget: number };
  /** invoice ids seen as drafts / non-drafts / customers created, for cleanup */
  seen: { drafts: Set<string>; nonDrafts: Set<string>; customers: Set<string> };
  /** POSTs whose response was lost (objects may exist at Stripe that were never seen) */
  uncertain: string[];
  aborted(): ProofAbort | null;
  /** Called ONLY by the identity gate after both pinned ids matched. Until then every non-identity request is refused before any network I/O. */
  /** Records an abort (first one wins; a no-further-call abort is never downgraded) and returns it for the caller to throw. */
  raise(code: ConstructorParameters<typeof ProofAbort>[0], message: string): ProofAbort;
  markIdentityVerified(): void;
  identityVerified(): boolean;
  /** Stripe-Version values Stripe reported in responses (all must equal the pin; recorded as evidence). */
  versionsSeen: Set<string>;
};

export function createGuardedClient(o: GuardedOptions): GuardedClient {
  // numbers are sanitised so NaN / negative / oversized values can never lift the absolute cap of 40
  const num = (v: number | undefined, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : dflt);
  const budget = Math.max(0, Math.min(num(o.budget, HARD_CALL_CAP), HARD_CALL_CAP));
  const reserve = Math.max(0, Math.min(num(o.cleanupReserve, CLEANUP_RESERVE), budget));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => new Date());
  const paceMs = o.paceMs ?? 250;
  const transcript: TranscriptEntry[] = [];
  const uncertain: string[] = [];
  const seen = { drafts: new Set<string>(), nonDrafts: new Set<string>(), customers: new Set<string>() };
  const versionsSeen = new Set<string>();
  let identityOk = false;
  let used = 0;
  let blocked = 0;
  let serverStreak = 0;
  let unexpectedStreak = 0;
  let abort: ProofAbort | null = null;

  const entry = (req: ProofRequest, status: TranscriptEntry["status"], extra: Partial<TranscriptEntry> = {}): TranscriptEntry => {
    const e: TranscriptEntry = {
      n: transcript.length + 1,
      atUtc: now().toISOString(),
      method: req.method,
      path: redactText(req.path),
      query: redactText(new URLSearchParams(req.query ?? {}).toString()),
      stripeAccount: req.stripeAccount ?? "-",
      idempotencyKey: maskIdempotencyKey(req.idempotencyKey),
      stripeVersion: req.stripeVersion ?? "-",
      status,
      requestId: "-",
      replayed: null,
      summary: {},
      ...extra,
    };
    transcript.push(e);
    return e;
  };
  // The FIRST abort wins, except that an abort which forbids any further call (NO_CLEANUP_AFTER) is never downgraded by a later, weaker one
  // (a parallel call finishing after a livemode:true must not turn it into "rate_limited" and re-enable cleanup).
  const raise = (code: ConstructorParameters<typeof ProofAbort>[0], msg: string): ProofAbort => {
    const err = new ProofAbort(code, redactText(msg));
    if (!abort || (NO_CLEANUP_AFTER.has(code) && !NO_CLEANUP_AFTER.has(abort.code))) abort = err;
    return err;
  };
  const fail = (code: ConstructorParameters<typeof ProofAbort>[0], msg: string): never => {
    throw raise(code, msg);
  };
  /** Refuses a call when the run has already aborted (cleanup excepted after a benign abort). Also polls the operator interrupt. */
  const gate = (opts: CallOptions) => {
    if (o.shouldStop?.() && !abort) abort = new ProofAbort("interrupted", "interrupted by the operator");
    if (abort && !(opts.phase === "cleanup" && !NO_CLEANUP_AFTER.has(abort.code))) throw abort;
  };
  const worthless = (r: ProofResponse) => r.status >= 500 || r.json === null || (r.status >= 200 && r.status < 300 && typeof r.json.id !== "string" && r.json.object !== "list");

  async function call(input: ProofRequest, opts: CallOptions = {}): Promise<ProofResponse> {
    // the request is copied and frozen BEFORE validation; exactly this copy is what gets sent (no mutation between check and send)
    const req: ProofRequest = Object.freeze(structuredClone(input));
    gate(opts);
    // 1. allow-list, before anything else
    const v = evaluateRequest(req, { connectedAcct: o.connectedAcct });
    if (!v.ok) {
      blocked += 1;
      entry(req, "BLOCKED", { note: v.reason });
      return fail("blocked_request", `blocked before network I/O: ${v.reason}`);
    }
    // 1b. nothing but the two identity reads may be sent before BOTH pinned ids matched
    if (!v.rule.startsWith("identity.") && !identityOk) {
      blocked += 1;
      entry(req, "BLOCKED", { note: "identity gate has not passed" });
      return fail("identity_not_verified", `refused before network I/O: ${v.rule} needs the identity gate to pass first`);
    }
    // 2. object scope: the run may only touch objects it created itself (drafts it saw, customers it created)
    const tail = req.path.split("/");
    const scope = (ok: boolean, what: string) => {
      if (ok) return;
      blocked += 1;
      entry(req, "BLOCKED", { note: `${what} was not created by this run` });
      fail("blocked_request", `${v.rule} refused: ${what} was not created by this run`);
    };
    if (v.rule === "invoice.delete_draft") scope(seen.drafts.has(tail[tail.length - 1]), `invoice ${tail[tail.length - 1]} (not observed as a draft)`);
    if (v.rule === "customer.delete") scope(seen.customers.has(tail[tail.length - 1]), `customer ${tail[tail.length - 1]}`);
    if (v.rule === "invoice.add_lines") scope(seen.drafts.has(tail[3]), `invoice ${tail[3]} (not observed as a draft)`);
    // reads and creates are scoped to the run's own customers / invoices too, so a foreign object can never enter `seen` (and later be deleted by cleanup)
    if (v.rule === "invoice.create_draft") scope(seen.customers.has(req.body?.customer ?? ""), `customer ${req.body?.customer ?? "?"}`);
    if (v.rule === "invoice.list_by_customer") scope(seen.customers.has(req.query?.customer ?? ""), `customer ${req.query?.customer ?? "?"}`);
    if (v.rule === "invoice.read") scope(seen.drafts.has(tail[tail.length - 1]), `invoice ${tail[tail.length - 1]} (not observed as a draft)`);
    // 3. budget (synchronous, so concurrent callers cannot overshoot)
    const limit = opts.phase === "cleanup" ? budget : budget - reserve;
    if (used >= limit) {
      entry(req, "BLOCKED", { note: `call budget ${used}/${limit} reached` });
      return fail("budget_exceeded", `call budget exhausted (${used} used, limit ${limit}${opts.phase === "cleanup" ? "" : `, ${reserve} reserved for cleanup`})`);
    }
    used += 1;
    if (paceMs > 0 && used > 1) {
      await sleep(paceMs);
      gate(opts); // an abort or interrupt that happened while this call was waiting stops it BEFORE the network
    }
    // 4. network
    let res: ProofResponse;
    try {
      res = await o.transport(req, o.apiKey);
    } catch (err) {
      entry(req, "ERROR", { note: redactText(String((err as Error)?.message ?? err)) });
      // the response was lost: a create may exist at Stripe that we never saw. Cleanup must not claim "empty".
      if (req.method === "POST") uncertain.push(`${req.path} idem=${maskIdempotencyKey(req.idempotencyKey)}`);
      throw err;
    }
    const e = entry(req, res.status, { requestId: res.requestId ?? "-", replayed: res.replayed ?? null, summary: summarizeBody(res.json), note: opts.note });
    // a create that came back as a gateway error / unparseable body / 2xx without an id may still have been committed at Stripe
    if (req.method === "POST" && worthless(res)) uncertain.push(`${req.path} idem=${maskIdempotencyKey(req.idempotencyKey)} (status ${res.status}, no usable body)`);
    // 5. response checks
    if (res.stripeVersion !== undefined) {
      versionsSeen.add(res.stripeVersion);
      if (res.stripeVersion !== STRIPE_API_VERSION) return fail("version_mismatch", `Stripe answered with API version ${JSON.stringify(res.stripeVersion.slice(0, 40))}, not the pinned ${STRIPE_API_VERSION}`);
    } else {
      // Stripe always reports the version it used; a response without it is not trusted (blocked requests never get here)
      return fail("version_mismatch", `the ${v.rule} response did not report a Stripe-Version`);
    }
    const body = res.json;
    if (body) {
      const asText = JSON.stringify(body);
      if (body.livemode === true || /"livemode":\s*true/.test(asText)) return fail("livemode_true", `livemode:true in a response (${req.method} ${req.path})`);
      // objects the run creates must POSITIVELY report test mode (livemode === false); a missing flag is not accepted
      if (req.method === "POST" && (body.object === "customer" || body.object === "invoice") && body.livemode !== false) {
        return fail("livemode_true", `a created ${String(body.object)} did not report livemode:false`);
      }
      if (body.deleted === true && typeof body.id === "string") {
        seen.drafts.delete(body.id);
        seen.customers.delete(body.id);
      } else if (body.object === "invoice" && typeof body.id === "string") {
        if (body.status === "draft") seen.drafts.add(body.id);
        else if (typeof body.status === "string") {
          seen.nonDrafts.add(body.id);
          seen.drafts.delete(body.id);
          return fail("non_draft_invoice", `invoice ${body.id} has status ${String(body.status)}`);
        }
      }
      if (body.object === "customer" && typeof body.id === "string" && !body.deleted) seen.customers.add(body.id);
      if (body.object === "list" && Array.isArray(body.data)) {
        for (const d of body.data as Array<Record<string, unknown>>) {
          if (d?.object === "invoice" && typeof d.id === "string") {
            if (d.status === "draft") seen.drafts.add(d.id);
            else if (typeof d.status === "string") {
              seen.nonDrafts.add(d.id);
              return fail("non_draft_invoice", `invoice ${d.id} has status ${String(d.status)}`);
            }
          }
        }
      }
    }
    if (res.status === 429) return fail("rate_limited", "HTTP 429 from Stripe");
    if (res.status >= 500) {
      serverStreak += 1;
      if (serverStreak >= 3) return fail("server_error_streak", "three consecutive 5xx responses");
    } else serverStreak = 0;
    const expected = opts.expectStatus ? opts.expectStatus.includes(res.status) : res.status >= 200 && res.status < 300;
    if (!expected) {
      e.note = [e.note, "unexpected status"].filter(Boolean).join("; ");
      if (res.status >= 400 && res.status < 500) {
        unexpectedStreak += 1;
        if (unexpectedStreak >= 2) return fail("unexpected_4xx_streak", "two consecutive unexpected 4xx responses");
      }
    } else unexpectedStreak = 0;
    return res;
  }

  return {
    call, transcript, seen, uncertain, versionsSeen,
    stats: () => ({ used, blocked, budget }),
    aborted: () => abort,
    raise,
    markIdentityVerified: () => { identityOk = true; },
    identityVerified: () => identityOk,
  };
}

/** Every scenario/cleanup request goes through this: it stamps the pinned Stripe-Version. The guard itself still refuses any request that arrives without it. */
export function pinned(client: GuardedClient, req: Omit<ProofRequest, "stripeVersion">, opts?: CallOptions): Promise<ProofResponse> {
  return client.call({ ...req, stripeVersion: STRIPE_API_VERSION }, opts);
}

/** After these aborts the run makes NO further Stripe call (cleanup included): another call could hit the wrong account/mode/version. */
export const NO_CLEANUP_AFTER: ReadonlySet<string> = new Set(["livemode_true", "identity_mismatch", "blocked_request", "version_mismatch", "environment_refused", "key_refused"]);
