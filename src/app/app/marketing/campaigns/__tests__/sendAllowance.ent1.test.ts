import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, usedThisMonth, type FakeDb, type Row } from "@/lib/usage/__tests__/fakeCampaignDb";

/**
 * ENT-1: studio campaign send path (sendMarketingCampaignAction) and the monthly recipient allowance.
 * Real action, fake database and fake provider: the reservation functions behave like the database ones (their real
 * behaviour is verified by the SQL test and the DEV race harness).
 */

const h = vi.hoisted(() => ({
  db: null as unknown as { from: (t: string) => unknown; rpc: (n: string, a: Record<string, unknown>) => Promise<unknown> },
  send: vi.fn(),
  plan: { studioId: "studio-a", status: "active", planCode: "growth" as string | null, planName: "Growth" as string | null },
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
  getCurrentStudioContext: async () => ({ studioId: "studio-a", studioRole: "studio_owner", isPlatformAdmin: false, userId: "user-1", email: "owner@example.test" }),
}));
vi.mock("@/lib/billing/access", () => ({
  requireStudioFeature: vi.fn().mockResolvedValue(undefined),
  resolveStudioBillingPlan: async () => h.plan,
  getCurrentStudioPlanForUser: vi.fn(),
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => h.send(...args) };
  },
}));

const { sendMarketingCampaignAction } = await import("../actions");

const STUDIO = "studio-a";
let db: FakeDb;

function seed(campaigns: Array<{ id: string; pending: number }>, extra: Record<string, Row[]> = {}) {
  const recipients: Row[] = [];
  for (const c of campaigns) {
    for (let i = 0; i < c.pending; i += 1) {
      recipients.push({ id: `${c.id}-r${i}`, campaign_id: c.id, studio_id: STUDIO, status: "pending", email: `${c.id}-r${i}@example.test`, name: `R${i}`, unsubscribe_token: `tok-${c.id}-${i}` });
    }
  }
  db = createFakeDb({
    marketing_campaigns: campaigns.map((c) => ({ id: c.id, studio_id: STUDIO, name: c.id, subject: "Hello", preview_text: "p", body_text: "Body", cta_label: null, cta_url: null, status: "draft" })),
    studios: [{ id: STUDIO, name: "Studio A", public_name: null, public_logo_url: null, email: "studio@example.test", address_line_1: "1 Main St", address_line_2: null, city: "Raleigh", state: "NC", postal_code: "27601", country: "US" }],
    marketing_campaign_recipients: recipients,
    ...extra,
  });
  h.db = db;
}

function usage(used: number): Row {
  return { studio_id: STUDIO, workspace_type: "studio", feature_key: "email_campaign_recipient", period_start: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10), quantity_used: used };
}

async function send(campaignId: string) {
  const fd = new FormData();
  fd.set("campaignId", campaignId);
  fd.set("confirmSend", "yes");
  try {
    await sendMarketingCampaignAction(fd);
    return null;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest) throw error;
    return digest.split(";")[2];
  }
}

