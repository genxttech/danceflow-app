import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  DIRECT_PAYMENT_AMOUNT_ERROR_MESSAGES,
  MAX_DIRECT_PAYMENT_AMOUNT,
  directPaymentAmountMessage,
  formatDirectPaymentAmountInput,
  hiddenDirectPaymentSubmission,
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

describe("stored amount precision", () => {
  it("stores exactly the decimal staff entered for every cent value up to $1,000 (no float drift)", () => {
    const mismatches: string[] = [];
    for (let cents = 1; cents <= 100000; cents += 1) {
      const entered = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
      const parsed = parseDirectPaymentAmount(entered);
      // PostgREST sends JSON; Postgres numeric parses that text exactly, so the
      // JSON text must be the entered decimal (trailing zeros aside).
      const json = parsed.ok ? JSON.stringify(parsed.amount) : "";
      if (!parsed.ok || Number(json).toFixed(2) !== entered || json !== String(Number(entered))) {
        mismatches.push(entered);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("stays exact near the $100,000 limit", () => {
    for (const entered of ["99999.99", "99999.01", "12345.67", "100000.00", "50000.10"]) {
      const parsed = parseDirectPaymentAmount(entered);
      expect(parsed.ok && parsed.amount.toFixed(2)).toBe(entered);
    }
  });
});

describe("single-class editor state helpers", () => {
  it("shows a price error only while direct payment is on", () => {
    expect(directPaymentAmountMessage(false, "abc")).toBeNull();
    expect(directPaymentAmountMessage(true, "")).toBe(DIRECT_PAYMENT_AMOUNT_ERROR_MESSAGES.direct_payment_amount_required);
    expect(directPaymentAmountMessage(true, "0")).toBe(DIRECT_PAYMENT_AMOUNT_ERROR_MESSAGES.direct_payment_amount_invalid);
    expect(directPaymentAmountMessage(true, "25")).toBeNull();
  });

  it("E: hidden controls carry a valid edited state through (like Package/Membership)", () => {
    expect(
      hiddenDirectPaymentSubmission({ enabled: true, amount: "30", storedFundingTypes: ["package"], storedAmount: null }),
    ).toEqual({ enabled: true, amount: "30" });
    expect(
      hiddenDirectPaymentSubmission({ enabled: false, amount: "30", storedFundingTypes: ["direct_payment"], storedAmount: 25 }),
    ).toEqual({ enabled: false, amount: "" });
  });

  it("E: an invalid in-progress price while hidden falls back to the stored setting (never an invisible blocker)", () => {
    expect(
      hiddenDirectPaymentSubmission({ enabled: true, amount: "abc", storedFundingTypes: ["direct_payment"], storedAmount: 25 }),
    ).toEqual({ enabled: true, amount: "25.00" });
    expect(
      hiddenDirectPaymentSubmission({ enabled: true, amount: "", storedFundingTypes: ["package"], storedAmount: null }),
    ).toEqual({ enabled: false, amount: "" });
    expect(
      hiddenDirectPaymentSubmission({ enabled: true, amount: "0", storedFundingTypes: null, storedAmount: null }),
    ).toEqual({ enabled: false, amount: "" });
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

  it("A: in the default 'This class' scope the Direct payment controls are editable (not locked)", () => {
    const html = renderEditor({
      seriesSettingsEnabled: true,
      enrollmentPolicy: {
        publicly_discoverable: true,
        self_enrollment_allowed: false,
        accepted_funding_types: ["direct_payment"],
        direct_payment_amount: 25,
      },
    });
    expect(checkbox(html, "directPaymentEnabled")).not.toMatch(/ disabled=""/);
    expect(html.match(/<input[^>]*name="directPaymentAmount"[^>]*>/)?.[0]).not.toMatch(/ disabled=""/);
    expect(html).not.toContain("Direct payment is managed per class");
    expect(html).toMatch(/<button type="submit"[^>]*>Save enrollment settings/);
    expect(html.match(/<button type="submit"[^>]*>(?=Save enrollment settings)/)?.[0]).not.toMatch(/ disabled=""/);
  });

  it("G: an active, visible, invalid price shows its error and disables Save", () => {
    const html = renderEditor({
      enrollmentPolicy: {
        publicly_discoverable: true,
        self_enrollment_allowed: false,
        accepted_funding_types: ["package", "direct_payment"],
        direct_payment_amount: null,
      },
    });
    expect(html).toContain(DIRECT_PAYMENT_AMOUNT_ERROR_MESSAGES.direct_payment_amount_required);
    expect(html).toMatch(/aria-invalid="true"/);
    expect(html.match(/<button type="submit"[^>]*>(?=Save enrollment settings)/)?.[0]).toMatch(/ disabled=""/);
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

  it("B/C: in series scope the Direct payment checkbox and price are locked, with a per-class explanation", () => {
    const src = readFileSync("src/app/app/schedule/[id]/edit/AppointmentEditForm.tsx", "utf8");
    expect(src).toContain('const directPaymentLocked = seriesSettingsEnabled && policyScope === "series";');
    const checkboxTag = src.slice(src.indexOf('name="directPaymentEnabled"'), src.indexOf("/>", src.indexOf('name="directPaymentEnabled"')));
    expect(checkboxTag).toContain("disabled={directPaymentLocked}");
    const priceTag = src.slice(src.indexOf('name="directPaymentAmount"'), src.indexOf("/>", src.indexOf('name="directPaymentAmount"')));
    expect(priceTag).toContain("disabled={directPaymentLocked}");
    expect(src).toContain("{directPaymentLocked ? (");
    expect(src.replace(/\s+/g, " ")).toContain(
      "Direct payment is managed per class and is not changed for following classes. Switch to &quot;This class&quot; to change this class&apos;s payment setting.",
    );
    // The price error is not shown against a locked control.
    expect(src).toContain("{directPaymentAmountError && !directPaymentLocked ? (");
  });

  it("B: series scope never posts the single-class save, so only the selected class can never be silently changed", () => {
    const src = readFileSync("src/app/app/schedule/[id]/edit/AppointmentEditForm.tsx", "utf8");
    expect(src).toContain('if (seriesSettingsEnabled && policyScope === "series") event.preventDefault();');
  });

  it("E: a hidden in-progress invalid price does not disable Save (only a visible one does)", () => {
    const src = readFileSync("src/app/app/schedule/[id]/edit/AppointmentEditForm.tsx", "utf8");
    expect(src).toContain(
      "singleDisabled={policyRequiresFundingType || (fundingControlsVisible && Boolean(directPaymentAmountError))}",
    );
    expect(src).toContain('value={hiddenDirectPayment.enabled ? "on" : ""}');
    expect(src).toContain("value={hiddenDirectPayment.amount}");
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
