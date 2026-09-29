import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createOwnershipFakeSupabase } from "./ownershipFakes";
import { paydc2dRowGuard } from "./identityWriteLockModel";

/**
 * PAY-DC-2D: server paths that own Stripe identity after the write-lock.
 *   N2  - Stripe Connect onboarding writes the connected account with the service
 *         role only after an explicit owner/admin check, and never overwrites.
 *   M2  - membership cancel/reactivate update stripe_subscriptions via the service
 *         role after the membership gate; studio roles cannot write it directly.
 *   N1  - the legacy anonymous registration flow writes nothing.
 *   M4  - the student order confirm route is read-only (no Stripe, no writes).
 */

const STUDIO_ID = "studio-1";
const ACCOUNT = "acct_studio1";

let db: ReturnType<typeof createOwnershipFakeSupabase>;
const context = { studioId: STUDIO_ID, studioRole: "studio_owner", isPlatformAdmin: false };
const stripeCalls: string[] = [];
let studentUser: { id: string; email: string } | null = null;

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    ...db.client,
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.adminClient }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => db.adminClient }));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => ({ ...context }) }));
vi.mock("@/lib/auth/studentApiAuth", () => ({
  getStudentApiUser: async () => studentUser,
  normalizeStudentApiUuid: (value: string) => value,
  sameStudentEmail: (user: { email?: string } | null, email: string | null | undefined) =>
    Boolean(user?.email && email && user.email.toLowerCase() === email.toLowerCase()),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    accounts: {
      create: async () => {
        stripeCalls.push("accounts.create");
        return { id: "acct_new" };
      },
      update: async () => {
        stripeCalls.push("accounts.update");
        return {};
      },
    },
    accountLinks: {
      create: async () => {
        stripeCalls.push("accountLinks.create");
        return { url: "https://connect.stripe.test/onboarding" };
      },
    },
    subscriptions: {
      update: async (_id: string, params: { cancel_at_period_end: boolean }) => {
        stripeCalls.push(`subscriptions.update:${params.cancel_at_period_end}`);
        return { status: "active", items: { data: [{ current_period_end: 1893456000 }] } };
      },
    },
    paymentIntents: {
      retrieve: async () => {
        stripeCalls.push("paymentIntents.retrieve");
        throw new Error("must not be called");
      },
    },
  }),
}));

const onboarding = await import("@/app/api/stripe/connect/onboarding/route");
const memberships = await import("@/app/app/memberships/actions");
const legacyRegister = await import("@/app/events/[slug]/register/actions");
const confirmRoute = await import("@/app/api/student/events/orders/[orderId]/confirm/route");

function redirectTarget(error: unknown) {
  const digest = (error as { digest?: string }).digest ?? "";
  return digest.split(";")[2] ?? "";
}

beforeEach(() => {
  context.studioRole = "studio_owner";
  context.isPlatformAdmin = false;
  stripeCalls.length = 0;
  studentUser = null;
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  // Fake values only; the Supabase client itself is mocked to the in-memory store.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-not-a-real-key";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("N2: Stripe Connect onboarding", () => {
  function seedStudio(account: string | null) {
    db = createOwnershipFakeSupabase(
      { studios: [{ id: STUDIO_ID, stripe_connected_account_id: account }] },
      { rowGuard: paydc2dRowGuard() },
    );
  }

  it("owner: account created and saved with the service role while NULL", async () => {
    seedStudio(null);
    const response = await onboarding.GET();

    expect(response.headers.get("location")).toBe("https://connect.stripe.test/onboarding");
    expect(db.rows("studios")[0].stripe_connected_account_id).toBe("acct_new");
    expect(db.mutations).toEqual([
      expect.objectContaining({ table: "studios", client: "admin", values: { stripe_connected_account_id: "acct_new" } }),
    ]);
  });

  it("the tenant session itself could not have written the account", async () => {
    seedStudio(null);
    const { error } = await db.client.from("studios").update({ stripe_connected_account_id: "acct_B" }).eq("id", STUDIO_ID);
    expect(error?.code).toBe("42501");
  });

  it.each(["front_desk", "instructor"])("%s: rejected before any Stripe call or write", async (role) => {
    seedStudio(null);
    context.studioRole = role;
    const response = await onboarding.GET();

    expect(response.headers.get("location")).toContain("error=connect_onboarding_unauthorized");
    expect(stripeCalls).toEqual([]);
    expect(db.mutations).toHaveLength(0);
  });

  it("platform admin may provision", async () => {
    seedStudio(null);
    context.studioRole = "front_desk";
    context.isPlatformAdmin = true;
    await onboarding.GET();
    expect(db.rows("studios")[0].stripe_connected_account_id).toBe("acct_new");
  });

  it("existing account: never overwritten, no new account created", async () => {
    seedStudio(ACCOUNT);
    await onboarding.GET();

    expect(stripeCalls).not.toContain("accounts.create");
    expect(db.mutations).toHaveLength(0);
    expect(db.rows("studios")[0].stripe_connected_account_id).toBe(ACCOUNT);
  });
});

