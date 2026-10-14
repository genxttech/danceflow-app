import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient } from "./competitionFixture";

/**
 * Marketing M-0 E2E support: a studio + organizer workspace with marketing audiences on the LOCAL QA stack, and a mock
 * email provider (the app is started with RESEND_BASE_URL pointing at it), so no message ever leaves the machine.
 */

export type MarketingFixture = {
  runId: string;
  studioId: string;
  organizerId: string;
  planId: string;
  createdPlan: boolean;
  owner: { id: string; email: string; password: string };
  clients: Record<"a" | "b" | "c", { id: string; email: string }>;
  contacts: Record<"x" | "y", { id: string; email: string }>;
  campaignId: string;
  organizerCampaignId: string;
  organizerCampaign2Id: string;
};

async function must<T>(promise: PromiseLike<{ data: T; error: { message: string } | null }>, label: string): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`marketing fixture: ${label}: ${error.message}`);
  return data;
}

export async function createMarketingFixture(config: E2EConfig): Promise<MarketingFixture> {
  const admin = e2eAdminClient(config);
  const runId = randomUUID().slice(0, 8);
  const email = (tag: string) => `e2e-mkt-${runId}-${tag}@example.com`;
  const fixture: MarketingFixture = {
    runId,
    studioId: randomUUID(),
    organizerId: randomUUID(),
    planId: randomUUID(),
    createdPlan: false,
    owner: { id: "", email: email("owner"), password: `E2e-${randomUUID()}` },
    clients: { a: { id: randomUUID(), email: email("a") }, b: { id: randomUUID(), email: email("b") }, c: { id: randomUUID(), email: email("c") } },
    contacts: { x: { id: randomUUID(), email: email("x") }, y: { id: randomUUID(), email: email("y") } },
    campaignId: randomUUID(),
    organizerCampaignId: randomUUID(),
    organizerCampaign2Id: randomUUID(),
  };
  try {
    const plan = await must<{ id: string } | null>(admin.from("subscription_plans").select("id").eq("code", "pro").maybeSingle(), "plan lookup");
    if (plan) fixture.planId = plan.id;
    else {
      await must(admin.from("subscription_plans").insert({ id: fixture.planId, code: "pro", name: "Pro (E2E)", active: true }), "plan");
      fixture.createdPlan = true;
    }
    await must(
      admin.from("studios").insert({
        id: fixture.studioId,
        name: `E2E Marketing Studio ${runId}`,
        slug: `e2e-mkt-${runId}`,
        subscription_status: "active",
        billing_plan: "pro",
        email: email("studio"),
        address_line_1: "1 E2E Street",
        city: "Austin",
        state: "TX",
        postal_code: "78701",
        country: "US",
      }),
      "studio",
    );
    await must(admin.from("studio_subscriptions").insert({ studio_id: fixture.studioId, subscription_plan_id: fixture.planId, status: "active" }), "subscription");
    await must(
      admin.from("organizers").insert({
        id: fixture.organizerId,
        studio_id: fixture.studioId,
        name: `E2E Marketing Organizer ${runId}`,
        slug: `e2e-mkt-org-${runId}`,
        subscription_status: "active",
        billing_plan: "organizer",
      }),
      "organizer",
    );

    const { data: created, error } = await admin.auth.admin.createUser({ email: fixture.owner.email, password: fixture.owner.password, email_confirm: true });
    if (error || !created.user) throw new Error(`marketing fixture: owner: ${error?.message}`);
    fixture.owner.id = created.user.id;
    await must(admin.from("profiles").upsert({ id: fixture.owner.id, email: fixture.owner.email, full_name: "E2E Marketing Owner" }), "owner profile");
    await must(admin.from("user_studio_roles").insert({ user_id: fixture.owner.id, studio_id: fixture.studioId, role: "studio_owner", active: true }), "owner role");
    await must(admin.from("organizer_users").insert({ organizer_id: fixture.organizerId, user_id: fixture.owner.id, role: "organizer_owner", active: true }), "organizer user");

    await must(
      admin.from("clients").insert(
        (["a", "b", "c"] as const).map((k) => ({
          id: fixture.clients[k].id,
          studio_id: fixture.studioId,
          first_name: `Client${k.toUpperCase()}`,
          last_name: "E2E",
          email: fixture.clients[k].email,
          status: "active",
        })),
      ),
      "clients",
    );
    await must(
      admin.from("organizer_contacts").insert(
        (["x", "y"] as const).map((k) => ({ id: fixture.contacts[k].id, organizer_id: fixture.organizerId, email: fixture.contacts[k].email, status: "active" })),
      ),
      "contacts",
    );
    await must(
      admin.from("marketing_campaigns").insert({
        id: fixture.campaignId,
        studio_id: fixture.studioId,
        name: `E2E M-0 ${runId}`,
        subject: "Spring classes",
        preview_text: "New classes",
        body_text: "Hello from the studio.",
        audience_type: "all_active_clients",
        status: "draft",
      }),
      "campaign",
    );
    await must(
      admin.from("organizer_marketing_campaigns").insert(
        [fixture.organizerCampaignId, fixture.organizerCampaign2Id].map((id, i) => ({
          id,
          organizer_id: fixture.organizerId,
          name: `E2E Org M-0 ${runId} ${i + 1}`,
          subject: "Festival news",
          preview_text: "Lineup",
          body_text: "Hello from the festival.",
          audience_type: "all_organizer_contacts",
          status: "draft",
        })),
      ),
      "organizer campaigns",
    );
    return fixture;
  } catch (error) {
    await cleanupMarketingFixture(config, fixture).catch(() => undefined);
    throw error;
  }
}

