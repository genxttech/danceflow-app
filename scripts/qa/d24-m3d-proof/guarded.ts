// The guarded client: the ONLY way scenarios talk to Stripe. Order of every call:
//   1. allow-list (refuses finalize/send/pay/void/mark_uncollectible and everything unlisted) -> ProofAbort("blocked_request"), no I/O
//   2. DELETE-invoice-only-if-seen-as-draft check
//   3. hard call budget (40 total; the last CLEANUP_RESERVE are only usable by cleanup) -> ProofAbort("budget_exceeded"), no I/O
//   4. transport (the network) with the key
//   5. response checks: livemode:true anywhere, non-draft invoice, 429, 5xx streak, unexpected 4xx streak
// Every step is appended to a redacted transcript.

import { evaluateRequest } from "./allowlist";
import { maskIdempotencyKey, redactText, summarizeBody } from "./redact";
import { ProofAbort, type ProofRequest, type ProofResponse, type Transport, type TranscriptEntry } from "./types";

export const HARD_CALL_CAP = 40;
export const CLEANUP_RESERVE = 8;

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
      status,
      requestId: "-",
      replayed: null,
      summary: {},
      ...extra,
    };
    transcript.push(e);
    return e;
  };
  const fail = (code: ConstructorParameters<typeof ProofAbort>[0], msg: string): never => {
    abort = new ProofAbort(code, redactText(msg));
    throw abort;
  };

  async function call(input: ProofRequest, opts: CallOptions = {}): Promise<ProofResponse> {
    // the request is copied and frozen BEFORE validation; exactly this copy is what gets sent (no mutation between check and send)
    const req: ProofRequest = Object.freeze(structuredClone(input));
    if (o.shouldStop?.() && !abort) abort = new ProofAbort("interrupted", "interrupted by the operator");
    if (abort && !(opts.phase === "cleanup" && abort.code !== "livemode_true" && abort.code !== "identity_mismatch" && abort.code !== "blocked_request")) {
      throw abort;
    }
    // 1. allow-list, before anything else
    const v = evaluateRequest(req, { connectedAcct: o.connectedAcct });
    if (!v.ok) {
      blocked += 1;
      entry(req, "BLOCKED", { note: v.reason });
      return fail("blocked_request", `blocked before network I/O: ${v.reason}`);
    }
    // 2. drafts only
    if (v.rule === "invoice.delete_draft") {
      const id = req.path.split("/").pop() as string;
      if (!seen.drafts.has(id)) {
        blocked += 1;
        entry(req, "BLOCKED", { note: "DELETE refused: invoice not seen with status=draft" });
        return fail("blocked_request", `DELETE refused for ${id}: it was not observed as a draft`);
      }
    }
    // 3. budget (synchronous, so concurrent callers cannot overshoot)
    const limit = opts.phase === "cleanup" ? budget : budget - reserve;
    if (used >= limit) {
      entry(req, "BLOCKED", { note: `call budget ${used}/${limit} reached` });
      return fail("budget_exceeded", `call budget exhausted (${used} used, limit ${limit}${opts.phase === "cleanup" ? "" : `, ${reserve} reserved for cleanup`})`);
    }
    used += 1;
    if (paceMs > 0 && used > 1) await sleep(paceMs);
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
    // 5. response checks
    const body = res.json;
    if (body) {
      const asText = JSON.stringify(body);
      if (body.livemode === true || /"livemode":\s*true/.test(asText)) return fail("livemode_true", `livemode:true in a response (${req.method} ${req.path})`);
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

  return { call, transcript, seen, uncertain, stats: () => ({ used, blocked, budget }), aborted: () => abort };
}
