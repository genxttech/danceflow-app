import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type Result = { data: unknown; error: { code?: string; message?: string } | null };
let userResults: Record<string, Result> = {};
let adminResult: Result = { data: null, error: null };

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  getCurrentUserStudioContext: async () => ({
    supabase: { rpc: async (fn: string) => userResults[fn] ?? { data: null, error: null } },
    user: { id: "a5700000-0000-0000-0000-000000000101" }, studioId: "a5700000-0000-0000-0000-00000000000a", studioRole: "studio_owner", isPlatformAdmin: false,
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => adminResult }) }));

import { saveSmsSetupAction, submitSmsSetupAction } from "../actions";
import SmsSetupWizard from "../SmsSetupWizard";
import { friendlyOnboardingError } from "@/lib/sms/onboarding/client";
import { emptyDraft, validateDraftFields } from "@/lib/sms/onboarding/fields";
import { problemsByStep, submitBlockReason, wizardKey } from "@/lib/sms/onboarding/wizardState";

const MIGRATION = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/20261119090000_twilio_tw4a_sms_onboarding.sql"), "utf8").replace(/\r/g, "");
const ATTESTED = { attest_authorized: "on", attest_accurate: "on", attest_opt_in_only: "on", attest_fees_terms: "on" };
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

beforeEach(() => {
  userResults = {};
  adminResult = { data: null, error: null };
  process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SMS_EIN_ENCRYPTION_KEY;
});

describe("the pilot defect: submitting before anything was saved", () => {
  it("is the refusal the database raises when there is no draft", () => {
    expect(MIGRATION).toMatch(/raise exception 'there is no setup to submit' using errcode = '22023'/);
  });
  it("says to save first and never points at highlighted fields", async () => {
    userResults.submit_sms_onboarding = { data: null, error: { code: "22023", message: "there is no setup to submit" } };
    const result = await submitSmsSetupAction({}, form(ATTESTED));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Nothing has been saved yet.*Save draft/);
    expect(result.error).not.toMatch(/highlighted/i);
  });
  it("no refusal that names no field asks the owner to look for highlights", () => {
    for (const [code, message] of [["22023", "every attestation must be accepted"], ["22023", "anything else"], ["23514", "invalid value (check)"], ["XX000", "boom"]]) {
      const error = friendlyOnboardingError({ code, message });
      expect(error.field).toBeUndefined();
      expect(error.friendly).not.toMatch(/highlighted/i);
    }
  });
});

