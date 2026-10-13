import { test, expect } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient } from "../helpers/competitionFixture";
import { signIn } from "../helpers/competitionWizard";
import {
  cleanupMarketingFixture,
  createMarketingFixture,
  isMarketingFrozen,
  setMarketingFreeze,
  startMockEmailProvider,
  type MarketingFixture,
} from "../helpers/marketingFixture";

/**
 * Marketing M-0 -- unsubscribe links in emails ALREADY SENT by M-0 keep working in every supported application state,
 * against the LOCAL QA stack with M-0 stage 1 installed (stage 2 is never combined with a pre-M-0 application).
 *
 * E2E_M0_APP_VARIANT selects the application under test at E2E_BASE_URL:
 *   m0      the M-0 application (default)
 *   compat  the prepared rollback build: pre-M-0 application + the M-0 one-click endpoint only (branch m0-rollback-compat)
 *   pre_m0  the plain pre-M-0 application -- documents why it must NOT be the rollback target (one-click 404)
 *
 * Every message link M-0 emits is exercised: the RFC 8058 one-click URL (studio, organizer and per-message tokens),
 * GET on that URL (never unsubscribes), and the footer confirmation pages (studio, per-message, organizer).
 * Tokens are seeded the way the M-0 pipeline issues them (sync -> claim -> complete 'sent'; message tokens).
 *
 * For the pre-M-0 variants it also proves the marketing send freeze stops that application's campaign send, even when
 * the disabled Send controls are forced (E2E_RESEND_MOCK_PORT: a local mock that must receive nothing).
 */

