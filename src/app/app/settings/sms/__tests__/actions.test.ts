import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type RpcCall = { fn: string; args: Record<string, unknown> };
const userCalls: RpcCall[] = [];
const adminCalls: RpcCall[] = [];
let userResults: Record<string, { data: unknown; error: { code?: string; message?: string } | null }> = {};
let adminResult: { data: unknown; error: { code?: string; message?: string } | null } = { data: null, error: null };
let adminCreated = 0;
let ctx: { supabase: unknown; user: { id: string }; studioId: string; studioRole: string | null; isPlatformAdmin: boolean };

vi.mock("@/lib/auth/serverRoleGuard", () => ({ getCurrentUserStudioContext: async () => ctx }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminCreated += 1;
    return { rpc: async (fn: string, args: Record<string, unknown>) => { adminCalls.push({ fn, args }); return adminResult; } };
  },
}));

import { cancelSmsSetupAction, saveSmsSetupAction, submitSmsSetupAction } from "../actions";
import { decryptEin } from "@/lib/sms/onboarding/ein";

const STUDIO = "a5700000-0000-0000-0000-00000000000a";
const OTHER = "a5700000-0000-0000-0000-00000000000b";
const OWNER = "a5700000-0000-0000-0000-000000000101";
const KEY = randomBytes(32).toString("base64");

