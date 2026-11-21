import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Marketing M-2a CHARACTERIZATION (written before the shared content module exists; must pass unchanged after the
 * refactor). It pins what the studio and organizer CREATE actions do today with subject/preview/body/CTA/audience input:
 * the redirect code for each invalid input, the order the checks run in, and the exact values written.
 *
 * Observations pinned deliberately, including the odd ones:
 * - the studio action validates the CTA URL with a strict normalizer (http/https only, canonical form);
 * - the organizer CREATE action uses a lax normalizer (prefixes https:// and nothing else: no URL validation).
 *   That divergence is existing behaviour; M-2a must not change it.
 */

const h = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  eventExists: true,
  studioRole: "studio_owner",
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

function chain(table: string) {
  const c: Record<string, unknown> = {};
  const self = () => c;
  c.select = self;
  c.eq = self;
  c.in = self;
  c.limit = self;
  c.insert = (payload: Record<string, unknown>) => {
    h.inserts.push({ table, payload });
    return c;
  };
  c.single = () => Promise.resolve({ data: { id: "new-1" }, error: null });
  c.maybeSingle = () => {
    if (table === "events") return Promise.resolve({ data: h.eventExists ? { id: "ev-1", organizer_id: "org-1" } : null, error: null });
    if (table === "organizers") return Promise.resolve({ data: { id: "org-1", studio_id: "studio-a" }, error: null });
    if (table === "organizer_users") return Promise.resolve({ data: { organizer_id: "org-1", role: "owner", active: true }, error: null });
    return Promise.resolve({ data: null, error: null });
  };
  c.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => chain(table),
    rpc: () => Promise.resolve({ data: false, error: null }),
  }),
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "studio-a", studioRole: h.studioRole, isPlatformAdmin: false, userId: "user-1" }),
}));
vi.mock("@/lib/billing/access", () => ({
  requireStudioFeature: vi.fn().mockResolvedValue(undefined),
}));

const { createMarketingCampaignDraftAction } = await import("../actions");
const { createOrganizerCampaignDraftAction } = await import("@/app/app/organizer-campaigns/actions");

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
const inserted = (table: string) => h.inserts.filter((i) => i.table === table).map((i) => i.payload);

