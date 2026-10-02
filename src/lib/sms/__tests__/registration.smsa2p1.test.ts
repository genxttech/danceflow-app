import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SMS_REGISTRATION_STATUSES,
  SMS_REGISTRATION_STATUS_LABELS,
  missingApprovalIdentifiers,
  normalizeCampaignSid,
  normalizeMessagingServiceSid,
  normalizeSenderE164,
} from "@/lib/sms/registration";

/** SMS-A2P-1: per-studio registration foundation (non-secret identifiers, fail-closed status). */

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

const MG = `MG${"a1".repeat(16)}`;
const QE = `QE${"0f".repeat(16)}`;

describe("identifier validation", () => {
  it("accepts well-formed Messaging Service, Campaign and sender values", () => {
    expect(normalizeMessagingServiceSid(` ${MG} `)).toEqual({ ok: true, value: MG });
    expect(normalizeCampaignSid(QE)).toEqual({ ok: true, value: QE });
    expect(normalizeSenderE164("(555) 010-0123")).toEqual({ ok: true, value: "+15550100123" });
  });

  it("treats blank values as null", () => {
    expect(normalizeMessagingServiceSid("")).toEqual({ ok: true, value: null });
    expect(normalizeCampaignSid(undefined)).toEqual({ ok: true, value: null });
    expect(normalizeSenderE164("  ")).toEqual({ ok: true, value: null });
  });

  it("keeps the two SID types distinct", () => {
    expect(normalizeMessagingServiceSid(QE).ok).toBe(false);
    expect(normalizeCampaignSid(MG).ok).toBe(false);
  });

  it("rejects secret-shaped or malformed values", () => {
    expect(normalizeMessagingServiceSid("MG123").ok).toBe(false);
    expect(normalizeMessagingServiceSid(`AC${"a1".repeat(16)}`).ok).toBe(false);
    expect(normalizeCampaignSid("not-a-sid").ok).toBe(false);
    expect(normalizeSenderE164("abc").ok).toBe(false);
  });
});

describe("status model fails closed", () => {
  it("is a closed set that begins unregistered", () => {
    expect([...SMS_REGISTRATION_STATUSES]).toEqual([
      "not_registered",
      "in_review",
      "approved",
      "rejected",
      "suspended",
    ]);
    expect(Object.keys(SMS_REGISTRATION_STATUS_LABELS).sort()).toEqual(
      [...SMS_REGISTRATION_STATUSES].sort(),
    );
  });

  it("an approval needs every identifier", () => {
    expect(
      missingApprovalIdentifiers({ messagingServiceSid: null, campaignSid: null, senderE164: null }),
    ).toEqual(["Messaging Service SID", "Campaign SID", "Sender number"]);
    expect(
      missingApprovalIdentifiers({ messagingServiceSid: MG, campaignSid: QE, senderE164: "+15550100123" }),
    ).toEqual([]);
  });
});

describe("migration contract", () => {
  const sql = read("src", "lib", "supabase", "migrations", "20261012090000_smsa2p1_studio_sms_registrations.sql");

  it("creates one row per studio with a constrained status defaulting to not_registered", () => {
    expect(sql).toContain("studio_id uuid not null unique references public.studios(id)");
    expect(sql).toContain("registration_status text not null default 'not_registered'");
    expect(sql).toContain(
      "registration_status in ('not_registered', 'in_review', 'approved', 'rejected', 'suspended')",
    );
    expect(sql).toContain("studio_sms_registrations_approved_requires_identifiers");
  });

  it("stores no credentials", () => {
    const columns = sql.slice(sql.indexOf("create table"), sql.indexOf("comment on table"));
    expect(columns).not.toMatch(/auth_token|api_key|secret|password|account_sid/i);
  });

  it("enables RLS with platform-admin-only policies, no anon grant and no studio policy", () => {
    expect(sql).toContain("alter table public.studio_sms_registrations enable row level security");
    expect(sql).toContain("revoke all on public.studio_sms_registrations from anon");
    expect(sql).toContain("grant select, insert, update on public.studio_sms_registrations to authenticated");
    const policies = sql.match(/create policy/g) ?? [];
    expect(policies).toHaveLength(3);
    expect(sql).not.toMatch(/user_studio_roles/);
    expect(sql).not.toMatch(/for delete/);
    expect(sql.match(/p\.platform_role = 'platform_admin'/g)?.length).toBe(4);
  });

  it("does not touch existing SMS objects", () => {
    expect(sql).not.toMatch(/alter table public\.(sms_|studios)/i);
    expect(sql).not.toMatch(/drop (table|policy|function)/i);
  });
});

describe("admin action", () => {
  const action = read("src", "app", "platform", "sms", "actions.ts");

  it("requires a platform admin before anything else", () => {
    const body = action.slice(action.indexOf("export async function saveStudioSmsRegistrationAction"));
    expect(body.indexOf("requirePlatformAdmin()")).toBeGreaterThan(-1);
    expect(body.indexOf("requirePlatformAdmin()")).toBeLessThan(body.indexOf("createClient()"));
  });

  it("writes through the RLS-bound user client, never the admin client", () => {
    expect(action).toContain('from "@/lib/supabase/server"');
    expect(action).not.toContain("supabase/admin");
  });

  it("requires every identifier before approving", () => {
    expect(action).toContain('statusResult.value === "approved"');
    expect(action).toContain("missingApprovalIdentifiers");
  });

  it("does not create Twilio resources or read credentials", () => {
    expect(action).not.toMatch(/twilio\.com|TWILIO_|process\.env/);
  });
});

describe("/sms-consent shows only currently permitted categories", () => {
  const page = read("src", "app", "sms-consent", "page.tsx");
  const compliance = read("src", "lib", "sms", "compliance.ts");

  it("source still permits exactly the three appointment templates", () => {
    expect(compliance).toMatch(
      /SMS_AUTOMATED_TEMPLATES[^=]*=\s*new Set\(\[\s*"appointment_confirmed",\s*"appointment_rescheduled",\s*"appointment_cancelled",\s*\]\)/,
    );
  });

  it("lists appointment confirmations, reschedules and cancellations plus one-to-one staff messages", () => {
    const text = page.replace(/\s+/g, " ");
    expect(text).toContain("Lesson appointment confirmations");
    expect(text).toContain("Lesson appointment reschedules");
    expect(text).toContain("Lesson appointment cancellations");
    expect(text).toContain("One-to-one messages from authorized studio staff");
  });

  it("no longer presents an inquiry/free-form sample as an automated message", () => {
    expect(page).not.toContain("thanks for your inquiry");
    expect(page).not.toContain("hold it?");
    expect(page).toContain("has been cancelled");
  });

  it("makes no claim about unregistered categories", () => {
    expect(page).not.toMatch(/event|reminder|ticket|raffle|newsletter|promo code|% off/i);
  });

  it("states it is not the sign-up form and keeps the program disclosures", () => {
    const text = page.replace(/\s+/g, " ");
    expect(text).toContain("It is not a sign-up form");
    expect(text).toContain("DanceFlow is a software platform owned and operated by GenX TotalTech LLC");
    expect(text).toContain("Message frequency varies");
    expect(text).toContain("Message and data rates may apply");
    expect(text).toContain("is not a condition of purchase");
    expect(text).toContain('href="/terms"');
    expect(text).toContain('href="/privacy"');
  });
});
