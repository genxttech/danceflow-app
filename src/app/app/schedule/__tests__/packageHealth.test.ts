import { describe, expect, it } from "vitest";

import { getPackageHealth, type ClientPackageItem } from "@/app/app/schedule/page";
import type { PackageWithItems } from "@/lib/packages/entitlement";

function item(overrides: Partial<ClientPackageItem> = {}): ClientPackageItem {
  return {
    usage_type: "private_lesson",
    quantity_remaining: 1,
    quantity_total: 5,
    is_unlimited: false,
    ...overrides,
  };
}

function replacement(overrides: Partial<PackageWithItems> = {}): PackageWithItems {
  return {
    id: "replacement-1",
    active: true,
    archived_at: null,
    expiration_date: null,
    client_package_items: [item({ quantity_remaining: 5 })],
    ...overrides,
  };
}

describe("schedule/page.tsx getPackageHealth (Slice 1b-b)", () => {
  it("returns unknown when there is no linked package", () => {
    expect(getPackageHealth(null)).toBe("unknown");
  });

  it("returns inactive when the linked package is explicitly inactive", () => {
    expect(getPackageHealth({ active: false, client_package_items: [item()] })).toBe("inactive");
  });

  it("low with no sibling packages stays low_balance (no otherPackages -> no suppression)", () => {
    expect(getPackageHealth({ active: true, client_package_items: [item({ quantity_remaining: 1 })] })).toBe(
      "low_balance",
    );
  });

  it("depleted with no sibling packages stays depleted", () => {
    expect(getPackageHealth({ active: true, client_package_items: [item({ quantity_remaining: 0 })] })).toBe(
      "depleted",
    );
  });

  it("low with a healthy same-usage sibling package is suppressed to healthy", () => {
    const pkg = { active: true, client_package_items: [item({ quantity_remaining: 1 })] };
    expect(getPackageHealth(pkg, [replacement()])).toBe("healthy");
  });

  it("a healthy sibling package for an unrelated usage type does not suppress", () => {
    const pkg = { active: true, client_package_items: [item({ quantity_remaining: 1 })] };
    const unrelated = replacement({ client_package_items: [item({ usage_type: "group_class", quantity_remaining: 5 })] });
    expect(getPackageHealth(pkg, [unrelated])).toBe("low_balance");
  });

  it("healthy package with plenty of balance is healthy regardless of siblings", () => {
    expect(getPackageHealth({ active: true, client_package_items: [item({ quantity_remaining: 5 })] })).toBe(
      "healthy",
    );
  });
});
