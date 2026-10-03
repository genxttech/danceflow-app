import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, monthStart, usedThisMonth, type FakeDb } from "./fakeCampaignDb";

/**
 * ENT-1: the monthly email-campaign recipient allowance. Allowance resolution (plan policy, fail-closed entitlement),
 * the pure preflight, the user-facing language, and the campaign-level reserve / settle / reconcile client over the
 * reservation functions. The database functions themselves are verified against the real database by
 * sql-tests/test_T_ent1_usage_allowance_reservations.sql and concurrency/ent1_race_harness.mjs.
 */

const resolveStudioBillingPlan = vi.fn();

vi.mock("@/lib/billing/access", () => ({
  resolveStudioBillingPlan: (...args: unknown[]) => resolveStudioBillingPlan(...args),
  getCurrentStudioPlanForUser: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const {
  campaignAllowanceMessageFromQuery,
  campaignAllowanceQuery,
  campaignReservationKey,
  describeCampaignAllowanceBlock,
  evaluateCampaignAllowance,
  getCampaignAllowanceState,
  reconcileStaleCampaignBatches,
  reserveCampaignSendAllowance,
  settleCampaignBatch,
} = await import("../campaignAllowance");

const STUDIO = "studio-a";
const OTHER_STUDIO = "studio-b";
const ORGANIZER = "organizer-a";
const asAdmin = (db: FakeDb) => db as unknown as NonNullable<Parameters<typeof getCampaignAllowanceState>[1]>["admin"];

function plan(planCode: string | null, status = "active", planName: string | null = null) {
  resolveStudioBillingPlan.mockResolvedValue({ studioId: STUDIO, status, planCode, planName });
}

let db: FakeDb;
beforeEach(() => {
  resolveStudioBillingPlan.mockReset();
  db = createFakeDb({
    organizers: [{ id: ORGANIZER, billing_plan: "organizer", subscription_status: "active" }],
  });
});

const studioState = () => getCampaignAllowanceState({ type: "studio", studioId: STUDIO }, { admin: asAdmin(db) });
const organizerState = () => getCampaignAllowanceState({ type: "organizer", organizerId: ORGANIZER }, { admin: asAdmin(db) });

describe("allowance resolution (policy unchanged: starter 0, growth 1,000, pro 5,000, organizer 1,000)", () => {
  it("starter resolves to zero allowance and is NOT entitled (zero is never unlimited)", async () => {
    plan("starter");
    const s = await studioState();
    expect(s.totalAllowance).toBe(0);
    expect(s.entitled).toBe(false);
    expect(s.blockedReason).toBe("no_allowance");
    expect(evaluateCampaignAllowance(s, 1).allowed).toBe(false);
  });

  it.each([
    ["growth", 1000],
    ["pro", 5000],
  ])("%s resolves to %i recipients per month", async (code, expected) => {
    plan(code);
    const s = await studioState();
    expect(s.includedAllowance).toBe(expected);
    expect(s.entitled).toBe(true);
    expect(s.remaining).toBe(expected);
  });

  it("organizer resolves to 1,000 from the organizer's own billing, not from any studio plan", async () => {
    plan("pro"); // a studio plan must be irrelevant to an organizer workspace
    const s = await organizerState();
    expect(s.includedAllowance).toBe(1000);
    expect(s.entitled).toBe(true);
    expect(resolveStudioBillingPlan).not.toHaveBeenCalled();
  });

  it("trialing counts as an active entitlement", async () => {
    plan("growth", "trialing");
    expect((await studioState()).entitled).toBe(true);
  });

  it.each(["past_due", "canceled", "inactive", "incomplete"])("a studio subscription that is %s fails closed", async (status) => {
    plan("growth", status);
    const s = await studioState();
    expect(s.entitled).toBe(false);
    expect(s.blockedReason).toBe("inactive_subscription");
    expect(s.remaining).toBe(0);
  });

  it("an inactive or missing organizer fails closed", async () => {
    db.tables.organizers[0].subscription_status = "past_due";
    expect((await organizerState()).blockedReason).toBe("inactive_subscription");
    db.tables.organizers = [];
    expect((await organizerState()).blockedReason).toBe("lookup_failed");
  });

  it("a plan it does not recognise resolves to zero, never unlimited", async () => {
    plan(null);
    expect((await studioState()).entitled).toBe(false);
    db.tables.organizers[0].billing_plan = "mystery";
    expect((await organizerState()).entitled).toBe(false);
  });

  it("any lookup failure fails closed", async () => {
    resolveStudioBillingPlan.mockRejectedValue(new Error("boom"));
    const s = await studioState();
    expect(s.entitled).toBe(false);
    expect(s.blockedReason).toBe("lookup_failed");
  });

  it("existing add-on entitlement rows add to the allowance (none is sold or offered in this slice)", async () => {
    plan("growth");
    db.tables.usage_addon_entitlements.push(
      { studio_id: STUDIO, feature_key: "email_campaign_recipient", status: "active", quantity_included: 250 },
      { studio_id: STUDIO, feature_key: "email_campaign_recipient", status: "canceled", quantity_included: 999 },
      { studio_id: STUDIO, feature_key: "ai_action", status: "active", quantity_included: 500 },
    );
    const s = await studioState();
    expect(s.addonAllowance).toBe(250);
    expect(s.totalAllowance).toBe(1250);
  });

  it("remaining subtracts recorded usage and the capacity still committed to campaigns in progress (consumed excluded)", async () => {
    plan("growth");
    db.tables.usage_monthly_summaries.push(
      { studio_id: STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), quantity_used: 300 },
      { studio_id: OTHER_STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), quantity_used: 900 },
      { studio_id: STUDIO, feature_key: "email_campaign_recipient", period_start: "2020-01-01", quantity_used: 777 },
    );
    db.tables.usage_reservations.push(
      // 250 committed in total, 150 of it already consumed (and already inside the 300 used): 100 still committed
      { studio_id: STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), status: "reserved", quantity_reserved: 250, quantity_consumed: 150, idempotency_key: "campaign:x", batch_started_at: null },
      { studio_id: STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), status: "released", quantity_reserved: 40, quantity_consumed: 0, idempotency_key: "campaign:y", batch_started_at: null },
      { studio_id: STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), status: "finalized", quantity_reserved: 60, quantity_consumed: 60, idempotency_key: "campaign:z", batch_started_at: null },
      { studio_id: OTHER_STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), status: "reserved", quantity_reserved: 500, quantity_consumed: 0, idempotency_key: "campaign:w", batch_started_at: null },
    );
    const s = await studioState();
    expect(s.used).toBe(300);
    expect(s.reserved).toBe(100);
    expect(s.remaining).toBe(600);
  });

  it("organizer usage is read from the organizer workspace only", async () => {
    db.tables.usage_monthly_summaries.push(
      { organizer_id: ORGANIZER, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), quantity_used: 400 },
      { studio_id: STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), quantity_used: 999 },
    );
    expect((await organizerState()).remaining).toBe(600);
  });
});

