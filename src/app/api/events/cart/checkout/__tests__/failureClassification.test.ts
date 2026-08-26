import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

import {
  FakeTable,
  createFakeAdminClient,
  type Row,
} from "@/lib/supabase/__tests__/simpleFakeAdminClient";

/**
 * Public Event Document-Checkpoint Remediation -- regression coverage for
 * src/app/api/events/cart/checkout/route.ts's deterministic
 * failure-classification fix. Drives the real POST handler end to end
 * against a fake admin client, distinguishing the two phases the route's
 * single catch block covers (required-document checkpoint creation vs.
 * Stripe Checkout session creation) purely by which one is made to fail --
 * never by asserting on exception text -- proving the route itself
 * classifies by execution phase, not by guessing from the error.
 */

const STUDIO_ID = "studio-1";
const EVENT_ID = "event-1";
const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const REQUIREMENT_ID = "req-1";

let tables: Record<string, FakeTable>;
let stripeSessionsCreate: Mock<(...args: unknown[]) => unknown>;
let beginEventSigningCheckpointMock: Mock<(...args: unknown[]) => unknown>;
let ipCounter = 0;

function table(rows: Row[] = []) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

function baseEventRow(overrides: Row = {}) {
  return {
    id: EVENT_ID,
    slug: "test-event",
    name: "Test Event",
    studio_id: STUDIO_ID,
    organizer_id: null,
    status: "published",
    visibility: "public",
    public_directory_enabled: true,
    registration_required: true,
    registration_opens_at: null,
    registration_closes_at: null,
    studios: {
      id: STUDIO_ID,
      name: "Test Studio",
      subscription_status: "active",
      stripe_connected_account_id: "acct_123",
      stripe_connect_charges_enabled: true,
      stripe_connect_payouts_enabled: true,
      stripe_connect_onboarding_complete: true,
    },
    ...overrides,
  };
}

function buildTables(requiredDocumentCount: 0 | 1) {
  return {
    events: table([baseEventRow()]),
    event_document_requirements: table(
      requiredDocumentCount === 1
        ? [
            {
              id: REQUIREMENT_ID,
              event_id: EVENT_ID,
              template_id: "template-1",
              template_version_id: null,
              studio_id: STUDIO_ID,
              organizer_id: null,
              active: true,
              is_required: true,
              document_templates: { id: "template-1", title: "Waiver", body: "Body", current_version: 1 },
            },
          ]
        : [],
    ),
    event_ticket_types: table([
      {
        id: TICKET_ID,
        event_id: EVENT_ID,
        name: "General Admission",
        description: null,
        ticket_kind: null,
        price: 25,
        currency: "USD",
        capacity: null,
        active: true,
        sale_starts_at: null,
        sale_ends_at: null,
        attendees_per_ticket: 1,
      },
    ]),
    event_registrations: table(),
    event_registration_items: table(),
    event_registration_attendees: table(),
    event_order_items: table(),
    event_orders: table(),
    event_private_lesson_slots: table(),
  };
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => createFakeAdminClient(tables),
}));

vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: (...args: unknown[]) => stripeSessionsCreate(...args) } },
  }),
}));

vi.mock("@/lib/documents/event-signing", () => ({
  beginEventSigningCheckpoint: (...args: unknown[]) => beginEventSigningCheckpointMock(...args),
}));

const { POST } = await import("@/app/api/events/cart/checkout/route");

function buildRequest(fields: Record<string, string>) {
  ipCounter += 1;
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);

  return new NextRequest("https://app.example.com/api/events/cart/checkout", {
    method: "POST",
    body: formData,
    headers: { "x-forwarded-for": `10.0.0.${ipCounter}` },
  });
}

function baseFormFields(overrides: Record<string, string> = {}) {
  return {
    eventSlug: "test-event",
    attendeeFirstName: "Taylor",
    attendeeLastName: "Attendee",
    attendeeEmail: "attendee@example.com",
    ticketTypeIds: TICKET_ID,
    ticketQuantities: "1",
    ...overrides,
  };
}

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake-service-role-key";

