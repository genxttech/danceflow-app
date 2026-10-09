import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SMS_CAMPAIGN_USE_CASES,
  evaluateSmsRegistrationReadiness,
  normalizeBrandSid,
  normalizeCustomerProfileSid,
  normalizePhoneNumberSid,
  registrationContradictions,
  type SmsRegistrationMetadata,
} from "@/lib/sms/registration";

/** TW-3: registration metadata validation and the single readiness calculation. */

const BU = `BU${"a1".repeat(16)}`;
const BN = `BN${"b2".repeat(16)}`;
const PN = `PN${"c3".repeat(16)}`;
const MG = `MG${"d4".repeat(16)}`;
const QE = `QE${"e5".repeat(16)}`;

const complete: SmsRegistrationMetadata = {
  registrationStatus: "approved",
  customerProfileSid: BU,
  brandSid: BN,
  brandStatus: "approved",
  messagingServiceSid: MG,
  campaignSid: QE,
  campaignStatus: "approved",
  campaignUseCase: "mixed",
  phoneNumberSid: PN,
  senderE164: "+15550100123",
};
const draft = (o: Partial<SmsRegistrationMetadata>): SmsRegistrationMetadata => ({ ...complete, ...o });

describe("TW-3 SID validation", () => {
  it("accepts well-formed Customer Profile, Brand and Phone Number SIDs and blanks", () => {
    expect(normalizeCustomerProfileSid(` ${BU} `)).toEqual({ ok: true, value: BU });
    expect(normalizeBrandSid(BN)).toEqual({ ok: true, value: BN });
    expect(normalizePhoneNumberSid(PN)).toEqual({ ok: true, value: PN });
    expect(normalizeBrandSid("  ")).toEqual({ ok: true, value: null });
  });

  it("keeps SID types distinct and rejects malformed or secret-shaped values", () => {
    expect(normalizeCustomerProfileSid(BN).ok).toBe(false);
    expect(normalizeBrandSid(BU).ok).toBe(false);
    expect(normalizePhoneNumberSid(MG).ok).toBe(false);
    expect(normalizeBrandSid("BN123").ok).toBe(false);
    expect(normalizePhoneNumberSid(`AC${"a1".repeat(16)}`).ok).toBe(false);
    expect(normalizeCustomerProfileSid(`${BU}x`).ok).toBe(false);
  });

  it("supports only the Mixed use case", () => {
    expect([...SMS_CAMPAIGN_USE_CASES]).toEqual(["mixed"]);
  });
});

describe("TW-3 readiness", () => {
  it("approved with every item is the only ready state", () => {
    expect(evaluateSmsRegistrationReadiness(complete)).toMatchObject({ state: "ready", canSend: true, missing: [] });
  });

  it("empty setup is incomplete and not sendable", () => {
    const r = evaluateSmsRegistrationReadiness(
      draft({
        registrationStatus: "not_registered",
        customerProfileSid: null,
        brandSid: null,
        brandStatus: "not_started",
        messagingServiceSid: null,
        campaignSid: null,
        campaignStatus: "not_started",
        campaignUseCase: null,
        phoneNumberSid: null,
        senderE164: null,
      }),
    );
    expect(r.state).toBe("incomplete");
    expect(r.canSend).toBe(false);
    expect(r.missing).toHaveLength(9);
  });

  it("in review is waiting and not sendable even with every identifier", () => {
    expect(evaluateSmsRegistrationReadiness(draft({ registrationStatus: "in_review" }))).toMatchObject({
      state: "waiting_review",
      canSend: false,
    });
  });

  it.each([
    ["Customer Profile SID", { customerProfileSid: null }],
    ["Brand SID", { brandSid: null }],
    ["Messaging Service SID", { messagingServiceSid: null }],
    ["Campaign SID", { campaignSid: null }],
    ["Campaign use case", { campaignUseCase: null }],
    ["Phone Number SID", { phoneNumberSid: null }],
    ["Sender number", { senderE164: null }],
    ["Brand status approved", { brandStatus: "in_review" as const }],
    ["Campaign status approved", { campaignStatus: "in_review" as const }],
  ])("approved but missing %s is not ready", (item, patch) => {
    const r = evaluateSmsRegistrationReadiness(draft(patch));
    expect(r.state).toBe("incomplete");
    expect(r.canSend).toBe(false);
    expect(r.missing).toContain(item);
    expect(registrationContradictions(draft(patch)).length).toBeGreaterThan(0);
  });

  it("rejected is action needed and never ready", () => {
    for (const patch of [
      { registrationStatus: "rejected" as const },
      { brandStatus: "rejected" as const },
      { campaignStatus: "rejected" as const },
    ]) {
      const r = evaluateSmsRegistrationReadiness(draft(patch));
      expect(r).toMatchObject({ state: "action_needed", canSend: false });
      expect(r.guidance).toMatch(/resubmit/i);
    }
  });

  it("suspended is blocked and never ready", () => {
    for (const patch of [
      { registrationStatus: "suspended" as const },
      { brandStatus: "suspended" as const },
      { campaignStatus: "suspended" as const },
    ]) {
      expect(evaluateSmsRegistrationReadiness(draft(patch))).toMatchObject({ state: "blocked", canSend: false });
    }
  });
});

