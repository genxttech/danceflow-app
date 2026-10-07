import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { FakeTable, createFakeEntitlementClient, type Row } from "@/lib/packages/__tests__/fakeEntitlementSupabase";

/**
 * GC-3.5-3: public paid Group Class registration on /register.
 *
 * The real page, server actions, data reads and purchase-state model run. Supabase is faked (user session: public read
 * model, auth, verified email, the purchaser's own holds; service role: links, studios, policies, attendees, payments,
 * dancer profiles). The Checkout service (proven separately in groupClassPurchase.gc353.test.ts) is spied in the action
 * tests so the inputs it receives can be asserted exactly.
 */

const h = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; user_metadata: Record<string, unknown> },
  verifiedEmail: null as string | null,
  classRow: {} as Record<string, unknown>,
  candidates: [] as Array<{ funding_type: string; source_id: string; label: string }>,
  startCheckout: vi.fn(),
  releasePurchase: vi.fn(),
  rateAllowed: true,
}));

let linksTable: FakeTable;
let studiosTable: FakeTable;
let attendeesTable: FakeTable;
let policiesTable: FakeTable;
let holdsTable: FakeTable;
let paymentsTable: FakeTable;
let profilesTable: FakeTable;
let clientsTable: FakeTable;
let clientReads = 0;

const ID = "11111111-1111-4111-8111-111111111111";
const STUDIO_A = "studio-a";
const USER = "user-1";
const OTHER_USER = "user-2";
const SELF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NEW_CLIENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REGISTER = `/studios/salsa-house/classes/${ID}/register`;

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Map([["host", "app.example.test"], ["x-forwarded-proto", "https"]]) }));
vi.mock("@/components/public/PublicShell", () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: h.rateAllowed }),
  getServerActionRateLimitKey: async () => "key",
}));
vi.mock("@/lib/notifications/groupClassNotices", () => ({
  notifyGroupClassEnrolled: vi.fn(),
  notifyStudioOfExternalGroupClassEnrollment: vi.fn(),
}));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => ({ fake: "stripe" }) }));
vi.mock("@/lib/payments/groupClassPurchase", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/payments/groupClassPurchase")>();
  return {
    ...original,
    startPublicClassCheckout: (...args: unknown[]) => h.startCheckout(...args),
    releaseOwnPublicClassPurchase: (...args: unknown[]) => h.releasePurchase(...args),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }), signOut: async () => ({ error: null }) },
    // RLS stand-in: the session client sees only the signed-in purchaser's own holds.
    from: (table: string) => {
      if (table !== "group_class_enrollment_holds") throw new Error(`Unexpected session table: ${table}`);
      const own = new FakeTable();
      own.rows = holdsTable.rows.filter((r) => r.purchaser_user_id === h.user?.id);
      return createFakeEntitlementClient({ t: own }).from("t");
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "public_group_class_occurrences") return { data: args.p_appointment_id === ID ? [h.classRow] : [], error: null };
      if (name === "my_verified_email") return { data: h.verifiedEmail, error: null };
      if (name === "email_binding_status") return { data: "unproven", error: null };
      if (name === "preview_self_enrollment_funding_candidates") return { data: h.candidates, error: null };
      throw new Error(`Unexpected session RPC: ${name}`);
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const client = createFakeEntitlementClient({
      get client_account_links() { return linksTable; },
      get studios() { return studiosTable; },
      get appointment_attendees() { return attendeesTable; },
      get group_class_enrollment_policies() { return policiesTable; },
      get payments() { return paymentsTable; },
      get dancer_profiles() { return profilesTable; },
      get clients() { return clientsTable; },
    });
    return {
      ...client,
      from: (table: string) => {
        if (table === "clients") clientReads += 1;
        return client.from(table);
      },
    };
  },
}));

const RegisterPage = (await import("../page")).default;
const { startClassPurchaseAction, releaseClassPurchaseAction } = await import("../actions");