beforeEach(() => {
  stripeSessionsCreate = vi.fn();
  beginEventSigningCheckpointMock = vi.fn();
});

describe("cart checkout -- document setup phase failure", () => {
  it("records failure_reason='document_setup_failed', preserves existing metadata, and never reaches Stripe", async () => {
    tables = buildTables(1);
    beginEventSigningCheckpointMock.mockRejectedValue(
      new Error("Required event document assignment could not be created."),
    );

    const response = await POST(buildRequest(baseFormFields()));

    expect(response.headers.get("location")).toContain("error=cart_checkout_failed");
    expect(stripeSessionsCreate).not.toHaveBeenCalled();

    expect(tables.event_orders.rows).toHaveLength(1);
    const order = tables.event_orders.rows[0];
    expect(order.status).toBe("cancelled");
    expect(order.payment_status).toBe("failed");
    const metadata = order.metadata as Record<string, unknown>;
    expect(metadata.failure_reason).toBe("document_setup_failed");
    // Existing metadata keys set at order creation are preserved, not clobbered.
    expect(metadata.source).toBe("event_cart_v1");
    expect(typeof metadata.holdToken).toBe("string");

    expect(tables.event_registrations.rows).toHaveLength(1);
    expect(tables.event_registrations.rows[0].status).toBe("cancelled");
    expect(tables.event_registrations.rows[0].payment_status).toBe("failed");
  });
});

describe("cart checkout -- Stripe checkout-session phase failure", () => {
  it("records failure_reason='checkout_session_failed' when Stripe session creation throws", async () => {
    tables = buildTables(0); // no required documents -- reaches the Stripe phase directly
    stripeSessionsCreate.mockRejectedValue(new Error("Stripe API error: card declined"));

    const response = await POST(buildRequest(baseFormFields()));

    expect(response.headers.get("location")).toContain("error=cart_checkout_failed");
    expect(beginEventSigningCheckpointMock).not.toHaveBeenCalled();

    expect(tables.event_orders.rows).toHaveLength(1);
    const metadata = tables.event_orders.rows[0].metadata as Record<string, unknown>;
    expect(metadata.failure_reason).toBe("checkout_session_failed");
    expect(metadata.source).toBe("event_cart_v1");
  });

  it("also classifies as checkout_session_failed when Stripe succeeds but returns no session.url", async () => {
    tables = buildTables(0);
    stripeSessionsCreate.mockResolvedValue({ id: "cs_test_123", url: null });

    const response = await POST(buildRequest(baseFormFields()));

    expect(response.headers.get("location")).toContain("error=cart_checkout_failed");
    const metadata = tables.event_orders.rows[0].metadata as Record<string, unknown>;
    expect(metadata.failure_reason).toBe("checkout_session_failed");
  });
});

describe("cart checkout -- no-waiver path remains unchanged on success", () => {
  it("redirects straight to the Stripe session URL without ever calling beginEventSigningCheckpoint", async () => {
    tables = buildTables(0);
    stripeSessionsCreate.mockResolvedValue({ id: "cs_test_123", url: "https://checkout.stripe.com/session/cs_test_123" });

    const response = await POST(buildRequest(baseFormFields()));

    expect(beginEventSigningCheckpointMock).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("https://checkout.stripe.com/session/cs_test_123");
    expect(tables.event_orders.rows[0].status).toBe("pending");
    expect(tables.event_orders.rows[0].metadata).not.toHaveProperty("failure_reason");
  });
});

describe("cart checkout -- required-document path remains unchanged on success", () => {
  it("redirects to the signing URL and never calls Stripe", async () => {
    tables = buildTables(1);
    beginEventSigningCheckpointMock.mockResolvedValue({
      checkpointId: "checkpoint-1",
      signingUrl: "https://app.example.com/sign/fake-token",
    });

    const response = await POST(buildRequest(baseFormFields()));

    expect(stripeSessionsCreate).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("https://app.example.com/sign/fake-token");
    expect(tables.event_orders.rows[0].status).toBe("pending");
  });
});
