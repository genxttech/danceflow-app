import { describe, expect, it, vi } from "vitest";
import {
  ATTESTATION_VERSION,
  OnboardingRpcError,
  cancelOnboarding,
  friendlyOnboardingError,
  getOnboardingDraft,
  getSmsLegalContext,
  getStudioSmsStatus,
  listOnboardings,
  parseOnboardingDraft,
  parseStudioSmsStatus,
  purgeDueEins,
  saveOnboardingDraft,
  setPilotAccess,
  storeEinCiphertext,
  submitOnboarding,
} from "@/lib/sms/onboarding/client";

const ok = (data: unknown) => ({ data, error: null });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stand-in for the Supabase client
const rpcWith = (result: unknown): any => ({ rpc: vi.fn(async () => result) });

describe("status parsing", () => {
  it("front desk and unflagged studios never get tracker data", () => {
    expect(parseStudioSmsStatus({ texting_on: true })).toEqual({ available: false, textingOn: true });
    expect(parseStudioSmsStatus({ available: false, texting_on: false })).toEqual({ available: false, textingOn: false });
    expect(parseStudioSmsStatus(null)).toEqual({ available: false, textingOn: false });
  });
  it("parses the full tracker for owner/admin", () => {
    const status = parseStudioSmsStatus({
      available: true, paused: false, texting_on: false, role: "studio_owner", can_edit: true, can_cancel: true, state: "needs_info", needs_info_fields: ["rep_email"], submitted_at: "2026-10-15T00:00:00Z", submission_seq: 2,
    });
    expect(status).toEqual({ available: true, textingOn: false, role: "studio_owner", paused: false, canEdit: true, canCancel: true, state: "needs_info", needsInfoFields: ["rep_email"], submittedAt: "2026-10-15T00:00:00Z", submissionSeq: 2 });
  });
  it("parses a paused setup (switch turned off after submission): read-only but cancellable, and tolerates an older database without the new keys", () => {
    const paused = parseStudioSmsStatus({ available: true, paused: true, texting_on: false, role: "studio_owner", can_edit: false, can_cancel: true, state: "submitted_for_checks", needs_info_fields: [], submitted_at: null, submission_seq: 1 });
    expect(paused).toMatchObject({ available: true, paused: true, canEdit: false, canCancel: true, state: "submitted_for_checks" });
    const legacy = parseStudioSmsStatus({ available: true, texting_on: false, role: "studio_owner", can_edit: true, state: "draft" });
    expect(legacy).toMatchObject({ available: true, paused: false, canCancel: false });
  });
});

describe("draft parsing", () => {
  it("returns every draft field as text, the last four only, and never a ciphertext", () => {
    const draft = parseOnboardingDraft({ state: "draft", legal_name: "Harbor", ein_last4: "6789", ein_on_file: true, missing: ["rep_email"], ein_ciphertext: "SHOULD-NOT-SURFACE" });
    expect(draft?.fields.legal_name).toBe("Harbor");
    expect(draft?.fields.rep_email).toBe("");
    expect(draft).toMatchObject({ einLast4: "6789", einOnFile: true, missing: ["rep_email"] });
    expect(JSON.stringify(draft)).not.toContain("SHOULD-NOT-SURFACE");
    expect(parseOnboardingDraft(null)).toBeNull();
  });
});

describe("errors are friendly and carry no raw database text", () => {
  it("maps codes", () => {
    expect(friendlyOnboardingError({ code: "42501", message: "nsi secret detail" }).friendly).toMatch(/access/);
    expect(friendlyOnboardingError({ code: "22023", message: "the setup is already submitted" }).friendly).toMatch(/can no longer be edited/);
    expect(friendlyOnboardingError({ code: "22023", message: "unsupported field x" }).friendly).toMatch(/not accepted/);
    expect(friendlyOnboardingError({ code: "23514", message: 'violates check "studio_sms_onboarding_x"' }).friendly).toMatch(/format/);
    for (const error of [friendlyOnboardingError({ code: "XX000", message: "boom 6789" }), friendlyOnboardingError(null)]) {
      expect(error.friendly).toBe("Something went wrong. Nothing was changed.");
      expect(error.friendly).not.toContain("6789");
    }
  });
});