/** Marketing M-0 send freeze (stage 1 lands frozen). Specs record the state, unfreeze, and restore it afterwards. */
export async function isMarketingFrozen(config: E2EConfig): Promise<boolean> {
  const { data, error } = await e2eAdminClient(config).rpc("marketing_send_frozen");
  if (error) throw new Error(`marketing freeze: ${error.message}`);
  return data === true;
}

export async function setMarketingFreeze(config: E2EConfig, frozen: boolean, reason: string) {
  const { error } = await e2eAdminClient(config).rpc("marketing_set_send_freeze", { p_frozen: frozen, p_reason: reason });
  if (error) throw new Error(`marketing freeze: ${error.message}`);
}

export async function cleanupMarketingFixture(config: E2EConfig, fixture: MarketingFixture | undefined) {
  if (!fixture) return;
  const admin = e2eAdminClient(config);
  const failures: string[] = [];
  const del = async (label: string, promise: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await promise;
    if (error) failures.push(`${label}: ${error.message}`);
  };
  await del("test sends", admin.from("marketing_test_sends").delete().in("scope_id", [fixture.studioId, fixture.organizerId]));
  await del("message tokens", admin.from("marketing_message_unsubscribe_tokens").delete().eq("studio_id", fixture.studioId));
  await del("outbound", admin.from("outbound_deliveries").delete().eq("studio_id", fixture.studioId));
  await del("organizer campaigns", admin.from("organizer_marketing_campaigns").delete().eq("organizer_id", fixture.organizerId));
  await del("studio campaigns", admin.from("marketing_campaigns").delete().eq("studio_id", fixture.studioId));
  await del("usage", admin.from("usage_reservations").delete().or(`studio_id.eq.${fixture.studioId},organizer_id.eq.${fixture.organizerId}`));
  await del("usage events", admin.from("usage_events").delete().or(`studio_id.eq.${fixture.studioId},organizer_id.eq.${fixture.organizerId}`));
  await del("usage summaries", admin.from("usage_monthly_summaries").delete().or(`studio_id.eq.${fixture.studioId},organizer_id.eq.${fixture.organizerId}`));
  await del("organizer users", admin.from("organizer_users").delete().eq("organizer_id", fixture.organizerId));
  await del("organizer", admin.from("organizers").delete().eq("id", fixture.organizerId));
  await del("roles", admin.from("user_studio_roles").delete().eq("studio_id", fixture.studioId));
  await del("subscription", admin.from("studio_subscriptions").delete().eq("studio_id", fixture.studioId));
  await del("studio", admin.from("studios").delete().eq("id", fixture.studioId));
  if (fixture.owner.id) {
    await del("profile", admin.from("profiles").delete().eq("id", fixture.owner.id));
    const { error } = await admin.auth.admin.deleteUser(fixture.owner.id);
    if (error) failures.push(`owner: ${error.message}`);
  }
  if (fixture.createdPlan) await del("plan", admin.from("subscription_plans").delete().eq("id", fixture.planId));
  if (failures.length) throw new Error(`marketing fixture cleanup incomplete: ${failures.join("; ")}`);
}

export type CapturedEmail = {
  idempotencyKey: string | null;
  body: { from: string; to: string[]; subject: string; html: string; text: string; headers?: Record<string, string>; reply_to?: string };
};

/** A minimal stand-in for the provider's POST /emails endpoint. Never forwards anything. */
export async function startMockEmailProvider(port: number) {
  const received: CapturedEmail[] = [];
  let failNext: null | { status: number; name: string } = null;
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      if (request.method !== "POST" || !request.url?.startsWith("/emails")) {
        response.writeHead(404).end();
        return;
      }
      if (failNext) {
        const failure = failNext;
        failNext = null;
        response.writeHead(failure.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: failure.name, message: failure.name, statusCode: failure.status }));
        return;
      }
      const body = JSON.parse(raw || "{}");
      received.push({ idempotencyKey: (request.headers["idempotency-key"] as string) ?? null, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `mock-${received.length}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    received,
    failNextWith(status: number, name: string) {
      failNext = { status, name };
    },
    clear() {
      received.length = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
