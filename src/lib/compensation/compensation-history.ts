/**
 * Phase 9C: plain-language descriptions of an instructor compensation rule
 * and of the changes recorded in `instructor_compensation_rule_history`.
 *
 * Pure functions only (no I/O) so the wording is unit tested. History rows
 * store the full previous / new rule values; nothing here shows raw JSON.
 */

export type CompensationRuleValues = {
  private_lesson_pay_mode: string;
  private_lesson_flat_amount: number | string | null;
  private_lesson_percentage: number | string | null;
  private_lesson_duration_rates_enabled: boolean | null;
  private_lesson_30_min_flat_amount: number | string | null;
  private_lesson_45_min_flat_amount: number | string | null;
  private_lesson_60_min_flat_amount: number | string | null;
  group_class_pay_mode: string;
  group_class_flat_amount: number | string | null;
  group_class_percentage: number | string | null;
  group_class_per_attendee_amount: number | string | null;
  active: boolean | null;
  notes: string | null;
};

export type CompensationHistoryRow = {
  id: string;
  change_type: string;
  changed_at: string;
  changed_by_name: string | null;
  changed_by_email: string | null;
  changed_by_role: string | null;
  changed_fields: string[] | null;
  previous_values: Partial<CompensationRuleValues> | null;
  new_values: Partial<CompensationRuleValues> | null;
};

export type CompensationDetailLine = {
  label: string;
  before: string;
  after: string;
};

const PRIVATE_KEYS = [
  "private_lesson_pay_mode",
  "private_lesson_flat_amount",
  "private_lesson_percentage",
  "private_lesson_duration_rates_enabled",
  "private_lesson_30_min_flat_amount",
  "private_lesson_45_min_flat_amount",
  "private_lesson_60_min_flat_amount",
] as const;

