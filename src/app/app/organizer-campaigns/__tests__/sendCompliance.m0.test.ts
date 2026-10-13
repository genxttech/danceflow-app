import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, seedToken, type FakeDb, type Row } from "@/lib/usage/__tests__/fakeCampaignDb";

/** Marketing M-0: organizer campaign send-time compliance, draft lock and test-send authorization (real actions). */

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
  getCurrentStudioContext: async () => ({ studioId: "studio-a", studioRole: "organizer_owner", isPlatformAdmin: false, userId: "user-1" }),
}));
vi.mock("@/lib/billing/access", () => ({
  resolveStudioBillingPlan: vi.fn(),
  getCurrentStudioPlanForUser: vi.fn(),
  requireStudioFeature: vi.fn(),
}));
vi.mock("@/lib/notifications/email-branding", () => ({
  renderStudioBrandedEmail: (_brand: unknown, content: { contentHtml?: string }) => `<html>${content.contentHtml ?? ""}</html>`,
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => h.send(...args) };
  },
}));

const { sendOrganizerCampaignAction, updateOrganizerCampaignDraftAction, sendOrganizerCampaignTestEmailAction } = await import(
  "../[id]/actions"
);

const ORG = "org-a";
let db: FakeDb;

function seed(recipients: Row[], extra: Record<string, Row[]> = {}) {
  db = createFakeDb({
    organizers: [{ id: ORG, studio_id: "studio-a", name: "Org A", billing_plan: "organizer", subscription_status: "active" }],
    organizer_users: [{ organizer_id: ORG, user_id: "user-1", role: "organizer_owner", active: true }],
    platform_admins: [],
    organizer_marketing_campaigns: [{ id: "c1", organizer_id: ORG, name: "c1", subject: "Hello", preview_text: "Preview", body_text: "Body", cta_label: null, cta_url: null, audience_type: "all_organizer_contacts", audience_event_id: null, status: "draft" }],
    organizer_marketing_campaign_recipients: recipients,
    organizer_marketing_unsubscribes: [],
    organizer_contacts: [],
    studios: [{ id: "studio-a", public_logo_url: null, email: "studio@example.test", address_line_1: "1 Main St", address_line_2: null, city: "Raleigh", state: "NC", postal_code: "27601", country: "US" }],
    ...extra,
  });
  h.db = db;
}
const pending = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `c1-r${i}`, campaign_id: "c1", organizer_id: ORG, status: "pending", email: `c1-r${i}@example.test`, name: `R${i}`, unsubscribe_token: seedToken(i + 1) }));

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
const statuses = () => {
  const counts: Record<string, number> = {};
  for (const r of db.tables.organizer_marketing_campaign_recipients) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
  return counts;
};

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.MARKETING_FROM_EMAIL = "news@example.test";
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.idanceflow.com";
  h.rpcOverride = null;
  h.send.mockReset();
  h.send.mockResolvedValue({ data: { id: "msg-1" }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("organizer campaign send: M-0 compliance", () => {
  it("sends with the organizer unsubscribe link and RFC 8058 headers, skipping unsubscribed addresses and contacts", async () => {
    seed(pending(4), {
      organizer_marketing_unsubscribes: [{ organizer_id: ORG, email: "c1-r0@example.test" }],
      organizer_contacts: [{ organizer_id: ORG, email: "c1-r1@example.test", status: "unsubscribed" }],
    });
    expect(await run(sendOrganizerCampaignAction, { campaignId: "c1", confirmSend: "yes", confirmSendPhrase: "SEND 4" })).toContain("campaign_sent=1");
    expect(h.send.mock.calls.map((c) => c[0].to[0])).toEqual(["c1-r2@example.test", "c1-r3@example.test"]);
    for (const [payload, options] of h.send.mock.calls) {
      const token = seedToken(Number(String(payload.to[0]).match(/-r(\d+)@/)![1]) + 1);
      expect(payload.headers["List-Unsubscribe"]).toBe(`<https://www.idanceflow.com/api/email/unsubscribe/${token}>`);
      expect(payload.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      expect(payload.html).toContain(`https://www.idanceflow.com/unsubscribe/organizer-marketing/${token}`);
      expect(options.idempotencyKey).toMatch(/^mkt-organizer-c1-r\d$/);
    }
    expect(statuses()).toEqual({ unsubscribed: 2, sent: 2 });
  });

  it("C4: an eligibility check that cannot run sends nothing and restores the campaign", async () => {
    seed(pending(2));
    db.failRpc.add("marketing_claim_campaign_recipient");
    expect(await run(sendOrganizerCampaignAction, { campaignId: "c1", confirmSend: "yes", confirmSendPhrase: "SEND 2" })).toContain(
      "campaign_error=eligibility_check_failed",
    );
    expect(h.send).not.toHaveBeenCalled();
    expect(db.tables.organizer_marketing_campaigns[0].status).toBe("draft");
  });

  it("the SEND n confirmation covers never-attempted recipients; uncertain ones are retried without re-confirmation", async () => {
    const rows = pending(3);
    Object.assign(rows[0], { status: "sending", claim_id: "x", claim_expires_at: new Date(Date.now() - 1000).toISOString(), first_attempt_at: new Date().toISOString(), attempt_count: 1 });
    seed(rows);
    expect(await run(sendOrganizerCampaignAction, { campaignId: "c1", confirmSend: "yes", confirmSendPhrase: "SEND 3" })).toContain(
      "campaign_error=final_confirmation_required",
    );
    expect(h.send).not.toHaveBeenCalled();
    expect(await run(sendOrganizerCampaignAction, { campaignId: "c1", confirmSend: "yes", confirmSendPhrase: "SEND 2" })).toContain("campaign_sent=1");
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(statuses()).toEqual({ sent: 3 });
  });

  it("C13: a campaign abandoned in 'sending' can be resumed once stale with no live claim; otherwise it stays locked", async () => {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const rows = pending(2);
    Object.assign(rows[0], { status: "sending", claim_id: "x", claim_expires_at: new Date(Date.now() + 300_000).toISOString(), first_attempt_at: minutesAgo(5), attempt_count: 1 });
    seed(rows);
    const sendNow = () => run(sendOrganizerCampaignAction, { campaignId: "c1", confirmSend: "yes", confirmSendPhrase: "SEND 1" });
    Object.assign(db.tables.organizer_marketing_campaigns[0], { status: "sending", updated_at: minutesAgo(1) });
    expect(await sendNow()).toContain("campaign_error=campaign_locked");
    db.tables.organizer_marketing_campaigns[0].updated_at = minutesAgo(20);
    expect(await sendNow()).toContain("campaign_error=campaign_locked");
    expect(h.send).not.toHaveBeenCalled();
    Object.assign(rows[0], { claim_expires_at: minutesAgo(1) });
    expect(await sendNow()).toContain("campaign_sent=1");
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(statuses()).toEqual({ sent: 2 });
  });
});

describe("organizer campaign send: marketing freeze", () => {
  it("while frozen nothing is sent and the campaign is restored", async () => {
    seed(pending(2));
    h.rpcOverride = (name) =>
      name === "marketing_claim_campaign_recipient" ? Promise.resolve({ data: { outcome: "frozen" }, error: null }) : null;
    expect(await run(sendOrganizerCampaignAction, { campaignId: "c1", confirmSend: "yes", confirmSendPhrase: "SEND 2" })).toContain(
      "campaign_error=marketing_paused",
    );
    expect(h.send).not.toHaveBeenCalled();
    expect(statuses()).toEqual({ pending: 2 });
    expect(db.tables.organizer_marketing_campaigns[0].status).toBe("draft");
  });
});

describe("organizer campaign draft lock", () => {
  const edit = () =>
    run(updateOrganizerCampaignDraftAction, { campaignId: "c1", name: "c1", subject: "Changed", bodyText: "Changed body", audienceType: "all_organizer_contacts" });

  it("a draft that has not started sending can be edited", async () => {
    seed(pending(2));
    expect(await edit()).toContain("campaign_saved=1");
    expect(db.tables.organizer_marketing_campaigns[0].subject).toBe("Changed");
  });

  it("once any recipient was handed to the provider the content is locked (remaining recipients get the same message)", async () => {
    const rows = pending(2);
    rows[0].status = "sent";
    seed(rows);
    expect(await edit()).toContain("campaign_error=campaign_started");
    expect(db.tables.organizer_marketing_campaigns[0].subject).toBe("Hello");
  });
});

describe("organizer campaign test send: D3", () => {
  it("is refused for an address that is not a verified organizer staff address", async () => {
    seed(pending(1));
    h.rpcOverride = (name) =>
      name === "marketing_authorize_test_send" ? Promise.resolve({ data: { allowed: false, reason: "recipient_not_verified_staff" }, error: null }) : null;
    expect(await run(sendOrganizerCampaignTestEmailAction, { campaignId: "c1", testEmail: "someone@example.test" })).toContain(
      "campaign_error=test_recipient_not_allowed",
    );
    expect(h.send).not.toHaveBeenCalled();
  });
});
