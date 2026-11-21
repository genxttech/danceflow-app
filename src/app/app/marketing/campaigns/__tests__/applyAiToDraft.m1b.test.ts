import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/usage/__tests__/fakeCampaignDb";

/**
 * Marketing M-1b: applyCampaignAiSuggestionToDraftAction. Real wrapper + real updateMarketingCampaignDraftAction
 * (M-1a) over the in-memory database. Contract: explicit confirmation required, draft-only, freeze-aware, role-gated,
 * never sends, never calls the AI provider or records ai_action usage when applying.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as { from: (t: string) => unknown; rpc: (n: string, a: Record<string, unknown>) => Promise<unknown> },
  role: "studio_owner",
  frozen: false,
  send: vi.fn(),
  recordUsage: vi.fn(),
  fetch: vi.fn(),
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
  getCurrentStudioContext: async () => ({ studioId: "studio-a", studioRole: h.role, isPlatformAdmin: false, userId: "user-1" }),
}));
vi.mock("@/lib/billing/access", () => ({
  requireStudioFeature: vi.fn().mockResolvedValue(undefined),
  studioHasFeature: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/usage/addons", () => ({
  getUsageAllowance: vi.fn().mockResolvedValue({ allowed: true }),
  getUsageLimitMessage: vi.fn(),
  recordUsageEvent: (...args: unknown[]) => h.recordUsage(...args),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getServerActionRateLimitKey: async () => "k",
  rateLimitErrorMessage: () => "limited",
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => h.send(...args) };
  },
}));

const { applyCampaignAiSuggestionToDraftAction } = await import("../ai-actions");

let db: FakeDb;
const ORIGINAL = {
  id: "c1",
  studio_id: "studio-a",
  name: "Original",
  subject: "Original subject",
  preview_text: "orig preview",
  body_text: "Original body",
  cta_label: "Book",
  cta_url: "https://example.com/book",
  audience_type: "all_active_clients",
  audience_event_id: null,
  status: "draft",
};

function seed(campaign: Record<string, unknown> = {}, recipients: Array<Record<string, unknown>> = []) {
  db = createFakeDb({
    marketing_campaigns: [{ ...ORIGINAL, ...campaign }],
    marketing_campaign_recipients: recipients,
  });
  h.db = db;
}

const valid = {
  campaignId: "c1",
  confirmApply: "yes",
  subject: "AI subject",
  previewText: "AI preview",
  bodyText: "AI body",
};

async function apply(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await applyCampaignAiSuggestionToDraftAction(fd);
    return null;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest) throw error;
    return digest.split(";")[2];
  }
}
const row = () => db.tables.marketing_campaigns[0];
const untouched = () =>
  expect(row()).toMatchObject({ subject: "Original subject", preview_text: "orig preview", body_text: "Original body" });

beforeEach(() => {
  h.role = "studio_owner";
  h.frozen = false;
  h.send.mockReset();
  h.recordUsage.mockReset();
  h.fetch.mockReset();
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  seed();
});

describe("applyCampaignAiSuggestionToDraftAction (M-1b)", () => {
  it("applies subject, preview and body to the draft and keeps every other field", async () => {
    expect(await apply(valid)).toBe("/app/marketing/campaigns/c1?campaign_saved=1");
    expect(row()).toMatchObject({
      name: "Original",
      subject: "AI subject",
      preview_text: "AI preview",
      body_text: "AI body",
      cta_label: "Book",
      cta_url: "https://example.com/book",
      audience_type: "all_active_clients",
      status: "draft",
    });
  });

  it("applies only the supplied parts; others keep their current values", async () => {
    await apply({ campaignId: "c1", confirmApply: "yes", bodyText: "AI body only" });
    expect(row()).toMatchObject({ subject: "Original subject", preview_text: "orig preview", body_text: "AI body only" });
  });

  it("never sends, never calls the AI provider and records no usage when applying", async () => {
    await apply(valid);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "no", "true"])("refuses without explicit confirmation (%s)", async (confirm) => {
    const fields: Record<string, string> = { ...valid };
    if (confirm === undefined) delete fields.confirmApply;
    else fields.confirmApply = confirm;
    expect(await apply(fields)).toContain("campaign_error=apply_not_confirmed");
    untouched();
  });

  it("refuses an empty suggestion", async () => {
    expect(await apply({ campaignId: "c1", confirmApply: "yes" })).toContain("campaign_error=apply_empty");
    untouched();
  });

  it("refuses without a campaign id", async () => {
    expect(await apply({ ...valid, campaignId: "" })).toContain("campaign_error=not_found");
  });

  it.each(["sending", "sent", "cancelled", "scheduled"])("never edits a %s campaign", async (status) => {
    seed({ status });
    expect(await apply(valid)).toContain("campaign_error=campaign_locked");
    untouched();
    expect(row().status).toBe(status);
  });

  it("never edits a draft whose delivery has started", async () => {
    seed({}, [{ id: "r1", campaign_id: "c1", studio_id: "studio-a", status: "sent", email: "a@example.test" }]);
    expect(await apply(valid)).toContain("campaign_error=campaign_started");
    untouched();
  });

  it("refuses while marketing sends are frozen", async () => {
    h.frozen = true;
    expect(await apply(valid)).toContain("campaign_error=marketing_paused");
    untouched();
  });

  it.each(["instructor", "independent_instructor", "unknown_role"])("refuses role %s", async (role) => {
    h.role = role;
    expect(await apply(valid)).toContain("campaign_error=unauthorized");
    untouched();
  });

  it("refuses another studio's campaign", async () => {
    seed({ studio_id: "studio-b" });
    expect(await apply(valid)).toContain("campaign_error=not_found");
    untouched();
  });
});
