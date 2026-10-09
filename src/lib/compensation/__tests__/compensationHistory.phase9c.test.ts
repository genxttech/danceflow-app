import { describe, expect, it } from "vitest";
import {
  describeCompensationActor,
  describeCompensationChange,
  describeCompensationChangeDetails,
  describeCompensationChangeType,
  describeCurrentCompensation,
  describeGroupClassPay,
  describePrivateLessonPay,
  formatCompensationTimestamp,
  type CompensationHistoryRow,
  type CompensationRuleValues,
} from "../compensation-history";
import {
  mapCompensationRuleSaveError,
  validateCompensationRuleInput,
  type RawCompensationRuleInput,
} from "../rule-validation";

/**
 * Phase 9C: plain-language history wording (pure, no raw JSON), the
 * server-side rule validation that mirrors the database, and the mapping of
 * database errors to friendly statuses.
 */

const NONE: CompensationRuleValues = {
  private_lesson_pay_mode: "none",
  private_lesson_flat_amount: 0,
  private_lesson_percentage: 0,
  private_lesson_duration_rates_enabled: false,
  private_lesson_30_min_flat_amount: 0,
  private_lesson_45_min_flat_amount: 0,
  private_lesson_60_min_flat_amount: 0,
  group_class_pay_mode: "none",
  group_class_flat_amount: 0,
  group_class_percentage: 0,
  group_class_per_attendee_amount: 0,
  active: true,
  notes: null,
};

function values(overrides: Partial<CompensationRuleValues>): CompensationRuleValues {
  return { ...NONE, ...overrides };
}

function row(
  change_type: string,
  previous: Partial<CompensationRuleValues> | null,
  next: Partial<CompensationRuleValues>,
): CompensationHistoryRow {
  return {
    id: "h1",
    change_type,
    changed_at: "2026-10-09T15:30:00Z",
    changed_by_name: "Olive Owner",
    changed_by_email: "olive@example.test",
    changed_by_role: "studio_owner",
    changed_fields: [],
    previous_values: previous === null ? null : values(previous),
    new_values: values(next),
  };
}

describe("rule wording", () => {
  it("describes private lesson modes", () => {
    expect(describePrivateLessonPay(values({}))).toBe("not configured");
    expect(describePrivateLessonPay(values({ private_lesson_pay_mode: "percentage", private_lesson_percentage: 45 }))).toBe("45%");
    expect(describePrivateLessonPay(values({ private_lesson_pay_mode: "flat", private_lesson_flat_amount: 40 }))).toBe("$40 flat");
    expect(describePrivateLessonPay(values({ private_lesson_pay_mode: "flat", private_lesson_flat_amount: 42.5 }))).toBe("$42.50 flat");
    expect(describePrivateLessonPay(values({ private_lesson_pay_mode: "percentage", private_lesson_percentage: "12.50" }))).toBe("12.5%");
  });

  it("describes duration rates", () => {
    expect(
      describePrivateLessonPay(
        values({
          private_lesson_pay_mode: "flat",
          private_lesson_flat_amount: 30,
          private_lesson_duration_rates_enabled: true,
          private_lesson_30_min_flat_amount: 25,
          private_lesson_45_min_flat_amount: 35,
          private_lesson_60_min_flat_amount: 50,
        }),
      ),
    ).toBe("flat by duration (30 min $25, 45 min $35, 60 min $50, other lengths $30)");
    expect(
      describePrivateLessonPay(values({ private_lesson_pay_mode: "flat", private_lesson_duration_rates_enabled: true })),
    ).toBe("flat by duration");
  });

  it("describes group class modes", () => {
    expect(describeGroupClassPay(values({ group_class_pay_mode: "per_attendee", group_class_per_attendee_amount: 4 }))).toBe("$4 per attendee");
    expect(describeGroupClassPay(values({ group_class_pay_mode: "flat", group_class_flat_amount: 25 }))).toBe("$25 flat");
    expect(describeGroupClassPay(values({ group_class_pay_mode: "percentage", group_class_percentage: 20 }))).toBe("20%");
    expect(describeGroupClassPay(null)).toBe("not configured");
  });

  it("summarizes the current rule for the panel", () => {
    expect(describeCurrentCompensation(null)).toEqual({ privateLesson: "Not configured", groupClass: "Not configured", configured: false });
    expect(describeCurrentCompensation(values({ private_lesson_pay_mode: "percentage", private_lesson_percentage: 40 }))).toEqual({
      privateLesson: "40%",
      groupClass: "Not configured",
      configured: true,
    });
  });
});

