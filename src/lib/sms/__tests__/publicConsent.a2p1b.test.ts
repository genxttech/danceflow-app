import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/** A2P-1B: server-only public-form SMS consent evidence rules. */

const fake = vi.hoisted(() => ({ current: null as { from: (table: string) => unknown } | null }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake.current,
}));

import { recordPublicFormSmsConsent, type PublicConsentInput } from "@/lib/sms/publicConsent";
import { SMS_CONSENT_DISCLOSURE_VERSION } from "@/lib/sms/compliance";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const OTHER_STUDIO = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const OTHER_CLIENT = "44444444-4444-4444-8444-444444444444";
const PHONE_RAW = "(555) 010-0123";
const PHONE = "+15550100123";

let db: ReturnType<typeof createFakeSupabase>;

function seed(permissions: FakeRow[] = []) {
  db = createFakeSupabase({ sms_contact_permissions: permissions });
  fake.current = db.client;
  return db;
}

function input(overrides: Partial<PublicConsentInput> = {}): PublicConsentInput {
  return {
    studioId: STUDIO,
    clientId: CLIENT,
    clientIsNew: true,
    submittedPhone: PHONE_RAW,
    consentChecked: true,
    form: "public_lead_form",
    ...overrides,
  };
}

function row(overrides: FakeRow): FakeRow {
  return {
    id: `perm-${Math.random()}`,
    studio_id: STUDIO,
    client_id: CLIENT,
    phone_e164: PHONE,
    consent_status: "opted_in",
    consent_source: "studio_staff_manual",
    consent_at: "2026-09-01T00:00:00.000Z",
    consent_note: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("no-write cases", () => {
  it("unchecked -> no write", async () => {
    seed();
    expect(await recordPublicFormSmsConsent(input({ consentChecked: false }))).toEqual({
      recorded: false,
      reason: "unchecked",
    });
    expect(db.mutations).toHaveLength(0);
  });

  it.each([null, "", "12345", "not a phone"])("missing/invalid phone %p -> no write", async (phone) => {
    seed();
    expect(await recordPublicFormSmsConsent(input({ submittedPhone: phone }))).toEqual({
      recorded: false,
      reason: "invalid_phone",
    });
    expect(db.mutations).toHaveLength(0);
  });

  it("any opted-out row for the studio+phone -> no write, opt-out untouched", async () => {
    seed([row({ id: "stop", client_id: OTHER_CLIENT, consent_status: "opted_out" })]);

    expect(await recordPublicFormSmsConsent(input())).toEqual({ recorded: false, reason: "opted_out" });
    expect(db.mutations).toHaveLength(0);
    expect(db.rows("sms_contact_permissions")[0]).toMatchObject({ consent_status: "opted_out" });
  });

  it("existing client's own opted-out row is never overwritten", async () => {
    seed([row({ id: "own", consent_status: "opted_out", consent_source: "twilio_inbound_stop" })]);

    expect(
      await recordPublicFormSmsConsent(input({ clientIsNew: false, existingClientPhone: PHONE_RAW })),
    ).toEqual({ recorded: false, reason: "opted_out" });
    expect(db.rows("sms_contact_permissions")[0]).toMatchObject({
      consent_status: "opted_out",
      consent_source: "twilio_inbound_stop",
    });
  });

  it.each([
    ["different phone", "(555) 010-0999"],
    ["no stored phone", null],
    ["invalid stored phone", "12"],
  ])("existing client with %s -> no write", async (_label, storedPhone) => {
    seed();
    expect(
      await recordPublicFormSmsConsent(input({ clientIsNew: false, existingClientPhone: storedPhone })),
    ).toEqual({ recorded: false, reason: "phone_mismatch" });
    expect(db.mutations).toHaveLength(0);
  });

  it("existing opted-in row -> idempotent no-op preserving consent time and source", async () => {
    seed([row({ id: "in" })]);

    expect(
      await recordPublicFormSmsConsent(input({ clientIsNew: false, existingClientPhone: PHONE })),
    ).toEqual({ recorded: false, reason: "already_opted_in" });
    expect(db.mutations).toHaveLength(0);
    expect(db.rows("sms_contact_permissions")[0]).toMatchObject({
      consent_at: "2026-09-01T00:00:00.000Z",
      consent_source: "studio_staff_manual",
    });
  });
});

describe("write cases", () => {
  it("new client + checked + valid phone -> one server-derived opted-in row", async () => {
    seed([row({ id: "elsewhere", studio_id: OTHER_STUDIO, consent_status: "opted_out" })]);

    expect(await recordPublicFormSmsConsent(input())).toEqual({ recorded: true, action: "inserted" });

    const inserted = db.rows("sms_contact_permissions").filter((r) => r.studio_id === STUDIO);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      studio_id: STUDIO,
      client_id: CLIENT,
      phone_e164: PHONE,
      consent_status: "opted_in",
      consent_source: "public_lead_form",
      consent_note: `disclosure=${SMS_CONSENT_DISCLOSURE_VERSION};form=public_lead_form`,
      created_by: null,
      updated_by: null,
    });
    expect(Date.parse(String(inserted[0].consent_at))).not.toBeNaN();
    expect(SMS_CONSENT_DISCLOSURE_VERSION).toBe("a2p1b-v1");
  });

  it("existing client, matching phone, no row -> inserted with booking source", async () => {
    seed();

    expect(
      await recordPublicFormSmsConsent(
        input({ clientIsNew: false, existingClientPhone: "555.010.0123", form: "public_booking_form" }),
      ),
    ).toEqual({ recorded: true, action: "inserted" });
    expect(db.rows("sms_contact_permissions")[0]).toMatchObject({
      consent_source: "public_booking_form",
      consent_note: "disclosure=a2p1b-v1;form=public_booking_form",
    });
  });

  it("existing client, matching phone, unknown row -> guarded upgrade to opted-in", async () => {
    seed([row({ id: "unknown", consent_status: "unknown", consent_at: null, consent_source: null })]);

    expect(
      await recordPublicFormSmsConsent(
        input({ clientIsNew: false, existingClientPhone: PHONE, form: "public_booking_form" }),
      ),
    ).toEqual({ recorded: true, action: "upgraded" });

    const updated = db.rows("sms_contact_permissions")[0];
    expect(updated).toMatchObject({
      id: "unknown",
      consent_status: "opted_in",
      consent_source: "public_booking_form",
      consent_note: "disclosure=a2p1b-v1;form=public_booking_form",
      updated_by: null,
    });
    expect(updated.consent_at).toBeTruthy();
    expect(db.rows("sms_contact_permissions")).toHaveLength(1);
  });

  it("only this client's row is touched when another client shares the phone", async () => {
    seed([row({ id: "other", client_id: OTHER_CLIENT, consent_status: "unknown", consent_at: null })]);

    expect(await recordPublicFormSmsConsent(input())).toEqual({ recorded: true, action: "inserted" });
    expect(db.rows("sms_contact_permissions").find((r) => r.id === "other")).toMatchObject({
      consent_status: "unknown",
    });
  });
});

