import { describe, expect, it } from "vitest";

import { hasUsableImportedPackageBalance } from "@/lib/packages/importBalance";

describe("hasUsableImportedPackageBalance", () => {
  it("14. an exhausted finite item (quantityRemaining=0) has no usable balance", () => {
    expect(
      hasUsableImportedPackageBalance([{ isUnlimited: false, quantityRemaining: 0 }]),
    ).toBe(false);
  });

  it("a finite item with positive quantityRemaining has usable balance", () => {
    expect(
      hasUsableImportedPackageBalance([{ isUnlimited: false, quantityRemaining: 4 }]),
    ).toBe(true);
  });

  it("an unlimited item has usable balance regardless of quantityRemaining", () => {
    expect(
      hasUsableImportedPackageBalance([{ isUnlimited: true, quantityRemaining: null }]),
    ).toBe(true);
  });

  it("a mix of one exhausted finite item and one unlimited item has usable balance (OR across items)", () => {
    expect(
      hasUsableImportedPackageBalance([
        { isUnlimited: false, quantityRemaining: 0 },
        { isUnlimited: true, quantityRemaining: null },
      ]),
    ).toBe(true);
  });

  it("multiple exhausted finite items with no unlimited item has no usable balance", () => {
    expect(
      hasUsableImportedPackageBalance([
        { isUnlimited: false, quantityRemaining: 0 },
        { isUnlimited: false, quantityRemaining: 0 },
      ]),
    ).toBe(false);
  });

  it("no items at all has no usable balance", () => {
    expect(hasUsableImportedPackageBalance([])).toBe(false);
  });

  it("a null quantityRemaining on a finite item is treated as no balance", () => {
    expect(
      hasUsableImportedPackageBalance([{ isUnlimited: false, quantityRemaining: null }]),
    ).toBe(false);
  });
});
