import { randomBytes } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Onboarding acceptance flows through the real server actions, with an in-memory stand-in that refuses what the TW-4A functions refuse
 * (the same flows run against a real schema in lib/sms/onboarding/__tests__/localStack.onboardingFlow.test.ts). Synthetic data only.
 */
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const REQUIRED = ["legal_name", "entity_type", "industry", "ein", "address_line1", "city", "region", "postal_code", "website_choice", "rep_first_name", "rep_last_name", "rep_title", "rep_position", "rep_email", "rep_phone"];
let record: null | { state: string; seq: number; fields: Record<string, string>; ein: boolean };
let calls: string[];
const missing = () => REQUIRED.filter((key) => (key === "ein" ? !record?.ein : !record?.fields[key]));
const refuse = (message: string) => ({ data: null, error: { code: "22023", message } });
const editable = () => !record || record.state === "draft" || record.state === "needs_info";

async function rpc(fn: string, args: Record<string, unknown>) {
  await Promise.resolve();
  calls.push(fn);
  if (fn === "save_sms_onboarding_draft") {
    if (!editable()) return refuse("the setup is already submitted and cannot be edited");
    record ??= { state: "draft", seq: 0, fields: {}, ein: false };
    Object.assign(record.fields, args.p_fields);
    return { data: { state: record.state, missing: missing() }, error: null };
  }
  if (fn === "store_sms_onboarding_ein") {
    if (!editable()) return refuse("the setup is already submitted and cannot be edited");
    record ??= { state: "draft", seq: 0, fields: {}, ein: false };
    record.ein = true;
    return { data: null, error: null };
  }
  if (fn === "submit_sms_onboarding") {
    if (!record) return refuse("there is no setup to submit");
    if (!editable()) return refuse("the setup is already submitted");
    if (missing().length) return { data: { submitted: false, missing: missing(), state: record.state }, error: null };
    record.state = "submitted_for_checks";
    record.seq += 1;
    return { data: { submitted: true, missing: [], state: record.state }, error: null };
  }
  return { data: null, error: null };
}
let role = "studio_owner";
let contextFails = false;
vi.mock("@/lib/auth/serverRoleGuard", () => ({ getCurrentUserStudioContext: async () => {
  if (contextFails) throw new Error("synthetic transient failure");
  return { supabase: { rpc }, user: { id: "u" }, studioId: "s", studioRole: role, isPlatformAdmin: false };
} }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));

import { smsSetupAction, type SmsSetupState } from "../actions";
import SmsSetupWizard from "../SmsSetupWizard";
import { emptyDraft } from "@/lib/sms/onboarding/fields";
import { wizardKey } from "@/lib/sms/onboarding/wizardState";
import { buildJourney, type FinanceFacts, type JourneyInput } from "@/lib/sms/provisioning/journey";

const FIELDS: Record<string, string> = {
  legal_name: "Synthetic Studio LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: "",
  address_line1: "1 Synthetic Way", address_line2: "", city: "Salem", region: "OR", postal_code: "97301",
  rep_first_name: "Test", rep_last_name: "Person", rep_title: "Owner", rep_position: "ceo", rep_email: "test@synthetic.example",
  rep_phone: "5035550100", preferred_area_code: "503",
};
const ATTEST = { attest_authorized: "on", attest_accurate: "on", attest_opt_in_only: "on", attest_fees_terms: "on" };
const press = (intent: "save" | "submit", values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ ...values, intent })) data.set(key, value);
  return smsSetupAction({} as SmsSetupState, data);
};
const noEin = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/987654321|98-7654321/);