const classRow = (over: Record<string, unknown> = {}) => ({
  appointment_id: ID, series_id: null, series_root_id: null, studio_slug: "salsa-house", studio_name: "Salsa House",
  studio_logo_url: null, studio_city: "Austin", studio_state: "TX", time_zone: "America/New_York", title: "Salsa Level 1",
  starts_at: "2030-11-02T22:00:00+00:00", ends_at: "2030-11-02T23:00:00+00:00", instructor_name: null, location_label: null,
  capacity: 10, spots_remaining: 4, availability: "available", enrollment_state: "open", public_state: "upcoming", ...over,
});

function hold(over: Partial<Row> = {}): Row {
  return {
    id: HOLD, appointment_id: ID, purchaser_user_id: USER, status: "held", amount_cents: 2500,
    expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(), created_at: new Date().toISOString(),
    stripe_checkout_session_id: "cs_test_1", stripe_account_id: "acct_studioA",
    client_id: null, attendee_id: null, payment_id: null, dancer_first_name: "Ada", dancer_last_name: "Lovelace", ...over,
  };
}

async function outcome(run: () => Promise<unknown>) {
  try {
    const value = await run();
    return { html: typeof value === "string" ? value : renderToStaticMarkup(value as never) };
  } catch (error) {
    return { thrown: (error as Error).message };
  }
}

const page = (search: Record<string, string> = {}) =>
  outcome(async () =>
    renderToStaticMarkup(
      await RegisterPage({
        params: Promise.resolve({ studioSlug: "salsa-house", appointmentId: ID }),
        searchParams: Promise.resolve(search),
      }),
    ),
  );