describe("M2: stripe_subscriptions writes", () => {
  function seedMembership() {
    db = createOwnershipFakeSupabase(
      {
        client_memberships: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            client_id: "client-1",
            studio_id: STUDIO_ID,
            status: "active",
            current_period_end: "2030-01-01",
            cancel_at_period_end: false,
            auto_renew: true,
          },
        ],
        stripe_subscriptions: [
          {
            id: "sub-row-1",
            studio_id: STUDIO_ID,
            client_membership_id: "11111111-1111-4111-8111-111111111111",
            stripe_subscription_id: "sub_1",
            stripe_account_id: ACCOUNT,
            status: "active",
          },
        ],
        studios: [{ id: STUDIO_ID, stripe_connected_account_id: ACCOUNT }],
      },
      { rowGuard: paydc2dRowGuard() },
    );
  }

  function form() {
    const data = new FormData();
    data.set("clientMembershipId", "11111111-1111-4111-8111-111111111111");
    data.set("clientId", "client-1");
    return data;
  }

  it.each([
    ["cancel", () => memberships.cancelMembershipAtPeriodEndAction(form()), true, "membership_cancel_at_period_end"],
    ["reactivate", () => memberships.reactivateMembershipAutoRenewAction(form()), false, "membership_auto_renew_restored"],
  ])("%s updates the subscription through the service role", async (_name, run, cancelFlag, success) => {
    seedMembership();
    const target = await run().then(() => "", redirectTarget);

    expect(target).toContain(`success=${success}`);
    expect(db.rows("stripe_subscriptions")[0]).toMatchObject({ cancel_at_period_end: cancelFlag });
    const subscriptionWrites = db.mutations.filter((m) => m.table === "stripe_subscriptions");
    expect(subscriptionWrites.map((m) => m.client)).toEqual(["admin"]);
  });

  it("instructor cannot reach the service-role write", async () => {
    seedMembership();
    context.studioRole = "instructor";
    const target = await memberships.cancelMembershipAtPeriodEndAction(form()).then(() => "", redirectTarget);

    expect(target).toContain("error=membership_unauthorized");
    expect(stripeCalls).toEqual([]);
    expect(db.mutations).toHaveLength(0);
  });

  it.each(["studio_admin", "front_desk", "instructor"])(
    "%s session cannot forge subscription ownership directly",
    async () => {
      seedMembership();
      const insert = await db.client.from("stripe_subscriptions").insert({
        studio_id: STUDIO_ID,
        stripe_subscription_id: "sub_other",
        stripe_account_id: "acct_other",
      });
      const update = await db.client
        .from("stripe_subscriptions")
        .update({ client_membership_id: "other" })
        .eq("id", "sub-row-1");
      expect(insert.error?.code).toBe("42501");
      expect(update.error?.code).toBe("42501");
    },
  );
});

