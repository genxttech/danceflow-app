import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, seedToken, usedThisMonth, type FakeDb, type Row } from "@/lib/usage/__tests__/fakeCampaignDb";

/**
 * Marketing M-0: studio campaign send-time compliance (sendMarketingCampaignAction / sendMarketingCampaignTestEmailAction).
 * Real actions, the in-memory database (claim/complete/sync behave like the SQL, verified by the M-0 SQL suite and the
 * concurrency harness) and a fake provider.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as { from: (t: string) => unknown; rpc: (n: string, a: Record<string, unknown>) => Promise<unknown> },
  send: vi.fn(),
  rpcOverride: null as null | ((name: string, args: Record<string, unknown>) => Promise<unknown> | null),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "owner@example.test" } }, error: null }) },
    from: (table: string) => h.db.from(table),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => h.db.from(table),
    rpc: (name: string, args: Record<string, unknown>) => h.rpcOverride?.(name, args) ?? h.db.rpc(name, args),
  }),
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "studio-a", studioRole: "studio_owner", isPlatformAdmin: false, userId: "user-1" }),
}));
vi.mock("@/lib/billing/access", () => ({
  requireStudioFeature: vi.fn().mockResolvedValue(undefined),
  resolveStudioBillingPlan: async () => ({ studioId: "studio-a", status: "active", planCode: "growth", planName: "Growth" }),
  getCurrentStudioPlanForUser: vi.fn(),
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => h.send(...args) };
  },
}));

const { sendMarketingCampaignAction, sendMarketingCampaignTestEmailAction } = await import("../actions");

const STUDIO = "studio-a";
let db: FakeDb;

function seed(pending: number, extra: Record<string, Row[]> = {}) {
  const recipients: Row[] = Array.from({ length: pending }, (_, i) => ({
    id: `c1-r${i}`,
    campaign_id: "c1",
    studio_id: STUDIO,
    status: "pending",
    email: `c1-r${i}@example.test`,
    name: `R${i}`,
    unsubscribe_token: seedToken(i + 1),
  }));
  db = createFakeDb({
    marketing_campaigns: [{ id: "c1", studio_id: STUDIO, name: "c1", subject: "Hello", preview_text: "p", body_text: "Body", cta_label: null, cta_url: null, status: "draft" }],
    studios: [{ id: STUDIO, name: "Studio A", public_name: null, public_logo_url: null, email: "studio@example.test", address_line_1: "1 Main St", address_line_2: null, city: "Raleigh", state: "NC", postal_code: "27601", country: "US" }],
    marketing_campaign_recipients: recipients,
    marketing_unsubscribes: [],
    marketing_email_suppressions: [],
    ...extra,
  });
  h.db = db;
}

async function run(action: (fd: FormData) => Promise<void>, fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await action(fd);
    return null;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest) throw error;
    return digest.split(";")[2];
  }
}
const send = () => run(sendMarketingCampaignAction, { campaignId: "c1", confirmSend: "yes" });
const statuses = () => {
  const counts: Record<string, number> = {};
  for (const r of db.tables.marketing_campaign_recipients) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
  return counts;
};
const campaignStatus = () => db.tables.marketing_campaigns[0].status;
const sentTo = () => h.send.mock.calls.map((c) => c[0].to[0]);

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.MARKETING_FROM_EMAIL = "news@example.test";
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.idanceflow.com";
  h.rpcOverride = null;
  h.send.mockReset();
  h.send.mockResolvedValue({ data: { id: "msg-1" }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("studio campaign send: M-0 compliance", () => {
  it("every message carries its own unsubscribe link, RFC 8058 one-click headers and a deterministic idempotency key", async () => {
    seed(3);
    expect(await send()).toContain("campaign_sent=1");
    expect(h.send).toHaveBeenCalledTimes(3);
    h.send.mock.calls.forEach(([payload, options], i) => {
      const token = seedToken(Number(String(payload.to[0]).match(/-r(\d+)@/)![1]) + 1);
      expect(payload.headers).toEqual({
        "List-Unsubscribe": `<https://www.idanceflow.com/api/email/unsubscribe/${token}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      });
      expect(payload.html).toContain(`https://www.idanceflow.com/unsubscribe/marketing/${token}`);
      expect(payload.text).toContain(`Unsubscribe: https://www.idanceflow.com/unsubscribe/marketing/${token}`);
      expect(options).toEqual({ idempotencyKey: expect.stringMatching(/^mkt-studio-c1-r\d$/) });
      expect(i).toBeLessThan(3);
    });
  });

  it("C3: an address unsubscribed AFTER the list was generated is not mailed (any campaign's unsubscribe counts)", async () => {
    seed(4, { marketing_unsubscribes: [{ studio_id: STUDIO, email: "C1-R1@example.test" }] });
    await send();
    expect(sentTo()).not.toContain("c1-r1@example.test");
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(statuses()).toEqual({ sent: 3, unsubscribed: 1 });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(3);
  });

  it("D2: a platform hard bounce / complaint suppression is enforced at send time", async () => {
    seed(3, { marketing_email_suppressions: [{ email: "c1-r2@example.test", reason: "complaint", active: true }] });
    await send();
    expect(sentTo()).not.toContain("c1-r2@example.test");
    expect(statuses()).toEqual({ sent: 2, suppressed: 1 });
  });

  it("C4: when eligibility cannot be confirmed nothing is sent, the allowance is released and the campaign is not left 'sending'", async () => {
    seed(3);
    db.failRpc.add("marketing_claim_campaign_recipient");
    const url = await send();
    expect(url).toContain("campaign_error=eligibility_check_failed");
    expect(h.send).not.toHaveBeenCalled();
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(0);
    expect(db.tables.usage_reservations[0]).toMatchObject({ status: "released" });
    expect(campaignStatus()).toBe("draft");
  });

  it("a completion that cannot be recorded stops the batch; the next send retries that recipient with the same idempotency key and counts it once", async () => {
    seed(3);
    let completions = 0;
    h.rpcOverride = (name) => {
      if (name !== "marketing_complete_campaign_recipient") return null;
      completions += 1;
      return completions === 2 ? Promise.resolve({ data: null, error: { message: "db down" } }) : null;
    };
    const url = await send();
    expect(url).toContain("campaign_error=eligibility_check_failed");
    expect(h.send).toHaveBeenCalledTimes(2); // stopped after the second recipient
    expect(statuses()).toEqual({ sent: 1, sending: 1, pending: 1 });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(1); // the unrecorded one is not counted yet
    const keyOfUnrecorded = h.send.mock.calls[1][1].idempotencyKey;
    // the claim lease must expire before a retry (a crashed sender may still be working)
    const row = db.tables.marketing_campaign_recipients.find((r) => r.status === "sending")!;
    row.claim_expires_at = new Date(Date.now() - 1000).toISOString();

    h.rpcOverride = null;
    h.send.mockClear();
    expect(await send()).toContain("campaign_sent=1");
    expect(h.send.mock.calls.map((c) => c[1].idempotencyKey)).toContain(keyOfUnrecorded);
    expect(statuses()).toEqual({ sent: 3 });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(3);
    expect(campaignStatus()).toBe("sent");
  });

  it("an unexpired claim (another sender in flight) is never sent twice", async () => {
    seed(2);
    const row = db.tables.marketing_campaign_recipients[0];
    Object.assign(row, { status: "sending", claim_id: "other", claim_expires_at: new Date(Date.now() + 600_000).toISOString(), first_attempt_at: new Date().toISOString(), attempt_count: 1 });
    await send();
    expect(sentTo()).toEqual(["c1-r1@example.test"]);
  });

  it("a provider rate limit releases the recipient untouched and pauses the batch", async () => {
    seed(4);
    h.send.mockImplementation(async (payload: { to: string[] }) =>
      payload.to[0] === "c1-r1@example.test"
        ? { data: null, error: { name: "rate_limit_exceeded", message: "slow down" } }
        : { data: { id: "ok" }, error: null },
    );
    const url = await send();
    expect(url).toContain("campaign_error=send_paused_provider");
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(statuses()).toEqual({ sent: 1, pending: 3 });
    const released = db.tables.marketing_campaign_recipients.find((r) => r.id === "c1-r1")!;
    expect(released).toMatchObject({ status: "pending", attempt_count: 0, first_attempt_at: null });
    expect(campaignStatus()).toBe("draft");
  });

  it("an uncertain attempt older than the provider's idempotency window is never re-sent (delivery_unknown) and is counted conservatively", async () => {
    seed(2);
    Object.assign(db.tables.marketing_campaign_recipients[0], {
      status: "sending",
      claim_id: "old",
      claim_expires_at: new Date(Date.now() - 60_000).toISOString(),
      first_attempt_at: new Date(Date.now() - 24 * 3600_000).toISOString(),
      attempt_count: 1,
    });
    await send();
    expect(sentTo()).toEqual(["c1-r1@example.test"]);
    expect(statuses()).toEqual({ delivery_unknown: 1, sent: 1 });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(2);
  });
  it("C13: a campaign abandoned in 'sending' (stale, no live claim) can be resumed; a recent or actively claimed one stays locked", async () => {
    seed(2);
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    Object.assign(db.tables.marketing_campaigns[0], { status: "sending", updated_at: minutesAgo(1) });
    expect(await send()).toContain("campaign_locked");
    db.tables.marketing_campaigns[0].updated_at = minutesAgo(20);
    Object.assign(db.tables.marketing_campaign_recipients[0], {
      status: "sending", claim_id: "other", claim_expires_at: new Date(Date.now() + 300_000).toISOString(),
      first_attempt_at: minutesAgo(5), attempt_count: 1,
    });
    expect(await send()).toContain("campaign_locked");
    expect(h.send).not.toHaveBeenCalled();
    db.tables.marketing_campaign_recipients[0].claim_expires_at = minutesAgo(1);
    expect(await send()).toContain("campaign_sent");
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls.map((c) => c[1].idempotencyKey).sort()).toEqual(["mkt-studio-c1-r0", "mkt-studio-c1-r1"]);
    expect(campaignStatus()).not.toBe("sending");
  });
});

describe("studio campaign send: marketing freeze (release / rollback transition)", () => {
  it("while frozen nothing is claimed or sent, recipients stay pending, the allowance is released and the campaign is restored", async () => {
    seed(3);
    h.rpcOverride = (name) =>
      name === "marketing_claim_campaign_recipient" ? Promise.resolve({ data: { outcome: "frozen" }, error: null }) : null;
    expect(await send()).toContain("campaign_error=marketing_paused");
    expect(h.send).not.toHaveBeenCalled();
    expect(statuses()).toEqual({ pending: 3 });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(0);
    expect(db.tables.usage_reservations[0]).toMatchObject({ status: "released" });
    expect(campaignStatus()).toBe("draft");

    h.rpcOverride = null; // released: the same campaign sends normally
    expect(await send()).toContain("campaign_sent=1");
    expect(h.send).toHaveBeenCalledTimes(3);
  });
});

describe("studio campaign test send: D3", () => {
  it("is refused (provider never called) when the address is not a verified staff address", async () => {
    seed(1);
    h.rpcOverride = (name) =>
      name === "marketing_authorize_test_send" ? Promise.resolve({ data: { allowed: false, reason: "recipient_not_verified_staff" }, error: null }) : null;
    const url = await run(sendMarketingCampaignTestEmailAction, { campaignId: "c1", testEmail: "anyone@example.test" });
    expect(url).toContain("campaign_error=test_recipient_not_allowed");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("is refused when rate limited, and fails closed when the check is unavailable", async () => {
    seed(1);
    h.rpcOverride = (name) =>
      name === "marketing_authorize_test_send" ? Promise.resolve({ data: { allowed: false, reason: "rate_limited" }, error: null }) : null;
    expect(await run(sendMarketingCampaignTestEmailAction, { campaignId: "c1" })).toContain("campaign_error=test_send_rate_limited");
    h.rpcOverride = (name) =>
      name === "marketing_authorize_test_send" ? Promise.resolve({ data: null, error: { message: "down" } }) : null;
    expect(await run(sendMarketingCampaignTestEmailAction, { campaignId: "c1" })).toContain("campaign_error=test_send_failed");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("an authorized test goes only to the requested staff address", async () => {
    seed(1);
    const authorize = vi.fn().mockResolvedValue({ data: { allowed: true }, error: null });
    h.rpcOverride = (name, args) => (name === "marketing_authorize_test_send" ? authorize(args) : null);
    expect(await run(sendMarketingCampaignTestEmailAction, { campaignId: "c1", testEmail: "owner@example.test" })).toContain("test_sent=1");
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ p_scope_kind: "studio", p_scope_id: STUDIO, p_campaign_id: "c1", p_requested_by: "user-1", p_email: "owner@example.test" }));
    expect(sentTo()).toEqual(["owner@example.test"]);
  });
});
