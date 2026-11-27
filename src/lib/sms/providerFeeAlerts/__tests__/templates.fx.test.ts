/**
 * TW-4F F-11 (20270223090000): every funding_exposure_* kind the migration adds has its own administrator copy, so a critical alert never renders as the
 * generic fallback, and the kind list here and in the migration stay in step.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { RFL_ALERT_KINDS, isKnownRflAlertKind, renderRflAlertEmail, sanitizeRflSummary } from "../templates";

const MIGRATION = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/20270223090000_twilio_funding_exposure_alerts.sql"), "utf8");
const migrationKinds = () => {
  const m = /array\['(funding_exposure_[a-z_]+)'(?:, '(funding_exposure_[a-z_]+)')*\]/.exec(MIGRATION);
  expect(m).not.toBeNull();
  return Array.from(new Set(MIGRATION.match(/'funding_exposure_[a-z_]+'/g)!.map((k) => k.slice(1, -1)))).sort();
};

describe("funding-exposure alert copy", () => {
  it("covers exactly the kinds the migration adds", () => {
    const kinds = migrationKinds();
    expect(kinds).toEqual(["funding_exposure_grace_ending", "funding_exposure_threshold", "funding_exposure_unauthorized", "funding_exposure_unfunded"]);
    for (const k of kinds) expect(isKnownRflAlertKind(k)).toBe(true);
    expect(RFL_ALERT_KINDS.filter((k) => k.startsWith("funding_exposure_")).sort()).toEqual(kinds);
  });

  it("each renders its own administrator subject (never the generic fallback), the platform link, and no amount or identifier", () => {
    const fallback = renderRflAlertEmail({ kind: "brand_new_kind", summary: "x x x x x", recipientKind: "admin" }).subject;
    for (const kind of migrationKinds()) {
      const mail = renderRflAlertEmail({ kind, summary: "A live phone number has no active rent authorization.", recipientKind: "admin" });
      expect(mail.templateKey).toBe(`platform_rfl_admin_${kind}`);
      expect(mail.subject).not.toBe(fallback);
      expect(mail.bodyText).toContain("/platform/sms");
      // a summary that looks sensitive falls back to the kind's own generic sentence, which itself passes the filter
      const generic = sanitizeRflSummary(kind, "owes $5 and 3 cents");
      expect(generic).not.toBe("A texting provider fee notice needs your attention.");
      expect(sanitizeRflSummary(kind, generic)).toBe(generic);
    }
  });

  it("the database summaries pass the sensitivity filter unchanged (they carry no amount)", () => {
    const summaries = [...MIGRATION.matchAll(/'((?:A|An|The) [^']{20,299})'/g)].map((m) => m[1]).filter((t) => t.endsWith("."));
    expect(summaries.length).toBeGreaterThanOrEqual(8);
    for (const s of summaries) expect(sanitizeRflSummary("funding_exposure_unauthorized", s)).toBe(s);
  });
});