const validFields: Record<string, string> = {
  legal_name: "Harbor Dance Studio LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: "",
  address_line1: "12 Harbor Way", address_line2: "", city: "Portland", region: "OR", postal_code: "97201",
  rep_first_name: "Pat", rep_last_name: "Morgan", rep_title: "Owner", rep_position: "ceo", rep_email: "pat@harbordance.example",
  rep_phone: "(503) 555-0123", preferred_area_code: "503",
};

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  userCalls.length = 0;
  adminCalls.length = 0;
  adminCreated = 0;
  adminResult = { data: null, error: null };
  userResults = {
    save_sms_onboarding_draft: { data: { state: "draft", missing: ["ein"] }, error: null },
    submit_sms_onboarding: { data: { submitted: true, missing: [], state: "submitted_for_checks" }, error: null },
    cancel_sms_onboarding: { data: { state: "cancelled" }, error: null },
  };
  ctx = {
    supabase: { rpc: async (fn: string, args: Record<string, unknown>) => { userCalls.push({ fn, args }); return userResults[fn] ?? { data: null, error: null }; } },
    user: { id: OWNER }, studioId: STUDIO, studioRole: "studio_owner", isPlatformAdmin: false,
  };
  process.env.SMS_EIN_ENCRYPTION_KEY = KEY;
  delete process.env.SMS_EIN_ENCRYPTION_KEY_ID;
  consoleSpies = (["log", "warn", "error", "info", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(() => {
  consoleSpies.forEach((spy) => spy.mockRestore());
  delete process.env.SMS_EIN_ENCRYPTION_KEY;
});

const loggedText = () => consoleSpies.flatMap((spy) => spy.mock.calls.map((call: unknown[]) => JSON.stringify(call))).join("\n");

describe("only the studio owner may change the setup", () => {
  it.each(["studio_admin", "front_desk", "instructor", "client", "platform_admin", "organizer_owner", null])("%s is refused before any database or admin call", async (role) => {
    ctx.studioRole = role;
    const results = [
      await saveSmsSetupAction({}, form({ ...validFields, ein: "12-3456789" })),
      await submitSmsSetupAction({}, form({ attest_authorized: "on", attest_accurate: "on", attest_opt_in_only: "on", attest_fees_terms: "on" })),
      await cancelSmsSetupAction(),
    ];
    for (const result of results) expect(result.ok).toBe(false);
    expect(userCalls).toEqual([]);
    expect(adminCalls).toEqual([]);
    expect(adminCreated).toBe(0);
  });
});

describe("save", () => {
  it("validation failures return field errors and write nothing", async () => {
    const result = await saveSmsSetupAction({}, form({ ...validFields, region: "Oregon", rep_phone: "12", ein: "98-7654321" }));
    expect(result.ok).toBe(false);
    expect(Object.keys(result.fieldErrors ?? {}).sort()).toEqual(["region", "rep_phone"]);
    expect(userCalls).toEqual([]);
    expect(adminCalls).toEqual([]);
  });
  it("a malformed EIN is refused with its own message and nothing is written", async () => {
    const result = await saveSmsSetupAction({}, form({ ...validFields, ein: "12-345" }));
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.ein).toMatch(/9-digit/);
    expect(userCalls).toEqual([]);
    expect(adminCalls).toEqual([]);
    expect(loggedText()).not.toContain("12-345");
  });
  it("a missing encryption key stops the save with a neutral message, logs only a code, and writes nothing", async () => {
    delete process.env.SMS_EIN_ENCRYPTION_KEY;
    const result = await saveSmsSetupAction({}, form({ ...validFields, ein: "98-7654321" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/temporarily unavailable/);
    expect(userCalls).toEqual([]);
    expect(adminCalls).toEqual([]);
    expect(loggedText()).toContain("sms_onboarding_ein_key_missing");
    expect(loggedText()).not.toMatch(/987654321|98-7654321/);
  });
  it("saves the normalized draft for the SESSION's studio, ignoring any studio id in the form, without touching the admin client when no EIN is entered", async () => {
    const result = await saveSmsSetupAction({}, form({ ...validFields, studio_id: OTHER, studioId: OTHER, state: "active" }));
    expect(result).toMatchObject({ ok: true });
    expect(userCalls).toHaveLength(1);
    expect(userCalls[0].fn).toBe("save_sms_onboarding_draft");
    expect(userCalls[0].args.p_studio_id).toBe(STUDIO);
    const fields = userCalls[0].args.p_fields as Record<string, string>;
    expect(fields.rep_phone).toBe("+15035550123");
    expect(Object.keys(fields)).not.toContain("studio_id");
    expect(Object.keys(fields)).not.toContain("state");
    expect(Object.keys(fields)).not.toContain("ein");
    expect(adminCreated).toBe(0);
    expect(result.missing).toEqual(["ein"]);
  });
  it("encrypts the EIN with the studio bound, hands only the ciphertext to the service-role RPC with the owner as actor, and never logs or returns the digits", async () => {
    const result = await saveSmsSetupAction({}, form({ ...validFields, ein: "98-7654321" }));
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(adminCalls).toHaveLength(1);
    const call = adminCalls[0];
    expect(call.fn).toBe("store_sms_onboarding_ein");
    expect(call.args).toMatchObject({ p_studio_id: STUDIO, p_actor: OWNER, p_key_id: "v1", p_last4: "4321" });
    const token = String(call.args.p_ciphertext);
    expect(token).not.toContain("987654321");
    expect(decryptEin(STUDIO, token)).toBe("987654321");
    expect(() => decryptEin(OTHER, token)).toThrow();
    expect(JSON.stringify([userCalls, adminCalls, result])).not.toMatch(/987654321|98-7654321/);
    expect(loggedText()).not.toMatch(/987654321|98-7654321/);
  });
  it("a database refusal is shown as friendly text without raw database detail", async () => {
    userResults.save_sms_onboarding_draft = { data: null, error: { code: "42501", message: "raw: not authorized for relation studio_sms_onboarding" } };
    const result = await saveSmsSetupAction({}, form(validFields));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("You do not have access to this setup.");
    expect(JSON.stringify(result)).not.toMatch(/relation|studio_sms_onboarding/);
  });
  it("if storing the EIN fails after the draft saved, the owner is told and the digits stay out of every message", async () => {
    adminResult = { data: null, error: { code: "22023", message: "the setup is already submitted" } };
    const result = await saveSmsSetupAction({}, form({ ...validFields, ein: "98-7654321" }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/987654321/);
  });
});

describe("partial posts", () => {
  it("only the posted fields are written, so a partial post cannot blank the rest of the draft", async () => {
    const result = await saveSmsSetupAction({}, form({ city: "Salem", rep_email: "Pat@Example.com" }));
    expect(result.ok).toBe(true);
    expect(userCalls[0].args.p_fields).toEqual({ city: "Salem", rep_email: "pat@example.com" });
  });
  it("a posted blank still clears that one field", async () => {
    await saveSmsSetupAction({}, form({ address_line2: "" }));
    expect(userCalls[0].args.p_fields).toEqual({ address_line2: "" });
  });
});

describe("a rejected save keeps what the owner typed (never the EIN)", () => {
  it("echoes the non-secret values on a validation failure", async () => {
    const result = await saveSmsSetupAction({}, form({ ...validFields, region: "Oregon", ein: "98-7654321" }));
    expect(result.ok).toBe(false);
    expect(result.values?.legal_name).toBe("Harbor Dance Studio LLC");
    expect(result.values?.rep_email).toBe("pat@harbordance.example");
    expect(Object.keys(result.values ?? {})).not.toContain("ein");
    expect(JSON.stringify(result)).not.toMatch(/987654321|98-7654321/);
  });
  it("echoes them on a database failure too, without raw database text", async () => {
    userResults.save_sms_onboarding_draft = { data: null, error: { code: "23514", message: 'Failing row contains (v1.SECRET) violates check "x"' } };
    const result = await saveSmsSetupAction({}, form({ ...validFields, ein: "98-7654321" }));
    expect(result.ok).toBe(false);
    expect(result.values?.city).toBe("Portland");
    expect(JSON.stringify(result)).not.toMatch(/SECRET|Failing row|987654321/);
  });
  it("a successful save does not echo values (the page reloads the saved draft)", async () => {
    expect((await saveSmsSetupAction({}, form(validFields))).values).toBeUndefined();
  });
});

describe("submit", () => {
  const all = { attest_authorized: "on", attest_accurate: "on", attest_opt_in_only: "on", attest_fees_terms: "on" };
  it("every statement must be accepted before anything is sent", async () => {
    for (const missing of Object.keys(all)) {
      const partial = { ...all } as Record<string, string>;
      delete partial[missing];
      const result = await submitSmsSetupAction({}, form(partial));
      expect(result.ok).toBe(false);
    }
    expect(userCalls).toEqual([]);
  });
  it("submits with the pinned attestation version for the session's studio", async () => {
    const result = await submitSmsSetupAction({}, form({ ...all, studioId: OTHER }));
    expect(result.ok).toBe(true);
    expect(userCalls).toEqual([
      { fn: "submit_sms_onboarding", args: { p_studio_id: STUDIO, p_attestation: { version: "tw4a-v1", authorized: true, accurate: true, opt_in_only: true, fees_terms: true } } },
    ]);
  });
  it("an unfinished form comes back as plain field names", async () => {
    userResults.submit_sms_onboarding = { data: { submitted: false, missing: ["ein", "rep_email"], state: "draft" }, error: null };
    const result = await submitSmsSetupAction({}, form(all));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("EIN");
    expect(result.error).toContain("Business email");
    expect(result.missing).toEqual(["ein", "rep_email"]);
  });
});

describe("cancel", () => {
  it("cancels the session studio's setup", async () => {
    expect(await cancelSmsSetupAction()).toMatchObject({ ok: true });
    expect(userCalls).toEqual([{ fn: "cancel_sms_onboarding", args: { p_studio_id: STUDIO } }]);
  });
  it("a refusal is friendly", async () => {
    userResults.cancel_sms_onboarding = { data: null, error: { code: "22023", message: "this setup can no longer be cancelled here" } };
    const result = await cancelSmsSetupAction();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
