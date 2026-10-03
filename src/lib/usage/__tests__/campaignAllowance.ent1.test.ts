import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, monthStart, usedThisMonth, type FakeDb } from "./fakeCampaignDb";

/**
 * ENT-1: the monthly email-campaign recipient allowance. Allowance resolution (plan policy, fail-closed entitlement),
 * the pure preflight, the user-facing language, and the reserve / finalize / release client over the reservation
 * functions. The database functions themselves are verified against the real database by
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
  campaignBatchKey,
  describeCampaignAllowanceBlock,
  evaluateCampaignAllowance,
  finalizeCampaignAllowance,
  getCampaignAllowanceState,
  releaseCampaignAllowance,
  reserveCampaignSendAllowance,
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

  it("remaining subtracts recorded usage and live reservations, but not expired ones or this month's neighbours", async () => {
    plan("growth");
    const soon = new Date(Date.now() + 600_000).toISOString();
    const past = new Date(Date.now() - 600_000).toISOString();
    db.tables.usage_monthly_summaries.push(
      { studio_id: STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), quantity_used: 300 },
      { studio_id: OTHER_STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), quantity_used: 900 },
      { studio_id: STUDIO, feature_key: "email_campaign_recipient", period_start: "2020-01-01", quantity_used: 777 },
    );
    db.tables.usage_reservations.push(
      { studio_id: STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), status: "reserved", quantity_reserved: 100, expires_at: soon },
      { studio_id: STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), status: "reserved", quantity_reserved: 50, expires_at: past },
      { studio_id: STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), status: "released", quantity_reserved: 40, expires_at: soon },
      { studio_id: OTHER_STUDIO, feature_key: "email_campaign_recipient", period_start: monthStart(new Date()), status: "reserved", quantity_reserved: 500, expires_at: soon },
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

describe("campaignBatchKey", () => {
  it("is stable for the same recipients in any order and differs when they differ", () => {
    expect(campaignBatchKey("c1", ["a", "b", "c"])).toBe(campaignBatchKey("c1", ["c", "a", "b"]));
    expect(campaignBatchKey("c1", ["a", "b"])).not.toBe(campaignBatchKey("c1", ["a", "b", "c"]));
    expect(campaignBatchKey("c1", ["a"])).not.toBe(campaignBatchKey("c2", ["a"]));
  });
});

describe("reserve / finalize / release", () => {
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
    expect(db.rpcCalls.filter((c) => c.name === "reserve_usage_allowance")).toHaveLength(0);
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

  it("reserves exactly the batch, scoped to the workspace, with the server-resolved allowance", async () => {
    plan("growth");
    const result = await reserve({ eligible: 10, batch: ids(10) });
    expect(result.ok).toBe(true);
    const call = db.rpcCalls.find((c) => c.name === "reserve_usage_allowance")!;
    expect(call.args).toMatchObject({ p_workspace_type: "studio", p_studio_id: STUDIO, p_organizer_id: null, p_feature_key: "email_campaign_recipient", p_quantity: 10, p_allowance: 1000, p_created_by: "user-1" });
  });

  it("reserves the WHOLE campaign's eligible recipients atomically, not just the batch it mails now", async () => {
    plan("growth");
    const result = await reserve({ eligible: 600, batch: ids(500) });
    expect(result.ok).toBe(true);
    expect(db.rpcCalls.find((c) => c.name === "reserve_usage_allowance")!.args.p_quantity).toBe(600);
    if (!result.ok) return;
    await finalizeCampaignAllowance({ reservationId: result.reservationId, sentCount: 500, deps: { admin: asAdmin(db) } });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(500);
    expect((await studioState()).remaining).toBe(500); // the 100 not mailed this time are released
  });

  it("another sender taking the allowance between the read and the reservation blocks this send (the database is authoritative)", async () => {
    plan("growth");
    db.tables.usage_reservations.push({
      id: "other", studio_id: STUDIO, workspace_type: "studio", feature_key: "email_campaign_recipient", period_start: monthStart(new Date()),
      status: "reserved", quantity_reserved: 995, expires_at: new Date(Date.now() + 600_000).toISOString(), idempotency_key: "x",
    });
    // the read-only preflight sees 5 remaining; this batch needs 10 -> blocked by the preflight itself
    expect((await reserve({ batch: ids(10) })).ok).toBe(false);
    // simulate the race: the preflight saw room, then the other reservation landed
    db.tables.usage_reservations[0].quantity_reserved = 0;
    const originalFrom = db.from.bind(db);
    let swapped = false;
    db.from = (table: string) => {
      const builder = originalFrom(table);
      if (table === "usage_reservations" && !swapped) {
        swapped = true;
        queueMicrotask(() => { db.tables.usage_reservations[0].quantity_reserved = 995; });
      }
      return builder;
    };
    const raced = await reserve({ batch: ids(10) });
    expect(raced.ok).toBe(false);
    if (!raced.ok) {
      expect(raced.reason).toBe("limit_reached");
      expect(raced.query.allowance_remaining).toBe("5");
    }
  });

  it("a database error while reserving fails closed", async () => {
    plan("growth");
    db.failRpc.add("reserve_usage_allowance");
    const result = await reserve();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lookup_failed");
  });

  it("finalize records only the recipients that succeeded; failed recipients consume nothing", async () => {
    plan("growth");
    const result = await reserve({ batch: ids(10) });
    if (!result.ok) throw new Error("expected a reservation");
    expect(await finalizeCampaignAllowance({ reservationId: result.reservationId, sentCount: 7, deps: { admin: asAdmin(db) } })).toBe(true);
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(7);
    // the 3 unused are released: 993 remain
    expect((await studioState()).remaining).toBe(993);
  });

  it("zero successes record no usage at all", async () => {
    plan("growth");
    const result = await reserve({ batch: ids(10) });
    if (!result.ok) throw new Error("expected a reservation");
    await finalizeCampaignAllowance({ reservationId: result.reservationId, sentCount: 0, deps: { admin: asAdmin(db) } });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(0);
    expect(db.tables.usage_events).toHaveLength(0);
    expect((await studioState()).remaining).toBe(1000);
  });

  it("a repeated finalize does not double count", async () => {
    plan("growth");
    const result = await reserve({ batch: ids(10) });
    if (!result.ok) throw new Error("expected a reservation");
    await finalizeCampaignAllowance({ reservationId: result.reservationId, sentCount: 4, deps: { admin: asAdmin(db) } });
    await finalizeCampaignAllowance({ reservationId: result.reservationId, sentCount: 4, deps: { admin: asAdmin(db) } });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(4);
  });

  it("a repeated identical send reuses the same reservation (idempotent), never reserving twice", async () => {
    plan("growth");
    const first = await reserve({ batch: ids(10) });
    const second = await reserve({ batch: ids(10) });
    expect(first.ok && second.ok && first.reservationId === second.reservationId).toBe(true);
    expect(db.tables.usage_reservations).toHaveLength(1);
    expect((await studioState()).remaining).toBe(990);
  });

  it("finalize retries once on a transient error and reports a persistent failure", async () => {
    plan("growth");
    const result = await reserve({ batch: ids(10) });
    if (!result.ok) throw new Error("expected a reservation");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.failRpc.add("finalize_usage_reservation");
    expect(await finalizeCampaignAllowance({ reservationId: result.reservationId, sentCount: 3, deps: { admin: asAdmin(db) } })).toBe(false);
    expect(db.rpcCalls.filter((c) => c.name === "finalize_usage_reservation")).toHaveLength(2);
    errorSpy.mockRestore();
  });

  it("release frees the reservation without recording usage", async () => {
    plan("growth");
    const result = await reserve({ batch: ids(10) });
    if (!result.ok) throw new Error("expected a reservation");
    expect(await releaseCampaignAllowance({ reservationId: result.reservationId, deps: { admin: asAdmin(db) } })).toBe(true);
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(0);
    expect((await studioState()).remaining).toBe(1000);
  });

  it("concurrent campaigns that cannot both fit: exactly one is reserved, none partially", async () => {
    plan("growth");
    const [a, b, c] = await Promise.all([
      reserve({ campaignId: "camp-a", batch: ids(600, "a") }),
      reserve({ campaignId: "camp-b", batch: ids(600, "b") }),
      reserve({ campaignId: "camp-c", batch: ids(600, "c") }),
    ]);
    const granted = [a, b, c].filter((r) => r.ok);
    expect(granted).toHaveLength(1);
    const reservedTotal = db.tables.usage_reservations.filter((r) => r.status === "reserved").reduce((s, r) => s + Number(r.quantity_reserved), 0);
    expect(reservedTotal).toBe(600);
  });

  it("many concurrent campaigns never overshoot the monthly allowance", async () => {
    plan("growth");
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => reserve({ campaignId: `camp-${i}`, batch: ids(100, `c${i}-`) })));
    const reservedTotal = db.tables.usage_reservations.filter((r) => r.status === "reserved").reduce((s, r) => s + Number(r.quantity_reserved), 0);
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(reservedTotal).toBeLessThanOrEqual(1000);
  });

  it("workspaces are independent: studio B's reservations never affect studio A", async () => {
    plan("growth");
    db.tables.usage_reservations.push({
      id: "b", studio_id: OTHER_STUDIO, workspace_type: "studio", feature_key: "email_campaign_recipient", period_start: monthStart(new Date()),
      status: "reserved", quantity_reserved: 1000, expires_at: new Date(Date.now() + 600_000).toISOString(), idempotency_key: "x",
    });
    expect((await reserve({ batch: ids(1000) })).ok).toBe(true);
  });
});
