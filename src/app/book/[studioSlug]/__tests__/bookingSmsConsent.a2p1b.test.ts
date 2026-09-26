import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/** A2P-1B: the public intro-booking action records explicit SMS consent conservatively. */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));
const redirectMock = vi.hoisted(() => vi.fn());

const STUDIO_ID = "11111111-1111-4111-8111-111111111111";
const INSTRUCTOR_ID = "22222222-2222-4222-8222-222222222222";
const EXISTING_CLIENT = "33333333-3333-4333-8333-333333333333";
const FOREIGN_CLIENT = "88888888-8888-4888-8888-888888888888";
const SLOT_START = "2026-10-14T22:00:00.000Z";
const SLOT_END = "2026-10-14T22:30:00.000Z";
const PHONE_E164 = "+15550100123";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("@/lib/security/bot-protection", () => ({
  checkPublicFormProtection: async () => ({ allowed: true }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake.current!.client,
}));
vi.mock("@/lib/booking/selfServiceAvailability", () => ({
  buildSelfServiceSlots: () => [
    {
      date: "2026-10-14",
      startsAt: "2026-10-14T22:00:00.000Z",
      endsAt: "2026-10-14T22:30:00.000Z",
      instructorId: "22222222-2222-4222-8222-222222222222",
      roomId: null,
    },
  ],
}));

import { createPublicIntroBookingAction } from "@/app/book/[studioSlug]/actions";

function seed(options: { existingClient?: FakeRow | null; permissions?: FakeRow[] } = {}) {
  fake.current = createFakeSupabase({
    studios: [
      { id: STUDIO_ID, name: "Harbor Dance Studio", public_name: null, public_logo_url: null, slug: "harbor" },
    ],
    studio_settings: [
      {
        studio_id: STUDIO_ID,
        timezone: "America/New_York",
        public_intro_booking_enabled: true,
        intro_lesson_duration_minutes: 30,
        intro_booking_window_days: 14,
        public_intro_bookable_instructor_ids: [],
      },
    ],
    clients: options.existingClient ? [options.existingClient] : [],
    sms_contact_permissions: options.permissions ?? [],
  });
  return fake.current;
}

function existingClient(phone: string | null): FakeRow {
  return {
    id: EXISTING_CLIENT,
    studio_id: STUDIO_ID,
    email: "alex@example.test",
    phone,
    first_name: "Alex",
    last_name: "Rivera",
  };
}

function bookingForm(fields: Record<string, string>) {
  const formData = new FormData();
  const base: Record<string, string> = {
    studioSlug: "harbor",
    slotStart: SLOT_START,
    slotEnd: SLOT_END,
    instructorId: INSTRUCTOR_ID,
    roomId: "",
    firstName: "Alex",
    lastName: "Rivera",
    email: "alex@example.test",
    phone: "(555) 010-0123",
  };
  for (const [key, value] of Object.entries({ ...base, ...fields })) formData.set(key, value);
  return formData;
}

async function submit(fields: Record<string, string> = {}) {
  return createPublicIntroBookingAction({ error: "" }, bookingForm(fields));
}

function permissions() {
  return fake.current!.rows("sms_contact_permissions");
}

beforeEach(() => {
  redirectMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public booking SMS consent", () => {
  it("new lead + checked -> booking created and opted-in row with booking source", async () => {
    const db = seed();

    await submit({ smsConsent: "yes" });

    expect(redirectMock).toHaveBeenCalledWith("/book/harbor?success=intro_requested");
    expect(db.rows("booking_requests")).toHaveLength(1);
    const newClient = db.rows("clients")[0];
    expect(permissions()).toHaveLength(1);
    expect(permissions()[0]).toMatchObject({
      studio_id: STUDIO_ID,
      client_id: newClient.id,
      phone_e164: PHONE_E164,
      consent_status: "opted_in",
      consent_source: "public_booking_form",
      consent_note: "disclosure=a2p1b-v1;form=public_booking_form",
      created_by: null,
    });
  });

  it("existing client, matching phone, no row -> opted-in", async () => {
    seed({ existingClient: existingClient(PHONE_E164) });

    await submit({ smsConsent: "yes" });

    expect(permissions()).toHaveLength(1);
    expect(permissions()[0]).toMatchObject({ client_id: EXISTING_CLIENT, consent_status: "opted_in" });
  });

  it("existing client, matching phone, unknown row -> upgraded to opted-in", async () => {
    seed({
      existingClient: existingClient("555-010-0123"),
      permissions: [
        {
          id: "unknown",
          studio_id: STUDIO_ID,
          client_id: EXISTING_CLIENT,
          phone_e164: PHONE_E164,
          consent_status: "unknown",
          consent_at: null,
        },
      ],
    });

    await submit({ smsConsent: "yes" });

    expect(permissions()).toHaveLength(1);
    expect(permissions()[0]).toMatchObject({
      id: "unknown",
      consent_status: "opted_in",
      consent_source: "public_booking_form",
    });
  });

  it("existing client with a different stored phone -> no consent written, booking still created", async () => {
    const db = seed({ existingClient: existingClient("+15550100999") });

    await submit({ smsConsent: "yes" });

    expect(db.rows("booking_requests")).toHaveLength(1);
    expect(permissions()).toHaveLength(0);
    expect(db.rows("clients")[0].phone).toBe("+15550100999");
  });

  it("existing opted-in row -> no-op preserving original consent", async () => {
    seed({
      existingClient: existingClient(PHONE_E164),
      permissions: [
        {
          id: "in",
          studio_id: STUDIO_ID,
          client_id: EXISTING_CLIENT,
          phone_e164: PHONE_E164,
          consent_status: "opted_in",
          consent_source: "studio_staff_manual",
          consent_at: "2026-09-01T00:00:00.000Z",
        },
      ],
    });

    await submit({ smsConsent: "yes" });

    expect(permissions()).toHaveLength(1);
    expect(permissions()[0]).toMatchObject({
      consent_source: "studio_staff_manual",
      consent_at: "2026-09-01T00:00:00.000Z",
    });
  });

  it("existing opted-out row -> never changed", async () => {
    seed({
      existingClient: existingClient(PHONE_E164),
      permissions: [
        {
          id: "stop",
          studio_id: STUDIO_ID,
          client_id: FOREIGN_CLIENT,
          phone_e164: PHONE_E164,
          consent_status: "opted_out",
        },
      ],
    });

    await submit({ smsConsent: "yes" });

    expect(permissions()).toHaveLength(1);
    expect(permissions()[0]).toMatchObject({ id: "stop", consent_status: "opted_out" });
  });

  it("unchecked -> booking created, no consent row", async () => {
    const db = seed();

    await submit({});

    expect(db.rows("booking_requests")).toHaveLength(1);
    expect(permissions()).toHaveLength(0);
  });

  it("browser-injected ids/status are ignored", async () => {
    const db = seed();

    await submit({
      smsConsent: "yes",
      clientId: FOREIGN_CLIENT,
      studioId: "99999999-9999-4999-8999-999999999999",
      consentStatus: "opted_out",
      consentSource: "staff_import",
    });

    expect(permissions()).toHaveLength(1);
    expect(permissions()[0]).toMatchObject({
      studio_id: STUDIO_ID,
      client_id: db.rows("clients")[0].id,
      consent_status: "opted_in",
      consent_source: "public_booking_form",
    });
  });
});
