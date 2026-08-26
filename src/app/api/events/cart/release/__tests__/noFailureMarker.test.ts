import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import {
  FakeTable,
  createFakeAdminClient,
  type Row,
} from "@/lib/supabase/__tests__/simpleFakeAdminClient";

/**
 * Public Event Document-Checkpoint Remediation: a genuine Stripe user
 * cancellation, handled entirely by this route (the Stripe `cancel_url`
 * target), must never receive either technical failure_reason marker
 * ("document_setup_failed" / "checkout_session_failed") that
 * cart/checkout/route.ts's catch block now writes. This route's own
 * event_orders update never references metadata at all -- confirmed both
 * structurally (asserted below) and behaviorally (the order's metadata is
 * unchanged end to end).
 */

const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const HOLD_TOKEN = "a".repeat(32);

let tables: Record<string, FakeTable>;

function table(rows: Row[] = []) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => createFakeAdminClient(tables),
}));

const { GET } = await import("@/app/api/events/cart/release/route");

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake-service-role-key";

beforeEach(() => {
  tables = {
    event_orders: table([
      {
        id: ORDER_ID,
        payment_status: "pending",
        metadata: { source: "event_cart_v1", holdToken: HOLD_TOKEN },
      },
    ]),
    event_competition_registration_carts: table(),
    event_private_lesson_slots: table(),
    event_registrations: table([
      { id: "reg-1", order_id: ORDER_ID, status: "pending", payment_status: "pending" },
    ]),
  };
});

describe("cart release (genuine Stripe cancellation) -- never sets a technical failure_reason", () => {
  it("cancels the order/registration without touching metadata at all", async () => {
    const url =
      `https://app.example.com/api/events/cart/release` +
      `?orderId=${ORDER_ID}&eventSlug=test-event&holdToken=${HOLD_TOKEN}`;
    const response = await GET(new NextRequest(url));

    expect(response.headers.get("location")).toContain("error=checkout_cancelled");

    const order = tables.event_orders.rows[0];
    expect(order.status).toBe("cancelled");
    // metadata is byte-identical to what it was before this request --
    // this route's own update payload never includes a metadata key.
    expect(order.metadata).toEqual({ source: "event_cart_v1", holdToken: HOLD_TOKEN });
    expect(order.metadata).not.toHaveProperty("failure_reason");

    expect(tables.event_registrations.rows[0].status).toBe("cancelled");
  });
});
