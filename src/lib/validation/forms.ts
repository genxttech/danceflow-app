export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const INVISIBLE_CHARACTERS = /[\u200B-\u200D\uFEFF]/g;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

function fail<T = never>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

function pass<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function rawFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export function cleanTextValue(
  value: string | null | undefined,
  options?: {
    fieldLabel?: string;
    maxLength?: number;
    allowNewlines?: boolean;
    required?: boolean;
  }
): ValidationResult<string> {
  const fieldLabel = options?.fieldLabel ?? "This field";
  const maxLength = options?.maxLength ?? 255;
  const allowNewlines = options?.allowNewlines ?? false;
  const required = options?.required ?? false;

  let cleaned = String(value ?? "")
    .replace(CONTROL_CHARACTERS, "")
    .replace(INVISIBLE_CHARACTERS, "")
    .trim();

  if (!allowNewlines) {
    cleaned = cleaned.replace(/\s+/g, " ");
  } else {
    cleaned = cleaned
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();
  }

  if (required && !cleaned) {
    return fail(`${fieldLabel} is required.`);
  }

  if (cleaned.length > maxLength) {
    return fail(`${fieldLabel} must be ${maxLength} characters or fewer.`);
  }

  return pass(cleaned);
}

export function cleanFormText(
  formData: FormData,
  key: string,
  options?: {
    fieldLabel?: string;
    maxLength?: number;
    allowNewlines?: boolean;
    required?: boolean;
  }
): ValidationResult<string> {
  return cleanTextValue(rawFormString(formData, key), options);
}

export function normalizeOptionalEmail(
  value: string | null | undefined,
  fieldLabel = "Email"
): ValidationResult<string | null> {
  const cleaned = cleanTextValue(value, {
    fieldLabel,
    maxLength: 254,
  });

  if (!cleaned.ok) return cleaned;
  if (!cleaned.value) return pass(null);

  const email = cleaned.value.toLowerCase();

  if (!EMAIL_PATTERN.test(email)) {
    return fail(`${fieldLabel} must be a valid email address.`);
  }

  return pass(email);
}

export function normalizeRequiredEmail(
  value: string | null | undefined,
  fieldLabel = "Email"
): ValidationResult<string> {
  const email = normalizeOptionalEmail(value, fieldLabel);

  if (!email.ok) return email;
  if (!email.value) return fail(`${fieldLabel} is required.`);

  return pass(email.value);
}

export function normalizeOptionalPhone(
  value: string | null | undefined,
  fieldLabel = "Phone"
): ValidationResult<string | null> {
  const cleaned = cleanTextValue(value, {
    fieldLabel,
    maxLength: 30,
  });

  if (!cleaned.ok) return cleaned;
  if (!cleaned.value) return pass(null);

  const candidate = cleaned.value;

  if (!/^[+\d\s().-]+$/.test(candidate)) {
    return fail(`${fieldLabel} can only contain numbers, spaces, +, parentheses, periods, or dashes.`);
  }

  if ((candidate.match(/\+/g) ?? []).length > 1 || (candidate.includes("+") && !candidate.startsWith("+"))) {
    return fail(`${fieldLabel} must be a valid phone number.`);
  }

  const digits = candidate.replace(/\D/g, "");

  if (candidate.startsWith("+")) {
    if (digits.length < 8 || digits.length > 15) {
      return fail(`${fieldLabel} must be a valid phone number.`);
    }

    return pass(`+${digits}`);
  }

  if (digits.length === 10) {
    return pass(`+1${digits}`);
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return pass(`+${digits}`);
  }

  return fail(`${fieldLabel} must be a valid 10-digit phone number.`);
}