describe("preflight (pure)", () => {
  async function stateWith(remaining: number) {
    plan("growth");
    db.tables.usage_monthly_summaries.push({ studio_id: STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), quantity_used: 1000 - remaining });
    return studioState();
  }

  it("exactly at the remaining allowance is allowed", async () => {
    const s = await stateWith(154);
    const d = evaluateCampaignAllowance(s, 154);
    expect(d.allowed).toBe(true);
    expect(d.remainingAfterSend).toBe(0);
  });

  it("one recipient over the remaining allowance blocks the whole campaign", async () => {
    const s = await stateWith(154);
    const d = evaluateCampaignAllowance(s, 155);
    expect(d.allowed).toBe(false);
    expect(d.remainingAfterSend).toBeNull();
  });

  it("reports what remains after a send that fits", async () => {
    const s = await stateWith(1000);
    expect(evaluateCampaignAllowance(s, 846).remainingAfterSend).toBe(154);
  });

  it("an empty campaign is never 'allowed' by the allowance check", async () => {
    expect(evaluateCampaignAllowance(await stateWith(1000), 0).allowed).toBe(false);
  });
});

describe("language: contextual upgrade only, no add-on, no pricing", () => {
  const forbidden = /buy more|add (more )?email credits|credit|purchase|add-on|addon|\$\s?\d|per month for|price/i;

  it("the over-limit message carries recipients, allowance, used and remaining, and says nothing was sent", () => {
    const text = describeCampaignAllowanceBlock({ reason: "limit_reached", recipients: 1180, planName: "Growth", allowance: 1000, used: 160, remaining: 840 });
    expect(text).toContain("1,180");
    expect(text).toContain("1,000");
    expect(text).toContain("160");
    expect(text).toContain("840");
    expect(text).toContain("exceeds your remaining monthly email allowance");
    expect(text).toContain("Nothing was sent");
    expect(text).toContain("Your Growth plan includes 1,000 campaign recipients per month");
    expect(text).toContain("Upgrade your plan to increase your monthly allowance");
    expect(text).not.toMatch(forbidden);
  });

  it("zero allowance, inactive and lookup failures have their own plain language", () => {
    for (const reason of ["no_allowance", "inactive_subscription", "lookup_failed", "limit_reached"] as const) {
      const text = describeCampaignAllowanceBlock({ reason, recipients: 5, planName: "Starter", allowance: reason === "limit_reached" ? 10 : 0, used: 0, remaining: 0 });
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(forbidden);
      expect(text).toMatch(/nothing was sent/i);
    }
    expect(describeCampaignAllowanceBlock({ reason: "no_allowance", recipients: 5, planName: "Starter", allowance: 0, used: 0, remaining: 0 })).toContain("Your Starter plan does not include campaign recipients");
  });

  it("the redirect query round-trips to the same message and ignores unsafe input", async () => {
    plan("growth", "active", "Growth");
    const s = await studioState();
    const query = campaignAllowanceQuery({ ...s, planName: "Growth", used: 160, remaining: 840 }, 1180);
    expect(query.campaign_error).toBe("allowance_exceeded");
    expect(campaignAllowanceMessageFromQuery(query)).toContain("1,180");
    const hostile = campaignAllowanceMessageFromQuery({ allowance_reason: "<script>", allowance_recipients: "-5", allowance_total: "NaN", allowance_used: "1e9999", allowance_remaining: "x", allowance_plan: "<img src=x onerror=alert(1)>" });
    expect(hostile).not.toMatch(/[<>]/);
  });
});

