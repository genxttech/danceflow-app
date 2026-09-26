import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/** A2P-1B: the public lead action records explicit SMS consent with server-derived evidence. */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));
const redirectMock = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("@/lib/security/bot-protection", () => ({
  checkPublicFormProtection: async () => ({ allowed: true }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fake.current!.client,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake.current!.client,
}));

import { submitPublicLeadAction } from "@/app/lead/[studioSlug]/actions";

const STUDIO_ID = "11111111-1111-4111-8111-111111111111";
const FOREIGN_STUDIO = "99999999-9999-4999-8999-999999999999";
const FOREIGN_CLIENT = "88888888-8888-4888-8888-888888888888";
const PHONE_E164 = "+15550100123";

function seed(permissions: FakeRow[] = []) {
  fake.current = createFakeSupabase({
    studios: [{ id: STUDIO_ID, name: "Harbor Dance Studio", slug: "harbor", public_lead_enabled: true }],
    studio_settings: [],
    clients: [],
    sms_contact_permissions: permissions,
  });
  return fake.current;
}

function leadForm(fields: Record<string, string>) {
  const formData = new FormData();
  const base: Record<string, string> = {
    studioSlug: "harbor",
    firstName: "Alex",
    lastName: "Rivera",
    email: "alex@example.test",
    phone: "(555) 010-0123",
  };
  for (const [key, value] of Object.entries({ ...base, ...fields })) formData.set(key, value);
  return formData;
}

async function submit(fields: Record<string, string>) {
  return submitPublicLeadAction({ error: "" }, leadForm(fields));
}

beforeEach(() => {
  redirectMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public lead SMS consent", () => {
  it("checked + valid phone -> lead created and exactly one server-derived opted-in row", async () => {
    const db = seed();

    await submit({ smsConsent: "yes" });

    expect(redirectMock).toHaveBeenCalledWith("/lead/harbor?success=1");
    const clients = db.rows("clients");
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ studio_id: STUDIO_ID, status: "lead", phone: PHONE_E164 });

    const permissions = db.rows("sms_contact_permissions");
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({
      studio_id: STUDIO_ID,
      client_id: clients[0].id,
      phone_e164: PHONE_E164,
      consent_status: "opted_in",
      consent_source: "public_lead_form",
      consent_note: "disclosure=a2p1b-v1;form=public_lead_form",
      created_by: null,
      updated_by: null,
    });
  });

  it("unchecked -> lead created, no consent row", async () => {
    const db = seed();

    await submit({});

    expect(db.rows("clients")).toHaveLength(1);
    expect(db.rows("sms_contact_permissions")).toHaveLength(0);
  });

  it("checked but no phone (email only) -> lead created, no consent row", async () => {
    const db = seed();

    await submit({ smsConsent: "yes", phone: "" });

    expect(db.rows("clients")).toHaveLength(1);
    expect(db.rows("sms_contact_permissions")).toHaveLength(0);
  });

  it("checked but un-normalizable phone -> no consent row", async () => {
    const db = seed();

    await submit({ smsConsent: "yes", phone: "12345" });

    expect(db.rows("sms_contact_permissions")).toHaveLength(0);
  });

  it("preferred contact 'text' without the checkbox is NOT consent", async () => {
    const db = seed();

    await submit({ preferredContactMethod: "text" });

    expect(db.rows("clients")[0].notes).toContain("Preferred Contact Method: text");
    expect(db.rows("sms_contact_permissions")).toHaveLength(0);
  });

  it("only the literal value 'yes' counts as consent", async () => {
    const db = seed();

    await submit({ smsConsent: "on" });

    expect(db.rows("sms_contact_permissions")).toHaveLength(0);
  });

  it("browser-injected studio/client/status/source fields are ignored", async () => {
    const db = seed();

    await submit({
      smsConsent: "yes",
      studioId: FOREIGN_STUDIO,
      studio_id: FOREIGN_STUDIO,
      clientId: FOREIGN_CLIENT,
      client_id: FOREIGN_CLIENT,
      consentStatus: "opted_out",
      consent_status: "opted_out",
      consentSource: "staff_import",
      consentAt: "2000-01-01T00:00:00.000Z",
    });

    const permissions = db.rows("sms_contact_permissions");
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({
      studio_id: STUDIO_ID,
      client_id: db.rows("clients")[0].id,
      consent_status: "opted_in",
      consent_source: "public_lead_form",
    });
    expect(permissions[0].consent_at).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("an existing opt-out for the studio+phone is never overwritten", async () => {
    const db = seed([
      {
        id: "stopped",
        studio_id: STUDIO_ID,
        client_id: FOREIGN_CLIENT,
        phone_e164: PHONE_E164,
        consent_status: "opted_out",
        consent_source: "public_lead_form",
      },
    ]);

    await submit({ smsConsent: "yes" });

    expect(db.rows("clients")).toHaveLength(1);
    const permissions = db.rows("sms_contact_permissions");
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({ id: "stopped", consent_status: "opted_out" });
  });

  it("a studio with public leads disabled creates nothing", async () => {
    const db = seed();
    db.rows("studios")[0].public_lead_enabled = false;

    const result = await submit({ smsConsent: "yes" });

    expect(result).toEqual({ error: "This inquiry form is not available." });
    expect(db.rows("clients")).toHaveLength(0);
    expect(db.rows("sms_contact_permissions")).toHaveLength(0);
  });
});