describe("change wording", () => {
  it("percentage change", () => {
    const r = row(
      "updated",
      { private_lesson_pay_mode: "percentage", private_lesson_percentage: 40 },
      { private_lesson_pay_mode: "percentage", private_lesson_percentage: 45 },
    );
    expect(describeCompensationChange(r)).toEqual(["Private lesson pay changed from 40% to 45%"]);
  });

  it("group mode change", () => {
    const r = row(
      "updated",
      { group_class_pay_mode: "flat", group_class_flat_amount: 25 },
      { group_class_pay_mode: "per_attendee", group_class_per_attendee_amount: 4 },
    );
    expect(describeCompensationChange(r)).toEqual(["Group class pay changed from $25 flat to $4 per attendee"]);
  });

  it("disabled and enabled", () => {
    expect(
      describeCompensationChange(
        row("cleared", { private_lesson_pay_mode: "flat", private_lesson_flat_amount: 40 }, {}),
      ),
    ).toEqual(["Private lesson pay disabled"]);
    expect(
      describeCompensationChange(
        row("updated", { group_class_pay_mode: "percentage", group_class_percentage: 10 }, { private_lesson_pay_mode: "flat", private_lesson_flat_amount: 30 }),
      ),
    ).toEqual(["Private lesson pay set to $30 flat", "Group class pay disabled"]);
  });

  it("duration rates on", () => {
    const r = row(
      "updated",
      { private_lesson_pay_mode: "flat", private_lesson_flat_amount: 50 },
      {
        private_lesson_pay_mode: "flat",
        private_lesson_flat_amount: 50,
        private_lesson_duration_rates_enabled: true,
        private_lesson_30_min_flat_amount: 25,
        private_lesson_45_min_flat_amount: 35,
        private_lesson_60_min_flat_amount: 50,
      },
    );
    expect(describeCompensationChange(r)).toEqual([
      "Private lesson pay changed from $50 flat to flat by duration (30 min $25, 45 min $35, 60 min $50, other lengths $50)",
    ]);
  });

  it("reports a duration-rate toggle and an activation change even when nothing else changed", () => {
    const toggled = row(
      "updated",
      { private_lesson_pay_mode: "flat", private_lesson_flat_amount: 50, private_lesson_duration_rates_enabled: false },
      { private_lesson_pay_mode: "flat", private_lesson_flat_amount: 50, private_lesson_duration_rates_enabled: true },
    );
    expect(describeCompensationChange(toggled)).toEqual([
      "Private lesson pay changed from $50 flat to flat by duration (other lengths $50)",
    ]);
    const deactivated = row(
      "updated",
      { private_lesson_pay_mode: "flat", private_lesson_flat_amount: 50, active: true },
      { private_lesson_pay_mode: "flat", private_lesson_flat_amount: 50, active: false },
    );
    expect(describeCompensationChange(deactivated)).toEqual(["Rule deactivated"]);
  });

  it("created rule lists both pay types and a note", () => {
    const r = row("created", null, { private_lesson_pay_mode: "flat", private_lesson_flat_amount: 40, notes: "Spring" });
    expect(describeCompensationChange(r)).toEqual([
      "Private lesson pay set to $40 flat",
      "Group class pay not configured",
      "Internal note added",
    ]);
  });

  it("notes only", () => {
    expect(describeCompensationChange(row("updated", { notes: null }, { notes: "x" }))).toEqual(["Internal note added"]);
    expect(describeCompensationChange(row("updated", { notes: "x" }, { notes: null }))).toEqual(["Internal note removed"]);
    expect(describeCompensationChange(row("updated", { notes: "x" }, { notes: "y" }))).toEqual(["Internal note updated"]);
  });

  it("treats numerically equal strings and numbers as unchanged", () => {
    const r = row(
      "updated",
      { private_lesson_pay_mode: "percentage", private_lesson_percentage: "45.00", notes: "n" },
      { private_lesson_pay_mode: "percentage", private_lesson_percentage: 45, notes: "m" },
    );
    expect(describeCompensationChange(r)).toEqual(["Internal note updated"]);
  });

  it("never produces raw JSON or snake_case keys", () => {
    const rows = [
      row("created", null, { private_lesson_pay_mode: "flat", private_lesson_flat_amount: 40 }),
      row("updated", { private_lesson_pay_mode: "flat", private_lesson_flat_amount: 40 }, { private_lesson_pay_mode: "percentage", private_lesson_percentage: 40 }),
      row("cleared", { group_class_pay_mode: "per_attendee", group_class_per_attendee_amount: 4 }, {}),
    ];
    for (const r of rows) {
      const text = [...describeCompensationChange(r), ...describeCompensationChangeDetails(r).flatMap((d) => [d.label, d.before, d.after])].join(" | ");
      expect(text).not.toMatch(/[{}"]/);
      expect(text).not.toMatch(/_[a-z]/);
    }
  });

  it("tolerates missing value keys", () => {
    const r = { ...row("updated", {}, {}), previous_values: {}, new_values: { private_lesson_pay_mode: "percentage", private_lesson_percentage: 10 } };
    expect(describeCompensationChange(r)).toEqual(["Private lesson pay set to 10%"]);
    expect(describeCompensationChange({ ...row("updated", {}, {}), previous_values: {}, new_values: {} })).toEqual(["Compensation rule updated"]);
  });
});

describe("change details, actor and time", () => {
  it("lists only the fields that changed", () => {
    const r = row(
      "updated",
      { private_lesson_pay_mode: "flat", private_lesson_flat_amount: 40 },
      { private_lesson_pay_mode: "percentage", private_lesson_percentage: 45 },
    );
    expect(describeCompensationChangeDetails(r)).toEqual([
      { label: "Private lesson pay type", before: "Flat rate", after: "Percentage" },
      { label: "Private lesson flat amount", before: "$40", after: "$0" },
      { label: "Private lesson percentage", before: "0%", after: "45%" },
    ]);
  });

  it("lists populated settings of a created rule", () => {
    const r = row("created", null, { private_lesson_pay_mode: "flat", private_lesson_flat_amount: 40 });
    const labels = describeCompensationChangeDetails(r).map((d) => d.label);
    expect(labels).toContain("Private lesson pay type");
    expect(labels).toContain("Private lesson flat amount");
    expect(labels).toContain("Group class pay type");
    expect(labels).not.toContain("Private lesson percentage");
  });

  it("names the change type and actor", () => {
    expect(describeCompensationChangeType("created")).toBe("Rule created");
    expect(describeCompensationChangeType("updated")).toBe("Rule updated");
    expect(describeCompensationChangeType("cleared")).toBe("Pay disabled");
    expect(describeCompensationActor({ changed_by_name: "Olive Owner", changed_by_email: "o@x.test", changed_by_role: "studio_owner" })).toBe("Olive Owner (Owner)");
    expect(describeCompensationActor({ changed_by_name: null, changed_by_email: "a@x.test", changed_by_role: "studio_admin" })).toBe("a@x.test (Admin)");
    expect(describeCompensationActor({ changed_by_name: " ", changed_by_email: null, changed_by_role: null })).toBe("Unknown user");
  });

  it("formats times in the studio time zone and falls back safely", () => {
    expect(formatCompensationTimestamp("2026-10-09T15:30:00Z", "America/New_York")).toContain("11:30");
    expect(formatCompensationTimestamp("2026-10-09T15:30:00Z", "Not/AZone")).toContain("3:30");
    expect(formatCompensationTimestamp("garbage")).toBe("Unknown time");
  });
});

function raw(overrides: Partial<RawCompensationRuleInput> = {}): RawCompensationRuleInput {
  return {
    privateLessonPayMode: "none",
    privateLessonFlatAmount: "0",
    privateLessonPercentage: "0",
    privateLessonDurationRatesEnabled: false,
    privateLesson30MinFlatAmount: "0",
    privateLesson45MinFlatAmount: "0",
    privateLesson60MinFlatAmount: "0",
    groupClassPayMode: "none",
    groupClassFlatAmount: "0",
    groupClassPercentage: "0",
    groupClassPerAttendeeAmount: "0",
    notes: "",
    ...overrides,
  };
}

describe("rule validation (mirrors the database)", () => {
  it("accepts boundaries", () => {
    expect(validateCompensationRuleInput(raw({ privateLessonPayMode: "percentage", privateLessonPercentage: "0" })).ok).toBe(true);
    expect(validateCompensationRuleInput(raw({ privateLessonPayMode: "percentage", privateLessonPercentage: "100" })).ok).toBe(true);
    expect(validateCompensationRuleInput(raw({ groupClassPayMode: "per_attendee", groupClassPerAttendeeAmount: "0" })).ok).toBe(true);
    expect(validateCompensationRuleInput(raw()).ok).toBe(true);
  });

  it("rejects out-of-range percentages and negative amounts", () => {
    expect(validateCompensationRuleInput(raw({ privateLessonPayMode: "percentage", privateLessonPercentage: "100.01" }))).toEqual({ ok: false, status: "rule_invalid_percentage" });
    expect(validateCompensationRuleInput(raw({ groupClassPayMode: "percentage", groupClassPercentage: "101" }))).toEqual({ ok: false, status: "rule_invalid_percentage" });
    expect(validateCompensationRuleInput(raw({ privateLessonPayMode: "percentage", privateLessonPercentage: "-1" }))).toEqual({ ok: false, status: "rule_negative_amount" });
    expect(validateCompensationRuleInput(raw({ privateLessonPayMode: "flat", privateLessonFlatAmount: "-0.01" }))).toEqual({ ok: false, status: "rule_negative_amount" });
    expect(validateCompensationRuleInput(raw({ groupClassPayMode: "per_attendee", groupClassPerAttendeeAmount: "-2" }))).toEqual({ ok: false, status: "rule_negative_amount" });
    expect(validateCompensationRuleInput(raw({ privateLessonPayMode: "flat", privateLessonFlatAmount: "5", privateLessonDurationRatesEnabled: true, privateLesson45MinFlatAmount: "-3" }))).toEqual({ ok: false, status: "rule_negative_amount" });
    // Range checks apply to irrelevant fields too (the DB does the same).
    expect(validateCompensationRuleInput(raw({ privateLessonPayMode: "flat", privateLessonFlatAmount: "5", privateLessonPercentage: "150" }))).toEqual({ ok: false, status: "rule_invalid_percentage" });
  });

  it("rejects unsupported modes, malformed numbers and missing required amounts", () => {
    expect(validateCompensationRuleInput(raw({ privateLessonPayMode: "per_attendee" }))).toEqual({ ok: false, status: "rule_invalid_mode" });
    expect(validateCompensationRuleInput(raw({ groupClassPayMode: "hourly" }))).toEqual({ ok: false, status: "rule_invalid_mode" });
    expect(validateCompensationRuleInput(raw({ privateLessonPayMode: "" }))).toEqual({ ok: false, status: "rule_invalid_mode" });
    for (const bad of ["abc", "1e3", "NaN", "Infinity", "0x10", "1,000", "--1"]) {
      expect(validateCompensationRuleInput(raw({ privateLessonPayMode: "flat", privateLessonFlatAmount: bad }))).toEqual({ ok: false, status: "rule_invalid_amount" });
    }
    expect(validateCompensationRuleInput(raw({ privateLessonPayMode: "flat", privateLessonFlatAmount: "" }))).toEqual({ ok: false, status: "rule_missing_amount" });
    expect(validateCompensationRuleInput(raw({ groupClassPayMode: "per_attendee", groupClassPerAttendeeAmount: "" }))).toEqual({ ok: false, status: "rule_missing_amount" });
    expect(validateCompensationRuleInput(raw({ notes: "x".repeat(1001) }))).toEqual({ ok: false, status: "rule_notes_too_long" });
  });

  it("normalizes fields that do not apply to the selected mode", () => {
    const flat = validateCompensationRuleInput(
      raw({ privateLessonPayMode: "flat", privateLessonFlatAmount: "40", privateLessonPercentage: "50", privateLesson30MinFlatAmount: "9", groupClassPayMode: "percentage", groupClassFlatAmount: "8", groupClassPercentage: "20", groupClassPerAttendeeAmount: "7", notes: "  hi  " }),
    );
    expect(flat).toEqual({
      ok: true,
      args: {
        p_private_lesson_pay_mode: "flat",
        p_private_lesson_flat_amount: 40,
        p_private_lesson_percentage: 0,
        p_private_lesson_duration_rates_enabled: false,
        p_private_lesson_30_min_flat_amount: 0,
        p_private_lesson_45_min_flat_amount: 0,
        p_private_lesson_60_min_flat_amount: 0,
        p_group_class_pay_mode: "percentage",
        p_group_class_flat_amount: 0,
        p_group_class_percentage: 20,
        p_group_class_per_attendee_amount: 0,
        p_notes: "hi",
      },
    });
    const dur = validateCompensationRuleInput(
      raw({ privateLessonPayMode: "flat", privateLessonFlatAmount: "50", privateLessonDurationRatesEnabled: true, privateLesson30MinFlatAmount: "25", privateLesson45MinFlatAmount: "35", privateLesson60MinFlatAmount: "50" }),
    );
    expect(dur.ok && dur.args.p_private_lesson_duration_rates_enabled).toBe(true);
    expect(dur.ok && dur.args.p_private_lesson_45_min_flat_amount).toBe(35);
    const pct = validateCompensationRuleInput(raw({ privateLessonPayMode: "percentage", privateLessonPercentage: "45", privateLessonFlatAmount: "40", privateLessonDurationRatesEnabled: true, privateLesson30MinFlatAmount: "25" }));
    expect(pct.ok && pct.args.p_private_lesson_flat_amount).toBe(0);
    expect(pct.ok && pct.args.p_private_lesson_percentage).toBe(45);
    expect(pct.ok && pct.args.p_private_lesson_duration_rates_enabled).toBe(false);
    expect(pct.ok && pct.args.p_private_lesson_30_min_flat_amount).toBe(0);
  });
});

describe("save error mapping", () => {
  it("maps database errors to friendly statuses", () => {
    const map = (message: string) => mapCompensationRuleSaveError({ message });
    expect(map("Payroll access denied.")).toBe("payroll_access_denied");
    expect(map("Instructor not found for this studio.")).toBe("rule_instructor_not_found");
    expect(map("Unsupported private lesson pay mode.")).toBe("rule_invalid_mode");
    expect(map("Unsupported group class pay mode.")).toBe("rule_invalid_mode");
    expect(map("Compensation rule percentages must be between 0 and 100.")).toBe("rule_invalid_percentage");
    expect(map("Compensation rule amounts cannot be negative.")).toBe("rule_negative_amount");
    expect(map("Compensation rule amounts must be valid numbers.")).toBe("rule_invalid_amount");
    expect(map("Compensation rule is missing a required amount.")).toBe("rule_missing_amount");
    expect(map("Compensation rule notes are too long.")).toBe("rule_notes_too_long");
    expect(map("something unexpected")).toBe("rule_save_failed");
    expect(mapCompensationRuleSaveError(null)).toBe("rule_save_failed");
  });
});
