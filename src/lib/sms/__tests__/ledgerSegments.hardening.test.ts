/**
 * TW-4F ledger / segment accounting hardening (app-side, no database): segment estimation edge cases checked against an independent reference packer,
 * the 10-segment bound, money-summary guards in the reconciler and the inbound recorder, and idempotency / fail-closed behaviour of the billed send.
 * The database-level guarantees (separate ledgers, atomic limits, settlement once) are proved by the localStack.* suites, which need the local QA stack.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MAX_BILLED_SEGMENTS, estimateBilledSegments } from "@/lib/sms/segments";
import { recordInboundUsage, parseInboundCounts } from "@/lib/sms/inboundUsage";
import { reconcileSmsUsage } from "@/lib/sms/usageReconciler";
import { sendBilledSms, type BilledSendInput } from "@/lib/sms/usageBilling";
import { FakeBilledSmsProvider } from "@/lib/sms/usageProvider";

const seg = (b: string) => estimateBilledSegments(b).segments;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// (a) segments
// ---------------------------------------------------------------------------------------------------------------------------------------------
const EXT = ["^", "{", "}", "\\", "[", "~", "]", "|", "€", "\f"];

/** Independent reference: pack code units into parts of `cap` units, never splitting an indivisible token (an escape pair or a surrogate pair). */
function pack(tokens: number[], cap: number): number {
  let parts = 0;
  let used = 0;
  for (const t of tokens) {
    if (parts === 0 || used + t > cap) {
      parts += 1;
      used = 0;
    }
    used += t;
  }
  return parts;
}

