import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getLowPackageCreditClientIds } from "@/app/app/marketing/campaigns/actions";
import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

const STUDIO_ID = "studio-1";

function buildClient(packageRows: Row[]) {
  const client_packages = new FakeTable();
  client_packages.rows = packageRows;
  const fake = createFakeEntitlementClient({ client_packages });
  return fake as unknown as SupabaseClient;
}

function lowPackage(overrides: Row = {}): Row {
  return {
    id: "pkg-low",
    studio_id: STUDIO_ID,
    client_id: "client-1",
    active: true,
    archived_at: null,
    expiration_date: null,
    lessons_remaining: null, // deprecated column, deliberately unpopulated/null
    client_package_items: [
      { usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false },
    ],
    ...overrides,
  };
}

describe("getLowPackageCreditClientIds (Slice 1b-b Marketing canonical segmentation)", () => {
  it("low current-era package, no replacement -> client included", async () => {
    const supabase = buildClient([lowPackage()]);
    const ids = await getLowPackageCreditClientIds(supabase, STUDIO_ID);
    expect(ids.has("client-1")).toBe(true);
  });

  it("low package + valid same-usage replacement -> client excluded", async () => {
    const supabase = buildClient([
      lowPackage(),
      lowPackage({
        id: "pkg-replacement",
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
        ],
      }),
    ]);
    const ids = await getLowPackageCreditClientIds(supabase, STUDIO_ID);
    expect(ids.has("client-1")).toBe(false);
  });

  it("low package + unrelated-usage-type replacement -> client included (healthy coverage for a different usage type must not suppress)", async () => {
    const supabase = buildClient([
      lowPackage(),
      lowPackage({
        id: "pkg-replacement",
        client_package_items: [
          { usage_type: "group_class", quantity_remaining: 5, is_unlimited: false },
        ],
      }),
    ]);
    const ids = await getLowPackageCreditClientIds(supabase, STUDIO_ID);
    expect(ids.has("client-1")).toBe(true);
  });

  it("low package + archived replacement -> client included (archived never suppresses)", async () => {
    const supabase = buildClient([
      lowPackage(),
      lowPackage({
        id: "pkg-replacement",
        archived_at: "2026-09-01T00:00:00.000Z",
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
        ],
      }),
    ]);
    const ids = await getLowPackageCreditClientIds(supabase, STUDIO_ID);
    expect(ids.has("client-1")).toBe(true);
  });

  it("low package + expired replacement -> client included (expired never suppresses)", async () => {
    const supabase = buildClient([
      lowPackage(),
      lowPackage({
        id: "pkg-replacement",
        expiration_date: "2020-01-01",
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
        ],
      }),
    ]);
    const ids = await getLowPackageCreditClientIds(supabase, STUDIO_ID);
    expect(ids.has("client-1")).toBe(true);
  });

  it("low package + unlimited same-usage replacement -> client excluded", async () => {
    const supabase = buildClient([
      lowPackage(),
      lowPackage({
        id: "pkg-replacement",
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: null, is_unlimited: true },
        ],
      }),
    ]);
    const ids = await getLowPackageCreditClientIds(supabase, STUDIO_ID);
    expect(ids.has("client-1")).toBe(false);
  });

  it("two warning-causing usage types on one package, only one covered -> client included", async () => {
    const supabase = buildClient([
      lowPackage({
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false },
          { usage_type: "group_class", quantity_remaining: 0, is_unlimited: false },
        ],
      }),
      lowPackage({
        id: "pkg-replacement",
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
        ],
      }),
    ]);
    const ids = await getLowPackageCreditClientIds(supabase, STUDIO_ID);
    expect(ids.has("client-1")).toBe(true);
  });

  it("two warning-causing usage types, separate replacements collectively cover both -> client excluded (no package selected)", async () => {
    const supabase = buildClient([
      lowPackage({
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false },
          { usage_type: "group_class", quantity_remaining: 0, is_unlimited: false },
        ],
      }),
      lowPackage({
        id: "pkg-replacement-private",
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
        ],
      }),
      lowPackage({
        id: "pkg-replacement-group",
        client_package_items: [
          { usage_type: "group_class", quantity_remaining: 3, is_unlimited: false },
        ],
      }),
    ]);
    const ids = await getLowPackageCreditClientIds(supabase, STUDIO_ID);
    expect(ids.has("client-1")).toBe(false);
    // The result is a Set of client ids only -- proves nothing resembling a
    // package reference/selection is produced by this segmentation path.
    expect([...ids].every((id) => typeof id === "string")).toBe(true);
  });

  it("current package with deprecated lessons_remaining=NULL still segments correctly (proves the fix)", async () => {
    // lowPackage() already sets lessons_remaining: null -- the old query
    // (`.lte("lessons_remaining", 2)`) would have silently excluded this
    // row entirely since NULL fails every comparison. This test fails
    // if getLowPackageCreditClientIds ever reads that column again.
    const supabase = buildClient([lowPackage()]);
    const ids = await getLowPackageCreditClientIds(supabase, STUDIO_ID);
    expect(ids.has("client-1")).toBe(true);
  });

  it("a healthy package (no warning-causing usage type) does not segment its client", async () => {
    const supabase = buildClient([
      lowPackage({
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
        ],
      }),
    ]);
    const ids = await getLowPackageCreditClientIds(supabase, STUDIO_ID);
    expect(ids.has("client-1")).toBe(false);
  });

  it("an archived package never segments its client even though it has a warning-causing item", async () => {
    const supabase = buildClient([
      lowPackage({ archived_at: "2026-09-01T00:00:00.000Z", active: false }),
    ]);
    const ids = await getLowPackageCreditClientIds(supabase, STUDIO_ID);
    expect(ids.has("client-1")).toBe(false);
  });
});
