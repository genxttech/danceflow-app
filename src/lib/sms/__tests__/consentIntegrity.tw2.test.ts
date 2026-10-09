import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { upsertSmsConsent } from "@/lib/sms/compliance";

/**
 * TW-2: consent integrity guards on the application side. The database behavior (staff
 * STOP-reversal guard, unknown-number STOP, append-only history, tenant checks, atomicity)
 * is proven by sql-tests/test_T_twilio_tw2_consent_integrity.sql.
 */

const ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATION = join(
  ROOT,
  "src/lib/supabase/migrations/20261105090000_twilio_tw2_consent_integrity.sql",
);

function productionSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "__tests__" || name === "migrations" || name === "node_modules" ? [] : productionSourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("no direct consent writes from application code", () => {
  it("nothing inserts, updates, upserts or deletes sms_contact_permissions / sms_consent_history directly", () => {
    const pattern = /from\(\s*["'](sms_contact_permissions|sms_consent_history)["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    const offenders = productionSourceFiles(join(ROOT, "src")).filter((file) => pattern.test(readFileSync(file, "utf8")));

    expect(offenders).toEqual([]);
  }, 30_000);

  it("consumer paths use the canonical database functions", () => {
    const inbound = readFileSync(join(ROOT, "src/app/api/sms/twilio/inbound/route.ts"), "utf8");
    const publicConsent = readFileSync(join(ROOT, "src/lib/sms/publicConsent.ts"), "utf8");

    expect(inbound).toContain('rpc("record_sms_inbound_opt_event"');
    expect(publicConsent).toContain('rpc("record_sms_public_opt_in"');
  });
});

describe("TW-2 migration shape", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("revokes direct consent writes and keeps history append-only", () => {
    expect(sql).toContain("revoke all on public.sms_contact_permissions from public, anon, authenticated, service_role;");
    expect(sql).toContain("revoke all on public.sms_consent_history from public, anon, authenticated, service_role;");
    expect(sql).toMatch(/before update or delete on public\.sms_consent_history/);
    expect(sql).toMatch(/before truncate on public\.sms_consent_history/);
  });

  it("guards consumer STOP, tenant ownership and active roles in the staff function", () => {
    expect(sql).toContain("hint = 'sms_consumer_opt_out_locked'");
    expect(sql).toContain("c.id = p_client_id and c.studio_id = p_studio_id");
    expect(sql).toContain("oc.id = p_organizer_contact_id and oc.organizer_id = p_organizer_id");
    expect(sql).toContain("and usr.active = true");
  });

  it("consumer functions are service_role only", () => {
    expect(sql).toContain("grant execute on function public.record_sms_inbound_opt_event(uuid, text, text) to service_role;");
    expect(sql).toContain("grant execute on function public.record_sms_public_opt_in(uuid, uuid, text, text, text) to service_role;");
  });
});

describe("staff consent errors reach the studio user", () => {
  it("the STOP-locked database message is returned verbatim (no raw identifiers added)", async () => {
    const message = "This number opted out by replying STOP. Only the contact can resubscribe, by texting START.";
    const supabase = {
      rpc: async () => ({ data: null, error: { code: "42501", message, hint: "sms_consumer_opt_out_locked" } }),
    };

    const result = await upsertSmsConsent(supabase as never, {
      studioId: "11111111-1111-4111-8111-111111111111",
      clientId: "33333333-3333-4333-8333-333333333333",
      phoneRaw: "(555) 010-0123",
      consentStatus: "opted_in",
      consentSource: "studio_staff_manual",
    });

    expect(result).toEqual({ data: null, error: message });
  });
});
