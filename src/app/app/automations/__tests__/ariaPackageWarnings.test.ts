import { describe, expect, it } from "vitest";

import {
  ariaLowItemsIncludeCanonicalWarning,
  ariaPackageHasReplacementCoverage,
  type AriaPackageWarningItem,
  type AriaPackageWarningRow,
} from "@/app/app/automations/ariaPackageWarnings";

function pkg(overrides: Partial<AriaPackageWarningRow> = {}): AriaPackageWarningRow {
  return {
    id: "pkg-1",
    client_id: "client-1",
    expiration_date: null,
    client_package_items: [
      { usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false },
    ],
    ...overrides,
  };
}

describe("ariaPackageHasReplacementCoverage (Slice 1b-b: rebuilt on the canonical helper)", () => {
  it("no other packages -> not covered", () => {
    const target = pkg();
    expect(
      ariaPackageHasReplacementCoverage({
        targetPackage: target,
        allPackages: [target],
        lowItems: target.client_package_items,
      }),
    ).toBe(false);
  });

  it("a healthy same-usage sibling package -> covered", () => {
    const target = pkg();
    const replacement = pkg({
      id: "pkg-2",
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
      ],
    });
    expect(
      ariaPackageHasReplacementCoverage({
        targetPackage: target,
        allPackages: [target, replacement],
        lowItems: target.client_package_items,
      }),
    ).toBe(true);
  });

  it("a replacement that's itself low (remaining=1, not depleted) still counts as coverage -- the fix from the original >threshold check", () => {
    const target = pkg();
    const lowButNotDepletedReplacement = pkg({
      id: "pkg-2",
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false },
      ],
    });
    expect(
      ariaPackageHasReplacementCoverage({
        targetPackage: target,
        allPackages: [target, lowButNotDepletedReplacement],
        lowItems: target.client_package_items,
      }),
    ).toBe(true);
  });

  it("a depleted replacement does not provide coverage", () => {
    const target = pkg();
    const depletedReplacement = pkg({
      id: "pkg-2",
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false },
      ],
    });
    expect(
      ariaPackageHasReplacementCoverage({
        targetPackage: target,
        allPackages: [target, depletedReplacement],
        lowItems: target.client_package_items,
      }),
    ).toBe(false);
  });

  it("a healthy replacement for an unrelated usage type does not provide coverage", () => {
    const target = pkg();
    const unrelated = pkg({
      id: "pkg-2",
      client_package_items: [
        { usage_type: "group_class", quantity_remaining: 5, is_unlimited: false },
      ],
    });
    expect(
      ariaPackageHasReplacementCoverage({
        targetPackage: target,
        allPackages: [target, unrelated],
        lowItems: target.client_package_items,
      }),
    ).toBe(false);
  });

  it("a belonging-to-a-different-client package is never treated as a replacement", () => {
    const target = pkg();
    const otherClient = pkg({
      id: "pkg-2",
      client_id: "client-2",
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
      ],
    });
    expect(
      ariaPackageHasReplacementCoverage({
        targetPackage: target,
        allPackages: [target, otherClient],
        lowItems: target.client_package_items,
      }),
    ).toBe(false);
  });

  it("an unlimited same-usage replacement provides coverage", () => {
    const target = pkg();
    const unlimitedReplacement = pkg({
      id: "pkg-2",
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: null, is_unlimited: true },
      ],
    });
    expect(
      ariaPackageHasReplacementCoverage({
        targetPackage: target,
        allPackages: [target, unlimitedReplacement],
        lowItems: target.client_package_items,
      }),
    ).toBe(true);
  });
});

describe("ariaLowItemsIncludeCanonicalWarning (Slice 1b-b: ARIA threshold vs. canonical status)", () => {
  it("a package at remaining=2, ARIA's proactive threshold of 2, is NOT canonically low or depleted", () => {
    const items: AriaPackageWarningItem[] = [
      { usage_type: "private_lesson", quantity_remaining: 2, is_unlimited: false },
    ];
    // remaining=2 satisfies a <=2 ARIA proactive trigger, but canonical Low
    // is exact remaining===1 -- this must return false so the generated
    // copy doesn't claim canonical "Low" status the package's own detail
    // page wouldn't show.
    expect(ariaLowItemsIncludeCanonicalWarning(items)).toBe(false);
  });

  it("a package at remaining=1 IS canonically low", () => {
    const items: AriaPackageWarningItem[] = [
      { usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false },
    ];
    expect(ariaLowItemsIncludeCanonicalWarning(items)).toBe(true);
  });

  it("a package at remaining=0 IS canonically depleted", () => {
    const items: AriaPackageWarningItem[] = [
      { usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false },
    ];
    expect(ariaLowItemsIncludeCanonicalWarning(items)).toBe(true);
  });

  it("an unlimited item is never canonically low or depleted regardless of quantity_remaining", () => {
    const items: AriaPackageWarningItem[] = [
      { usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: true },
    ];
    expect(ariaLowItemsIncludeCanonicalWarning(items)).toBe(false);
  });

  it("mixed items: at least one canonical match is enough to return true", () => {
    const items: AriaPackageWarningItem[] = [
      { usage_type: "private_lesson", quantity_remaining: 2, is_unlimited: false },
      { usage_type: "group_class", quantity_remaining: 0, is_unlimited: false },
    ];
    expect(ariaLowItemsIncludeCanonicalWarning(items)).toBe(true);
  });
});
