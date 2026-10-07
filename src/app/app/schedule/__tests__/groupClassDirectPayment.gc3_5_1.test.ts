import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  DIRECT_PAYMENT_AMOUNT_ERROR_MESSAGES,
  MAX_DIRECT_PAYMENT_AMOUNT,
  formatDirectPaymentAmountInput,
  parseDirectPaymentAmount,
} from "@/lib/schedule/directPaymentAmount";

/**
 * GC-3.5-1: staff direct-payment policy configuration -- the shared USD price
 * parser and the staff single-class / series editors. The server action
 * itself is covered in groupClassActions.gc3_3.test.ts and the series layer
 * in groupClassSeries.gcsb2 / groupClassSeriesFormModel.gcsb3.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  redirect: vi.fn(),
}));

vi.mock("@/app/app/schedule/actions", () => ({
  updateAppointmentAction: vi.fn(),
  updateGroupClassEnrollmentPolicyAction: vi.fn(),
}));

vi.mock("@/app/app/schedule/groupClassSeriesSettingsActions", () => ({
  applySeriesSettingsAction: vi.fn(),
  previewSeriesSettingsAction: vi.fn(),
}));

vi.mock("@/app/app/schedule/groupClassSeriesActions", () => ({
  previewGroupClassSeriesAction: vi.fn(),
  createGroupClassSeriesAction: vi.fn(),
}));

const { default: AppointmentEditForm } = await import("@/app/app/schedule/[id]/edit/AppointmentEditForm");
const { default: GroupClassSeriesForm } = await import("@/app/app/schedule/new/GroupClassSeriesForm");

const APPOINTMENT = {
  id: "appt-class-1",
  title: "Beginner Salsa",
  appointment_type: "group_class",
  client_id: null,
  instructor_id: null,
  room_id: null,
  starts_at: "2027-01-12T23:30:00.000Z",
  ends_at: "2027-01-13T00:30:00.000Z",
  status: "scheduled",
  notes: null,
  client_package_id: null,
  roster_capacity: 12,
};

type Policy = {
  publicly_discoverable: boolean;
  self_enrollment_allowed: boolean;
  accepted_funding_types: string[] | null;
  direct_payment_amount?: number | string | null;
};

function renderEditor(extra: { enrollmentPolicy?: Policy | null; instructorSearchMode?: boolean; seriesSettingsEnabled?: boolean } = {}) {
  return renderToStaticMarkup(
    createElement(AppointmentEditForm, {
      appointment: APPOINTMENT,
      clients: [],
      instructors: [],
      rooms: [],
      clientPackages: [],
      clientMemberships: [],
      ...extra,
    }),
  );
}

function checkbox(html: string, name: string) {
  return html.match(new RegExp(`<input[^>]*type="checkbox"[^>]*name="${name}"[^>]*>`))?.[0] ?? null;
}

describe("parseDirectPaymentAmount (shared USD price rules)", () => {
  it.each([
    ["25", 25],
    ["25.5", 25.5],
    ["25.50", 25.5],
    ["$25.50", 25.5],
    ["$ 9.99", 9.99],
    [" 0.01 ", 0.01],
    [String(MAX_DIRECT_PAYMENT_AMOUNT), MAX_DIRECT_PAYMENT_AMOUNT],
  ])("normalizes %j to %s dollars", (input, amount) => {
    expect(parseDirectPaymentAmount(input)).toEqual({ ok: true, amount });
  });

  it.each([undefined, null, "", "   ", "$"])("requires a price (%j)", (input) => {
    expect(parseDirectPaymentAmount(input)).toEqual({ ok: false, code: "direct_payment_amount_required" });
  });

  it.each(["0", "0.00", "-1", "-0.01", "abc", "1,000", "1e3", "Infinity", "NaN", "10.999", ".5", "5.", "100000.01", "12 34"])(
    "rejects %j",
    (input) => {
      expect(parseDirectPaymentAmount(input)).toEqual({ ok: false, code: "direct_payment_amount_invalid" });
    },
  );

  it("formats a stored amount for the input and never shows $0", () => {
    expect(formatDirectPaymentAmountInput(25)).toBe("25.00");
    expect(formatDirectPaymentAmountInput("18.5")).toBe("18.50");
    expect(formatDirectPaymentAmountInput(null)).toBe("");
    expect(formatDirectPaymentAmountInput(0)).toBe("");
  });
});

describe("single-class editor", () => {
  it("shows the Direct payment option to authorized staff (staff editor, not instructor mode)", () => {
    const html = renderEditor({
      enrollmentPolicy: { publicly_discoverable: true, self_enrollment_allowed: false, accepted_funding_types: ["package"] },
    });
    expect(checkbox(html, "directPaymentEnabled")).not.toBeNull();
    expect(html).toContain("Direct payment");
  });

  it("does not render the enrollment policy (or direct payment) in instructor mode", () => {
    const html = renderEditor({
      instructorSearchMode: true,
      enrollmentPolicy: { publicly_discoverable: true, self_enrollment_allowed: false, accepted_funding_types: ["package"] },
    });
    expect(html).not.toContain("directPaymentEnabled");
    expect(html).not.toContain("directPaymentAmount");
  });

  it("with direct payment enabled, reveals the price field prefilled with the stored amount", () => {
    const html = renderEditor({
      enrollmentPolicy: {
        publicly_discoverable: true,
        self_enrollment_allowed: true,
        accepted_funding_types: ["package", "direct_payment"],
        direct_payment_amount: 25,
      },
    });
    expect(checkbox(html, "directPaymentEnabled")).toContain("checked");
    expect(html).toMatch(/<input[^>]*name="directPaymentAmount"[^>]*value="25.00"/);
    expect(html).toContain("Direct payment price");
    expect(html).not.toContain(DIRECT_PAYMENT_AMOUNT_ERROR_MESSAGES.direct_payment_amount_required);
  });

  it("with direct payment disabled, hides the price field", () => {
    const html = renderEditor({
      enrollmentPolicy: { publicly_discoverable: true, self_enrollment_allowed: false, accepted_funding_types: ["package"] },
    });
    expect(checkbox(html, "directPaymentEnabled")).not.toContain("checked");
    expect(html).not.toContain('name="directPaymentAmount"');
    expect(html).not.toContain("Direct payment price");
  });

  it("carries direct payment through hidden inputs while the toggles section is hidden (no silent erasure)", () => {
    const html = renderEditor({
      enrollmentPolicy: {
        publicly_discoverable: false,
        self_enrollment_allowed: false,
        accepted_funding_types: ["direct_payment"],
        direct_payment_amount: "40",
      },
    });
    expect(html).toMatch(/<input type="hidden" name="directPaymentEnabled" value="on"\/>/);
    expect(html).toMatch(/<input type="hidden" name="directPaymentAmount" value="40.00"\/>/);
  });

  it("in series scope, explains that applying to following classes keeps each class's own direct payment (shown regardless of the checkbox)", () => {
    const src = readFileSync("src/app/app/schedule/[id]/edit/AppointmentEditForm.tsx", "utf8");
    const note = src.indexOf("keeps each class&apos;s own direct payment setting");
    expect(note).toBeGreaterThan(-1);
    const gate = src.lastIndexOf('seriesSettingsEnabled && policyScope === "series" ?', note);
    const priceBlock = src.lastIndexOf("{directPaymentEnabled ? (", note);
    expect(gate).toBeGreaterThan(-1);
    // The note is gated on series scope only, not nested in the enabled-only price block.
    expect(priceBlock).toBeLessThan(gate);
  });

  it("the series settings request never carries direct payment (preserved per class by the existing RPC)", () => {
    const src = readFileSync("src/app/app/schedule/[id]/edit/AppointmentEditForm.tsx", "utf8");
    expect(src).toContain("settings={{ publiclyDiscoverable, selfEnrollmentAllowed, packageEnabled, membershipEnabled }}");
  });

  it("has no currency selector, Stripe readiness gate or checkout code", () => {
    const src = readFileSync("src/app/app/schedule/[id]/edit/AppointmentEditForm.tsx", "utf8");
    expect(src).not.toMatch(/stripe|checkout|charges_enabled|name="currency"|selectedCurrency/i);
  });
});

describe("series creation form", () => {
  const html = renderToStaticMarkup(
    createElement(GroupClassSeriesForm, {
      instructors: [],
      rooms: [],
      studioTimeZone: "America/New_York",
      onChooseMode: () => undefined,
    }),
  );

  it("is off by default: no direct payment option or price until enrollment options are turned on", () => {
    expect(html).not.toContain('id="series-fund-direct"');
    expect(html).not.toContain('id="series-direct-price"');
  });

  it("offers Direct payment next to Package and Membership, with the price only while it is checked", () => {
    const src = readFileSync("src/app/app/schedule/new/GroupClassSeriesForm.tsx", "utf8");
    const fieldset = src.slice(src.indexOf("Accepted enrollment methods"));
    expect(fieldset.indexOf('id="series-fund-package"')).toBeGreaterThan(-1);
    expect(fieldset.indexOf('id="series-fund-direct"')).toBeGreaterThan(fieldset.indexOf('id="series-fund-package"'));
    const priceGate = fieldset.indexOf("{values.directPaymentEnabled ? (");
    expect(priceGate).toBeGreaterThan(-1);
    expect(fieldset.indexOf('id="series-direct-price"')).toBeGreaterThan(priceGate);
  });
});
