import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { FakeSenderReadProvider, REVERIFY_LEASE_SECONDS, reverifyDueSenders, runScheduledSenderReverify } from "../senderVerification";

const AC = `AC${"a1".repeat(16)}`;
const MG = `MG${"b2".repeat(16)}`;
const QE = `QE${"c3".repeat(16)}`;
const PN = `PN${"d4".repeat(16)}`;
const BN = `BN${"e5".repeat(16)}`;
const URL_IN = "https://www.idanceflow.com/api/sms/twilio/inbound";
const RUN = "11111111-1111-4111-8111-111111111111";

const due = (n: number) => ({ studio_id: `s${n}`, sender_id: `x${n}`, account_sid: AC, messaging_service_sid: MG, campaign_sid: QE, phone_number_sid: PN, sender_e164: "+15035550123" });

function healthyFake() {
  return new FakeSenderReadProvider()
    .script("account", AC, { sid: AC, status: "active" })
    .script("service", MG, { sid: MG, account_sid: AC, us_app_to_person_registered: true, inbound_request_url: URL_IN, use_inbound_webhook_on_number: false })
    .script("campaign", QE, { sid: QE, account_sid: AC, messaging_service_sid: MG, campaign_status: "VERIFIED", mock: false, brand_registration_sid: BN, us_app_to_person_usecase: "MIXED" })
    .script("brand", BN, { sid: BN, status: "APPROVED", mock: false })
    .script("number", PN, { sid: PN, account_sid: AC, phone_number: "+15035550123", sms_capable: true, status: "in-use", sms_url: null })
    .script("service_number", PN, { sid: PN, service_sid: MG, account_sid: AC });
}

type Reply = { data?: unknown; error?: { code?: string } | null };
type Call = { fn: string; args: Record<string, unknown> };
function fakeRpc(handlers: Record<string, (args: Record<string, unknown>) => Reply>) {
  const calls: Call[] = [];
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const h = handlers[fn];
      if (!h) throw new Error(`unexpected rpc ${fn}`);
      const r = h(args);
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
  return { admin: admin as never, calls };
}
const begun = { tw4_reconcile_run_begin: () => ({ data: { acquired: true, run_id: RUN } }), tw4_reconcile_run_finish: () => ({ data: null }) };
const finish = (calls: Call[]) => calls.filter((c) => c.fn === "tw4_reconcile_run_finish").at(-1)!.args;

