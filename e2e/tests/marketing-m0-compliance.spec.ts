import { test, expect } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient } from "../helpers/competitionFixture";
import { signIn } from "../helpers/competitionWizard";
import { cleanupMarketingFixture, createMarketingFixture, startMockEmailProvider, type MarketingFixture } from "../helpers/marketingFixture";

/**
 * Marketing M-0 -- email compliance and suppression integrity, end to end in the browser against the LOCAL QA stack.
 *
 * The app under test must run with RESEND_BASE_URL=http://127.0.0.1:<E2E_RESEND_MOCK_PORT> (a mock provider this spec
 * starts), RESEND_API_KEY set to any dummy value, MARKETING_FROM_EMAIL set, NEXT_PUBLIC_SITE_URL = the app origin, and
 * CRON_SECRET = E2E_CRON_SECRET. Nothing is delivered anywhere: the mock records what the app would have sent.
 *
 * Proves: test sends only to verified staff; the send list is built with suppression decided in the database; an
 * address unsubscribed (one-click) between preparing and sending is not mailed; every campaign email carries its own
 * unsubscribe link, RFC 8058 headers and a per-recipient idempotency key; GET never unsubscribes; the confirmation page
 * and the one-click endpoint both record the unsubscribe; organizer unsubscribes persist and suppress the next campaign
 * (C1); commercial automation email is suppressed / footed at the dispatch boundary while operational email is not.
 */

test.describe.configure({ mode: "serial", timeout: 240_000 });

const MOCK_PORT = Number(process.env.E2E_RESEND_MOCK_PORT ?? 0);
const CRON_SECRET = process.env.E2E_CRON_SECRET ?? "";