const GROUP_KEYS = [
  "group_class_pay_mode",
  "group_class_flat_amount",
  "group_class_percentage",
  "group_class_per_attendee_amount",
] as const;

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatMoney(value: unknown): string {
  const amount = num(value);
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

export function formatPercent(value: unknown): string {
  return `${num(value)}%`;
}

/** Short rule wording for private lessons, e.g. "45%" or "$40 flat". */
export function describePrivateLessonPay(
  values: Partial<CompensationRuleValues> | null | undefined,
): string {
  const mode = values?.private_lesson_pay_mode ?? "none";
  if (mode === "percentage") return formatPercent(values?.private_lesson_percentage);
  if (mode === "flat") {
    if (values?.private_lesson_duration_rates_enabled) {
      const buckets = [
        ["30 min", values.private_lesson_30_min_flat_amount],
        ["45 min", values.private_lesson_45_min_flat_amount],
        ["60 min", values.private_lesson_60_min_flat_amount],
      ]
        .filter(([, amount]) => num(amount) > 0)
        .map(([label, amount]) => `${label} ${formatMoney(amount)}`);
      const fallback = num(values.private_lesson_flat_amount);
      const parts = [...buckets];
      if (fallback > 0) parts.push(`other lengths ${formatMoney(fallback)}`);
      if (parts.length > 0) return `flat by duration (${parts.join(", ")})`;
      return "flat by duration";
    }
    return `${formatMoney(values?.private_lesson_flat_amount)} flat`;
  }
  return "not configured";
}

/** Short rule wording for group classes, e.g. "20%" or "$4 per attendee". */
export function describeGroupClassPay(
  values: Partial<CompensationRuleValues> | null | undefined,
): string {
  const mode = values?.group_class_pay_mode ?? "none";
  if (mode === "percentage") return formatPercent(values?.group_class_percentage);
  if (mode === "flat") return `${formatMoney(values?.group_class_flat_amount)} flat`;
  if (mode === "per_attendee") {
    return `${formatMoney(values?.group_class_per_attendee_amount)} per attendee`;
  }
  return "not configured";
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") return Boolean(a) === Boolean(b);
  if (typeof a === "string" && typeof b === "string" && Number.isNaN(Number(a))) return a === b;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x === y;
  return a === b;
}

function groupChanged(
  keys: readonly (keyof CompensationRuleValues)[],
  before: Partial<CompensationRuleValues> | null,
  after: Partial<CompensationRuleValues> | null,
) {
  return keys.some((key) => !sameValue(before?.[key] ?? emptyValue(key), after?.[key] ?? emptyValue(key)));
}

function emptyValue(key: keyof CompensationRuleValues): unknown {
  if (key === "private_lesson_pay_mode" || key === "group_class_pay_mode") return "none";
  if (key === "notes") return null;
  if (key === "active" || key === "private_lesson_duration_rates_enabled") return false;
  return 0;
}

function payLine(
  subject: string,
  before: string,
  after: string,
  hadBefore: boolean,
  hasAfter: boolean,
  created: boolean,
) {
  if (!hasAfter) return `${subject} disabled`;
  if (created || !hadBefore) return `${subject} set to ${after}`;
  return `${subject} changed from ${before} to ${after}`;
}

/**
 * One concise sentence per material change, newest-first friendly, e.g.
 * "Private lesson pay changed from 40% to 45%".
 */
export function describeCompensationChange(row: CompensationHistoryRow): string[] {
  const before = row.previous_values;
  const after = row.new_values ?? {};
  const created = row.change_type === "created" || !before;
  const lines: string[] = [];

  if (created) {
    lines.push(
      payLine(
        "Private lesson pay",
        "",
        describePrivateLessonPay(after),
        false,
        (after.private_lesson_pay_mode ?? "none") !== "none",
        true,
      ).replace(/ disabled$/, " not configured"),
    );
    lines.push(
      payLine(
        "Group class pay",
        "",
        describeGroupClassPay(after),
        false,
        (after.group_class_pay_mode ?? "none") !== "none",
        true,
      ).replace(/ disabled$/, " not configured"),
    );
    if (after.notes) lines.push("Internal note added");
    return lines;
  }

  if (groupChanged(PRIVATE_KEYS, before, after)) {
    lines.push(
      payLine(
        "Private lesson pay",
        describePrivateLessonPay(before),
        describePrivateLessonPay(after),
        (before.private_lesson_pay_mode ?? "none") !== "none",
        (after.private_lesson_pay_mode ?? "none") !== "none",
        false,
      ),
    );
  }
  if (groupChanged(GROUP_KEYS, before, after)) {
    lines.push(
      payLine(
        "Group class pay",
        describeGroupClassPay(before),
        describeGroupClassPay(after),
        (before.group_class_pay_mode ?? "none") !== "none",
        (after.group_class_pay_mode ?? "none") !== "none",
        false,
      ),
    );
  }
  if ((before.notes ?? null) !== (after.notes ?? null)) {
    if (!before.notes) lines.push("Internal note added");
    else if (!after.notes) lines.push("Internal note removed");
    else lines.push("Internal note updated");
  }
  if (!sameValue(before.active ?? true, after.active ?? true)) {
    lines.push(after.active ? "Rule activated" : "Rule deactivated");
  }
  if (lines.length === 0) lines.push("Compensation rule updated");
  return lines;
}

const DETAIL_FIELDS: Array<{
  key: keyof CompensationRuleValues;
  label: string;
  format: (value: unknown) => string;
}> = [
  { key: "private_lesson_pay_mode", label: "Private lesson pay type", format: (v) => modeLabel(v) },
  { key: "private_lesson_flat_amount", label: "Private lesson flat amount", format: formatMoney },
  { key: "private_lesson_percentage", label: "Private lesson percentage", format: formatPercent },
  { key: "private_lesson_duration_rates_enabled", label: "Private lesson duration rates", format: (v) => (v ? "On" : "Off") },
  { key: "private_lesson_30_min_flat_amount", label: "30 minute lesson", format: formatMoney },
  { key: "private_lesson_45_min_flat_amount", label: "45 minute lesson", format: formatMoney },
  { key: "private_lesson_60_min_flat_amount", label: "60 minute lesson", format: formatMoney },
  { key: "group_class_pay_mode", label: "Group class pay type", format: (v) => modeLabel(v) },
  { key: "group_class_flat_amount", label: "Group class flat amount", format: formatMoney },
  { key: "group_class_percentage", label: "Group class percentage", format: formatPercent },
  { key: "group_class_per_attendee_amount", label: "Group class per attendee", format: formatMoney },
  { key: "active", label: "Rule active", format: (v) => (v ? "Yes" : "No") },
  { key: "notes", label: "Internal note", format: (v) => (v ? String(v) : "None") },
];

function modeLabel(value: unknown) {
  if (value === "flat") return "Flat rate";
  if (value === "percentage") return "Percentage";
  if (value === "per_attendee") return "Per attendee";
  return "Not configured";
}

/** Field-by-field before/after for the fields that actually changed. */
export function describeCompensationChangeDetails(
  row: CompensationHistoryRow,
): CompensationDetailLine[] {
  const before = row.previous_values;
  const after = row.new_values ?? {};
  const created = row.change_type === "created" || !before;
  const lines: CompensationDetailLine[] = [];
  for (const field of DETAIL_FIELDS) {
    const b = before?.[field.key] ?? emptyValue(field.key);
    const a = after[field.key] ?? emptyValue(field.key);
    const unchanged = field.key === "notes" ? (b ?? null) === (a ?? null) : sameValue(b, a);
    if (!created && unchanged) continue;
    // A created rule lists only the settings that carry a value.
    if (created && sameValue(a, emptyValue(field.key)) && field.key !== "private_lesson_pay_mode" && field.key !== "group_class_pay_mode") continue;
    lines.push({
      label: field.label,
      before: created ? "—" : field.format(b),
      after: field.format(a),
    });
  }
  return lines;
}

export function describeCompensationChangeType(changeType: string): string {
  if (changeType === "created") return "Rule created";
  if (changeType === "cleared") return "Pay disabled";
  return "Rule updated";
}

export function describeCompensationActor(row: {
  changed_by_name: string | null;
  changed_by_email: string | null;
  changed_by_role: string | null;
}): string {
  const who = row.changed_by_name?.trim() || row.changed_by_email?.trim() || "Unknown user";
  const role =
    row.changed_by_role === "studio_owner"
      ? "Owner"
      : row.changed_by_role === "studio_admin"
        ? "Admin"
        : null;
  return role ? `${who} (${role})` : who;
}

export function formatCompensationTimestamp(iso: string, timeZone?: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const build = (tz: string) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
      timeZoneName: "short",
    }).format(date);
  try {
    return build(timeZone || "UTC");
  } catch {
    return build("UTC");
  }
}

/** The current rule, one line per pay type (used by the detail panel). */
export function describeCurrentCompensation(
  rule: Partial<CompensationRuleValues> | null | undefined,
): { privateLesson: string; groupClass: string; configured: boolean } {
  if (!rule) {
    return { privateLesson: "Not configured", groupClass: "Not configured", configured: false };
  }
  const priv = describePrivateLessonPay(rule);
  const group = describeGroupClassPay(rule);
  const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  return {
    privateLesson: capitalize(priv),
    groupClass: capitalize(group),
    configured:
      (rule.private_lesson_pay_mode ?? "none") !== "none" ||
      (rule.group_class_pay_mode ?? "none") !== "none",
  };
}
