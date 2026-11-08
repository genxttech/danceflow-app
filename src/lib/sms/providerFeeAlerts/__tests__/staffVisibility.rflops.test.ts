import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RFL_ADMIN_TEMPLATE_PREFIX, STAFF_VISIBLE_DELIVERY_OR_FILTER, isStaffVisibleDeliveryTemplate } from "../staffVisibility";

describe("studio staff visibility of RFL admin mail", () => {
  it("hides admin-addressed keys, keeps owner-addressed, other and null keys", () => {
    expect(isStaffVisibleDeliveryTemplate("platform_rfl_admin_exposure_open")).toBe(false);
    expect(isStaffVisibleDeliveryTemplate("platform_rfl_admin_alert")).toBe(false);
    expect(isStaffVisibleDeliveryTemplate("platform_rfl_exposure_open")).toBe(true);
    expect(isStaffVisibleDeliveryTemplate("appointment_confirmed")).toBe(true);
    expect(isStaffVisibleDeliveryTemplate(null)).toBe(true);
  });

  it("the query filter keeps NULL keys and excludes the admin prefix", () => {
    expect(STAFF_VISIBLE_DELIVERY_OR_FILTER).toBe(`template_key.is.null,template_key.not.like.${RFL_ADMIN_TEMPLATE_PREFIX}*`);
  });

  it("the Communications page applies both the query filter and the in-memory filter to its outbound_deliveries list", () => {
    const src = readFileSync(join(process.cwd(), "src/app/app/communications/page.tsx"), "utf8");
    expect(src).toContain(".or(STAFF_VISIBLE_DELIVERY_OR_FILTER)");
    expect(src).toContain("isStaffVisibleDeliveryTemplate(row.template_key)");
    // the only outbound_deliveries query on the page is the filtered one
    expect(src.split(".from(\"outbound_deliveries\")").length - 1).toBe(1);
  });
});
