import { DRAFT_FIELD_KEYS, FIELD_LABELS, missingRequired, validateDraftFields, type DraftFieldKey } from "@/lib/sms/onboarding/fields";

/**
 * Stage B preparation: checks an owner-filled business JSON file against the EXACT rules the onboarding wizard, the database and the runner
 * use (it calls the same `validateDraftFields` / `missingRequired`), without touching Twilio or the database and WITHOUT ever returning or
 * printing a field's value. Findings name fields and rules only, so the output is safe to paste into a chat or a log.
 *
 * What the file must NOT contain: the EIN (it is typed into a hidden prompt at run time and is never stored in a file) and any secret.
 */

/**
 * The name Twilio shows on the approved Primary (ISV) profile, as recorded by the read-only Stage A probe. Not sensitive.
 * The Primary profile is DanceFlow's OWN identity. A Secondary profile belongs to a studio (a different legal entity), so a business file
 * that names the ISV is refused: it is never a valid Secondary-profile subject (see TW-4_StageB_Studio_Identity.md).
 */
export const PRIMARY_PROFILE_NAME_ON_TWILIO = "Genx TotalTech LLC";
/** Words that identify the ISV's own legal entity; a studio legal name containing any of them is refused. */
const ISV_NAME_MARKERS = ["genx", "totaltech"];
/** Domain of the ISV's own mailboxes; the representative must be the studio's, so an ISV address is refused. */
const ISV_EMAIL_DOMAINS = ["idanceflow.com"];

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

export type BusinessFileFinding = { field: string; label: string; message: string };
export type BusinessFileReport = {
  ok: boolean;
  /** Problems that block a run. */
  errors: BusinessFileFinding[];
  /** Fields the runner needs that are empty. */
  missing: BusinessFileFinding[];
  /** Things worth a look that do not block a run. */
  warnings: BusinessFileFinding[];
  /** Facts the owner should know before running (no values). */
  notes: string[];
  /** Per-field status for a checklist: "ok" | "missing" | "error" | "optional-empty". */
  fields: Record<string, "ok" | "missing" | "error" | "optional-empty">;
};

const OPTIONAL: readonly DraftFieldKey[] = ["website_url", "address_line2"];
const labelOf = (key: string) => (FIELD_LABELS as Record<string, string>)[key] ?? key;

export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  return v.startsWith("<") || /\bTODO\b/i.test(v) || /^(x{3,}|n\/a|tbd|changeme)$/i.test(v);
}

export function checkBusinessFile(parsed: unknown): BusinessFileReport {
  const report: BusinessFileReport = { ok: false, errors: [], missing: [], warnings: [], notes: [], fields: {} };
  const add = (list: BusinessFileFinding[], field: string, message: string) => list.push({ field, label: labelOf(field), message });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    add(report.errors, "(file)", "The file must be one JSON object of field names to text values.");
    return report;
  }
  const input = parsed as Record<string, unknown>;

  // 1. keys: the EIN and anything unknown are refused
  for (const key of Object.keys(input)) {
    if ((DRAFT_FIELD_KEYS as readonly string[]).includes(key)) continue;
    if (/^(ein|tax_?id|fein|ssn)$/i.test(key)) add(report.errors, key, "The EIN / tax id must NOT be in this file. It is typed into a hidden prompt when the launcher runs and is never stored in a file.");
    else if (/secret|token|password|api_?key|auth/i.test(key)) add(report.errors, key, "Secrets must never be in this file.");
    else add(report.errors, key, "Unknown field; remove it (only the fields in the template are accepted).");
  }

  // 2. values: strings only, no placeholders
  const text: Record<string, string> = {};
  for (const key of DRAFT_FIELD_KEYS) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") {
      add(report.errors, key, "Must be text (a JSON string).");
      continue;
    }
    if (isPlaceholder(raw)) {
      add(report.errors, key, "Still holds a placeholder; replace it with the real value.");
      continue;
    }
    text[key] = raw;
  }

  // 3. the wizard's own rules
  const validation = validateDraftFields(text);
  for (const [key, message] of Object.entries(validation.errors)) add(report.errors, key, String(message));
  for (const [key, message] of Object.entries(validation.warnings)) add(report.warnings, key, String(message));
  for (const key of missingRequired(validation.fields, true)) add(report.missing, key, "Required and empty.");

  // 4. the subject must be the STUDIO, never the ISV (no values are echoed)
  const name = (validation.fields.legal_name ?? "").trim();
  if (name) {
    const flat = squash(name);
    if (flat === squash(PRIMARY_PROFILE_NAME_ON_TWILIO) || ISV_NAME_MARKERS.some((marker) => flat.includes(marker))) {
      add(report.errors, "legal_name", "This is the ISV's own legal identity (the approved Primary profile). A Secondary profile must describe the studio, a different legal entity with its own EIN; the ISV's identity is refused.");
    }
  }
  const emailDomain = (validation.fields.rep_email ?? "").split("@")[1] ?? "";
  if (ISV_EMAIL_DOMAINS.includes(emailDomain)) {
    add(report.errors, "rep_email", "The representative must be the studio's authorized person with the studio's own email, not an ISV (DanceFlow) address. The ISV compliance mailbox is entered separately by the launcher.");
  }
  if (validation.fields.entity_type) report.notes.push(`entity_type "${validation.fields.entity_type}" must be what the studio's IRS letter / formation documents show; a studio without an EIN (for example a sole proprietor) cannot use this path.`);
  if (validation.fields.website_choice === "danceflow") {
    report.notes.push('website_choice "danceflow": the website becomes a DanceFlow page for the throwaway LOCAL test studio, which does not exist publicly. Use "own" with the studio\'s real https:// page for a studio whose profile Twilio will evaluate.');
  }
  if (validation.fields.website_choice === "own") report.notes.push('website_choice "own": the website_url you gave is sent as the profile\'s website.');

  // 5. per-field status (after every check, so a field refused above shows as an error)
  const errorFields = new Set(report.errors.map((e) => e.field));
  const missingFields = new Set(report.missing.map((m) => m.field));
  for (const key of DRAFT_FIELD_KEYS) {
    if (errorFields.has(key)) report.fields[key] = "error";
    else if (missingFields.has(key)) report.fields[key] = "missing";
    else if (!validation.fields[key] && OPTIONAL.includes(key)) report.fields[key] = "optional-empty";
    else report.fields[key] = validation.fields[key] ? "ok" : "missing";
  }

  report.ok = report.errors.length === 0 && report.missing.length === 0;
  return report;
}

/** True when `candidate` is inside `root` (case-insensitive, separator-agnostic). Used to keep owner-filled files out of the repository. */
export function isInsideDirectory(candidate: string, root: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const c = norm(candidate);
  const r = norm(root);
  return c === r || c.startsWith(`${r}/`);
}