describe("N1: legacy anonymous registration flow is retired", () => {
  it("create action writes nothing and points to the supported flow", async () => {
    db = createOwnershipFakeSupabase({}, { rowGuard: paydc2dRowGuard() });
    const form = new FormData();
    form.set("eventSlug", "spring-social");
    form.set("ticketTypeId", "22222222-2222-4222-8222-222222222222");

    const result = await legacyRegister.createEventRegistrationAction(undefined, form);

    expect(result.error).toContain("registration page");
    expect(db.fromCalls).toEqual([]);
  });

  it("retry redirects to the supported registration page with a fixed code", async () => {
    db = createOwnershipFakeSupabase({});
    const form = new FormData();
    form.set("eventSlug", "spring-social");
    form.set("registrationId", "33333333-3333-4333-8333-333333333333");

    const target = await legacyRegister.retryEventRegistrationCheckoutAction(form).then(() => "", redirectTarget);

    expect(target).toBe("/events/spring-social/register?error=cart_checkout_failed");
    expect(db.fromCalls).toEqual([]);
  });

  it("no anonymous insert remains in the legacy module; public checkout stays server-side", () => {
    const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
    const legacy = read("src", "app", "events", "[slug]", "register", "actions.ts");
    expect(legacy).not.toMatch(/\.insert\(|\.update\(|from\(|createClient/);

    const cart = read("src", "app", "api", "events", "cart", "checkout", "route.ts");
    expect(cart).toContain("SUPABASE_SERVICE_ROLE_KEY");
    // The redirect code maps to an existing register-page banner.
    expect(read("src", "app", "events", "[slug]", "register", "page.tsx")).toContain("cart_checkout_failed: {");
  });
});

describe("M4: student order confirm route is read-only", () => {
  const ORDER_ID = "44444444-4444-4444-8444-444444444444";

  function seedOrder(order: Record<string, unknown>) {
    db = createOwnershipFakeSupabase({
      event_orders: [{ id: ORDER_ID, buyer_email: "buyer@example.test", ...order }],
      event_registrations: [{ id: "reg-1", order_id: ORDER_ID }],
    });
  }

  async function post() {
    const response = await confirmRoute.POST(
      new NextRequest(`https://app.test/api/student/events/orders/${ORDER_ID}/confirm`, { method: "POST" }),
      { params: Promise.resolve({ orderId: ORDER_ID }) },
    );
    return { status: response.status, body: await response.json() };
  }

  it("webhook-confirmed order -> confirmed with registration ids; no Stripe call, no write", async () => {
    seedOrder({ payment_status: "paid", status: "confirmed", stripe_payment_intent_id: "pi_1" });
    studentUser = { id: "student-1", email: "buyer@example.test" };

    const result = await post();

    expect(result).toEqual({ status: 200, body: { confirmed: true, orderId: ORDER_ID, registrationIds: ["reg-1"] } });
    expect(stripeCalls).toEqual([]);
    expect(db.mutations).toHaveLength(0);
  });

  it("pending order is reported as not confirmed and never fulfilled here", async () => {
    seedOrder({ payment_status: "pending", status: "pending", stripe_payment_intent_id: "pi_1" });
    studentUser = { id: "student-1", email: "buyer@example.test" };

    const result = await post();

    expect(result.body).toEqual({ confirmed: false, orderId: ORDER_ID, registrationIds: [] });
    expect(stripeCalls).toEqual([]);
    expect(db.mutations).toHaveLength(0);
    expect(db.rows("event_orders")[0]).toMatchObject({ payment_status: "pending" });
  });

  it("keeps auth and buyer ownership checks", async () => {
    seedOrder({ payment_status: "paid", status: "confirmed" });

    studentUser = null;
    expect((await post()).status).toBe(401);

    studentUser = { id: "other", email: "someone@example.test" };
    expect((await post()).status).toBe(404);
  });

  it("the route no longer references Stripe or write operations (source guard)", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "app", "api", "student", "events", "orders", "[orderId]", "confirm", "route.ts"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toMatch(/getStripe|paymentIntents|\.insert\(|\.update\(|sendMobilePushToUser/);
  });
});