beforeEach(() => {
  h.inserts.length = 0;
  h.eventExists = true;
  h.studioRole = "studio_owner";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const SAVE_FAILED = "/app/marketing/campaigns?campaign_error=save_failed";
const studio = { name: "N", subject: "S", bodyText: "B", audienceType: "all_active_clients" };

describe("studio create: content validation order and stored values", () => {
  it("accepts and stores trimmed content, normalizing the CTA URL to its canonical form", async () => {
    const result = await run(createMarketingCampaignDraftAction, {
      ...studio,
      name: "  Spring  ",
      subject: "  Hello  ",
      previewText: "  pre  ",
      bodyText: "  body  ",
      ctaLabel: " Go ",
      ctaUrl: " example.com/a b ",
    });
    expect(result).toBe("/app/marketing/campaigns?campaign_saved=1");
    expect(inserted("marketing_campaigns")).toEqual([
      expect.objectContaining({
        studio_id: "studio-a",
        name: "Spring",
        audience_type: "all_active_clients",
        audience_event_id: null,
        subject: "Hello",
        preview_text: "pre",
        body_text: "body",
        body_html: null,
        cta_label: "Go",
        cta_url: "https://example.com/a%20b",
        status: "draft",
        created_by: "user-1",
      }),
    ]);
  });

  it("stores null for empty preview/CTA", async () => {
    await run(createMarketingCampaignDraftAction, { ...studio });
    expect(inserted("marketing_campaigns")[0]).toMatchObject({ preview_text: null, cta_label: null, cta_url: null });
  });

  it.each([
    ["http://example.com", "http://example.com/"],
    ["HTTPS://Example.com/x?y=1", "https://example.com/x?y=1"],
    ["example.com", "https://example.com/"],
  ])("CTA %s is stored as %s", async (ctaUrl, stored) => {
    await run(createMarketingCampaignDraftAction, { ...studio, ctaUrl });
    expect(inserted("marketing_campaigns")[0].cta_url).toBe(stored);
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "vbscript:x", "http://", "https://%"])("CTA %s is refused and nothing is inserted", async (ctaUrl) => {
    expect(await run(createMarketingCampaignDraftAction, { ...studio, ctaUrl })).toBe(SAVE_FAILED);
    expect(inserted("marketing_campaigns")).toEqual([]);
  });

  it.each([
    ["ftp://example.com/x", "https://ftp//example.com/x"],
    ["mailto:a@b.test", "https://mailto:a@b.test/"],
  ])("a non-http(s) scheme %s is rewritten to an https URL, not rejected (quirk, pinned)", async (ctaUrl, stored) => {
    await run(createMarketingCampaignDraftAction, { ...studio, ctaUrl });
    expect(inserted("marketing_campaigns")[0].cta_url).toBe(stored);
  });

  /**
   * EXISTING DEFECT, pinned (not fixed by this refactor): the create action's validation redirects are thrown inside
   * its own try block and the catch-all converts every one of them into save_failed, so the specific codes
   * (missing_name, invalid_cta_url, ...) never reach the page. Nothing is inserted in any of these cases.
   * The M-1a update action rethrows redirects and does report the specific codes.
   */
  it.each([
    ["missing name", { name: "" }],
    ["invalid audience", { audienceType: "bogus" }],
    ["event audience without an event", { audienceType: "specific_event_registrants" }],
    ["missing subject", { subject: "" }],
    ["missing body", { bodyText: "" }],
    ["invalid CTA", { ctaUrl: "javascript:x" }],
  ])("%s: every validation failure surfaces as save_failed and inserts nothing", async (_label, override) => {
    expect(await run(createMarketingCampaignDraftAction, { ...studio, ...override })).toBe(SAVE_FAILED);
    expect(inserted("marketing_campaigns")).toEqual([]);
  });

  it("an event of another studio is also refused with nothing inserted", async () => {
    h.eventExists = false;
    expect(
      await run(createMarketingCampaignDraftAction, { ...studio, audienceType: "specific_event_registrants", audienceEventId: "ev-1" }),
    ).toBe(SAVE_FAILED);
    expect(inserted("marketing_campaigns")).toEqual([]);
  });

  it("event audiences store the event id; others store null even when one is posted", async () => {
    await run(createMarketingCampaignDraftAction, { ...studio, audienceType: "specific_event_checked_in", audienceEventId: "ev-1" });
    await run(createMarketingCampaignDraftAction, { ...studio, audienceEventId: "ev-1" });
    expect(inserted("marketing_campaigns").map((p) => [p.audience_type, p.audience_event_id])).toEqual([
      ["specific_event_checked_in", "ev-1"],
      ["all_active_clients", null],
    ]);
  });

  it.each(["manual", "all_active_clients", "new_leads", "inactive_clients", "event_attendees", "clients_no_upcoming_lesson", "low_package_credits"])(
    "studio audience %s is accepted without an event",
    async (audienceType) => {
      expect(await run(createMarketingCampaignDraftAction, { ...studio, audienceType })).toContain("campaign_saved=1");
    },
  );

  it("an unauthorized role is refused before any insert", async () => {
    h.studioRole = "instructor";
    expect(await run(createMarketingCampaignDraftAction, studio)).toBe(SAVE_FAILED);
    expect(inserted("marketing_campaigns")).toEqual([]);
  });
});

const organizer = { organizerId: "org-1", name: "N", subject: "S", bodyText: "B" };

describe("organizer create: content validation order and stored values", () => {
  it("stores trimmed content; the CTA goes through the LAX normalizer (https:// prefix only)", async () => {
    const result = await run(createOrganizerCampaignDraftAction, {
      ...organizer,
      name: "  Spring ",
      subject: " Hello ",
      previewText: " pre ",
      bodyText: " body ",
      ctaLabel: " Go ",
      ctaUrl: " example.com/a b ",
    });
    expect(result).toBe("/app/organizer-campaigns/new-1?campaign_saved=1");
    expect(inserted("organizer_marketing_campaigns")).toEqual([
      expect.objectContaining({
        organizer_id: "org-1",
        name: "Spring",
        subject: "Hello",
        preview_text: "pre",
        body_text: "body",
        cta_label: "Go",
        cta_url: "https://example.com/a b",
        audience_type: "all_organizer_contacts",
        audience_event_id: null,
        status: "draft",
        created_by: "user-1",
      }),
    ]);
  });

  it.each([
    ["http://example.com", "http://example.com"],
    ["https://example.com/x", "https://example.com/x"],
    ["example.com", "https://example.com"],
    ["javascript:alert(1)", "https://javascript:alert(1)"],
    ["HTTP://Example.com", "https://HTTP://Example.com"],
  ])("CTA %s is stored as %s (no validation)", async (ctaUrl, stored) => {
    await run(createOrganizerCampaignDraftAction, { ...organizer, ctaUrl });
    expect(inserted("organizer_marketing_campaigns")[0].cta_url).toBe(stored);
  });

  it("stores null for empty preview/CTA", async () => {
    await run(createOrganizerCampaignDraftAction, organizer);
    expect(inserted("organizer_marketing_campaigns")[0]).toMatchObject({ preview_text: null, cta_label: null, cta_url: null });
  });

  it.each([
    ["organizerId", { organizerId: "" }],
    ["name", { name: "" }],
    ["subject", { subject: "" }],
    ["bodyText", { bodyText: "" }],
  ])("a missing %s answers missing_required_fields", async (_f, override) => {
    expect(await run(createOrganizerCampaignDraftAction, { ...organizer, ...override })).toContain("campaign_error=missing_required_fields");
    expect(inserted("organizer_marketing_campaigns")).toEqual([]);
  });

  it("check order: required fields, audience, event required, event ownership", async () => {
    expect(await run(createOrganizerCampaignDraftAction, { ...organizer, name: "", audienceType: "bogus" })).toContain(
      "campaign_error=missing_required_fields",
    );
    expect(await run(createOrganizerCampaignDraftAction, { ...organizer, audienceType: "bogus" })).toContain("campaign_error=invalid_audience");
    expect(await run(createOrganizerCampaignDraftAction, { ...organizer, audienceType: "specific_event_registrants" })).toContain(
      "campaign_error=event_required",
    );
    h.eventExists = false;
    expect(
      await run(createOrganizerCampaignDraftAction, { ...organizer, audienceType: "specific_event_registrants", audienceEventId: "ev-1" }),
    ).toContain("campaign_error=invalid_event");
  });

  it.each([
    "all_organizer_contacts",
    "paid_registration_contacts",
  ])("audience %s needs no event", async (audienceType) => {
    expect(await run(createOrganizerCampaignDraftAction, { ...organizer, audienceType })).toContain("campaign_saved=1");
  });

  it.each([
    "specific_event_registrants",
    "specific_event_ticket_buyers",
    "specific_event_unpaid_pending",
    "specific_event_checked_in",
    "specific_event_no_shows",
    "specific_event_refunded",
  ])("audience %s requires an event and stores it", async (audienceType) => {
    expect(await run(createOrganizerCampaignDraftAction, { ...organizer, audienceType })).toContain("campaign_error=event_required");
    expect(await run(createOrganizerCampaignDraftAction, { ...organizer, audienceType, audienceEventId: "ev-1" })).toContain("campaign_saved=1");
    expect(inserted("organizer_marketing_campaigns")[0]).toMatchObject({ audience_type: audienceType, audience_event_id: "ev-1" });
  });

  it("a posted event id is stored even for a non-event audience (existing behaviour)", async () => {
    await run(createOrganizerCampaignDraftAction, { ...organizer, audienceEventId: "ev-1" });
    expect(inserted("organizer_marketing_campaigns")[0]).toMatchObject({ audience_type: "all_organizer_contacts", audience_event_id: "ev-1" });
  });
});