describe("a database check names its field", () => {
  const table = MIGRATION.slice(MIGRATION.indexOf("create table public.studio_sms_onboarding ("), MIGRATION.indexOf("create unique index studio_sms_onboarding_one_active"));
  const checked = [...table.matchAll(/^ {2}([a-z0-9_]+) [^\n]*\bcheck \(/gm)].map((match) => match[1]);
  const ownerColumns = checked.filter((column) => /^(legal_name|entity_type|industry|website_|address_line|city|region|postal_code|rep_|preferred_area_code)/.test(column));

  it("covers every owner-entered column that has a check", () => {
    expect(ownerColumns.length).toBeGreaterThanOrEqual(15);
    for (const column of ownerColumns) expect(friendlyOnboardingError({ code: "23514", message: `invalid value (studio_sms_onboarding_${column}_check)` }).field).toBe(column);
  });
  it("maps the EIN and website pair constraints", () => {
    for (const name of ["ein_last4_check", "ein_ciphertext_check", "ein_key_id_check", "ein_pair"]) expect(friendlyOnboardingError({ code: "23514", message: `invalid value (studio_sms_onboarding_${name})` }).field).toBe("ein");
    expect(friendlyOnboardingError({ code: "23514", message: "invalid value (studio_sms_onboarding_website_pair)" }).field).toBe("website_url");
  });
  it("highlights that field on save, keeps what was typed, and leaks no database text", async () => {
    userResults.save_sms_onboarding_draft = { data: null, error: { code: "23514", message: "invalid value (studio_sms_onboarding_rep_email_check) SECRET" } };
    const result = await saveSmsSetupAction({}, form({ city: "Salem", rep_email: "pat@example.com", ein: "98-7654321" }));
    expect(Object.keys(result.fieldErrors ?? {})).toEqual(["rep_email"]);
    expect(result.values).toMatchObject({ city: "Salem", rep_email: "pat@example.com" });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|studio_sms|987654321|98-7654321/);
  });
  it("an EIN that could not be stored is highlighted, says the rest was saved, and never echoes digits", async () => {
    userResults.save_sms_onboarding_draft = { data: { state: "draft", missing: ["ein"] }, error: null };
    adminResult = { data: null, error: { code: "XX000", message: "boom 987654321" } };
    const result = await saveSmsSetupAction({}, form({ city: "Salem", ein: "98-7654321" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/other details were saved, but the EIN was not/);
    expect(result.fieldErrors?.ein).toBeTruthy();
    expect(JSON.stringify(result)).not.toMatch(/987654321|98-7654321/);
  });
});

describe("problems on earlier screens", () => {
  it("are named by screen and field", async () => {
    userResults.submit_sms_onboarding = { data: { submitted: false, missing: ["rep_phone", "ein", "legal_name"], state: "draft" }, error: null };
    const result = await submitSmsSetupAction({}, form(ATTESTED));
    expect(result.error).toBe("Nothing was submitted. Still needed: Business: Legal business name, EIN. Representative: Mobile number.");
  });
  it("group in screen order and ignore unknown or repeated keys", () => {
    expect(problemsByStep(["preferred_area_code", "city", "city", "nope"]).map((group) => [group.step, group.fields.map((field) => field.key)])).toEqual([[0, ["city"]], [2, ["preferred_area_code"]]]);
  });
});

describe("submitting only what is saved", () => {
  const campaign = { description: "d", samples: ["s"], termsUrl: "/t", privacyUrl: "/p", optInPageUrl: "/o" };
  const render = (hasSavedDraft: boolean) => renderToStaticMarkup(createElement(SmsSetupWizard, { initial: emptyDraft(), hasSavedDraft, einOnFile: false, einLast4: null, canEdit: true, highlightFields: [], campaign }));
  const submitButton = (html: string) => html.match(/<button[^>]*>Submit for review<\/button>/)?.[0] ?? "";

  it("is blocked with a reason until a draft exists, with a save button wired to the draft form", () => {
    const html = render(false);
    expect(submitButton(html)).toContain('disabled=""');
    expect(html).toContain("Nothing is saved yet");
    expect(html).toContain('form="sms-setup-draft"');
    expect(html).toContain('id="sms-setup-draft"');
  });
  it("is available once a draft is saved", () => {
    expect(submitButton(render(true))).not.toContain('disabled=""');
  });
  it("is blocked again by unsaved changes", () => {
    expect(submitBlockReason({ hasSavedDraft: true, unsaved: true })).toMatch(/not saved/);
    expect(submitBlockReason({ hasSavedDraft: true, unsaved: false })).toBeNull();
  });
  it("the first save does not remount the wizard", () => {
    expect(wizardKey("not_started")).toBe(wizardKey("draft"));
    expect(wizardKey("needs_info")).not.toBe(wizardKey("draft"));
  });
});

describe("app validation never passes a value the database refuses", () => {
  const pattern = (column: string) => new RegExp(MIGRATION.match(new RegExp(`${column} ~ '([^']+)'`))![1]);
  it("a capitalized scheme is normalized", () => {
    const { fields, errors } = validateDraftFields({ website_url: "Https://www.example.com" });
    expect(errors.website_url).toBeUndefined();
    expect(fields.website_url).toBe("https://www.example.com");
    expect(fields.website_url).toMatch(pattern("website_url"));
  });
  it("an over-long email and a phone the database cannot hold are field errors", () => {
    expect(validateDraftFields({ rep_email: `${"a".repeat(250)}@x.co` }).errors.rep_email).toBeTruthy();
    expect(validateDraftFields({ rep_phone: "+012345678901" }).errors.rep_phone).toBeTruthy();
  });
  it("accepted phone formats satisfy the database pattern", () => {
    for (const input of ["(503) 555-0123", "503.555.0123", "1 503 555 0123", "+15035550123"]) expect(validateDraftFields({ rep_phone: input }).fields.rep_phone).toMatch(pattern("rep_phone"));
  });
});