function visibleText(markup: string) {
  return markup.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  h.user = { id: USER, email: "ada@example.test", user_metadata: { full_name: "Ada Account" } };
  h.verifiedEmail = "ada@example.test";
  h.classRow = classRow();
  h.candidates = [];
  h.rateAllowed = true;
  h.startCheckout.mockReset();
  h.releasePurchase.mockReset();
  clientReads = 0;
  linksTable = new FakeTable();
  studiosTable = new FakeTable();
  attendeesTable = new FakeTable();
  policiesTable = new FakeTable();
  holdsTable = new FakeTable();
  paymentsTable = new FakeTable();
  profilesTable = new FakeTable();
  clientsTable = new FakeTable();
  studiosTable.rows.push({
    id: STUDIO_A, slug: "salsa-house", stripe_connected_account_id: "acct_studioA",
    stripe_connect_onboarding_complete: true, stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true,
  });
  policiesTable.rows.push({
    appointment_id: ID, studio_id: STUDIO_A, publicly_discoverable: true, self_enrollment_allowed: true,
    accepted_funding_types: ["package", "direct_payment"], direct_payment_amount: "25.00",
  });
  profilesTable.rows.push({ user_id: USER, first_name: "Ada", last_name: "Lovelace", phone: "555-010-2030" });
  // A pre-existing studio client with the purchaser's email: must never be revealed or matched.
  clientsTable.rows.push({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", studio_id: STUDIO_A, first_name: "Ada", last_name: "OldRecord", email: "ada@example.test" });
});

describe("identity gates (unchanged)", () => {
  it("signed out goes to sign-in with the canonical return", async () => {
    h.user = null;
    expect((await page()).thrown).toBe(`NEXT_REDIRECT:/login?intent=public&next=${encodeURIComponent(REGISTER)}`);
  });

  it("an unverified account must confirm its email first (no price, no payment)", async () => {
    h.verifiedEmail = null;
    const { html } = await page();
    expect(html).toContain("Confirm your email to continue");
    expect(html).not.toContain("Pay $");
  });
});

describe("unlinked verified purchaser (A)", () => {
  it("A: sees the authoritative price, a minimal self-only identity form and the verified receipt email", async () => {
    const { html } = await page();
    expect(html).toContain("Register for Salsa Level 1");
    expect(html).toContain("$25.00");
    expect(html).toContain("Pay $25.00");
    expect(html).toContain('name="firstName"');
    expect(html).toContain('value="Ada"');
    expect(html).toContain('name="lastName"');
    expect(html).toContain('name="phone"');
    expect(html).toContain("ada@example.test");
    // no amount, email, studio, user or hold fields posted by the browser; no guardian/dependent UI
    expect(html).not.toMatch(/name="(amount|email|studioId|userId|holdId|price|dancer)"/);
    expect(visibleText(html ?? "")).not.toMatch(/guardian|dependent|child|parent/i);
  });

  it("never reveals or reads a possible pre-existing studio client (no email auto-link)", async () => {
    const { html } = await page();
    expect(html).not.toContain("OldRecord");
    expect(clientReads).toBe(0);
  });

  it("a class without direct payment keeps the existing not-set-up state", async () => {
    policiesTable.rows[0].accepted_funding_types = ["package"];
    const { html } = await page();
    expect(html).toContain("not set up with Salsa House yet");
    expect(html).not.toContain("Pay $");
  });

  it("missing Connect readiness shows the safe unavailable state", async () => {
    studiosTable.rows[0].stripe_connect_charges_enabled = false;
    const { html } = await page();
    expect(html).toContain("Online payment is not available for this class right now. Please contact Salsa House.");
    expect(html).not.toContain("Pay $");
  });

  it("purchase errors render as safe copy; unknown kinds and raw text are ignored", async () => {
    expect((await page({ purchase_error: "full" })).html).toContain("This class is full.");
    const raw = await page({ purchase_error: "GC35_ACCOUNT_MISMATCH: secret" });
    expect(raw.html).not.toContain("GC35_");
    expect(raw.html).not.toContain("secret");
  });
});

describe("linked studio students keep GC-3.4C (regression)", () => {
  function selfLink(over: Partial<Row> = {}) {
    linksTable.rows.push({
      id: "link-self", studio_id: STUDIO_A, user_id: USER, client_id: SELF, status: "linked", relationship_type: "self",
      is_primary: true, can_manage_bookings: true, created_at: "2026-01-01T00:00:00Z",
      clients: { id: SELF, studio_id: STUDIO_A, first_name: "Pat", last_name: "Dancer" }, ...over,
    });
  }

  it("a linked student with no eligible credit gets the portal/contact boundary, never Public Discovery payment", async () => {
    selfLink();
    const { html } = await page();
    expect(html).toContain("No class credit available");
    expect(html).toContain("Open Student Portal");
    expect(html).not.toContain("Pay $");
  });

  it("a linked student with a package keeps the existing join flow", async () => {
    selfLink();
    h.candidates = [{ funding_type: "package", source_id: "99999999-9999-4999-8999-999999999999", label: "10-Lesson Package" }];
    const { html } = await page();
    expect(html).toContain("Join this class");
    expect(html).not.toContain("Pay $");
  });

  it("a view-only linked account (no booking rights) is not sold through Public Discovery", async () => {
    selfLink({ can_manage_bookings: false });
    const { html } = await page();
    expect(html).not.toContain("Pay $");
  });

  it("the start action refuses a linked account before any hold/checkout", async () => {
    selfLink();
    const res = await outcome(() => startClassPurchaseAction(form({ appointmentId: ID, firstName: "Ada", lastName: "L" })));
    expect(res.thrown).toBe(`NEXT_REDIRECT:${REGISTER}?purchase_error=already_linked`);
    expect(h.startCheckout).not.toHaveBeenCalled();
  });
});

describe("start action (price / studio / identity authority)", () => {
  it("forged amount, studio, email, user and hold fields are ignored; only server-derived values reach checkout", async () => {
    h.startCheckout.mockResolvedValue({ kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    const res = await outcome(() =>
      startClassPurchaseAction(
        form({
          appointmentId: ID, firstName: "Ada", lastName: "Lovelace", phone: "555",
          amount: "1", amount_cents: "1", price: "0.01", studioId: "studio-b", email: "evil@example.test",
          userId: OTHER_USER, holdId: HOLD, stripeAccount: "acct_evil", currency: "eur",
        }),
      ),
    );
    expect(res.thrown).toBe("NEXT_REDIRECT:https://checkout.stripe.com/c/pay/cs_test_1");
    expect(h.startCheckout).toHaveBeenCalledTimes(1);
    const args = h.startCheckout.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({
      userId: USER, studioId: STUDIO_A, appointmentId: ID, firstName: "Ada", lastName: "Lovelace", phone: "555",
      customerEmail: "ada@example.test", classTitle: "Salsa Level 1", classStartsAt: "2030-11-02T22:00:00+00:00",
    });
    expect(Object.keys(args)).not.toEqual(expect.arrayContaining(["amount", "amountCents", "currency", "stripeAccount", "holdId"]));
    // canonical return URLs to this exact class route (no open redirect)
    expect(String(args.successUrl)).toMatch(new RegExp(`^https?://[^/]+${REGISTER.replace(/[/]/g, "\\/")}\\?purchase=return$`));
    expect(String(args.cancelUrl)).toMatch(new RegExp(`^https?://[^/]+${REGISTER.replace(/[/]/g, "\\/")}\\?purchase=cancelled$`));
  });

  it("an unverified or signed-out account never reaches checkout", async () => {
    h.verifiedEmail = null;
    expect((await outcome(() => startClassPurchaseAction(form({ appointmentId: ID })))).thrown).toBe(`NEXT_REDIRECT:${REGISTER}`);
    h.user = null;
    expect((await outcome(() => startClassPurchaseAction(form({ appointmentId: ID })))).thrown).toContain("NEXT_REDIRECT:/login");
    expect(h.startCheckout).not.toHaveBeenCalled();
  });

  it("rate limiting stops repeated start attempts before any hold/checkout", async () => {
    h.rateAllowed = false;
    expect((await outcome(() => startClassPurchaseAction(form({ appointmentId: ID })))).thrown).toBe(`NEXT_REDIRECT:${REGISTER}?purchase_error=rate_limited`);
    expect(h.startCheckout).not.toHaveBeenCalled();
  });

  it("service errors become safe error kinds; finalizing goes to the return view", async () => {
    h.startCheckout.mockResolvedValueOnce({ kind: "error", code: "full" });
    expect((await outcome(() => startClassPurchaseAction(form({ appointmentId: ID })))).thrown).toBe(`NEXT_REDIRECT:${REGISTER}?purchase_error=full`);
    h.startCheckout.mockResolvedValueOnce({ kind: "finalizing" });
    expect((await outcome(() => startClassPurchaseAction(form({ appointmentId: ID })))).thrown).toBe(`NEXT_REDIRECT:${REGISTER}?purchase=return`);
  });

  it("never redirects to a non-https checkout URL", async () => {
    h.startCheckout.mockResolvedValue({ kind: "redirect", url: "javascript:alert(1)" });
    expect((await outcome(() => startClassPurchaseAction(form({ appointmentId: ID })))).thrown).toBe(`NEXT_REDIRECT:${REGISTER}?purchase_error=checkout_failed`);
  });
});

describe("release action", () => {
  it("releases only through the purchaser's own session with the signed-in user's id", async () => {
    h.releasePurchase.mockResolvedValue("released");
    expect((await outcome(() => releaseClassPurchaseAction(form({ appointmentId: ID, holdId: HOLD })))).thrown).toBe(`NEXT_REDIRECT:${REGISTER}`);
    expect(h.releasePurchase.mock.calls[0][0]).toMatchObject({ userId: USER, holdId: HOLD });
    h.releasePurchase.mockResolvedValue("finalizing");
    expect((await outcome(() => releaseClassPurchaseAction(form({ appointmentId: ID, holdId: HOLD })))).thrown).toBe(`NEXT_REDIRECT:${REGISTER}?purchase=return`);
    h.releasePurchase.mockResolvedValue("error");
    expect((await outcome(() => releaseClassPurchaseAction(form({ appointmentId: ID, holdId: HOLD })))).thrown).toBe(`NEXT_REDIRECT:${REGISTER}?purchase_error=release_failed`);
  });
});

describe("return / status views (L, Y, Z)", () => {
  it("L: a browser return with no purchase marks nothing paid -- the normal offer shows", async () => {
    const { html } = await page({ purchase: "return" });
    expect(html).toContain("Pay $25.00");
    expect(html).not.toContain(">You&#x27;re registered</h1>");
    expect(html).not.toContain("Paid online");
    expect(html).not.toContain("finalizing");
  });

  it("Y: returning before the webhook shows finalizing with bounded polling, never 'registered'", async () => {
    holdsTable.rows.push(hold());
    const { html } = await page({ purchase: "return" });
    // The return flag is browser-controlled: the wording claims nothing the database has not confirmed.
    expect(html).toContain("Confirming your payment");
    expect(html).not.toContain("Payment received");
    expect(html).toContain("Checking your registration");
    expect(html).not.toContain("You&#x27;re registered");
  });

  it("Z: after the webhook converts, shows registered + paid online + Open Student Portal (even when the class is now full)", async () => {
    h.classRow = classRow({ spots_remaining: 0, availability: "full", enrollment_state: "full" });
    holdsTable.rows.push(hold({ status: "converted", client_id: NEW_CLIENT, attendee_id: "att-1", payment_id: "pay-1", stripe_payment_intent_id: "pi_1" }));
    attendeesTable.rows.push({ id: "att-1", studio_id: STUDIO_A, appointment_id: ID, client_id: NEW_CLIENT, status: "booked" });
    const { html } = await page({ purchase: "return" });
    expect(html).toContain("You&#x27;re registered");
    expect(html).toContain("Ada Lovelace is registered for Salsa Level 1");
    expect(html).toContain("Paid online — $25.00");
    expect(html).toContain(`href="/portal/salsa-house?client=${NEW_CLIENT}"`);
    expect(html).not.toContain("Pay $");
  });

  it("an open checkout offers continue + cancel; a cancelled return offers try again + cancel", async () => {
    holdsTable.rows.push(hold());
    const open = await page();
    expect(open.html).toContain("Finish your payment");
    expect(open.html).toContain("Continue to payment");
    expect(open.html).toContain("Cancel registration");
    const cancelled = await page({ purchase: "cancelled" });
    expect(cancelled.html).toContain("Payment not completed — try again");
    expect(cancelled.html).toContain("Try again");
  });

  it("a refunded conflict says so; an unrefunded conflict never claims a refund or registration", async () => {
    holdsTable.rows.push(hold({ status: "conflict", payment_id: "pay-c", stripe_payment_intent_id: "pi_c", conflict_reason: "class_full" }));
    paymentsTable.rows.push({ id: "pay-c", studio_id: STUDIO_A, status: "refunded" });
    const refunded = await page({ purchase: "return" });
    expect(refunded.html).toContain("Your payment was refunded because registration could not be completed.");
    paymentsTable.rows[0].status = "paid";
    const pending = await page({ purchase: "return" });
    expect(pending.html).toContain("We couldn&#x27;t finish registration");
    expect(pending.html).not.toMatch(/refunded|registered/i);
    expect(pending.html).not.toContain("class_full");
  });

  it("another user's hold is never shown (own holds only)", async () => {
    holdsTable.rows.push(hold({ purchaser_user_id: OTHER_USER, status: "converted", client_id: NEW_CLIENT, attendee_id: "att-1" }));
    attendeesTable.rows.push({ id: "att-1", studio_id: STUDIO_A, appointment_id: ID, client_id: NEW_CLIENT, status: "booked" });
    const { html } = await page({ purchase: "return" });
    expect(html).toContain("Pay $25.00");
    expect(html).not.toContain("Paid online");
  });
});