describe("segments: encodings and limits", () => {
  it("every extension character is GSM-7 and costs two septets", () => {
    for (const ch of EXT) {
      const e = estimateBilledSegments(ch);
      expect(e.encoding, JSON.stringify(ch)).toBe("gsm7");
      expect(e.units).toBe(2);
    }
  });

  it("characters just outside GSM (a backtick, a curly quote, a tab) force UCS-2", () => {
    for (const ch of ["`", "’", "\t", "ç", "Á"]) expect(estimateBilledSegments(`hi ${ch}`).encoding, JSON.stringify(ch)).toBe("ucs2");
  });

  it("empty body is 0 segments; one character is 1", () => {
    expect(seg("")).toBe(0);
    expect(seg("a")).toBe(1);
    expect(seg("😀")).toBe(1);
  });

  it("concatenated limits: GSM 153 per part, UCS-2 67 per part", () => {
    expect(seg("a".repeat(153 * 3))).toBe(3);
    expect(seg("a".repeat(153 * 3 + 1))).toBe(4);
    expect(seg("✓".repeat(70))).toBe(1);
    expect(seg("✓".repeat(71))).toBe(2);
    expect(seg("✓".repeat(134))).toBe(2);
    expect(seg("✓".repeat(135))).toBe(3);
    expect(seg("✓".repeat(201))).toBe(3);
    expect(seg("✓".repeat(202))).toBe(4);
  });

  it("the 10-segment bound: the largest billable body is 1530 GSM septets / 670 UCS-2 units; one more is over the bound", () => {
    expect(MAX_BILLED_SEGMENTS).toBe(10);
    expect(seg("a".repeat(1530))).toBe(10);
    expect(seg("a".repeat(1531))).toBeGreaterThan(MAX_BILLED_SEGMENTS);
    expect(seg("✓".repeat(670))).toBe(10);
    expect(seg("✓".repeat(671))).toBeGreaterThan(MAX_BILLED_SEGMENTS);
  });

  it("a huge body does not blow up and is far over the bound", () => {
    expect(seg("a".repeat(1_000_000))).toBeGreaterThan(MAX_BILLED_SEGMENTS);
  });

  it("is never fewer than the reference packer for GSM-7 (escape pairs never split) and BMP UCS-2 bodies (property test)", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 2000; i++) {
      const n = Math.floor(rnd() * 700);
      const ucs = rnd() < 0.5;
      let body = "";
      const tokens: number[] = [];
      for (let k = 0; k < n; k++) {
        const r = rnd();
        if (ucs && r < 0.05) {
          body += "✓";
          tokens.push(1);
        } else if (!ucs && r < 0.2) {
          body += EXT[Math.floor(rnd() * EXT.length)];
          tokens.push(2);
        } else {
          body += "a";
          tokens.push(1);
        }
      }
      if (ucs && !body.includes("✓")) {
        body += "✓";
        tokens.push(1);
      }
      const units = tokens.reduce((a, b) => a + b, 0);
      const total = tokens.length === 0 ? 0 : units <= (ucs ? 70 : 160) ? 1 : pack(tokens, ucs ? 67 : 153);
      expect(seg(body), `${ucs ? "ucs2" : "gsm"} n=${n}`).toBeGreaterThanOrEqual(total);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// inbound counts
// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("inbound NumSegments / NumMedia are clamped", () => {
  it("never yields zero, negative, fractional or oversize counts", () => {
    for (const v of ["0", "00", "-3", "1.5", "999", "1e9", "abc", "", " ", null, undefined]) {
      const { segments, media } = parseInboundCounts(v as never, v as never);
      expect(Number.isInteger(segments) && segments >= 1 && segments <= 20, String(v)).toBe(true);
      expect(Number.isInteger(media) && media >= 0 && media <= 10, String(v)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// money summaries
// ---------------------------------------------------------------------------------------------------------------------------------------------
const ACCOUNT = `AC${"a".repeat(32)}`;
const sidOf = (n: number) => `SM${n.toString(16).padStart(32, "0")}`;

describe("reconcileSmsUsage: the summary never counts invented money", () => {
  it("ignores a charged_cents that is negative, fractional, non-finite or beyond the safe integer range, and still counts the settlement", async () => {
    const bad: unknown[] = [-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60];
    const rows = bad.map((_, i) => ({ attempt_id: `a-${i}`, account_sid: ACCOUNT, provider_sid: sidOf(i + 1) }));
    const admin = {
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        if (fn === "tw4_usage_release_unsent") return { data: { released: 0 }, error: null };
        if (fn === "tw4_usage_due") return { data: rows, error: null };
        const i = Number(String(args?.p_attempt_id).split("-")[1]);
        return { data: { outcome: "settled", charged_cents: bad[i], replayed: false }, error: null };
      },
    } as never;
    const summary = await reconcileSmsUsage(admin, new FakeBilledSmsProvider());
    expect(summary.settled).toBe(bad.length);
    expect(summary.chargedCents).toBe(0);
  });

  it("passes the provider's own evidence (its segment count, not a local estimate) to settlement, and a replayed settlement adds no money", async () => {
    const provider = new FakeBilledSmsProvider();
    provider.setEvidence(sidOf(1), { num_segments: "3", status: "delivered" });
    const seen: Array<Record<string, unknown>> = [];
    const admin = {
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        if (fn === "tw4_usage_release_unsent") return { data: { released: 0 }, error: null };
        if (fn === "tw4_usage_due") return { data: [{ attempt_id: "a-1", account_sid: ACCOUNT, provider_sid: sidOf(1) }], error: null };
        seen.push(args?.p_evidence as Record<string, unknown>);
        return { data: { outcome: "settled", charged_cents: 6, replayed: true }, error: null };
      },
    } as never;
    const summary = await reconcileSmsUsage(admin, provider);
    expect(seen[0]).toMatchObject({ sid: sidOf(1), account_sid: ACCOUNT, num_segments: "3" });
    expect(summary).toMatchObject({ settled: 1, chargedCents: 0 });
  });
});

describe("recordInboundUsage: charged and uncollected cents are only ever honest numbers", () => {
  const args = { studioId: "s", signerAccountSid: ACCOUNT, providerSid: sidOf(9), segments: 1, media: 0, classification: "ordinary" as const, replyBody: null };
  it("treats negative, fractional or unsafe cents from the database as zero", async () => {
    const admin = { rpc: async () => ({ data: { recorded: true, replayed: false, charged_cents: -4, uncollected_cents: 2 ** 60 }, error: null }) } as never;
    const r = await recordInboundUsage(admin, args, { SMS_INBOUND_RECORDING: "on" });
    expect(r).toEqual({ recorded: true, replayed: false, chargedCents: 0, uncollectedCents: 0 });
  });
  it("never throws and never blocks: any failure is a value (opt-out processing continues in the caller)", async () => {
    for (const rpc of [
      async () => {
        throw new Error("boom");
      },
      async () => ({ data: null, error: { code: "TW007" } }),
      async () => ({ data: "x", error: null }),
    ]) {
      const r = await recordInboundUsage({ rpc } as never, { ...args, classification: "compliance" }, { SMS_INBOUND_RECORDING: "on" });
      expect(r.recorded).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// billed send under concurrency, retries, fail-closed
// ---------------------------------------------------------------------------------------------------------------------------------------------
const ATTEMPT = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const SERVICE = `MG${"2".repeat(32)}`;
const input = (id: string): BilledSendInput => ({
  source: { kind: "manual", id },
  studioId: "s",
  clientId: null,
  phoneE164: "+15550100123",
  body: "Hello",
  messageType: "manual",
  relatedTable: null,
  relatedId: null,
  sentBy: null,
  statusCallbackBase: null,
});

/** A stand-in for the database: begin is atomic (one JS turn) over a budget and a per-source attempt table, as the real function is under its locks. */
function atomicDb(budgetCents: number, priceCents: number, parkedStop = false) {
  let left = budgetCents;
  const bySource = new Map<string, { id: string; state: string }>();
  let n = 0;
  const counts: Record<string, number> = {};
  return {
    counts,
    get left() {
      return left;
    },
    client: {
      rpc: async (fn: string, a: Record<string, unknown>) => {
        counts[fn] = (counts[fn] ?? 0) + 1;
        // sendBilledSms asks the parked-opt-out gate (#472) before it reserves. The gate fails closed on any answer that is not exactly true or false, so this
        // stand-in must answer it explicitly: true = an open parked STOP exists for the studio + phone, false = none.
        if (fn === "sms_pending_opt_out_blocks") return { data: parkedStop, error: null };
        if (fn === "tw4_usage_begin") {
          const key = `${a.p_source_kind}:${a.p_source_id}`;
          const prior = bySource.get(key);
          if (prior) return { data: { decision: "replay", attempt_id: prior.id, message_log_id: "l", state: prior.state }, error: null };
          if (left < priceCents) return { data: null, error: { code: "TW007" } };
          left -= priceCents;
          const at = { id: ATTEMPT(++n), state: "reserved" };
          bySource.set(key, at);
          return {
            data: { decision: "send", attempt_id: at.id, message_log_id: "l", account_sid: ACCOUNT, messaging_service_sid: SERVICE, sender_e164: "+15035550199" },
            error: null,
          };
        }
        const at = [...bySource.values()].find((x) => x.id === a.p_attempt_id);
        if (fn === "tw4_usage_dispatching") {
          if (!at || at.state !== "reserved") return { data: { dispatch: false, state: at?.state }, error: null };
          at.state = "submitting";
          return { data: { dispatch: true }, error: null };
        }
        if (fn === "tw4_usage_rejected") {
          if (at) at.state = "released";
          left += priceCents; // a definite refusal releases the reservation
          return { data: {}, error: null };
        }
        if (fn === "tw4_usage_submitted" && at) at.state = "submitted";
        return { data: {}, error: null };
      },
    } as never,
  };
}

describe("billed send: boundary, retries and refusals", () => {
  it("two parallel sends at the budget boundary: exactly one reaches the provider, the other is refused insufficient_credit", async () => {
    const db = atomicDb(2, 2);
    const provider = new FakeBilledSmsProvider();
    const [a, b] = await Promise.all([sendBilledSms(db.client, provider, input("k1")), sendBilledSms(db.client, provider, input("k2"))]);
    expect([a.outcome, b.outcome].sort()).toEqual(["refused", "sent"]);
    expect([a, b].find((o) => o.outcome === "refused")).toMatchObject({ reason: "insufficient_credit" });
    expect(provider.sent).toHaveLength(1);
    expect(db.left).toBe(0);
  });

  it("ten parallel retries of ONE source send once and reserve once", async () => {
    const db = atomicDb(100, 2);
    const provider = new FakeBilledSmsProvider();
    const out = await Promise.all(Array.from({ length: 10 }, () => sendBilledSms(db.client, provider, input("same"))));
    expect(provider.sent).toHaveLength(1);
    expect(out.filter((o) => o.outcome === "sent")).toHaveLength(1);
    expect(db.left).toBe(98);
  });

  it("a definite provider refusal gives the reserved funds back; the retry of that source is a replay, never a second text", async () => {
    const db = atomicDb(2, 2);
    const provider = new FakeBilledSmsProvider().nextSend({ kind: "refused", code: "21610" });
    const first = await sendBilledSms(db.client, provider, input("r1"));
    expect(first).toMatchObject({ outcome: "rejected", code: "21610" });
    expect(db.left).toBe(2);
    const again = await sendBilledSms(db.client, provider, input("r1"));
    expect(again.outcome).toBe("replay");
    expect(provider.sent).toHaveLength(1);
  });

  it("insufficient funds fail closed for outbound: no marker, no provider call, nothing reserved", async () => {
    const db = atomicDb(1, 2);
    const provider = new FakeBilledSmsProvider();
    const out = await sendBilledSms(db.client, provider, input("p1"));
    expect(out).toEqual({ outcome: "refused", reason: "insufficient_credit" });
    expect(db.counts.tw4_usage_dispatching ?? 0).toBe(0);
    expect(provider.sent).toHaveLength(0);
  });

  it("a parked STOP refuses the billed send before anything is reserved: no begin, no marker, no provider call", async () => {
    const db = atomicDb(100, 2, true);
    const provider = new FakeBilledSmsProvider();
    const out = await sendBilledSms(db.client, provider, input("s1"));
    expect(out).toEqual({ outcome: "refused", reason: "opted_out" });
    expect(db.counts.tw4_usage_begin ?? 0).toBe(0);
    expect(db.counts.tw4_usage_dispatching ?? 0).toBe(0);
    expect(db.left).toBe(100);
    expect(provider.sent).toHaveLength(0);
  });
});
