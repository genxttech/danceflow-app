import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** TW-3: platform SMS registration UI + save action (platform-admin only, no secrets). */

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  upsert: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/platform", () => ({ requirePlatformAdmin: mocks.requirePlatformAdmin }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => ({ upsert: mocks.upsert }) }),
}));

import StudioSmsRegistrations, { type StudioSmsRegistrationRow } from "../StudioSmsRegistrations";
import { saveStudioSmsRegistrationAction } from "../actions";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const BU = `BU${"a1".repeat(16)}`;
const BN = `BN${"b2".repeat(16)}`;
const PN = `PN${"c3".repeat(16)}`;
const MG = `MG${"d4".repeat(16)}`;
const QE = `QE${"e5".repeat(16)}`;

function row(o: Partial<StudioSmsRegistrationRow> = {}): StudioSmsRegistrationRow {
  return {
    id: "r1",
    studio_id: STUDIO,
    customer_profile_sid: BU,
    brand_sid: BN,
    brand_status: "approved",
    messaging_service_sid: MG,
    campaign_sid: QE,
    campaign_status: "approved",
    campaign_use_case: "mixed",
    phone_number_sid: PN,
    sender_e164: "+15550100123",
    registration_status: "approved",
    approved_at: null,
    review_note: null,
    updated_at: "2026-10-09T00:00:00Z",
    ...o,
  };
}

function render(rows: StudioSmsRegistrationRow[], error: string | null = null) {
  return renderToStaticMarkup(
    createElement(StudioSmsRegistrations, {
      studios: [{ id: STUDIO, name: "ConfiDance Studio" }],
      registrations: rows,
      notice: false,
      error,
    }),
  );
}

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

const validForm = {
  studioId: STUDIO,
  registrationStatus: "approved",
  customerProfileSid: BU,
  brandSid: BN,
  brandStatus: "approved",
  messagingServiceSid: MG,
  campaignSid: QE,
  campaignStatus: "approved",
  campaignUseCase: "mixed",
  phoneNumberSid: PN,
  senderE164: "+1 555 010 0123",
};

async function redirectOf(values: Record<string, string>) {
  try {
    await saveStudioSmsRegistrationAction(form(values));
  } catch (e) {
    return decodeURIComponent(String((e as Error).message)).replace(/\+/g, " ");
  }
  return "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue(undefined);
  mocks.upsert.mockResolvedValue({ error: null });
});

describe("registration list rendering", () => {
  it("shows new metadata, statuses and ready wording for an existing row", () => {
    const html = render([row()]);
    for (const needle of [BU, BN, PN, MG, QE, "+15550100123", "Brand status", "Campaign status", "Mixed", "Approved / ready", "App sending enabled"]) {
      expect(html).toContain(needle);
    }
    expect(html).toContain('name="customerProfileSid"');
    expect(html).toContain('name="phoneNumberSid"');
  });

  it("loads a legacy-shaped row (no TW-3 metadata) without crashing and lists what is missing", () => {
    const html = render([
      row({
        customer_profile_sid: null,
        brand_sid: null,
        phone_number_sid: null,
        campaign_use_case: null,
        brand_status: undefined as never,
        campaign_status: undefined as never,
        registration_status: "in_review",
      }),
    ]);
    expect(html).toContain("Waiting for review");
    expect(html).toContain("App sending blocked");
    expect(html).toContain("Customer Profile SID");
  });

  it("incomplete approved row lists missing items and is blocked", () => {
    const html = render([row({ campaign_sid: null })]);
    expect(html).toContain("Setup incomplete");
    expect(html).toContain("Missing: Campaign SID");
    expect(html).toContain("App sending blocked");
  });

  it("rejected row shows action-needed wording; suspended shows blocked", () => {
    expect(render([row({ registration_status: "rejected" })])).toContain("Action needed");
    expect(render([row({ registration_status: "rejected" })])).toMatch(/resubmit/i);
    expect(render([row({ registration_status: "suspended" })])).toContain("Suspended / blocked");
  });

  it("offers only the supported use case and renders no secrets", () => {
    const html = render([row()]);
    expect(html.match(/<option value="mixed"/g)?.length).toBeGreaterThan(0);
    expect(html).not.toMatch(/value="(marketing|promotional|low_volume)"/);
    const names = [...html.matchAll(/name="([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(names.filter((n) => /token|secret|password|key|accountSid/i.test(n))).toEqual([]);
    expect(html).not.toContain("TWILIO_AUTH");
    expect(html).not.toMatch(/name="(authToken|apiSecret|accountSid)"/);
  });
});

describe("save action", () => {
  it("is guarded by the platform-admin check before anything is written", async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(saveStudioSmsRegistrationAction(form(validForm))).rejects.toThrow("FORBIDDEN");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("stores every TW-3 field on a valid approved registration", async () => {
    expect(await redirectOf(validForm)).toContain("registration=saved");
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert.mock.calls[0][0]).toMatchObject({
      studio_id: STUDIO,
      registration_status: "approved",
      customer_profile_sid: BU,
      brand_sid: BN,
      brand_status: "approved",
      messaging_service_sid: MG,
      campaign_sid: QE,
      campaign_status: "approved",
      campaign_use_case: "mixed",
      phone_number_sid: PN,
      sender_e164: "+15550100123",
    });
    expect(Object.keys(mocks.upsert.mock.calls[0][0]).join(" ")).not.toMatch(/token|secret|password/i);
  });

  it("saves a draft with blank optional metadata and not_started defaults", async () => {
    await redirectOf({ studioId: STUDIO, registrationStatus: "not_registered" });
    expect(mocks.upsert.mock.calls[0][0]).toMatchObject({
      brand_status: "not_started",
      campaign_status: "not_started",
      campaign_use_case: null,
      customer_profile_sid: null,
      brand_sid: null,
      phone_number_sid: null,
    });
  });

  it.each([
    ["Customer Profile", { customerProfileSid: BN }],
    ["Brand", { brandSid: BU }],
    ["Phone Number", { phoneNumberSid: MG }],
  ])("rejects a wrong-type %s SID", async (_label, patch) => {
    const out = await redirectOf({ ...validForm, ...patch });
    expect(out).toContain("registration_error");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects an unsupported use case and an invalid status", async () => {
    expect(await redirectOf({ ...validForm, campaignUseCase: "marketing" })).toContain("registration_error");
    expect(await redirectOf({ ...validForm, brandStatus: "live" })).toContain("registration_error");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["Campaign SID", { campaignSid: "" }],
    ["Messaging Service SID", { messagingServiceSid: "" }],
    ["Sender number", { senderE164: "", phoneNumberSid: "" }],
    ["Brand status approved", { brandStatus: "in_review" }],
    ["Campaign status approved", { campaignStatus: "in_review" }],
    ["without a use case", { campaignUseCase: "" }],
  ])("refuses approved when %s is missing", async (item, patch) => {
    const out = await redirectOf({ ...validForm, ...patch });
    expect(out).toContain("registration_error");
    expect(out).toContain(item);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses component approval without its SID even when the aggregate is in review", async () => {
    const out = await redirectOf({ ...validForm, registrationStatus: "in_review", campaignSid: "" });
    expect(out).toContain("Campaign status cannot be approved without a Campaign SID");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("only the platform page and action write the table (source scan)", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "platform", "sms", "actions.ts"), "utf8");
    expect(src).toContain("await requirePlatformAdmin();");
    expect(src.indexOf("requirePlatformAdmin()")).toBeLessThan(src.indexOf("createClient()"));
  });
});