describe("campaignReservationKey", () => {
  it("is one stable key per campaign: every batch of a campaign continues under the same logical send", () => {
    expect(campaignReservationKey("c1")).toBe("campaign:c1");
    expect(campaignReservationKey("c1")).not.toBe(campaignReservationKey("c2"));
  });
});

describe("campaign-level reservation: admission, continuation, settle, reconcile", () => {
  const ids = (n: number, prefix = "r") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const reserve = (over: { eligible?: number; batch?: string[]; campaignId?: string } = {}) =>
    reserveCampaignSendAllowance({
      workspace: { type: "studio", studioId: STUDIO },
      campaignId: over.campaignId ?? "camp-1",
      eligibleTotal: over.eligible ?? (over.batch ?? ids(10)).length,
      batchRecipientIds: over.batch ?? ids(10),
      userId: "user-1",
      source: "marketing_campaign_send",
      relatedTable: "marketing_campaigns",
      deps: { admin: asAdmin(db) },
    });
  const settle = (reservationId: string, sentCount: number, pendingRemaining: number | null) =>
    settleCampaignBatch({ reservationId, sentCount, pendingRemaining, deps: { admin: asAdmin(db) } });
  const reservations = () => db.tables.usage_reservations;
  const rpc = (name: string) => db.rpcCalls.filter((c) => c.name === name);

  it("blocks before reserving when the campaign does not fit, and never calls the database to reserve", async () => {
    plan("growth");
    db.tables.usage_monthly_summaries.push({ studio_id: STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), quantity_used: 840 });
    const result = await reserve({ eligible: 161, batch: ids(161) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("limit_reached");
      expect(result.query.allowance_recipients).toBe("161");
      expect(result.query.allowance_remaining).toBe("160");
      expect(result.query.allowance_total).toBe("1000");
      expect(result.query.allowance_used).toBe("840");
    }
    expect(rpc("reserve_usage_allowance")).toHaveLength(0);
  });

  it("a starter / zero-allowance workspace is blocked without any reservation", async () => {
    plan("starter");
    const result = await reserve();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_allowance");
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("an inactive workspace is blocked without any reservation", async () => {
    plan("growth", "past_due");
    const result = await reserve();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("inactive_subscription");
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("a database error while reserving fails closed", async () => {
    plan("growth");
    db.failRpc.add("reserve_usage_allowance");
    const result = await reserve();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lookup_failed");
  });

  it("MULTI-BATCH: a campaign larger than one delivery batch commits its WHOLE eligible set at admission", async () => {
    plan("growth");
    const result = await reserve({ eligible: 600, batch: ids(500) });
    expect(result.ok).toBe(true);
    const call = rpc("reserve_usage_allowance")[0];
    expect(call.args).toMatchObject({ p_workspace_type: "studio", p_studio_id: STUDIO, p_organizer_id: null, p_quantity: 600, p_allowance: 1000, p_idempotency_key: "campaign:camp-1", p_created_by: "user-1" });
    expect((call.args.p_batch_recipient_ids as string[]).length).toBe(500); // delivery scope stays the safe batch
    expect(Number(reservations()[0].quantity_reserved)).toBe(600);
    expect((await studioState()).remaining).toBe(400);
  });

  it("MULTI-BATCH: the first batch does not release capacity the later batch needs; a concurrent campaign cannot steal it", async () => {
    plan("growth");
    const first = await reserve({ eligible: 600, batch: ids(500, "a") });
    if (!first.ok) throw new Error("expected admission");
    expect(await settle(first.reservationId, 500, 100)).toBe(true);
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(500);
    // 1000 - 500 used - 100 still committed to the first campaign = 400 free: a 401-recipient campaign cannot take its 100
    const thief = await reserve({ campaignId: "camp-thief", eligible: 401, batch: ids(401, "t") });
    expect(thief.ok).toBe(false);
    expect((await studioState()).remaining).toBe(400);
  });

  it("MULTI-BATCH: the later batch continues under the original reservation even after other campaigns used everything else", async () => {
    plan("growth");
    const first = await reserve({ campaignId: "camp-a", eligible: 600, batch: ids(500, "a") });
    if (!first.ok) throw new Error("expected admission");
    const other = await reserve({ campaignId: "camp-b", eligible: 400, batch: ids(400, "b") });
    expect(other.ok).toBe(true); // fills the rest of the allowance exactly
    expect(await settle(first.reservationId, 500, 100)).toBe(true);
    if (other.ok) expect(await settle(other.reservationId, 400, 0)).toBe(true);
    expect((await studioState()).remaining).toBe(0); // 900 used + 100 committed to camp-a
    // the second batch of camp-a: nothing is free, yet it continues (its 100 are already committed)
    const second = await reserve({ campaignId: "camp-a", eligible: 100, batch: ids(100, "a2") });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.continued).toBe(true);
    expect(second.reservationId).toBe(first.reservationId);
    expect(await settle(second.reservationId, 100, 0)).toBe(true);
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(1000);
    expect(reservations().find((r) => r.id === first.reservationId)?.status).toBe("finalized");
  });

  it("MULTI-BATCH: no entitlement condition leaves an admitted campaign partially sent because allowance was consumed after admission", async () => {
    plan("growth");
    const first = await reserve({ campaignId: "camp-a", eligible: 1000, batch: ids(500, "a") });
    if (!first.ok) throw new Error("expected admission");
    // everyone else is blocked for the whole time, whatever they try
    for (let i = 0; i < 5; i += 1) expect((await reserve({ campaignId: `x${i}`, eligible: 1, batch: ["x"] })).ok).toBe(false);
    await settle(first.reservationId, 500, 500);
    for (let i = 0; i < 5; i += 1) expect((await reserve({ campaignId: `y${i}`, eligible: 1, batch: ["y"] })).ok).toBe(false);
    const second = await reserve({ campaignId: "camp-a", eligible: 500, batch: ids(500, "a2") });
    expect(second.ok).toBe(true);
    if (second.ok) await settle(second.reservationId, 500, 0);
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(1000);
  });

  it("failed recipients in a batch release only their own share; successes are the only usage", async () => {
    plan("growth");
    const first = await reserve({ campaignId: "camp-a", eligible: 700, batch: ids(500, "a") });
    if (!first.ok) throw new Error("expected admission");
    // 450 of the 500 delivered, 50 failed, 200 still pending
    await settle(first.reservationId, 450, 200);
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(450);
    expect((await studioState()).remaining).toBe(350); // 1000 - 450 used - 200 still committed
    const next = await reserve({ campaignId: "camp-a", eligible: 200, batch: ids(200, "a2") });
    expect(next.ok && next.continued).toBe(true);
    if (next.ok) await settle(next.reservationId, 150, 0); // 50 more fail
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(600);
    expect((await studioState()).remaining).toBe(400); // the failed recipients' capacity is free again
  });

  it("a campaign that mailed nobody holds no commitment", async () => {
    plan("growth");
    const result = await reserve({ eligible: 100, batch: ids(100) });
    if (!result.ok) throw new Error("expected admission");
    await settle(result.reservationId, 0, 0);
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(0);
    expect(db.tables.usage_events).toHaveLength(0);
    expect((await studioState()).remaining).toBe(1000);
  });

  it("settle is idempotent: a retry never double counts", async () => {
    plan("growth");
    const result = await reserve({ eligible: 10, batch: ids(10) });
    if (!result.ok) throw new Error("expected admission");
    await settle(result.reservationId, 4, 6);
    await settle(result.reservationId, 4, 6);
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(4);
  });

  it("a second action on a campaign whose batch is still open is refused as a lock, not an allowance problem", async () => {
    plan("growth");
    const first = await reserve({ eligible: 10, batch: ids(10) });
    expect(first.ok).toBe(true);
    const second = await reserve({ eligible: 10, batch: ids(10) });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("in_progress");
      expect(second.query).toEqual({ campaign_error: "campaign_locked" });
    }
    expect(reservations()).toHaveLength(1);
  });

  it("DURABLE: if settling keeps failing, the capacity stays held (never released) and the batch stays open", async () => {
    plan("growth");
    const result = await reserve({ eligible: 100, batch: ids(100) });
    if (!result.ok) throw new Error("expected admission");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.failRpc.add("settle_usage_reservation");
    expect(await settle(result.reservationId, 60, 0)).toBe(false);
    expect(rpc("settle_usage_reservation")).toHaveLength(3); // retried
    errorSpy.mockRestore();
    // 60 successful sends are not recorded yet, but the 100 stay committed: nobody can reuse that capacity
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(0);
    expect(reservations()[0].status).toBe("reserved");
    expect(reservations()[0].batch_started_at).toBeTruthy();
    expect((await studioState()).remaining).toBe(900);
    const other = await reserve({ campaignId: "camp-other", eligible: 901, batch: ids(901, "o") });
    expect(other.ok).toBe(false);
  });

  it("DURABLE: a stale unsettled batch is reconciled from the durable 'sent' records, exactly once, before anything is admitted", async () => {
    plan("growth");
    const batch = ids(100, "a");
    const result = await reserve({ campaignId: "camp-a", eligible: 150, batch });
    if (!result.ok) throw new Error("expected admission");
    // the request died: 60 recipients were marked sent, 10 failed, 30 were never reached; 50 more were never in the batch
    db.tables.marketing_campaign_recipients = [
      ...batch.map((id, i) => ({ id, campaign_id: "camp-a", studio_id: STUDIO, status: i < 60 ? "sent" : i < 70 ? "failed" : "pending" })),
      ...ids(50, "later").map((id) => ({ id, campaign_id: "camp-a", studio_id: STUDIO, status: "pending" })),
    ];
    reservations()[0].batch_started_at = new Date(Date.now() - 3_600_000).toISOString();

    // capacity is still held while unresolved...
    expect(reservations()[0].status).toBe("reserved");
    // ...and the next state read repairs it
    const state = await studioState();
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(60);
    expect(reservations()[0].batch_started_at).toBeNull();
    expect(state.used).toBe(60);
    expect(state.reserved).toBe(80); // 30 + 50 still pending stay committed; the 10 failed were released
    // repeated reconciliation changes nothing
    await studioState();
    await reconcileStaleCampaignBatches({ type: "studio", studioId: STUDIO }, { admin: asAdmin(db) });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(60);
    // and the campaign can continue
    const next = await reserve({ campaignId: "camp-a", eligible: 80, batch: ids(80, "n") });
    expect(next.ok && next.continued).toBe(true);
  });

  it("DURABLE: if the truth cannot be established the stale batch stays open and everything fails closed", async () => {
    plan("growth");
    const result = await reserve({ campaignId: "camp-a", eligible: 100, batch: ids(100) });
    if (!result.ok) throw new Error("expected admission");
    reservations()[0].batch_started_at = new Date(Date.now() - 3_600_000).toISOString();
    const realFrom = db.from.bind(db);
    db.from = (table: string) => {
      if (table === "marketing_campaign_recipients") throw new Error("recipients unavailable");
      return realFrom(table);
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const blocked = await reserve({ campaignId: "camp-a", eligible: 100, batch: ids(100, "b") });
    errorSpy.mockRestore();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe("lookup_failed");
    expect(reservations()[0].status).toBe("reserved");
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(0);
  });

  it("concurrent campaigns that cannot both fit: exactly one is admitted, none partially", async () => {
    plan("growth");
    const [a, b, c] = await Promise.all([
      reserve({ campaignId: "camp-a", batch: ids(600, "a") }),
      reserve({ campaignId: "camp-b", batch: ids(600, "b") }),
      reserve({ campaignId: "camp-c", batch: ids(600, "c") }),
    ]);
    expect([a, b, c].filter((r) => r.ok)).toHaveLength(1);
    expect(reservations().filter((r) => r.status === "reserved").reduce((s, r) => s + Number(r.quantity_reserved), 0)).toBe(600);
  });

  it("many concurrent campaigns never overshoot the monthly allowance", async () => {
    plan("growth");
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => reserve({ campaignId: `camp-${i}`, batch: ids(100, `c${i}-`) })));
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(reservations().reduce((s, r) => s + Number(r.quantity_reserved), 0)).toBeLessThanOrEqual(1000);
  });

  it("workspaces are independent: studio B's commitments never affect studio A", async () => {
    plan("growth");
    db.tables.usage_reservations.push({
      id: "b", studio_id: OTHER_STUDIO, workspace_type: "studio", feature_key: "email_campaign_recipient", period_start: monthStart(new Date()),
      status: "reserved", quantity_reserved: 1000, quantity_consumed: 0, idempotency_key: "campaign:other", batch_started_at: null,
    });
    expect((await reserve({ eligible: 1000, batch: ids(500) })).ok).toBe(true);
  });

  it("the page/preflight state counts capacity already committed to this campaign as available to it", async () => {
    plan("growth");
    const first = await reserve({ campaignId: "camp-a", eligible: 600, batch: ids(500, "a") });
    if (!first.ok) throw new Error("expected admission");
    await settle(first.reservationId, 500, 100);
    const view = await getCampaignAllowanceState({ type: "studio", studioId: STUDIO }, { admin: asAdmin(db), campaignId: "camp-a" });
    expect(view.campaignCommitted).toBe(100);
    expect(view.remaining).toBe(400);
    expect(view.available).toBe(500);
    expect(evaluateCampaignAllowance(view, 100).allowed).toBe(true);
    expect(evaluateCampaignAllowance(view, 501).allowed).toBe(false);
  });
});

describe("stale 500-recipient batch reconciliation reads recipient state in safe chunks", () => {
  const BATCH = Array.from({ length: 500 }, (_, i) => `rcp-${String(i).padStart(3, "0")}`);
  const SENT = 337; // recipients 0..336 were marked sent before the request died
  const workspace = { type: "studio", studioId: STUDIO } as const;
  const settleCalls = () => db.rpcCalls.filter((c) => c.name === "settle_usage_reservation");

  async function openStaleBatch() {
    plan("growth");
    const admitted = await reserveCampaignSendAllowance({
      workspace, campaignId: "camp-a", eligibleTotal: 800, batchRecipientIds: BATCH, userId: "user-1",
      source: "marketing_campaign_send", relatedTable: "marketing_campaigns", deps: { admin: asAdmin(db) },
    });
    if (!admitted.ok) throw new Error("expected admission");
    db.tables.marketing_campaign_recipients = [
      ...BATCH.map((id, i) => ({ id, campaign_id: "camp-a", studio_id: STUDIO, status: i < SENT ? "sent" : i < 360 ? "failed" : "pending" })),
      ...Array.from({ length: 300 }, (_, i) => ({ id: `later-${i}`, campaign_id: "camp-a", studio_id: STUDIO, status: "pending" })),
    ];
    db.tables.usage_reservations[0].batch_started_at = new Date(Date.now() - 3_600_000).toISOString();
    return admitted;
  }

  let lookupDown = false;
  /** Records the size of every `.in()` lookup on the recipients table; while `lookupDown`, the chunk that starts at recipient 200 fails. */
  function spyOnLookups() {
    const sizes: number[] = [];
    const realFrom = db.from.bind(db);
    db.from = (table: string) => {
      const builder = realFrom(table) as unknown as { in: (col: string, values: unknown[]) => unknown };
      if (table !== "marketing_campaign_recipients") return builder as never;
      const realIn = builder.in.bind(builder);
      builder.in = (col: string, values: unknown[]) => {
        sizes.push(values.length);
        if (lookupDown && values[0] === BATCH[200]) return Promise.resolve({ data: null, error: { message: "chunk lookup failed" }, count: null });
        return realIn(col, values);
      };
      return builder as never;
    };
    return sizes;
  }

  it("splits the lookup so no query receives more than 200 ids, examines all 500, and settles ONCE with the aggregate", async () => {
    await openStaleBatch();
    const sizes = spyOnLookups();
    expect(await reconcileStaleCampaignBatches(workspace, { admin: asAdmin(db) })).toBe(1);
    expect(sizes).toEqual([200, 200, 100]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(200);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(500);
    expect(settleCalls()).toHaveLength(1); // one logical settlement, never one per chunk
    expect(settleCalls()[0].args).toMatchObject({ p_batch_sent: SENT, p_pending_remaining: 140 + 300 });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(SENT);
    expect(db.tables.usage_events).toHaveLength(1);
    expect(db.tables.usage_reservations[0].batch_started_at).toBeNull();
  });

  it("repeated reconciliation changes nothing: no double count", async () => {
    await openStaleBatch();
    await reconcileStaleCampaignBatches(workspace, { admin: asAdmin(db) });
    await reconcileStaleCampaignBatches(workspace, { admin: asAdmin(db) });
    await studioState();
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(SENT);
    expect(db.tables.usage_events).toHaveLength(1);
    expect(settleCalls()).toHaveLength(1);
  });

  it("if ANY chunk lookup fails nothing is settled or counted and the commitment stays intact; a later retry reconciles the whole batch", async () => {
    await openStaleBatch();
    lookupDown = true;
    const failing = spyOnLookups(); // the second chunk fails
    expect(await reconcileStaleCampaignBatches(workspace, { admin: asAdmin(db) })).toBe(0);
    expect(failing.slice(0, 2)).toEqual([200, 200]); // stopped at the failed chunk: no partial count was used
    expect(failing).not.toContain(100); // the third chunk was never read, nothing was counted from a partial read
    expect(settleCalls()).toHaveLength(0);
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(0);
    expect(db.tables.usage_reservations[0]).toMatchObject({ status: "reserved", quantity_reserved: 800, quantity_consumed: 0 });
    expect(db.tables.usage_reservations[0].batch_started_at).toBeTruthy(); // still unresolved, still conservative
    // the capacity is still held: another campaign cannot take it
    const other = await reserveCampaignSendAllowance({
      workspace, campaignId: "camp-b", eligibleTotal: 201, batchRecipientIds: ["x"], userId: "user-1",
      source: "marketing_campaign_send", relatedTable: "marketing_campaigns", deps: { admin: asAdmin(db) },
    });
    expect(other.ok).toBe(false);

    // the lookup recovers: the entire logical batch is retried (all three chunks again) and counted once
    lookupDown = false;
    failing.length = 0;
    expect(await reconcileStaleCampaignBatches(workspace, { admin: asAdmin(db) })).toBe(1);
    expect(failing).toEqual([200, 200, 100]);
    expect(settleCalls()).toHaveLength(1);
    expect(settleCalls()[0].args).toMatchObject({ p_batch_sent: SENT });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(SENT);
    expect(db.tables.usage_reservations[0].batch_started_at).toBeNull();
  });
});
