// The Pay Now URL is built in the app from the web address and the payment id. Pin its shape: the id is encoded
// (a crafted id cannot add a query parameter or change the path) and it targets the client checkout route only.
jest.mock("@/lib/supabase", () => {
  const rows = [{ id: "pay 1&x=2/../", studio_id: "s1", amount: 40, currency: "usd", payment_type: "lesson", notes: null, created_at: "2026-11-01" }];
  const chain = (table: string): unknown => {
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_t, prop: string) => (prop === "then" ? (resolve: (v: unknown) => unknown) => resolve({ data: table === "payments" ? rows : [], error: null }) : () => proxy),
    });
    return proxy;
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } } };
});
jest.mock("@/lib/studentDigitalContent", () => ({ loadStudentDigitalLibrary: async () => [] }));

import { loadStudentWallet } from "@/lib/studentWallet";

describe("payment request checkout URL", () => {
  it("encodes the payment id and targets only the client checkout route", async () => {
    const wallet = await loadStudentWallet([{ studioId: "s1", clientId: "c1", studioName: "S", studioPublicName: null } as never], "a@example.test", { force: true });
    const url = new URL(wallet.paymentRequests[0].checkoutUrl);
    expect(url.pathname).toBe("/api/stripe/client-checkout");
    expect([...url.searchParams.keys()]).toEqual(["paymentId"]);
    expect(url.searchParams.get("paymentId")).toBe("pay 1&x=2/../");
  });
});
