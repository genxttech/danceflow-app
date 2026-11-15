// A buyer owns marketplace content by account (user_id), not by studio link. When the web stops creating a
// client and portal link at checkout (audit G-01), such a buyer has NO linked studio: the wallet must still
// list the purchase with the right studio name.
jest.mock("@/lib/supabase", () => {
  const entitlement = {
    id: "ent-1",
    studio_id: "studio-9",
    catalog_item_id: "item-1",
    granted_at: "2026-11-01T00:00:00Z",
    expires_at: null,
    status: "active",
    commerce_catalog_items: { name: "Rumba Basics", item_type: "digital_video" },
  };
  const chain = (table: string): unknown => {
    const result = { data: table === "commerce_entitlements" ? [entitlement] : [], error: null };
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => unknown) => resolve(result) : () => proxy),
    });
    return proxy;
  };
  return { supabase: { from: (table: string) => chain(table), auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } } };
});
jest.mock("@/lib/studentDigitalContent", () => ({
  loadStudentDigitalLibrary: async () => [
    { entitlementId: "ent-1", catalogItemId: "item-1", studioId: "studio-9", studioName: "Halcyon Dance Studio", imageUrl: "https://img/x.jpg" },
  ],
}));

import { loadStudentWallet } from "@/lib/studentWallet";

describe("digital purchases without a linked studio", () => {
  it("lists the purchase and names the studio from the library, not the generic fallback", async () => {
    const wallet = await loadStudentWallet([], "buyer@example.test", { force: true });
    expect(wallet.digitalEntitlements).toHaveLength(1);
    expect(wallet.digitalEntitlements[0]).toMatchObject({ name: "Rumba Basics", studioName: "Halcyon Dance Studio", imageUrl: "https://img/x.jpg" });
    expect(wallet.packages).toEqual([]);
    expect(wallet.memberships).toEqual([]);
  });
});