type Variant = "m0" | "compat" | "pre_m0";
const VARIANT = (process.env.E2E_M0_APP_VARIANT ?? "m0") as Variant;
const oneClickServed = VARIANT !== "pre_m0";

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.describe(`Marketing M-0 unsubscribe link survival (app variant: ${VARIANT})`, () => {
  let config: E2EConfig;
  let fixture: MarketingFixture;
  let frozenBefore = true;
  const tokens: Record<string, string> = {};
  const admin = () => e2eAdminClient(config);

  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await admin().rpc(name, args);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data as T;
  }

  async function sendViaPipeline(kind: "studio" | "organizer", scopeId: string, campaignId: string, email: string) {
    const table = kind === "studio" ? "marketing_campaign_recipients" : "organizer_marketing_campaign_recipients";
    const { data } = await admin().from(table).select("id, unsubscribe_token").eq("campaign_id", campaignId).eq("email", email).single();
    const claim = await rpc<{ outcome: string; claim_id: string }>("marketing_claim_campaign_recipient", {
      p_scope_kind: kind, p_scope_id: scopeId, p_campaign_id: campaignId, p_recipient_id: data!.id, p_lease_seconds: 600,
    });
    expect(claim.outcome).toBe("claimed");
    await rpc("marketing_complete_campaign_recipient", {
      p_scope_kind: kind, p_scope_id: scopeId, p_recipient_id: data!.id, p_claim_id: claim.claim_id, p_outcome: "sent",
      p_provider_message_id: `e2e-${fixture.runId}-${email}`, p_error: null,
    });
    return String(data!.unsubscribe_token);
  }

  async function studioUnsubscribed(email: string) {
    const { count } = await admin().from("marketing_unsubscribes").select("id", { count: "exact", head: true })
      .eq("studio_id", fixture.studioId).eq("email", email.toLowerCase());
    return (count ?? 0) > 0;
  }
  async function organizerUnsubscribed(email: string) {
    const { count } = await admin().from("organizer_marketing_unsubscribes").select("id", { count: "exact", head: true })
      .eq("organizer_id", fixture.organizerId).eq("email", email.toLowerCase());
    return (count ?? 0) > 0;
  }
  async function oneClick(request: import("@playwright/test").APIRequestContext, token: string) {
    return request.post(`/api/email/unsubscribe/${token}`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: "List-Unsubscribe=One-Click",
      maxRedirects: 0,
    });
  }

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl)) throw new Error("refusing: not the local QA Supabase");
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.baseUrl)) throw new Error("refusing: app is not local");
    frozenBefore = await isMarketingFrozen(config);
    await setMarketingFreeze(config, false, "e2e unsubscribe survival: seeding");
    fixture = await createMarketingFixture(config);
    const { clients: c, contacts: k } = fixture;
    const extra = { m1: `e2e-mkt-${fixture.runId}-m1@example.com` };

    await rpc("marketing_sync_campaign_recipients", {
      p_scope_kind: "studio", p_scope_id: fixture.studioId, p_campaign_id: fixture.campaignId,
      p_recipients: [c.a, c.b, c.c].map((x) => ({ email: x.email, ref_id: x.id })),
    });
    tokens.studioA = await sendViaPipeline("studio", fixture.studioId, fixture.campaignId, c.a.email);
    tokens.studioB = await sendViaPipeline("studio", fixture.studioId, fixture.campaignId, c.b.email);
    await rpc("marketing_sync_campaign_recipients", {
      p_scope_kind: "organizer", p_scope_id: fixture.organizerId, p_campaign_id: fixture.organizerCampaignId,
      p_recipients: [k.x, k.y].map((x) => ({ email: x.email, ref_id: x.id })),
    });
    await rpc("marketing_sync_campaign_recipients", {
      p_scope_kind: "organizer", p_scope_id: fixture.organizerId, p_campaign_id: fixture.organizerCampaign2Id,
      p_recipients: [k.x, k.y].map((x) => ({ email: x.email, ref_id: x.id })),
    });
    tokens.orgX = await sendViaPipeline("organizer", fixture.organizerId, fixture.organizerCampaignId, k.x.email);
    tokens.orgY = await sendViaPipeline("organizer", fixture.organizerId, fixture.organizerCampaignId, k.y.email);
    // commercial ARIA / automation messages carry per-message tokens
    tokens.msgC = await rpc<string>("marketing_issue_message_unsubscribe_token", {
      p_scope_kind: "studio", p_scope_id: fixture.studioId, p_email: c.c.email, p_source_table: "outbound_deliveries", p_source_id: crypto.randomUUID(),
    });
    tokens.msgM1 = await rpc<string>("marketing_issue_message_unsubscribe_token", {
      p_scope_kind: "studio", p_scope_id: fixture.studioId, p_email: extra.m1, p_source_table: "outbound_deliveries", p_source_id: crypto.randomUUID(),
    });
    Object.assign(tokens, { m1Email: extra.m1 });
  });

  test.afterAll(async () => {
    if (config) await setMarketingFreeze(config, frozenBefore, "e2e unsubscribe survival: restore");
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    await cleanupMarketingFixture(config, fixture);
  });

  test("RFC 8058 one-click: studio campaign token", async ({ request }) => {
    const response = await oneClick(request, tokens.studioA);
    if (!oneClickServed) {
      expect(response.status()).toBe(404); // the plain pre-M-0 build cannot honor one-click: not a valid rollback target
      expect(await studioUnsubscribed(fixture.clients.a.email)).toBe(false);
      return;
    }
    expect(response.status()).toBe(200);
    expect(await studioUnsubscribed(fixture.clients.a.email)).toBe(true);
  });

  test("RFC 8058 one-click: organizer campaign token (persists and suppresses the organizer's next campaign)", async ({ request }) => {
    const response = await oneClick(request, tokens.orgX);
    if (!oneClickServed) {
      expect(response.status()).toBe(404);
      return;
    }
    expect(response.status()).toBe(200);
    expect(await organizerUnsubscribed(fixture.contacts.x.email)).toBe(true);
    const { data } = await admin().from("organizer_marketing_campaign_recipients").select("status")
      .eq("campaign_id", fixture.organizerCampaign2Id).eq("email", fixture.contacts.x.email).single();
    expect(data?.status).toBe("unsubscribed");
  });

  test("RFC 8058 one-click: per-message token of a commercial automation email", async ({ request }) => {
    const response = await oneClick(request, tokens.msgC);
    if (!oneClickServed) {
      expect(response.status()).toBe(404);
      return;
    }
    expect(response.status()).toBe(200);
    expect(await studioUnsubscribed(fixture.clients.c.email)).toBe(true);
    const { data } = await admin().from("marketing_campaign_recipients").select("status")
      .eq("campaign_id", fixture.campaignId).eq("email", fixture.clients.c.email).single();
    expect(data?.status).toBe("unsubscribed"); // the address's pending campaign row is suppressed too
  });

  test("GET on the one-click URL never unsubscribes", async ({ request }) => {
    const response = await request.get(`/api/email/unsubscribe/${tokens.studioB}`, { maxRedirects: 0 });
    if (!oneClickServed) {
      expect(response.status()).toBe(404);
    } else {
      expect(response.status()).toBe(303);
      expect(response.headers().location).toContain(`/unsubscribe/marketing/${tokens.studioB}`);
    }
    expect(await studioUnsubscribed(fixture.clients.b.email)).toBe(false);
  });

  test("footer link: studio campaign confirmation page", async ({ page }) => {
    await page.goto(`/unsubscribe/marketing/${tokens.studioB}`);
    expect(await studioUnsubscribed(fixture.clients.b.email)).toBe(false); // opening the page changes nothing
    await page.getByRole("button", { name: "Unsubscribe" }).click();
    await expect(page.getByText(VARIANT === "m0" ? "Your request has been received." : "You are unsubscribed.")).toBeVisible();
    expect(await studioUnsubscribed(fixture.clients.b.email)).toBe(true);
  });

  test("footer link: per-message token on the studio confirmation page", async ({ page }) => {
    await page.goto(`/unsubscribe/marketing/${tokens.msgM1}`);
    await page.getByRole("button", { name: "Unsubscribe" }).click();
    await expect(page.getByText(VARIANT === "m0" ? "Your request has been received." : "You are unsubscribed.")).toBeVisible();
    expect(await studioUnsubscribed(tokens.m1Email)).toBe(true);
  });

  test("footer link: organizer confirmation page persists the organizer opt-out", async ({ page }) => {
    await page.goto(`/unsubscribe/organizer-marketing/${tokens.orgY}`);
    if (VARIANT === "m0") {
      expect(await organizerUnsubscribed(fixture.contacts.y.email)).toBe(false);
      await page.getByRole("button", { name: "Unsubscribe" }).click();
      await expect(page.getByText("Your request has been received.")).toBeVisible();
    } else {
      // the pre-M-0 page unsubscribes on load; stage 1's compatibility trigger now persists it (C1)
      await expect(page.getByText("You have been unsubscribed")).toBeVisible();
    }
    expect(await organizerUnsubscribed(fixture.contacts.y.email)).toBe(true);
    const { data } = await admin().from("organizer_marketing_campaign_recipients").select("status")
      .eq("campaign_id", fixture.organizerCampaign2Id).eq("email", fixture.contacts.y.email).single();
    expect(data?.status).toBe("unsubscribed");
  });

  test("freeze: the pre-M-0 application cannot send a campaign (pending recipients hidden; a forced submit sends nothing)", async ({ page }) => {
    test.skip(VARIANT === "m0", "the M-0 application's freeze is covered by marketing-m0-compliance.spec.ts");
    const port = Number(process.env.E2E_RESEND_MOCK_PORT ?? 0);
    test.skip(!port, "E2E_RESEND_MOCK_PORT is required (the app must point RESEND_BASE_URL at it)");
    const mock = await startMockEmailProvider(port);
    const campaignId = crypto.randomUUID();
    const addresses = [`e2e-mkt-${fixture.runId}-f1@example.com`, `e2e-mkt-${fixture.runId}-f2@example.com`];
    try {
      const { error } = await admin().from("marketing_campaigns").insert({
        id: campaignId, studio_id: fixture.studioId, name: `E2E freeze ${fixture.runId}`, subject: "Freeze", preview_text: "Freeze",
        body_text: "Must not be sent.", audience_type: "all_active_clients", status: "draft",
      });
      if (error) throw new Error(error.message);
      await rpc("marketing_sync_campaign_recipients", {
        p_scope_kind: "studio", p_scope_id: fixture.studioId, p_campaign_id: campaignId, p_recipients: addresses.map((email) => ({ email })),
      });
      await setMarketingFreeze(config, true, "e2e unsubscribe survival: freeze vs pre-M-0 send");
      const url = `/app/marketing/campaigns/${campaignId}`;
      await signIn(page, fixture.owner, url);
      await page.goto(url);
      const sendForm = page.locator("form").filter({ has: page.locator('input[name="confirmSend"]') });
      await expect(sendForm.locator('button[type="submit"]')).toBeDisabled();
      // force it: re-enable every control and submit the server action anyway
      await page.evaluate(() => document.querySelectorAll("[disabled]").forEach((el) => el.removeAttribute("disabled")));
      await sendForm.locator('input[name="confirmSend"]').check();
      await sendForm.locator('button[type="submit"]').click();
      // the pre-M-0 action finds no pending recipient and stops before any provider call (it reports that as
      // no_pending_recipients, or as send_failed because it swallows redirects thrown inside its try block)
      await page.waitForURL(/campaign_error=(no_pending_recipients|send_failed)/);
      expect(mock.received).toHaveLength(0);
      const { data: rows } = await admin().from("marketing_campaign_recipients").select("status").eq("campaign_id", campaignId);
      expect((rows ?? []).map((r) => r.status)).toEqual(["pending", "pending"]);
    } finally {
      await setMarketingFreeze(config, false, "e2e unsubscribe survival: freeze released");
      await mock.close();
    }
  });

  test("an unknown token looks processed and records nothing", async ({ request }) => {
    const before = await admin().from("marketing_unsubscribes").select("id", { count: "exact", head: true }).eq("studio_id", fixture.studioId);
    const response = await oneClick(request, crypto.randomUUID());
    expect(response.status()).toBe(oneClickServed ? 200 : 404);
    const after = await admin().from("marketing_unsubscribes").select("id", { count: "exact", head: true }).eq("studio_id", fixture.studioId);
    expect(after.count).toBe(before.count);
  });
});