describe("runScheduledSenderReverify", () => {
  it("a busy lease is {ran:false, busy} and reads nothing", async () => {
    const t = fakeRpc({ tw4_reconcile_run_begin: () => ({ data: { acquired: false, run_id: null } }) });
    const provider = healthyFake();
    expect(await runScheduledSenderReverify(t.admin, provider, { runner: "cron:x", inboundUrl: URL_IN })).toEqual({ ran: false, reason: "busy" });
    expect(t.calls.map((c) => c.fn)).toEqual(["tw4_reconcile_run_begin"]);
    expect(provider.calls).toEqual([]);
  });

  it("a begin error is unavailable; begin is called with the sender_reverify job and a 120 s lease", async () => {
    const bad = fakeRpc({ tw4_reconcile_run_begin: () => ({ error: { code: "42883" } }) });
    expect(await runScheduledSenderReverify(bad.admin, null, { runner: "r" })).toEqual({ ran: false, reason: "unavailable" });
    const t = fakeRpc({ ...begun });
    await runScheduledSenderReverify(t.admin, null, { runner: "cron:abc", inboundUrl: URL_IN });
    expect(t.calls[0]).toEqual({ fn: "tw4_reconcile_run_begin", args: { p_job: "sender_reverify", p_runner: "cron:abc", p_lease_seconds: 120 } });
    expect(REVERIFY_LEASE_SECONDS).toBe(120);
  });

  it("a run that can read nothing (no provider, no inbound URL, work list error) is recorded FAILED, never as a healthy completed run", async () => {
    const t = fakeRpc({ ...begun });
    const out = await runScheduledSenderReverify(t.admin, null, { runner: "r", inboundUrl: URL_IN });
    expect(out).toMatchObject({ ran: true, runId: RUN, failed: true });
    expect(t.calls.map((c) => c.fn)).toEqual(["tw4_reconcile_run_begin", "tw4_reconcile_run_finish"]);
    expect(finish(t.calls)).toMatchObject({ p_run_id: RUN, p_status: "failed", p_error: "sender reverify: provider reads unavailable" });
    expect((finish(t.calls).p_summary as Record<string, unknown>).reads_available).toBe(false);
    const u = fakeRpc({ ...begun });
    await runScheduledSenderReverify(u.admin, new FakeSenderReadProvider(), { runner: "r", inboundUrl: null });
    expect(finish(u.calls)).toMatchObject({ p_status: "failed", p_error: "sender reverify: inbound url not configured" });
    const w = fakeRpc({ ...begun, tw4_sender_due_reverify: () => ({ error: { code: "57014" } }) });
    await runScheduledSenderReverify(w.admin, new FakeSenderReadProvider(), { runner: "r", inboundUrl: URL_IN });
    expect(finish(w.calls)).toMatchObject({ p_status: "failed", p_error: "sender reverify: work list unavailable" });
    expect((finish(w.calls).p_summary as Record<string, unknown>).work_list_failed).toBe(true);
  });

  it("TW023 from tw4_sender_reverify_run stops the batch and finishes 'failed' with a fixed message", async () => {
    const t = fakeRpc({
      ...begun,
      tw4_sender_due_reverify: () => ({ data: [due(1), due(2), due(3)] }),
      tw4_sender_reverify_run: () => ({ error: { code: "TW023" } }),
    });
    const out = await runScheduledSenderReverify(t.admin, healthyFake(), { runner: "r", inboundUrl: URL_IN });
    expect(out).toMatchObject({ ran: true, failed: true });
    expect(t.calls.filter((c) => c.fn === "tw4_sender_reverify_run")).toHaveLength(1);
    expect(finish(t.calls)).toMatchObject({ p_status: "failed", p_error: "sender reverify: the run lost its lease" });
  });

  it("a deadline truncates the batch, and the finish summary holds numbers and booleans only", async () => {
    let n = 0;
    const t = fakeRpc({
      ...begun,
      tw4_sender_due_reverify: () => ({ data: [due(1), due(2), due(3)] }),
      tw4_sender_reverify_run: () => ({ data: { outcome: ++n === 1 ? "verified" : "failed", code: n === 1 ? null : "campaign_not_verified" } }),
    });
    const out = await runScheduledSenderReverify(t.admin, healthyFake(), { runner: "r", inboundUrl: URL_IN, budgetMs: -1 });
    expect(out).toMatchObject({ ran: true, failed: false });
    const summary = finish(t.calls).p_summary as Record<string, unknown>;
    expect(summary).toMatchObject({ due: 3, truncated: true, reads_available: true, inbound_url_configured: true });
    for (const v of Object.values(summary)) expect(["number", "boolean"]).toContain(typeof v);

    const full = fakeRpc({
      ...begun,
      tw4_sender_due_reverify: () => ({ data: [due(1), due(2)] }),
      tw4_sender_reverify_run: (a) => ({ data: { outcome: a.p_studio_id === "s1" ? "verified" : "failed", code: "campaign_not_verified" } }),
    });
    await runScheduledSenderReverify(full.admin, healthyFake(), { runner: "r", inboundUrl: URL_IN });
    const s2 = finish(full.calls).p_summary as Record<string, unknown>;
    expect(s2).toMatchObject({ due: 2, verified: 1, failed: 1, truncated: false });
    expect(JSON.stringify(s2)).not.toMatch(/campaign_not_verified|AC[0-9a-f]{32}|MG[0-9a-f]{32}/);
  });
});

describe("reverifyDueSenders", () => {
  it("passes the run id to every fenced call, keeps going past one sender's error, and never reads without an inbound URL", async () => {
    let n = 0;
    const t = fakeRpc({
      tw4_sender_due_reverify: () => ({ data: [due(1), due(2)] }),
      tw4_sender_reverify_run: () => (++n === 1 ? { error: { code: "XX000" } } : { data: { outcome: "verified", code: null } }),
    });
    const counts = await reverifyDueSenders(t.admin, healthyFake(), { runId: RUN, inboundUrl: URL_IN });
    expect(counts).toMatchObject({ due: 2, verified: 1, errors: 1 });
    expect(t.calls.filter((c) => c.fn === "tw4_sender_reverify_run").every((c) => c.args.p_run_id === RUN)).toBe(true);

    const none = fakeRpc({});
    expect(await reverifyDueSenders(none.admin, healthyFake(), { runId: RUN, inboundUrl: null })).toMatchObject({ due: 0 });
    expect(none.calls).toEqual([]);
  });
});
