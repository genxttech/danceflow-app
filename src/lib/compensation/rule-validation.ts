/**
 * Phase 9C: server-side validation and normalization of an instructor
 * compensation rule before it is saved through the canonical
 * `save_instructor_compensation_rule` RPC.
 *
 * This mirrors the database validation (which stays authoritative) so a bad
 * submission gets a clear status without a round trip. Fields that are
 * irrelevant for the selected mode are normalized to 0 / false, exactly like
 * the RPC does, so a saved rule never carries a contradictory configuration.
 */

export const PRIVATE_LESSON_PAY_MODES = ["none", "flat", "percentage"] as const;
export const GROUP_CLASS_PAY_MODES = [
  "none",
  "flat",
  "percentage",
  "per_attendee",
] as const;
export const RULE_NOTES_MAX_LENGTH = 1000;

export type PrivateLessonPayMode = (typeof PRIVATE_LESSON_PAY_MODES)[number];
export type GroupClassPayMode = (typeof GROUP_CLASS_PAY_MODES)[number];

/** Raw (string) values as submitted by the rule form. */
export type RawCompensationRuleInput = {
  privateLessonPayMode: string;
  privateLessonFlatAmount: string;
  privateLessonPercentage: string;
  privateLessonDurationRatesEnabled: boolean;
  privateLesson30MinFlatAmount: string;
  privateLesson45MinFlatAmount: string;
  privateLesson60MinFlatAmount: string;
  groupClassPayMode: string;
  groupClassFlatAmount: string;
  groupClassPercentage: string;
  groupClassPerAttendeeAmount: string;
  notes: string;
};

/** Arguments of the save RPC (without the studio and instructor ids). */
export type CompensationRuleRpcArgs = {
  p_private_lesson_pay_mode: PrivateLessonPayMode;
  p_private_lesson_flat_amount: number;
  p_private_lesson_percentage: number;
  p_private_lesson_duration_rates_enabled: boolean;
  p_private_lesson_30_min_flat_amount: number;
  p_private_lesson_45_min_flat_amount: number;
  p_private_lesson_60_min_flat_amount: number;
  p_group_class_pay_mode: GroupClassPayMode;
  p_group_class_flat_amount: number;
  p_group_class_percentage: number;
  p_group_class_per_attendee_amount: number;
  p_notes: string | null;
};

export type CompensationRuleStatus =
  | "rule_invalid_mode"
  | "rule_invalid_amount"
  | "rule_negative_amount"
  | "rule_invalid_percentage"
  | "rule_missing_amount"
  | "rule_notes_too_long";

export type CompensationRuleValidation =
  | { ok: true; args: CompensationRuleRpcArgs }
  | { ok: false; status: CompensationRuleStatus };

type ParsedAmount = { ok: true; value: number | null } | { ok: false };

function parseAmount(raw: string): ParsedAmount {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, value: null };
  // Plain decimal numbers only (no exponents, hex, thousands separators).
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return { ok: false };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false };
  return { ok: true, value };
}

export function validateCompensationRuleInput(
  raw: RawCompensationRuleInput,
): CompensationRuleValidation {
  const privateMode = raw.privateLessonPayMode;
  const groupMode = raw.groupClassPayMode;

  if (!(PRIVATE_LESSON_PAY_MODES as readonly string[]).includes(privateMode)) {
    return { ok: false, status: "rule_invalid_mode" };
  }
  if (!(GROUP_CLASS_PAY_MODES as readonly string[]).includes(groupMode)) {
    return { ok: false, status: "rule_invalid_mode" };
  }

  const notes = (raw.notes ?? "").trim();
  if (notes.length > RULE_NOTES_MAX_LENGTH) {
    return { ok: false, status: "rule_notes_too_long" };
  }

  const amounts = {
    privateFlat: parseAmount(raw.privateLessonFlatAmount),
    privatePct: parseAmount(raw.privateLessonPercentage),
    private30: parseAmount(raw.privateLesson30MinFlatAmount),
    private45: parseAmount(raw.privateLesson45MinFlatAmount),
    private60: parseAmount(raw.privateLesson60MinFlatAmount),
    groupFlat: parseAmount(raw.groupClassFlatAmount),
    groupPct: parseAmount(raw.groupClassPercentage),
    groupPer: parseAmount(raw.groupClassPerAttendeeAmount),
  };

  for (const parsed of Object.values(amounts)) {
    if (!parsed.ok) return { ok: false, status: "rule_invalid_amount" };
  }
  const value = (key: keyof typeof amounts) => {
    const parsed = amounts[key];
    return parsed.ok ? parsed.value : null;
  };

  // Every supplied value is range-checked before irrelevant ones are normalized.
  for (const key of Object.keys(amounts) as Array<keyof typeof amounts>) {
    const v = value(key);
    if (v !== null && v < 0) return { ok: false, status: "rule_negative_amount" };
  }
  for (const key of ["privatePct", "groupPct"] as const) {
    const v = value(key);
    if (v !== null && v > 100) return { ok: false, status: "rule_invalid_percentage" };
  }

  if (
    (privateMode === "flat" && value("privateFlat") === null) ||
    (privateMode === "percentage" && value("privatePct") === null) ||
    (groupMode === "flat" && value("groupFlat") === null) ||
    (groupMode === "percentage" && value("groupPct") === null) ||
    (groupMode === "per_attendee" && value("groupPer") === null)
  ) {
    return { ok: false, status: "rule_missing_amount" };
  }

  const durationOn =
    privateMode === "flat" && raw.privateLessonDurationRatesEnabled === true;

  return {
    ok: true,
    args: {
      p_private_lesson_pay_mode: privateMode as PrivateLessonPayMode,
      p_private_lesson_flat_amount:
        privateMode === "flat" ? (value("privateFlat") ?? 0) : 0,
      p_private_lesson_percentage:
        privateMode === "percentage" ? (value("privatePct") ?? 0) : 0,
      p_private_lesson_duration_rates_enabled: durationOn,
      p_private_lesson_30_min_flat_amount: durationOn ? (value("private30") ?? 0) : 0,
      p_private_lesson_45_min_flat_amount: durationOn ? (value("private45") ?? 0) : 0,
      p_private_lesson_60_min_flat_amount: durationOn ? (value("private60") ?? 0) : 0,
      p_group_class_pay_mode: groupMode as GroupClassPayMode,
      p_group_class_flat_amount: groupMode === "flat" ? (value("groupFlat") ?? 0) : 0,
      p_group_class_percentage:
        groupMode === "percentage" ? (value("groupPct") ?? 0) : 0,
      p_group_class_per_attendee_amount:
        groupMode === "per_attendee" ? (value("groupPer") ?? 0) : 0,
      p_notes: notes === "" ? null : notes,
    },
  };
}

/** Friendly status for an error returned by the save RPC. */
export function mapCompensationRuleSaveError(error: unknown): string {
  const message =
    typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message).toLowerCase()
      : "";

  if (message.includes("payroll access denied")) return "payroll_access_denied";
  if (message.includes("instructor not found")) return "rule_instructor_not_found";
  if (message.includes("unsupported") && message.includes("pay mode")) return "rule_invalid_mode";
  if (message.includes("percentages must be between")) return "rule_invalid_percentage";
  if (message.includes("cannot be negative")) return "rule_negative_amount";
  if (message.includes("must be valid numbers")) return "rule_invalid_amount";
  if (message.includes("missing a required amount")) return "rule_missing_amount";
  if (message.includes("notes are too long")) return "rule_notes_too_long";
  return "rule_save_failed";
}
