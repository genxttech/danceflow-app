import { describe, expect, it } from "vitest";

import { getLowBalancePackagesForAriaGoals } from "../page";

type PackageItemInput = {
  usage_type?: string | null;
  quantity_remaining: number | string | null;
  is_unlimited: boolean | null;
};

type PackageInput = {
  id: string;
  client_id: string | null;
  active: boolean | null;
  archived_at: string | null;
  expiration_date: string | null;
  client_package_items: PackageItemInput[] | null;
};

function pkg(overrides: Partial<PackageInput> = {}): PackageInput {
  return {
    id: "pkg-1",
    client_id: "client-1",
    active: true,
    archived_at: null,
    expiration_date: null,
    client_package_items: [
      { usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false },
    ],
    ...overrides,
  };
}

describe("getLowBalancePackagesForAriaGoals (Slice 1b-b fix)", () => {
  it("a canonically low package with no replacement is included", () => {
    const target = pkg();
    expect(getLowBalancePackagesForAriaGoals([target])).toEqual([target]);
  });

  it("a package with a healthy same-usage-type sibling is suppressed", () => {
    const target = pkg();
    const replacement = pkg({
      id: "pkg-2",
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
      ],
    });
    expect(getLowBalancePackagesForAriaGoals([target, replacement])).toEqual([]);
  });

  it("a sibling covering a different usage type does not suppress (per-usage-type completeness)", () => {
    const target = pkg();
    const unrelated = pkg({
      id: "pkg-2",
      client_package_items: [
        { usage_type: "group_class", quantity_remaining: 5, is_unlimited: false },
      ],
    });
    expect(getLowBalancePackagesForAriaGoals([target, unrelated])).toEqual([target]);
  });

  it("an unlimited-item package is never included", () => {
    const target = pkg({
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: null, is_unlimited: true },
      ],
    });
    expect(getLowBalancePackagesForAriaGoals([target])).toEqual([]);
  });

  it("a depleted (remaining=0) package with no coverage is included", () => {
    const target = pkg({
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false },
      ],
    });
    expect(getLowBalancePackagesForAriaGoals([target])).toEqual([target]);
  });

  it("packages belonging to different clients never suppress each other", () => {
    const target = pkg({ client_id: "client-1" });
    const otherClientReplacement = pkg({
      id: "pkg-2",
      client_id: "client-2",
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
      ],
    });
    expect(getLowBalancePackagesForAriaGoals([target, otherClientReplacement])).toEqual([target]);
  });

  it("a healthy package (remaining > 1, no warning) is not included", () => {
    const healthy = pkg({
      client_package_items: [
        { usage_type: "private_lesson", quantity_remaining: 3, is_unlimited: false },
      ],
    });
    expect(getLowBalancePackagesForAriaGoals([healthy])).toEqual([]);
  });
});