test.describe("Marketing M-0 email compliance (local QA stack, mock provider)", () => {
  test.skip(!MOCK_PORT || !CRON_SECRET, "E2E_RESEND_MOCK_PORT and E2E_CRON_SECRET (and an app wired to the mock) are required");

  let config: E2EConfig;
  let fixture: MarketingFixture;
  let mock: Awaited<ReturnType<typeof startMockEmailProvider>>;
  const admin = () => e2eAdminClient(config);
  const campaignUrl = () => `/app/marketing/campaigns/${fixture.campaignId}`;

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl)) throw new Error("refusing: not the local QA Supabase");
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.baseUrl)) throw new Error("refusing: app is not local");
    mock = await startMockEmailProvider(MOCK_PORT);
    fixture = await createMarketingFixture(config);
  });

  test.afterAll(async () => {
    await mock?.close();
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    await cleanupMarketingFixture(config, fixture);
  });

  async function recipient(email: string, campaignId = fixture.campaignId) {
    const { data } = await admin()
      .from("marketing_campaign_recipients")
      .select("id, status, unsubscribe_token, provider_message_id")
      .eq("campaign_id", campaignId)
      .eq("email", email)
      .maybeSingle();
    return data as { id: string; status: string; unsubscribe_token: string; provider_message_id: string | null } | null;
  }

  test("studio test send: refused for a non-staff address, delivered only to verified staff", async ({ page }) => {
    await signIn(page, fixture.owner, campaignUrl());
    await page.goto(campaignUrl());
    await page.locator("#testEmail").fill(`e2e-outsider-${fixture.runId}@example.com`);
    await page.getByRole("button", { name: "Send Test Email" }).click();
    await page.waitForURL(/campaign_error=test_recipient_not_allowed/);
    await expect(page.getByText("Test emails can only be sent to a verified email address")).toBeVisible();
    expect(mock.received).toHaveLength(0);

    await page.locator("#testEmail").fill(fixture.owner.email);
    await page.getByRole("button", { name: "Send Test Email" }).click();
    await page.waitForURL(/test_sent=1/);
    expect(mock.received).toHaveLength(1);
    expect(mock.received[0].body.to).toEqual([fixture.owner.email]);
    expect(mock.received[0].body.subject).toContain("[TEST]");
    mock.clear();
  });

  test("studio send: an address unsubscribed (one-click) after the list was prepared is not mailed; every email is compliant", async ({ page, request }) => {
    await signIn(page, fixture.owner, campaignUrl());
    await page.goto(campaignUrl());
    await page.getByRole("button", { name: /^(Prepare Send List|Refresh Send List)$/ }).click();
    await page.waitForURL(/recipients_generated=1/);
    const b = await recipient(fixture.clients.b.email);
    expect(b?.status).toBe("pending");

    // RFC 8058 one-click, exactly as a mailbox provider sends it: no cookies, no login
    const oneClick = await request.post(`/api/email/unsubscribe/${b!.unsubscribe_token}`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: "List-Unsubscribe=One-Click",
    });
    expect(oneClick.status()).toBe(200);

    await page.goto(campaignUrl());
    await page.locator('input[name="confirmSend"]').check();
    await page.getByRole("button", { name: /^Send to \d+ Recipients?$/ }).click();
    await page.waitForURL(/campaign_sent=1/);

    const sentTo = mock.received.map((m) => m.body.to[0]).sort();
    expect(sentTo).toEqual([fixture.clients.a.email, fixture.clients.c.email].sort());
    for (const message of mock.received) {
      const row = await recipient(message.body.to[0]);
      expect(row?.status).toBe("sent");
      expect(message.idempotencyKey).toBe(`mkt-studio-${row!.id}`);
      expect(message.body.headers?.["List-Unsubscribe"]).toBe(`<${config.baseUrl}/api/email/unsubscribe/${row!.unsubscribe_token}>`);
      expect(message.body.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      expect(message.body.html).toContain(`${config.baseUrl}/unsubscribe/marketing/${row!.unsubscribe_token}`);
      expect(message.body.html).toContain("1 E2E Street");
    }
    expect((await recipient(fixture.clients.b.email))?.status).toBe("unsubscribed");
    const { data: unsub } = await admin().from("marketing_unsubscribes").select("source").eq("studio_id", fixture.studioId).eq("email", fixture.clients.b.email).single();
    expect(unsub?.source).toBe("one_click");
  });

  test("GET never unsubscribes; the confirmation page does", async ({ page, request }) => {
    const a = await recipient(fixture.clients.a.email);
    const header = mock.received.find((m) => m.body.to[0] === fixture.clients.a.email)!.body.headers!["List-Unsubscribe"];
    const oneClickUrl = header.slice(1, -1);
    const get = await request.get(oneClickUrl, { maxRedirects: 0 });
    expect(get.status()).toBe(303);
    await page.goto(`/unsubscribe/marketing/${a!.unsubscribe_token}`);
    await expect(page.getByRole("heading", { name: "Unsubscribe from marketing emails?" })).toBeVisible();
    await expect(page.getByText(fixture.clients.a.email)).toHaveCount(0);
    const { count: before } = await admin().from("marketing_unsubscribes").select("id", { count: "exact", head: true }).eq("studio_id", fixture.studioId).eq("email", fixture.clients.a.email);
    expect(before).toBe(0);

    await page.getByRole("button", { name: "Unsubscribe" }).click();
    await expect(page.getByText("Your request has been received.")).toBeVisible();
    const { data: unsub } = await admin().from("marketing_unsubscribes").select("source").eq("studio_id", fixture.studioId).eq("email", fixture.clients.a.email).single();
    expect(unsub?.source).toBe("page_form");
  });

  test("organizer send + one-click from the delivered header persists the unsubscribe and suppresses the next campaign (C1)", async ({ page, request }) => {
    mock.clear();
    const url = `/app/organizer-campaigns/${fixture.organizerCampaignId}`;
    await signIn(page, fixture.owner, url);
    await page.goto(url);
    await page.locator('input[name="testEmail"]').fill(fixture.owner.email);
    await page.getByRole("button", { name: "Send test email", exact: true }).click();
    await page.waitForURL(/test_sent=1/);
    await page.getByRole("button", { name: "Prepare recipient list" }).click();
    await page.waitForURL(/recipients_generated=1/);
    await page.locator('input[name="confirmSend"]').check();
    await page.locator('input[name="confirmSendPhrase"]').fill("SEND 2");
    await page.getByRole("button", { name: "Send live campaign" }).click();
    await page.waitForURL(/campaign_sent=1/);

    const toX = mock.received.find((m) => m.body.to[0] === fixture.contacts.x.email);
    expect(toX).toBeTruthy();
    expect(toX!.idempotencyKey).toMatch(/^mkt-organizer-/);
    expect(toX!.body.html).toContain("/unsubscribe/organizer-marketing/");
    const oneClickUrl = toX!.body.headers!["List-Unsubscribe"].slice(1, -1);
    expect((await request.post(oneClickUrl, { headers: { "content-type": "application/x-www-form-urlencoded" }, data: "List-Unsubscribe=One-Click" })).status()).toBe(200);

    const { data: record } = await admin().from("organizer_marketing_unsubscribes").select("source, request_count").eq("organizer_id", fixture.organizerId).eq("email", fixture.contacts.x.email).single();
    expect(record).toMatchObject({ source: "one_click", request_count: 1 });
    const { data: contact } = await admin().from("organizer_contacts").select("status").eq("id", fixture.contacts.x.id).single();
    expect(contact?.status).toBe("unsubscribed");

    // the next campaign's list suppresses the address
    await page.goto(`/app/organizer-campaigns/${fixture.organizerCampaign2Id}`);
    await page.getByRole("button", { name: "Prepare recipient list" }).click();
    await page.waitForURL(/recipients_generated=1|campaign_error/);
    const { data: rows } = await admin().from("organizer_marketing_campaign_recipients").select("email, status").eq("campaign_id", fixture.organizerCampaign2Id);
    expect(rows?.find((r) => r.email === fixture.contacts.x.email)).toBeUndefined(); // contact no longer active: not in the audience
    expect(rows?.find((r) => r.email === fixture.contacts.y.email)?.status).toBe("pending");
  });

  test("commercial automation email is suppressed and footed at the dispatch boundary; operational email is unaffected", async ({ request }) => {
    mock.clear();
    const db = admin();
    const base = { studio_id: fixture.studioId, channel: "email", status: "queued", body_html: null, reply_to_email: null, related_table: null, related_id: null };
    await db.from("outbound_deliveries").insert([
      { ...base, template_key: "automation_low_package_balance", recipient_email: fixture.clients.c.email, subject: "Renew", body_text: "Renew your package.", payload: { content_origin: "system_default" }, dedupe_key: `m0-${fixture.runId}-1` },
      { ...base, template_key: "automation_low_package_balance", recipient_email: fixture.clients.b.email, subject: "Renew", body_text: "Renew your package.", payload: { content_origin: "system_default" }, dedupe_key: `m0-${fixture.runId}-2` },
      { ...base, template_key: "automation_unsigned_document", recipient_email: fixture.clients.b.email, subject: "Please sign", body_text: "A document needs your signature.", payload: { content_origin: "system_default" }, dedupe_key: `m0-${fixture.runId}-3` },
    ]).throwOnError();

    const response = await request.get("/api/notifications/send", { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    expect(response.status()).toBe(200);

    const toC = mock.received.find((m) => m.body.to[0] === fixture.clients.c.email && m.body.subject === "Renew");
    expect(toC?.body.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(toC?.body.html).toContain("1 E2E Street");
    expect(mock.received.filter((m) => m.body.to[0] === fixture.clients.b.email && m.body.subject === "Renew")).toHaveLength(0);
    const toBOperational = mock.received.find((m) => m.body.to[0] === fixture.clients.b.email && m.body.subject === "Please sign");
    expect(toBOperational).toBeTruthy();
    expect(toBOperational?.body.headers).toBeUndefined();

    const { data: rows } = await db.from("outbound_deliveries").select("dedupe_key, status, error_message").eq("studio_id", fixture.studioId).order("dedupe_key");
    expect(rows?.map((r) => `${r.status}:${r.error_message ?? ""}`)).toEqual(["sent:", "skipped:marketing_unsubscribed", "sent:"]);
  });
});
