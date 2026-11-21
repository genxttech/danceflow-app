import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/usage/__tests__/fakeCampaignDb";

/**
 * Marketing M-1a: updateMarketingCampaignDraftAction. Real action, in-memory database.
 * Contract: edits only a draft with no started delivery, refuses while sends are frozen, validates like create, applies
 * the communications role gate, and never sends or touches recipients.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as { from: (t: string) => unknown; rpc: (n: string, a: Record<string, unknown>) => Promise<unknown> },
  role: "studio_owner",
  studioId: "studio-a" as string | null,
  frozen: false,
  send: vi.fn(),
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
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => h.db.from(table),
    rpc: (name: string, args: Record<string, unknown>) =>
      name === "marketing_send_frozen" ? Promise.resolve({ data: h.frozen, error: null }) : h.db.rpc(name, args),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => h.db.from(t), rpc: (n: string, a: Record<string, unknown>) => h.db.rpc(n, a) }),
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: h.studioId, studioRole: h.role, isPlatformAdmin: false, userId: "user-1" }),
}));
vi.mock("@/lib/billing/access", () => ({
  requireStudioFeature: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => h.send(...args) };
  },
}));

const { updateMarketingCampaignDraftAction } = await import("../actions");

let db: FakeDb;
const ORIGINAL = {
  id: "c1",
  studio_id: "studio-a",
  name: "Original",
  subject: "Original subject",
  preview_text: "orig preview",
  body_text: "Original body",
  cta_label: null,
  cta_url: null,
  audience_type: "all_active_clients",
  audience_event_id: null,
  status: "draft",
};

function seed(
  campaign: Record<string, unknown> = {},
  recipients: Array<Record<string, unknown>> = [],
  events: Array<Record<string, unknown>> = [],
) {
  db = createFakeDb({
    marketing_campaigns: [{ ...ORIGINAL, ...campaign }],
    marketing_campaign_recipients: recipients,
    events,
  });
  h.db = db;
}

const valid = {
  campaignId: "c1",
  name: "Renamed",
  subject: "New subject",
  previewText: "new preview",
  bodyText: "New body",
  ctaLabel: "Book",
  ctaUrl: "example.com/book",
  audienceType: "all_active_clients",
};

async function update(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await updateMarketingCampaignDraftAction(fd);
    return null;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest) throw error;
    return digest.split(";")[2];
  }
}
const row = () => db.tables.marketing_campaigns[0];
const untouched = () =>
  expect(row()).toMatchObject({ name: "Original", subject: "Original subject", body_text: "Original body" });

beforeEach(() => {
  h.role = "studio_owner";
  h.studioId = "studio-a";
  h.frozen = false;
  h.send.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  seed();
});

describe("updateMarketingCampaignDraftAction (M-1a)", () => {
  it("saves a valid edit to a draft and normalizes the CTA URL", async () => {
    expect(await update(valid)).toBe("/app/marketing/campaigns/c1?campaign_saved=1");
    expect(row()).toMatchObject({
      name: "Renamed",
      subject: "New subject",
      preview_text: "new preview",
      body_text: "New body",
      cta_label: "Book",
      cta_url: "https://example.com/book",
      status: "draft",
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("clears optional fields when emptied", async () => {
    seed({ preview_text: "x", cta_label: "y", cta_url: "https://a.test/" });
    await update({ ...valid, previewText: "", ctaLabel: "", ctaUrl: "" });
    expect(row()).toMatchObject({ preview_text: null, cta_label: null, cta_url: null });
  });

  it.each(["sending", "sent", "cancelled", "scheduled"])("refuses a %s campaign and changes nothing", async (status) => {
    seed({ status });
    expect(await update(valid)).toContain("campaign_error=campaign_locked");
    untouched();
    expect(row().status).toBe(status);
  });

  it.each(["sent", "sending", "failed", "delivery_unknown"])("refuses a draft once a recipient is %s", async (status) => {
    seed({}, [{ id: "r1", campaign_id: "c1", studio_id: "studio-a", status, email: "a@example.test" }]);
    expect(await update(valid)).toContain("campaign_error=campaign_started");
    untouched();
  });

  it("allows an edit when recipients are only pending", async () => {
    seed({}, [{ id: "r1", campaign_id: "c1", studio_id: "studio-a", status: "pending", email: "a@example.test" }]);
    expect(await update(valid)).toContain("campaign_saved=1");
    expect(db.tables.marketing_campaign_recipients[0].status).toBe("pending");
  });

  it("refuses while marketing sends are frozen and changes nothing", async () => {
    h.frozen = true;
    expect(await update(valid)).toContain("campaign_error=marketing_paused");
    untouched();
  });

  it.each(["instructor", "independent_instructor", "unknown_role"])("refuses role %s before any change", async (role) => {
    h.role = role;
    expect(await update(valid)).toContain("campaign_error=unauthorized");
    untouched();
  });

  it("refuses a campaign belonging to another studio", async () => {
    h.studioId = "studio-b";
    expect(await update(valid)).toContain("campaign_error=not_found");
    untouched();
  });

  it("redirects to login without a studio context", async () => {
    h.studioId = null;
    expect(await update(valid)).toBe("/login");
    untouched();
  });

  it.each([
    ["missing_name", { name: "" }],
    ["missing_subject", { subject: "" }],
    ["missing_body", { bodyText: "" }],
    ["invalid_audience", { audienceType: "everyone" }],
    ["missing_event", { audienceType: "specific_event_registrants", audienceEventId: "" }],
    ["invalid_event", { audienceType: "specific_event_registrants", audienceEventId: "ev-other" }],
    ["not_found", { campaignId: "" }],
  ])("validation: %s", async (code, override) => {
    expect(await update({ ...valid, ...override })).toContain(`campaign_error=${code}`);
    untouched();
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "vbscript:x"])(
    "rejects CTA URL scheme %s",
    async (ctaUrl) => {
      expect(await update({ ...valid, ctaUrl })).toContain("campaign_error=invalid_cta_url");
      untouched();
    },
  );

  it("a non-http(s) scheme is never stored as such: the shared normalizer rewrites it to an https URL (same as create)", async () => {
    await update({ ...valid, ctaUrl: "ftp://example.com/x" });
    expect(String(row().cta_url)).toMatch(/^https:\/\//);
  });

  it("accepts a specific-event audience only for an event of this studio", async () => {
    seed({}, [], [{ id: "ev-1", studio_id: "studio-a" }]);
    expect(await update({ ...valid, audienceType: "specific_event_registrants", audienceEventId: "ev-1" })).toContain(
      "campaign_saved=1",
    );
    expect(row()).toMatchObject({ audience_type: "specific_event_registrants", audience_event_id: "ev-1" });
    seed({}, [], [{ id: "ev-1", studio_id: "studio-b" }]);
    expect(await update({ ...valid, audienceType: "specific_event_registrants", audienceEventId: "ev-1" })).toContain(
      "campaign_error=invalid_event",
    );
  });

  it("clears the audience event for a non-event audience", async () => {
    seed({ audience_type: "specific_event_registrants", audience_event_id: "ev-1" }, [], [{ id: "ev-1", studio_id: "studio-a" }]);
    await update({ ...valid, audienceEventId: "ev-1" });
    expect(row()).toMatchObject({ audience_type: "all_active_clients", audience_event_id: null });
  });
});