beforeEach(() => {
  record = null;
  calls = [];
  role = "studio_owner";
  contextFails = false;
  process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterEach(() => {
  delete process.env.SMS_EIN_ENCRYPTION_KEY;
});

describe("first-time registration (single location or independent instructor: the same path)", () => {
  it("submits directly, without a manual save: saved first, then submitted once", async () => {
    const result = await press("submit", { ...FIELDS, ein: "98-7654321", ...ATTEST });
    expect(result).toMatchObject({ ok: true, intent: "submit" });
    expect(calls).toEqual(["save_sms_onboarding_draft", "store_sms_onboarding_ein", "submit_sms_onboarding"]);
    expect(record).toMatchObject({ state: "submitted_for_checks", seq: 1 });
    noEin(result);
  });
  it("submits what is on screen, not an older saved copy", async () => {
    await press("save", { ...FIELDS, ein: "98-7654321" });
    await press("submit", { ...FIELDS, city: "Portland", ...ATTEST });
    expect(record).toMatchObject({ state: "submitted_for_checks", fields: { city: "Portland" } });
  });
});

describe("save and finish later", () => {
  it("keeps a partial draft, lists what is still needed, and submits after the rest is added without retyping the EIN", async () => {
    const saved = await press("save", { ...FIELDS, rep_title: "", ein: "98-7654321" });
    expect(saved).toMatchObject({ ok: true, intent: "save", missing: ["rep_title"] });
    expect(record?.state).toBe("draft");
    expect(await press("submit", { ...FIELDS, ...ATTEST })).toMatchObject({ ok: true });
    expect(record?.state).toBe("submitted_for_checks");
  });
  it("resumes with the saved values, the EIN shown only as on file, and the wizard not remounted by the first save", () => {
    const html = renderToStaticMarkup(createElement(SmsSetupWizard, { initial: { ...emptyDraft(), ...FIELDS }, hasSavedDraft: true, einOnFile: true, einLast4: "4321", canEdit: true, isOwner: true, highlightFields: [], campaign: { description: "d", samples: ["s"], termsUrl: "/t", privacyUrl: "/p", optInPageUrl: "/o" } }));
    expect(html).toContain("1 Synthetic Way");
    expect(html).toContain("On file, ending 4321");
    expect(wizardKey("not_started")).toBe(wizardKey("draft"));
    // "Save draft" is the first submit button, so Enter in a field never submits
    expect(html.indexOf('value="save"')).toBeGreaterThan(0);
    expect(html.indexOf('value="save"')).toBeLessThan(html.indexOf('value="submit"'));
    expect(html.match(/<form/g)).toHaveLength(1);
  });
});

describe("invalid and missing information", () => {
  it("an invalid value on an earlier screen writes and submits nothing, names the field and keeps what was typed", async () => {
    const result = await press("submit", { ...FIELDS, rep_phone: "12", ein: "98-7654321", ...ATTEST });
    expect(result.ok).toBe(false);
    expect(Object.keys(result.fieldErrors ?? {}).sort()).toEqual(["ein", "rep_phone"]);
    expect(result.error).toMatch(/^Nothing was submitted\. Check the highlighted fields/);
    expect(result.values?.city).toBe("Salem");
    expect(calls).toEqual([]);
    noEin(result);
  });
  it("missing required fields are saved, not submitted, and named by screen", async () => {
    const result = await press("submit", { ...FIELDS, legal_name: "", rep_email: "", ein: "98-7654321", ...ATTEST });
    expect(result).toMatchObject({ ok: false, intent: "submit", missing: ["legal_name", "rep_email"] });
    expect(result.error).toBe("Nothing was submitted. Still needed: Business: Legal business name. Representative: Business email.");
    expect(record?.state).toBe("draft");
  });
  it("an unticked statement keeps the details saved and never submits", async () => {
    const result = await press("submit", { ...FIELDS, ein: "98-7654321", ...ATTEST, attest_accurate: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/details are saved, but nothing was submitted/);
    expect(calls).not.toContain("submit_sms_onboarding");
    expect(record?.state).toBe("draft");
  });
});

describe("duplicates and roles", () => {
  it("two simultaneous submissions produce one submission and one clear answer", async () => {
    const results = await Promise.all([press("submit", { ...FIELDS, ein: "98-7654321", ...ATTEST }), press("submit", { ...FIELDS, ein: "98-7654321", ...ATTEST })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.error).toMatch(/already (been )?submitted/);
    expect(record?.seq).toBe(1);
  });
  it("a later repeat changes nothing", async () => {
    await press("submit", { ...FIELDS, ein: "98-7654321", ...ATTEST });
    const again = await press("submit", { ...FIELDS, city: "Portland", ...ATTEST });
    expect(again.error).toBe("This setup was already submitted. Nothing in this window was changed.");
    expect(record).toMatchObject({ seq: 1, fields: { city: "Salem" } });
  });
  it("anyone but the owner is refused before any database call", async () => {
    role = "studio_admin";
    expect((await press("submit", { ...FIELDS, ...ATTEST })).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("after submission: who acts next", () => {
  const finance = (over: Partial<FinanceFacts> = {}): FinanceFacts => ({ legalBusiness: false, availableCents: 0, onHold: false, pilotBusiness: false, campaignMonthlyKind: null, hasActiveAuthorization: false, prices: [], purchasesOpen: false, authorizationOpen: false, ...over });
  const input = (over: Partial<JourneyInput> = {}): JourneyInput => ({ state: "submitted_for_checks", textingOn: false, paused: false, isOwner: true, finance: finance(), provisioning: null, canEditForm: false, ...over });

  it("a first-time studio without a business record is waiting for DanceFlow, not on hold", () => {
    for (const state of ["submitted_for_checks", "profile_review"] as const) {
      const { next, stages } = buildJourney(input({ state }));
      expect(next).toMatchObject({ stage: "eligibility", kind: "waiting", cta: null });
      expect(next.detail).toMatch(/do not need to do anything/);
      expect(stages.find((s) => s.key === "approvals")?.status).toBe("upcoming");
      expect(JSON.stringify(stages)).not.toMatch(/not linked|cannot be approved/i);
      expect(stages.filter((s) => s.status === "done").map((s) => s.key)).toEqual(["business"]);
    }
  });
  it("no fee can be acted on before the business record exists, in any state", () => {
    for (const state of ["draft", "submitted_for_checks", "brand_pending", "service_setup"] as const) {
      const { next, stages } = buildJourney(input({ state, finance: finance({ purchasesOpen: true, authorizationOpen: true }) }));
      expect(next.stage === "approvals" && next.kind === "owner").toBe(false);
      expect(["done", "current"]).not.toContain(stages.find((s) => s.key === "approvals")?.status);
    }
  });
  it("once the business record exists the review continues and fees still wait their turn", () => {
    const { next } = buildJourney(input({ finance: finance({ legalBusiness: true, pilotBusiness: true }) }));
    expect(next).toMatchObject({ stage: "eligibility", kind: "waiting" });
  });
});

describe("a replacement EIN is never dropped silently", () => {
  const onFile = async () => {
    await press("save", { ...FIELDS, ein: "98-7654321" });
    calls = [];
  };
  const NEW = { ein: "12-3456789" };

  it("another field's refusal marks the typed EIN unsaved on the EIN field", async () => {
    await onFile();
    const result = await press("submit", { ...FIELDS, ...NEW, postal_code: "9720", ...ATTEST });
    expect(result).toMatchObject({ ok: false, einUnsaved: true });
    expect(Object.keys(result.fieldErrors ?? {}).sort()).toEqual(["ein", "postal_code"]);
    expect(calls).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/123456789|12-3456789/);
  });
  it("submitting afterwards without retyping it is refused, so the old EIN is not submitted", async () => {
    await onFile();
    const result = await press("submit", { ...FIELDS, ein: "", ein_unsaved: "1", ...ATTEST });
    expect(result).toMatchObject({ ok: false, einUnsaved: true });
    expect(result.error).toMatch(/nothing was submitted/);
    expect(calls).not.toContain("submit_sms_onboarding");
    expect(record?.state).toBe("draft");
  });
  it("a failure before anything is written keeps the typed EIN marked unsaved, on submit and on save", async () => {
    await onFile();
    contextFails = true;
    for (const intent of ["submit", "save"] as const) {
      const result = await press(intent, { ...FIELDS, ...NEW, ...ATTEST });
      expect(result).toMatchObject({ ok: false, intent, einUnsaved: true });
      expect(result.fieldErrors?.ein).toBeTruthy();
      expect(JSON.stringify(result)).not.toMatch(/123456789|12-3456789/);
    }
    expect(calls).toEqual([]);
  });
  it("a save in between keeps asking", async () => {
    await onFile();
    expect(await press("save", { ...FIELDS, ein: "", ein_unsaved: "1" })).toMatchObject({ ok: true, einUnsaved: true });
  });
  it("retyping it, or choosing to keep the one on file, submits", async () => {
    await onFile();
    expect(await press("submit", { ...FIELDS, ...NEW, ein_unsaved: "1", ...ATTEST })).toMatchObject({ ok: true });
    record = null;
    await onFile();
    expect(await press("submit", { ...FIELDS, ein: "", ein_unsaved: "1", keep_ein: "on", ...ATTEST })).toMatchObject({ ok: true });
  });
});
