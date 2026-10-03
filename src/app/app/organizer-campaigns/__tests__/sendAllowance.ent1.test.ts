import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, usedThisMonth, type FakeDb, type Row } from "@/lib/usage/__tests__/fakeCampaignDb";

/**
 * ENT-1: organizer campaign send path (sendOrganizerCampaignAction) and the monthly recipient allowance. Same
 * semantics as the studio path, metered against the ORGANIZER workspace and the organizer's own billing.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as { from: (t: string) => unknown; rpc: (n: string, a: Record<string, unknown>) => Promise<unknown> },
  send: vi.fn(),
  studioPlan: vi.fn(),
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
  createAdminClient: () => ({ from: (table: string) => h.db.from(table), rpc: (name: string, args: Record<string, unknown>) => h.db.rpc(name, args) }),
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "studio-a", studioRole: "organizer_owner", isPlatformAdmin: false, userId: "user-1" }),
}));
vi.mock("@/lib/billing/access", () => ({
  resolveStudioBillingPlan: (...args: unknown[]) => h.studioPlan(...args),
  getCurrentStudioPlanForUser: vi.fn(),
  requireStudioFeature: vi.fn(),
}));
vi.mock("@/lib/notifications/email-branding", () => ({
  renderStudioBrandedEmail: () => "<html>branded</html>",
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => h.send(...args) };
  },
}));

const { sendOrganizerCampaignAction } = await import("../[id]/actions");

const ORG = "org-a";
let db: FakeDb;

function seed(campaigns: Array<{ id: string; pending: number }>, extra: Record<string, Row[]> = {}, organizer: Partial<Row> = {}) {
  const recipients: Row[] = [];
  for (const c of campaigns) {
    for (let i = 0; i < c.pending; i += 1) {
      recipients.push({ id: `${c.id}-r${i}`, campaign_id: c.id, organizer_id: ORG, status: "pending", email: `${c.id}-r${i}@example.test`, name: `R${i}`, unsubscribe_token: `tok-${c.id}-${i}` });
    }
  }
  db = createFakeDb({
    organizers: [{ id: ORG, studio_id: "studio-a", name: "Org A", billing_plan: "organizer", subscription_status: "active", ...organizer }],
    organizer_users: [{ organizer_id: ORG, user_id: "user-1", role: "organizer_owner", active: true }],
    platform_admins: [],
    organizer_marketing_campaigns: campaigns.map((c) => ({ id: c.id, organizer_id: ORG, name: c.id, subject: "Hello", preview_text: "Preview", body_text: "Body", cta_label: null, cta_url: null, audience_type: "all_organizer_contacts", audience_event_id: null, status: "draft" })),
    organizer_marketing_campaign_recipients: recipients,
    studios: [{ id: "studio-a", public_logo_url: null, email: "studio@example.test", address_line_1: "1 Main St", address_line_2: null, city: "Raleigh", state: "NC", postal_code: "27601", country: "US" }],
    ...extra,
  });
  h.db = db;
}

const period = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10);
const usage = (used: number, over: Row = {}): Row => ({ organizer_id: ORG, workspace_type: "organizer", feature_key: "email_campaign_recipient", period_start: period(), quantity_used: used, ...over });

async function send(campaignId: string, batch?: number) {
  const pending = db.tables.organizer_marketing_campaign_recipients.filter((r) => r.campaign_id === campaignId && r.status === "pending").length;
  const fd = new FormData();
  fd.set("campaignId", campaignId);
  fd.set("confirmSend", "yes");
  fd.set("confirmSendPhrase", `SEND ${batch ?? Math.min(500, pending)}`);
  try {
    await sendOrganizerCampaignAction(fd);
    return null;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest) throw error;
    return digest.split(";")[2];
  }
}

const statuses = (campaignId: string) => {
  const counts: Record<string, number> = {};
  for (const r of db.tables.organizer_marketing_campaign_recipients.filter((x) => x.campaign_id === campaignId)) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
  return counts;
};

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.MARKETING_FROM_EMAIL = "news@example.test";
  h.send.mockReset();
  h.send.mockResolvedValue({ data: { id: "msg-1" }, error: null });
  h.studioPlan.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("organizer campaign send: monthly recipient allowance (ENT-1)", () => {
  it("organizer allowance (1,000): a campaign that fits sends to everyone and records exactly those recipients", async () => {
    seed([{ id: "c1", pending: 12 }]);
    const url = await send("c1");
    expect(url).toContain("campaign_sent=1");
    expect(h.send).toHaveBeenCalledTimes(12);
    expect(usedThisMonth(db, "organizer_id", ORG)).toBe(12);
    expect(db.tables.organizer_marketing_campaigns[0].status).toBe("sent");
    expect(h.studioPlan).not.toHaveBeenCalled(); // the organizer's own billing decides, never a studio plan
  });

  it("exactly at the remaining allowance succeeds", async () => {
    seed([{ id: "c1", pending: 10 }], { usage_monthly_summaries: [usage(990)] });
    expect(await send("c1")).toContain("campaign_sent=1");
    expect(usedThisMonth(db, "organizer_id", ORG)).toBe(1000);
  });

  it("one over the remaining allowance blocks the whole campaign: nothing sent, nothing recorded, status untouched", async () => {
    seed([{ id: "c1", pending: 11 }], { usage_monthly_summaries: [usage(990)] });
    const url = await send("c1");
    expect(url).toContain("campaign_error=allowance_exceeded");
    expect(url).toContain("allowance_recipients=11");
    expect(url).toContain("allowance_total=1000");
    expect(url).toContain("allowance_used=990");
    expect(url).toContain("allowance_remaining=10");
    expect(h.send).not.toHaveBeenCalled();
    expect(usedThisMonth(db, "organizer_id", ORG)).toBe(990);
    expect(db.tables.usage_reservations).toHaveLength(0);
    expect(statuses("c1")).toEqual({ pending: 11 });
    expect(db.tables.organizer_marketing_campaigns[0].status).toBe("draft");
  });

  it.each(["past_due", "canceled", "inactive"])("an organizer subscription that is %s fails closed", async (status) => {
    seed([{ id: "c1", pending: 3 }], {}, { subscription_status: status });
    const url = await send("c1");
    expect(url).toContain("allowance_reason=inactive_subscription");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("an organizer whose billing cannot be established fails closed", async () => {
    seed([{ id: "c1", pending: 3 }], {}, { billing_plan: "unknown" });
    const url = await send("c1");
    expect(url).toContain("allowance_reason=no_allowance");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("failed recipients do not consume allowance", async () => {
    seed([{ id: "c1", pending: 10 }]);
    h.send.mockImplementation(async (args: { to: string[] }) => {
      if (/-r[0-3]@/.test(args.to[0])) throw new Error("down");
      return { data: { id: "ok" }, error: null };
    });
    expect(await send("c1")).toContain("campaign_sent=1");
    expect(statuses("c1")).toEqual({ failed: 4, sent: 6 });
    expect(usedThisMonth(db, "organizer_id", ORG)).toBe(6);
    expect(db.tables.usage_reservations[0]).toMatchObject({ status: "finalized", quantity_reserved: 10, quantity_consumed: 6 });
  });

  it("keeps the existing delivery semantics: the provider accepting the call is a send (nothing about delivery changed)", async () => {
    seed([{ id: "c1", pending: 3 }]);
    h.send.mockResolvedValue({ data: null, error: { message: "api error" } }); // this pipeline has always treated a resolved call as sent
    await send("c1");
    expect(statuses("c1")).toEqual({ sent: 3 });
    expect(usedThisMonth(db, "organizer_id", ORG)).toBe(3);
  });

  it("a missing marketing footer after reserving releases the whole reservation and sends nothing", async () => {
    seed([{ id: "c1", pending: 5 }], { studios: [{ id: "studio-a", public_logo_url: null, email: null, address_line_1: null, city: null, state: null, postal_code: null, country: null }] });
    delete process.env.MARKETING_POSTAL_ADDRESS;
    const url = await send("c1");
    expect(url).toContain("campaign_error=missing_marketing_footer");
    expect(h.send).not.toHaveBeenCalled();
    expect(usedThisMonth(db, "organizer_id", ORG)).toBe(0);
    expect(db.tables.usage_reservations[0]).toMatchObject({ status: "finalized", quantity_consumed: 0 });
    // the allowance is free again
    expect(db.tables.usage_reservations.filter((r) => r.status === "reserved")).toHaveLength(0);
  });

  it("concurrent organizer campaigns that cannot both fit: exactly one sends", async () => {
    seed([{ id: "ca", pending: 600 }, { id: "cb", pending: 600 }]);
    const results = await Promise.all([send("ca", 500), send("cb", 500)]);
    expect(results.filter((u) => u?.includes("campaign_sent=1"))).toHaveLength(1);
    expect(results.filter((u) => u?.includes("allowance_exceeded"))).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(500);
    expect(usedThisMonth(db, "organizer_id", ORG)).toBe(500);
  });

  it("many concurrent sends never exceed the monthly allowance", async () => {
    seed(Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, pending: 200 })));
    await Promise.all(Array.from({ length: 12 }, (_, i) => send(`c${i}`)));
    expect(usedThisMonth(db, "organizer_id", ORG)).toBe(1000);
    expect(h.send).toHaveBeenCalledTimes(1000);
  });

  it("tenant scoping: the studio workspace and another organizer never affect this organizer", async () => {
    seed([{ id: "c1", pending: 10 }], {
      usage_monthly_summaries: [usage(999, { organizer_id: null, studio_id: "studio-a", workspace_type: "studio" }), usage(999, { organizer_id: "org-b" })],
      usage_reservations: [{ id: "rb", organizer_id: "org-b", workspace_type: "organizer", feature_key: "email_campaign_recipient", period_start: period(), status: "reserved", quantity_reserved: 1000, expires_at: new Date(Date.now() + 600_000).toISOString(), idempotency_key: "z" }],
    });
    expect(await send("c1")).toContain("campaign_sent=1");
    expect(usedThisMonth(db, "organizer_id", ORG)).toBe(10);
    expect(db.tables.usage_events.every((e) => e.organizer_id === ORG && e.studio_id === null)).toBe(true);
  });

  it("reserves with the server-derived organizer workspace and the caller's user id", async () => {
    seed([{ id: "c1", pending: 3 }]);
    await send("c1");
    const call = db.rpcCalls.find((c) => c.name === "reserve_usage_allowance")!;
    expect(call.args).toMatchObject({ p_workspace_type: "organizer", p_studio_id: null, p_organizer_id: ORG, p_quantity: 3, p_allowance: 1000, p_created_by: "user-1", p_source: "organizer_campaign_send" });
  });

  it("a database error while reserving fails closed", async () => {
    seed([{ id: "c1", pending: 5 }]);
    db.failRpc.add("reserve_usage_allowance");
    const url = await send("c1");
    expect(url).toContain("allowance_reason=lookup_failed");
    expect(h.send).not.toHaveBeenCalled();
    expect(db.tables.organizer_marketing_campaigns[0].status).toBe("draft");
  });
});