describe("TW-3 contradictions", () => {
  it("accepts a consistent approved and a consistent draft", () => {
    expect(registrationContradictions(complete)).toEqual([]);
    expect(registrationContradictions(draft({ registrationStatus: "in_review" }))).toEqual([]);
  });

  it("rejects component approvals without their identifiers and a phone SID without a sender", () => {
    expect(registrationContradictions(draft({ registrationStatus: "in_review", campaignSid: null }))).toContain(
      "Campaign status cannot be approved without a Campaign SID.",
    );
    expect(registrationContradictions(draft({ registrationStatus: "in_review", brandSid: null }))).toContain(
      "Brand status cannot be approved without a Brand SID.",
    );
    expect(registrationContradictions(draft({ registrationStatus: "in_review", senderE164: null }))).toContain(
      "A Phone Number SID needs the sender number it belongs to.",
    );
  });
});

describe("TW-3 migration contract", () => {
  const dir = join(process.cwd(), "src", "lib", "supabase", "migrations");
  const sql = readFileSync(join(dir, "20261106090000_twilio_tw3_registration_metadata.sql"), "utf8").replace(/\r\n/g, "\n");
  const rollback = readFileSync(
    join(dir, "rollback", "20261106090000_twilio_tw3_registration_metadata_rollback.sql"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const body = sql.replace(/^--.*$/gm, "");

  it("adds only non-secret metadata columns and no credential columns", () => {
    for (const col of [
      "customer_profile_sid",
      "brand_sid",
      "phone_number_sid",
      "campaign_use_case",
      "brand_status",
      "campaign_status",
    ]) {
      expect(sql).toContain(`add column ${col} `);
    }
    expect(body).not.toMatch(/auth_token|api_secret|password|api_key/i);
  });

  it("constrains SID prefixes, use case, statuses and approval prerequisites", () => {
    expect(sql).toContain("'^BU[0-9a-fA-F]{32}$'");
    expect(sql).toContain("'^BN[0-9a-fA-F]{32}$'");
    expect(sql).toContain("'^PN[0-9a-fA-F]{32}$'");
    expect(sql).toContain("campaign_use_case in ('mixed')");
    expect(sql).toContain("studio_sms_registrations_approved_requires_full_setup");
    expect(sql).toContain("brand_status = 'approved'");
    expect(sql).toContain("campaign_status = 'approved'");
    expect(sql).toContain("campaign_sid is not null and campaign_use_case is not null");
  });

  it("does not touch RLS, grants or the integrity trigger", () => {
    expect(body).not.toMatch(/policy|grant |revoke |disable row level|create or replace function|create trigger/i);
  });

  it("rollback fails closed when TW-3 metadata is populated", () => {
    expect(rollback).toContain("tw3.allow_data_loss");
    expect(rollback).toContain("TW-3 rollback refused");
  });
});