describe("idempotency and failure handling", () => {
  it("a concurrent insert reported as duplicate by the database -> idempotent no-op", async () => {
    seed();
    db.overrideRpc("record_sms_public_opt_in", () => ({ data: "duplicate", error: null }));

    expect(await recordPublicFormSmsConsent(input())).toEqual({ recorded: false, reason: "duplicate" });
  });

  it("TW-2: consent is written only through the canonical database function", async () => {
    seed();

    await recordPublicFormSmsConsent(input({ form: "public_booking_form" }));

    expect(db.rpcCalls).toEqual([
      {
        name: "record_sms_public_opt_in",
        args: {
          p_studio_id: STUDIO,
          p_client_id: CLIENT,
          p_phone_e164: PHONE,
          p_source: "public_booking_form",
          p_note: `disclosure=${SMS_CONSENT_DISCLOSURE_VERSION};form=public_booking_form`,
        },
      },
    ]);
  });

  it("an opt-out recorded for the phone before it had a client (STOP from an unknown number) wins", async () => {
    seed([row({ id: "phone-level", client_id: null, consent_status: "opted_out", consent_at: null, opted_out_source: "twilio_inbound_stop" })]);

    expect(await recordPublicFormSmsConsent(input())).toEqual({ recorded: false, reason: "opted_out" });
    expect(db.rows("sms_contact_permissions")).toHaveLength(1);
  });

  it.each([
    ["database error", () => ({ data: null, error: { code: "42501", message: `boom ${PHONE}` } })],
    ["unexpected result", () => ({ data: "something_else", error: null })],
  ])("%s -> no consent, code-only warning (no PII)", async (_name, handler) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    seed();
    db.overrideRpc("record_sms_public_opt_in", handler);

    expect(await recordPublicFormSmsConsent(input())).toEqual({ recorded: false, reason: "write_failed" });
    const logged = warn.mock.calls.flat().map(String).join("\n");
    expect(logged).toBe("sms_public_consent_write_failed");
    expect(logged).not.toContain("555");
  });
});