const statuses = (campaignId: string) => {
  const counts: Record<string, number> = {};
  for (const r of db.tables.marketing_campaign_recipients.filter((x) => x.campaign_id === campaignId)) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
  return counts;
};
const campaignStatus = (campaignId: string) => db.tables.marketing_campaigns.find((c) => c.id === campaignId)?.status;

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.MARKETING_FROM_EMAIL = "news@example.test";
  h.plan = { studioId: STUDIO, status: "active", planCode: "growth", planName: "Growth" };
  h.send.mockReset();
  h.send.mockResolvedValue({ data: { id: "msg-1" }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("studio campaign send: monthly recipient allowance (ENT-1)", () => {
  it("growth: a campaign that fits sends to everyone and records exactly those recipients as usage", async () => {
    seed([{ id: "c1", pending: 10 }]);
    const url = await send("c1");
    expect(url).toContain("campaign_sent=1");
    expect(h.send).toHaveBeenCalledTimes(10);
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(10);
    expect(campaignStatus("c1")).toBe("sent");
    expect(db.tables.usage_reservations[0].status).toBe("finalized");
  });

  it("pro (5,000) and the growth/organizer plans resolve through the same path", async () => {
    h.plan = { studioId: STUDIO, status: "active", planCode: "pro", planName: "Pro" };
    seed([{ id: "c1", pending: 1500 }]);
    // 1,500 pending: the first action mails its 500-recipient batch; it fits the 5,000 allowance
    const url = await send("c1");
    expect(url).toContain("campaign_sent=1");
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(500);
  });

  it("exactly at the remaining allowance succeeds", async () => {
    seed([{ id: "c1", pending: 10 }], { usage_monthly_summaries: [usage(990)] });
    const url = await send("c1");
    expect(url).toContain("campaign_sent=1");
    expect(h.send).toHaveBeenCalledTimes(10);
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(1000);
  });

  it("one recipient over the remaining allowance blocks the WHOLE campaign: nothing is sent, nothing is recorded", async () => {
    seed([{ id: "c1", pending: 11 }], { usage_monthly_summaries: [usage(990)] });
    const url = await send("c1");
    expect(url).toContain("campaign_error=allowance_exceeded");
    expect(url).toContain("allowance_recipients=11");
    expect(url).toContain("allowance_total=1000");
    expect(url).toContain("allowance_used=990");
    expect(url).toContain("allowance_remaining=10");
    expect(h.send).not.toHaveBeenCalled();
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(990);
    expect(db.tables.usage_reservations).toHaveLength(0);
    expect(db.tables.usage_events).toHaveLength(0);
    expect(statuses("c1")).toEqual({ pending: 11 });
    expect(campaignStatus("c1")).toBe("draft"); // untouched, and recipient order decided nothing
  });

  it("starter (zero allowance) is blocked, never treated as unlimited", async () => {
    h.plan = { studioId: STUDIO, status: "active", planCode: "starter", planName: "Starter" };
    seed([{ id: "c1", pending: 1 }]);
    const url = await send("c1");
    expect(url).toContain("campaign_error=allowance_exceeded");
    expect(url).toContain("allowance_reason=no_allowance");
    expect(h.send).not.toHaveBeenCalled();
    expect(db.tables.usage_reservations).toHaveLength(0);
  });

  it.each(["past_due", "canceled", "inactive"])("a %s subscription fails closed", async (status) => {
    h.plan = { studioId: STUDIO, status, planCode: "growth", planName: "Growth" };
    seed([{ id: "c1", pending: 5 }]);
    const url = await send("c1");
    expect(url).toContain("allowance_reason=inactive_subscription");
    expect(h.send).not.toHaveBeenCalled();
    expect(campaignStatus("c1")).toBe("draft");
  });

  it("failed recipients do not consume allowance (provider errors, rejected sends)", async () => {
    seed([{ id: "c1", pending: 10 }]);
    h.send.mockImplementation(async (args: { to: string[] }) => {
      const email = args.to[0];
      if (email.includes("-r0@") || email.includes("-r1@") || email.includes("-r2@")) throw new Error("network down");
      if (email.includes("-r3@")) return { data: null, error: { message: "rejected" } };
      return { data: { id: "ok" }, error: null };
    });
    const url = await send("c1");
    expect(url).toContain("campaign_sent=1");
    expect(statuses("c1")).toEqual({ failed: 4, sent: 6 });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(6);
    expect(db.tables.usage_reservations[0]).toMatchObject({ status: "finalized", quantity_reserved: 10, quantity_consumed: 6 });
  });

  it("when every recipient fails nothing is recorded and nothing stays committed", async () => {
    seed([{ id: "c1", pending: 5 }]);
    h.send.mockRejectedValue(new Error("down"));
    await send("c1");
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(0);
    expect(db.tables.usage_events).toHaveLength(0);
    expect(db.tables.usage_reservations[0]).toMatchObject({ status: "released", quantity_consumed: 0 });
  });

  it("an unexpected error mid-send still finalizes with the recipients already mailed", async () => {
    seed([{ id: "c1", pending: 6 }]);
    let calls = 0;
    h.send.mockImplementation(async () => {
      calls += 1;
      return { data: { id: "m" }, error: null };
    });
    const realFrom = db.from.bind(db);
    // the status update of the 4th recipient throws outside the per-recipient try (database outage)
    let updates = 0;
    db.from = (table: string) => {
      const b = realFrom(table) as unknown as { update: (p: Row) => unknown };
      if (table === "marketing_campaign_recipients") {
        const originalUpdate = b.update.bind(b);
        b.update = (patch: Row) => {
          if (patch.status === "sent") {
            updates += 1;
            if (updates === 4) throw new Error("db outage");
          }
          return originalUpdate(patch);
        };
      }
      return b as never;
    };
    await send("c1");
    // sends 1..4 reached the provider before the outage; the outage is caught per recipient, the rest continue
    expect(calls).toBe(6);
    expect(["finalized", "reserved"]).toContain(db.tables.usage_reservations[0].status);
    expect(db.tables.usage_reservations[0].batch_started_at).toBeNull(); // the batch was settled, not left open
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(Number(db.tables.usage_reservations[0].quantity_consumed));
    expect(Number(db.tables.usage_reservations[0].quantity_consumed)).toBeGreaterThan(0);
  });

  it("concurrent campaigns that cannot both fit: exactly one sends, the other sends nothing", async () => {
    seed([{ id: "ca", pending: 600 }, { id: "cb", pending: 600 }]);
    const [ua, ub] = await Promise.all([send("ca"), send("cb")]);
    const results = [ua, ub];
    expect(results.filter((u) => u?.includes("campaign_sent=1"))).toHaveLength(1);
    expect(results.filter((u) => u?.includes("allowance_exceeded"))).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(500); // one batch of the per-action cap, from exactly one campaign
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(500);
  });

  it("many concurrent sends never exceed the monthly allowance", async () => {
    seed(Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, pending: 200 })));
    await Promise.all(Array.from({ length: 12 }, (_, i) => send(`c${i}`)));
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBeLessThanOrEqual(1000);
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(5 * 200); // five 200-recipient campaigns fit exactly
    expect(h.send).toHaveBeenCalledTimes(1000);
  });

  it("a multi-batch campaign is judged on ALL its pending recipients, not just the first batch", async () => {
    seed([{ id: "c1", pending: 600 }], { usage_monthly_summaries: [usage(500)] });
    const url = await send("c1"); // 600 pending > 500 remaining: block before mailing the first 500
    expect(url).toContain("campaign_error=allowance_exceeded");
    expect(url).toContain("allowance_recipients=600");
    expect(h.send).not.toHaveBeenCalled();
    expect(statuses("c1")).toEqual({ pending: 600 });
  });

  it("a campaign mailed over two actions consumes allowance per successful batch, under ONE reservation", async () => {
    seed([{ id: "c1", pending: 600 }]);
    await send("c1");
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(500);
    expect(campaignStatus("c1")).toBe("draft"); // 100 still pending
    expect(db.tables.usage_reservations).toHaveLength(1);
    expect(db.tables.usage_reservations[0]).toMatchObject({ status: "reserved", quantity_consumed: 500, quantity_reserved: 600 });
    await send("c1");
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(600);
    expect(campaignStatus("c1")).toBe("sent");
    expect(db.tables.usage_reservations).toHaveLength(1);
    expect(db.tables.usage_reservations[0].status).toBe("finalized");
  });

  it("MULTI-BATCH: another campaign cannot take the capacity committed to a campaign in progress, and the later batch is never blocked", async () => {
    seed([{ id: "c1", pending: 600 }, { id: "c2", pending: 450 }]);
    expect(await send("c1")).toContain("campaign_sent=1");
    expect(await send("c2")).toContain("allowance_exceeded"); // 400 free, 450 needed: c2 sends nothing
    expect(statuses("c2")).toEqual({ pending: 450 });
    expect(await send("c1")).toContain("campaign_sent=1"); // second batch continues
    expect(statuses("c1")).toEqual({ sent: 600 });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(600);
  });

  it("MULTI-BATCH: no allowance level other than a campaign's own size can leave it partially mailed (1,500 recipients on pro)", async () => {
    h.plan = { studioId: STUDIO, status: "active", planCode: "pro", planName: "Pro" };
    seed([{ id: "big", pending: 1500 }, ...Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, pending: 700 }))]);
    expect(await send("big")).toContain("campaign_sent=1"); // admitted for 1,500, mails 500
    // other campaigns race for what is left: 5,000 - 500 used - 1,000 still committed = 3,500 free: five 700s fit, the sixth must not
    const others = await Promise.all(Array.from({ length: 6 }, (_, i) => send(`o${i}`)));
    expect(others.filter((u) => u?.includes("allowance_exceeded")).length).toBeGreaterThanOrEqual(1);
    expect(await send("big")).toContain("campaign_sent=1");
    expect(await send("big")).toContain("campaign_sent=1");
    expect(statuses("big")).toEqual({ sent: 1500 }); // never partially mailed
  });

  it("DURABLE: if settling is unavailable, successful sends are not lost and capacity is not reused; the next state read reconciles them once", async () => {
    seed([{ id: "c1", pending: 10 }, { id: "c2", pending: 991 }]);
    db.failRpc.add("settle_usage_reservation");
    expect(await send("c1")).toContain("campaign_sent=1");
    expect(statuses("c1")).toEqual({ sent: 10 });
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(0);
    expect(db.tables.usage_reservations[0].status).toBe("reserved");
    expect(await send("c2")).toContain("allowance_exceeded"); // the 10 mailed recipients' capacity is still held
    db.failRpc.delete("settle_usage_reservation");
    db.tables.usage_reservations[0].batch_started_at = new Date(Date.now() - 3_600_000).toISOString();
    expect(await send("c2")).toContain("allowance_exceeded");
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(10);
    expect(db.tables.usage_events).toHaveLength(1);
    expect(db.tables.usage_reservations[0].status).toBe("finalized");
  });

  it("a second action while the campaign's first batch is still open is a lock, never a second send", async () => {
    seed([{ id: "c1", pending: 5 }]);
    db.failRpc.add("settle_usage_reservation");
    await send("c1"); // leaves the batch open (settle unavailable), campaign now 'sent' in the fake: reopen it to retry
    db.tables.marketing_campaigns[0].status = "draft";
    for (const r of db.tables.marketing_campaign_recipients) r.status = "pending";
    h.send.mockClear();
    const url = await send("c1");
    expect(url).toContain("campaign_error=campaign_locked");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("repeating a finished send changes nothing (already sent) and never reserves again", async () => {
    seed([{ id: "c1", pending: 4 }]);
    await send("c1");
    const reservations = db.tables.usage_reservations.length;
    const url = await send("c1");
    expect(url).toContain("campaign_error=");
    expect(db.tables.usage_reservations).toHaveLength(reservations);
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(4);
  });

  it("a database error while reserving fails closed: nothing is sent", async () => {
    seed([{ id: "c1", pending: 5 }]);
    db.failRpc.add("reserve_usage_allowance");
    const url = await send("c1");
    expect(url).toContain("allowance_reason=lookup_failed");
    expect(h.send).not.toHaveBeenCalled();
    expect(campaignStatus("c1")).toBe("draft");
  });

  it("tenant scoping: another studio's usage and reservations never count, and usage is recorded for this studio only", async () => {
    seed([{ id: "c1", pending: 10 }], {
      usage_monthly_summaries: [{ ...usage(995), studio_id: "studio-b" }],
      usage_reservations: [{ id: "rb", studio_id: "studio-b", workspace_type: "studio", feature_key: "email_campaign_recipient", period_start: usage(0).period_start, status: "reserved", quantity_reserved: 1000, expires_at: new Date(Date.now() + 600_000).toISOString(), idempotency_key: "z" }],
    });
    const url = await send("c1");
    expect(url).toContain("campaign_sent=1");
    expect(usedThisMonth(db, "studio_id", STUDIO)).toBe(10);
    expect(usedThisMonth(db, "studio_id", "studio-b")).toBe(995);
    expect(db.tables.usage_events.every((e) => e.studio_id === STUDIO && e.organizer_id === null)).toBe(true);
  });

  it("reserves with the server-derived workspace and the caller's user id (no client-supplied totals)", async () => {
    seed([{ id: "c1", pending: 3 }]);
    await send("c1");
    const call = db.rpcCalls.find((c) => c.name === "reserve_usage_allowance")!;
    expect(call.args).toMatchObject({ p_workspace_type: "studio", p_studio_id: STUDIO, p_organizer_id: null, p_quantity: 3, p_allowance: 1000, p_created_by: "user-1", p_source: "marketing_campaign_send" });
  });
});