export function normalizeOptionalDate(
  value: string | null | undefined,
  fieldLabel = "Date"
): ValidationResult<string | null> {
  const cleaned = cleanTextValue(value, {
    fieldLabel,
    maxLength: 10,
  });

  if (!cleaned.ok) return cleaned;
  if (!cleaned.value) return pass(null);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned.value)) {
    return fail(`${fieldLabel} must be a valid date.`);
  }

  const parsed = new Date(`${cleaned.value}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== cleaned.value) {
    return fail(`${fieldLabel} must be a valid date.`);
  }

  return pass(cleaned.value);
}

export function normalizeOptionalUuid(
  value: string | null | undefined,
  fieldLabel = "Identifier"
): ValidationResult<string | null> {
  const cleaned = cleanTextValue(value, {
    fieldLabel,
    maxLength: 36,
  });

  if (!cleaned.ok) return cleaned;
  if (!cleaned.value) return pass(null);

  if (!UUID_PATTERN.test(cleaned.value)) {
    return fail(`${fieldLabel} is invalid.`);
  }

  return pass(cleaned.value);
}

export function normalizeRequiredSlug(
  value: string | null | undefined,
  fieldLabel = "Slug"
): ValidationResult<string> {
  const cleaned = cleanTextValue(value, {
    fieldLabel,
    maxLength: 80,
    required: true,
  });

  if (!cleaned.ok) return cleaned;

  if (!SLUG_PATTERN.test(cleaned.value)) {
    return fail(`${fieldLabel} is invalid.`);
  }

  return pass(cleaned.value);
}

export function normalizeOptionalEnum<T extends string>(
  value: string | null | undefined,
  allowedValues: readonly T[],
  fieldLabel = "Selection"
): ValidationResult<T | null> {
  const cleaned = cleanTextValue(value, {
    fieldLabel,
    maxLength: 80,
  });

  if (!cleaned.ok) return cleaned;
  if (!cleaned.value) return pass(null);

  if (!allowedValues.includes(cleaned.value as T)) {
    return fail(`${fieldLabel} is invalid.`);
  }

  return pass(cleaned.value as T);
}

export function normalizeRequiredEnum<T extends string>(
  value: string | null | undefined,
  allowedValues: readonly T[],
  fieldLabel = "Selection"
): ValidationResult<T> {
  const normalized = normalizeOptionalEnum(value, allowedValues, fieldLabel);

  if (!normalized.ok) return normalized;
  if (!normalized.value) return fail(`${fieldLabel} is required.`);

  return pass(normalized.value);
}

export function normalizeTextList(
  values: string[],
  options?: {
    fieldLabel?: string;
    maxItemLength?: number;
    maxItems?: number;
    allowedValues?: readonly string[];
  }
): ValidationResult<string[]> {
  const fieldLabel = options?.fieldLabel ?? "Selection";
  const maxItems = options?.maxItems ?? 50;
  const maxItemLength = options?.maxItemLength ?? 120;

  if (values.length > maxItems) {
    return fail(`${fieldLabel} has too many selections.`);
  }

  const normalized: string[] = [];

  for (const value of values) {
    const cleaned = cleanTextValue(value, {
      fieldLabel,
      maxLength: maxItemLength,
    });

    if (!cleaned.ok) return cleaned;
    if (!cleaned.value) continue;

    if (options?.allowedValues && !options.allowedValues.includes(cleaned.value)) {
      return fail(`${fieldLabel} contains an invalid selection.`);
    }

    if (!normalized.includes(cleaned.value)) {
      normalized.push(cleaned.value);
    }
  }

  return pass(normalized);
}

export function safeLocalRedirectPath(value: string | null | undefined, fallback: string) {
  const cleaned = cleanTextValue(value, {
    fieldLabel: "Return path",
    maxLength: 400,
  });

  if (!cleaned.ok || !cleaned.value) return fallback;

  if (
    !cleaned.value.startsWith("/") ||
    cleaned.value.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(cleaned.value)
  ) {
    return fallback;
  }

  return cleaned.value;
}


export function getValidationError(results: ValidationResult<unknown>[]) {
  const invalid = results.find((result) => !result.ok);
  return invalid && !invalid.ok ? invalid.error : null;
}

export function getValidatedValue<T>(result: ValidationResult<T>) {
  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.value;
}
