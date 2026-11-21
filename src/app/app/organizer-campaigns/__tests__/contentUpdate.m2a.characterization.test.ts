import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/usage/__tests__/fakeCampaignDb";

/**
 * Marketing M-2a CHARACTERIZATION for the organizer UPDATE-draft action (written before the shared content module;
 * must pass unchanged after the refactor). Pins validation order, redirect codes and the stored values.
 * The organizer UPDATE normalizer is strict (unlike organizer CREATE, see the create characterization test).
 */

const h = vi.hoisted(() => ({
  db: null as unknown as { from: (t: string) => unknown; rpc: (n: string, a: Record<string, unknown>) => Promise<unknown> },
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
    rpc: (name: string, args: Record<string, unknown>) => h.db.rpc(name, args),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => h.db.from(t), rpc: (n: string, a: Record<string, unknown>) => h.db.rpc(n, a) }),
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "studio-a", studioRole: "organizer_owner", isPlatformAdmin: false, userId: "user-1" }),
}));
vi.mock("@/lib/billing/access", () => ({
  resolveStudioBillingPlan: vi.fn(),
  getCurrentStudioPlanForUser: vi.fn(),
  requireStudioFeature: vi.fn(),
}));

const { updateOrganizerCampaignDraftAction } = await import("../[id]/actions");

const ORG = "org-a";
let db: FakeDb;
function seed(events: Array<Record<string, unknown>> = []) {
  db = createFakeDb({
    organizers: [{ id: ORG, studio_id: "studio-a" }],
    organizer_users: [{ organizer_id: ORG, user_id: "user-1", role: "organizer_owner", active: true }],
    platform_admins: [],
    organizer_marketing_campaigns: [
      { id: "c1", organizer_id: ORG, name: "Orig", subject: "Orig subject", preview_text: "p", body_text: "Orig body", cta_label: null, cta_url: null, audience_type: "all_organizer_contacts", audience_event_id: null, status: "draft" },
    ],
    organizer_marketing_campaign_recipients: [],
    events,
  });
  h.db = db;
}
const valid = { campaignId: "c1", name: "N", subject: "S", bodyText: "B", audienceType: "all_organizer_contacts" };

async function update(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await updateOrganizerCampaignDraftAction(fd);
    return null;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest) throw error;
    return digest.split(";")[2];
  }
}
const row = () => db.tables.organizer_marketing_campaigns[0];
const untouched = () => expect(row()).toMatchObject({ name: "Orig", subject: "Orig subject", body_text: "Orig body" });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  seed();
});

describe("organizer update: content validation order and stored values", () => {
  it("stores trimmed content and the canonical strict CTA URL", async () => {
    expect(
      await update({ ...valid, name: " Spring ", subject: " Hi ", previewText: " pre ", bodyText: " body ", ctaLabel: " Go ", ctaUrl: " example.com/a b " }),
    ).toBe("/app/organizer-campaigns/c1?campaign_saved=1");
    expect(row()).toMatchObject({
      name: "Spring",
      subject: "Hi",
      preview_text: "pre",
      body_text: "body",
      cta_label: "Go",
      cta_url: "https://example.com/a%20b",
      audience_type: "all_organizer_contacts",
      audience_event_id: null,
    });
  });

  it("clears preview/CTA when emptied", async () => {
    await update(valid);
    expect(row()).toMatchObject({ preview_text: null, cta_label: null, cta_url: null });
  });

  it.each([
    ["http://example.com", "http://example.com/"],
    ["example.com", "https://example.com/"],
  ])("CTA %s is stored as %s", async (ctaUrl, stored) => {
    await update({ ...valid, ctaUrl });
    expect(row().cta_url).toBe(stored);
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "vbscript:x"])("CTA %s is rejected", async (ctaUrl) => {
    expect(await update({ ...valid, ctaUrl })).toContain("campaign_error=invalid_cta_url");
    untouched();
  });

  it("a non-http(s) scheme ftp://example.com/x is rewritten to an https URL (quirk, pinned)", async () => {
    await update({ ...valid, ctaUrl: "ftp://example.com/x" });
    expect(row().cta_url).toBe("https://ftp//example.com/x");
  });

  it.each([
    ["campaignId", { campaignId: "" }],
    ["name", { name: "" }],
    ["subject", { subject: "" }],
    ["bodyText", { bodyText: "" }],
  ])("a missing %s answers missing_required_fields", async (_f, override) => {
    expect(await update({ ...valid, ...override })).toContain("campaign_error=missing_required_fields");
    untouched();
  });

  it("check order: required fields, CTA, audience, event required", async () => {
    const bad = { ...valid, name: "", ctaUrl: "javascript:x", audienceType: "bogus" };
    expect(await update(bad)).toContain("campaign_error=missing_required_fields");
    expect(await update({ ...bad, name: "N" })).toContain("campaign_error=invalid_cta_url");
    expect(await update({ ...bad, name: "N", ctaUrl: "" })).toContain("campaign_error=invalid_audience");
    expect(await update({ ...bad, name: "N", ctaUrl: "", audienceType: "specific_event_refunded" })).toContain("campaign_error=event_required");
    untouched();
  });

  it("an event of another organizer is refused", async () => {
    seed([{ id: "ev-1", organizer_id: "other-org" }]);
    expect(await update({ ...valid, audienceType: "specific_event_registrants", audienceEventId: "ev-1" })).toContain(
      "campaign_error=invalid_event",
    );
    untouched();
  });

  it("an own event is stored with its event audience", async () => {
    seed([{ id: "ev-1", organizer_id: ORG }]);
    expect(await update({ ...valid, audienceType: "specific_event_no_shows", audienceEventId: "ev-1" })).toContain("campaign_saved=1");
    expect(row()).toMatchObject({ audience_type: "specific_event_no_shows", audience_event_id: "ev-1" });
  });

  it("a posted event id is validated and stored even for a non-event audience (existing behaviour)", async () => {
    seed([{ id: "ev-1", organizer_id: ORG }]);
    await update({ ...valid, audienceEventId: "ev-1" });
    expect(row()).toMatchObject({ audience_type: "all_organizer_contacts", audience_event_id: "ev-1" });
  });

  it("defaults the audience to all_organizer_contacts", async () => {
    const { audienceType: _a, ...noAudience } = valid;
    await update(noAudience);
    expect(row().audience_type).toBe("all_organizer_contacts");
  });
});
