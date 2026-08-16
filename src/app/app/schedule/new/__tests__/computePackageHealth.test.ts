import { describe, expect, it } from "vitest";

import {
  computePackageHealth,
  type ClientPackageOption,
} from "@/app/app/schedule/new/AppointmentCreateForm";
import type { PackageWithItems } from "@/lib/packages/entitlement";

function pkg(overrides: Partial<ClientPackageOption> = {}): ClientPackageOption {
  return {
    id: "pkg-1",
    name_snapshot: "5-Lesson Package",
    active: true,
    expiration_date: null,
    client_package_items: [
      { usage_type: "private_lesson", quantity_remaining: 1, quantity_total: 5, is_unlimited: false },
    ],
    ...overrides,
  };
}

function replacement(overrides: Partial<PackageWithItems> = {}): PackageWithItems {
  return {
    id: "replacement-1",
    active: true,
    archived_at: null,
    expiration_date: null,
    client_package_items: [
      { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
    ],
    ...overrides,
  };
}

describe("AppointmentCreateForm computePackageHealth (Slice 1b-b: canonical threshold + suppression)", () => {
  it("no package selected -> inactive", () => {
    expect(computePackageHealth("private_lesson", null)).toBe("inactive");
  });

  it("inactive package -> inactive", () => {
    expect(computePackageHealth("private_lesson", pkg({ active: false }))).toBe("inactive");
  });

  it("expired package -> expired", () => {
    expect(computePackageHealth("private_lesson", pkg({ expiration_date: "2020-01-01" }))).toBe("expired");
  });

  it("exactly 1 remaining for the relevant usage type -> low (canonical threshold, not the old <=2)", () => {
    expect(computePackageHealth("private_lesson", pkg())).toBe("low");
  });

  it("2 remaining for the relevant usage type is healthy under the canonical threshold (old code called this low)", () => {
    const target = pkg({
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 2, quantity_total: 5, is_unlimited: false },
      ],
    });
    expect(computePackageHealth("private_lesson", target)).toBe("healthy");
  });

  it("0 remaining for the relevant usage type -> depleted", () => {
    const target = pkg({
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 0, quantity_total: 5, is_unlimited: false },
      ],
    });
    expect(computePackageHealth("private_lesson", target)).toBe("depleted");
  });

  it("unlimited relevant item -> healthy regardless of other items", () => {
    const target = pkg({
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: null, quantity_total: null, is_unlimited: true },
      ],
    });
    expect(computePackageHealth("private_lesson", target)).toBe("healthy");
  });

  it("low, no replacement -> stays low", () => {
    expect(computePackageHealth("private_lesson", pkg(), [])).toBe("low");
  });

  it("low with a healthy same-usage replacement -> suppressed to healthy", () => {
    expect(computePackageHealth("private_lesson", pkg(), [replacement()])).toBe("healthy");
  });

  it("depleted with a healthy same-usage replacement -> suppressed to healthy", () => {
    const target = pkg({
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 0, quantity_total: 5, is_unlimited: false },
      ],
    });
    expect(computePackageHealth("private_lesson", target, [replacement()])).toBe("healthy");
  });

  it("a healthy replacement for an unrelated usage type (group_class) does not suppress a private_lesson warning", () => {
    const unrelated = replacement({
      client_package_items: [{ usage_type: "group_class", quantity_remaining: 5, is_unlimited: false }],
    });
    expect(computePackageHealth("private_lesson", pkg(), [unrelated])).toBe("low");
  });

  it("an archived replacement (active=false) does not suppress", () => {
    const archived = replacement({ active: false, archived_at: "2026-09-01T00:00:00.000Z" });
    expect(computePackageHealth("private_lesson", pkg(), [archived])).toBe("low");
  });
});