describe("wrappers call exactly the intended RPCs with the intended arguments", () => {
  it("studio-facing calls", async () => {
    const status = rpcWith(ok({ available: true, role: "studio_owner", can_edit: true, state: "draft" }));
    await getStudioSmsStatus(status, "S1");
    expect(status.rpc).toHaveBeenCalledWith("get_studio_sms_status", { p_studio_id: "S1" });

    const draft = rpcWith(ok(null));
    expect(await getOnboardingDraft(draft, "S1")).toBeNull();
    expect(draft.rpc).toHaveBeenCalledWith("get_sms_onboarding_draft", { p_studio_id: "S1" });

    const save = rpcWith(ok({ state: "draft", missing: ["ein"] }));
    expect(await saveOnboardingDraft(save, "S1", { city: "Salem" })).toEqual({ state: "draft", missing: ["ein"] });
    expect(save.rpc).toHaveBeenCalledWith("save_sms_onboarding_draft", { p_studio_id: "S1", p_fields: { city: "Salem" } });

    const submit = rpcWith(ok({ submitted: true, missing: [], state: "submitted_for_checks" }));
    const attestation = { authorized: true, accurate: true, opt_in_only: true, fees_terms: true };
    expect((await submitOnboarding(submit, "S1", attestation)).submitted).toBe(true);
    expect(submit.rpc).toHaveBeenCalledWith("submit_sms_onboarding", { p_studio_id: "S1", p_attestation: { version: ATTESTATION_VERSION, ...attestation } });

    const cancel = rpcWith(ok({ state: "cancelled" }));
    expect(await cancelOnboarding(cancel, "S1")).toEqual({ state: "cancelled" });
    expect(cancel.rpc).toHaveBeenCalledWith("cancel_sms_onboarding", { p_studio_id: "S1" });
  });
  it("service-role calls never receive a clear EIN", async () => {
    const store = rpcWith(ok(null));
    await storeEinCiphertext(store, { studioId: "S1", actorUserId: "U1", ciphertext: "v1.a.b.c", keyId: "v1", last4: "6789" });
    expect(store.rpc).toHaveBeenCalledWith("store_sms_onboarding_ein", { p_studio_id: "S1", p_actor: "U1", p_ciphertext: "v1.a.b.c", p_key_id: "v1", p_last4: "6789" });
    expect(JSON.stringify(store.rpc.mock.calls)).not.toContain("123456789");

    const purge = rpcWith(ok(3));
    expect(await purgeDueEins(purge)).toBe(3);
    const legal = rpcWith(ok({ display_name: "Harbor", legal_name: null }));
    expect(await getSmsLegalContext(legal, "harbor")).toEqual({ displayName: "Harbor", legalName: null });
    expect(legal.rpc).toHaveBeenCalledWith("get_sms_legal_context", { p_studio_slug: "harbor" });
    expect(await getSmsLegalContext(rpcWith(ok(null)), "nope")).toBeNull();
  });
  it("platform calls", async () => {
    const list = rpcWith(ok([{ studio_id: "S1", studio_name: "Harbor", access_enabled: true, state: "draft", submission_seq: 0, submitted_at: null, updated_at: "t", ein_stored: true }]));
    expect(await listOnboardings(list)).toEqual([{ studioId: "S1", studioName: "Harbor", accessEnabled: true, state: "draft", submissionSeq: 0, submittedAt: null, updatedAt: "t", einStored: true }]);
    const access = rpcWith(ok(null));
    await setPilotAccess(access, "S1", true, "pilot");
    expect(access.rpc).toHaveBeenCalledWith("set_sms_onboarding_access", { p_studio_id: "S1", p_enabled: true, p_reason: "pilot" });
  });
  it("an RPC error becomes an OnboardingRpcError", async () => {
    await expect(getStudioSmsStatus(rpcWith({ data: null, error: { code: "42501", message: "x" } }), "S1")).rejects.toBeInstanceOf(OnboardingRpcError);
  });
});
