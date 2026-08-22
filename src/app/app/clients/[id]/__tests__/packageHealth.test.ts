import { describe, expect, it } from "vitest";

import {
  getPackageHealth,
  type ClientPackageRow,
} from "@/app/app/clients/[id]/page";

function pkg(overrides: Partial<ClientPackageRow> = {}): ClientPackageRow {
  return {
    id: "pkg-1",
    name_snapshot: "5-Lesson Package",
    expiration_date: null,
    purchase_date: null,
    created_at: null,
    active: true,
    archived_at: null,
    archived_by: null,
    archive_reason: null,
    refund_status: null,
    client_package_items: [
      { id: "item-1", usage_type: "private_lesson", quantity_total: 5, quantity_used: 4, quantity_remaining: 1, is_unlimited: false },
    ],
    ...overrides,
  };
}

describe("getPackageHealth (Slice 1b-b: canonical status + replacement-coverage suppression)", () => {
  it("archived always wins, regardless of any replacement", () => {
    const target = pkg({ archived_at: "2026-09-01T00:00:00.000Z", active: false });
    const replacement = pkg({
      id: "pkg-2",
      client_package_items: [
        { id: "item-2", usage_type: "private_lesson", quantity_total: 5, quantity_used: 0, quantity_remaining: 5, is_unlimited: false },
      ],
    });
    expect(getPackageHealth(target, [replacement])).toBe("archived");
  });

  it("expired always wins, regardless of any replacement", () => {
    const target = pkg({ expiration_date: "2020-01-01" });
    const replacement = pkg({
      id: "pkg-2",
      client_package_items: [
        { id: "item-2", usage_type: "private_lesson", quantity_total: 5, quantity_used: 0, quantity_remaining: 5, is_unlimited: false },
      ],
    });
    expect(getPackageHealth(target, [replacement])).toBe("expired");
  });

  it("low with no replacement stays low", () => {
    expect(getPackageHealth(pkg(), [])).toBe("low");
  });

  it("low with a healthy same-usage replacement shows active (suppressed)", () => {
    const target = pkg();
    const replacement = pkg({
      id: "pkg-2",
      client_package_items: [
        { id: "item-2", usage_type: "private_lesson", quantity_total: 5, quantity_used: 0, quantity_remaining: 5, is_unlimited: false },
      ],
    });
    expect(getPackageHealth(target, [replacement])).toBe("active");
  });

  it("depleted with a healthy same-usage replacement shows active (suppressed)", () => {
    const target = pkg({
      client_package_items: [
        { id: "item-1", usage_type: "private_lesson", quantity_total: 5, quantity_used: 5, quantity_remaining: 0, is_unlimited: false },
      ],
    });
    const replacement = pkg({
      id: "pkg-2",
      client_package_items: [
        { id: "item-2", usage_type: "private_lesson", quantity_total: 5, quantity_used: 0, quantity_remaining: 5, is_unlimited: false },
      ],
    });
    expect(getPackageHealth(target, [replacement])).toBe("active");
  });

  it("a healthy replacement for an unrelated usage type does not suppress", () => {
    const target = pkg();
    const replacement = pkg({
      id: "pkg-2",
      client_package_items: [
        { id: "item-2", usage_type: "group_class", quantity_total: 5, quantity_used: 0, quantity_remaining: 5, is_unlimited: false },
      ],
    });
    expect(getPackageHealth(target, [replacement])).toBe("low");
  });

  it("a mixed multi-item package (private=1 low, group=0 depleted) with only private covered still shows depleted, the worst unsuppressed severity", () => {
    const target = pkg({
      client_package_items: [
        { id: "item-1", usage_type: "private_lesson", quantity_total: 5, quantity_used: 4, quantity_remaining: 1, is_unlimited: false },
        { id: "item-2", usage_type: "group_class", quantity_total: 5, quantity_used: 5, quantity_remaining: 0, is_unlimited: false },
      ],
    });
    const replacement = pkg({
      id: "pkg-2",
      client_package_items: [
        { id: "item-3", usage_type: "private_lesson", quantity_total: 5, quantity_used: 0, quantity_remaining: 5, is_unlimited: false },
      ],
    });
    // The raw aggregate getClientPackageStatus would actually read "active" here
    // (hasUsableBalance is true via private=1, and the lowest finite across
    // items is 0, not exactly 1) -- getPackageHealth must not trust that and
    // instead surface the real, still-uncovered group_class depletion.
    expect(getPackageHealth(target, [replacement])).toBe("depleted");
  });

  it("a healthy package with no warning-causing usage type shows active", () => {
    const target = pkg({
      client_package_items: [
        { id: "item-1", usage_type: "private_lesson", quantity_total: 5, quantity_used: 1, quantity_remaining: 4, is_unlimited: false },
      ],
    });
    expect(getPackageHealth(target, [])).toBe("active");
  });
});
