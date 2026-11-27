"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUserStudioContext } from "@/lib/auth/serverRoleGuard";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ALREADY_SUBMITTED,
  cancelOnboarding,
  friendlyOnboardingError,
  OnboardingRpcError,
  saveOnboardingDraft,
  storeEinCiphertext,
  submitOnboarding,
} from "@/lib/sms/onboarding/client";
import { EinCryptoError, einEncryptionConfigured, encryptEin } from "@/lib/sms/onboarding/ein";
import { describeProblems } from "@/lib/sms/onboarding/wizardState";
import { DRAFT_FIELD_KEYS, normalizeEin, validateDraftFields, type DraftFieldKey, type WizardFieldKey } from "@/lib/sms/onboarding/fields";

/**
 * TW-4A server actions for Settings -> Texting. Owner only (the database re-checks the role and the pilot flag on every call).
 * No action talks to Twilio. The EIN is validated, encrypted here with the environment key, and stored through a service-role
 * RPC that re-verifies the actor is an active owner; the clear value is never logged, returned, or placed in an error.
 */

export type SmsSetupState = {
  ok?: boolean;
  /** Which button produced this result. */
  intent?: "save" | "submit";
  error?: string;
  notice?: string;
  fieldErrors?: Partial<Record<WizardFieldKey, string>>;
  /** NON-SECRET field values: what was typed (a failed save) or what was written (a successful one), so the form shows it. Never the EIN. */
  values?: Partial<Record<DraftFieldKey, string>>;
  warnings?: Partial<Record<WizardFieldKey, string>>;
  missing?: string[];
};

const PATH = "/app/settings/sms";

async function ownerContext() {
  const ctx = await getCurrentUserStudioContext();
  if (ctx.studioRole !== "studio_owner") {
    throw new OnboardingRpcError("42501", "Only the studio owner can set up texting.");
  }
  return ctx;
}

function failure(error: unknown): SmsSetupState {
  if (error instanceof OnboardingRpcError) {
    if (!error.field) return { ok: false, error: error.friendly };
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: { [error.field]: "This value was not accepted. Correct it and click Save draft." } };
  }
  if (error instanceof EinCryptoError) {
    // Operational problem on our side; the code is safe to log, the studio gets a neutral message.
    console.warn(`sms_onboarding_ein_${error.code}`);
    return { ok: false, error: "Texting setup is temporarily unavailable. DanceFlow has been notified; please try again later." };
  }
  return { ok: false, error: "Something went wrong. Nothing was changed." };
}

function formText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

type OwnerContext = Awaited<ReturnType<typeof ownerContext>>;

const typedValues = (formData: FormData) =>
  Object.fromEntries(DRAFT_FIELD_KEYS.filter((key) => formData.has(key)).map((key) => [key, formText(formData, key)])) as Partial<Record<DraftFieldKey, string>>;

/** Validates the posted fields and writes them (and a typed EIN) to the draft. Used by both buttons, so what is submitted is what was on screen. */
async function persistDraft(ctx: OwnerContext, formData: FormData): Promise<SmsSetupState> {
  const input: Record<string, string> = {};
  for (const key of DRAFT_FIELD_KEYS) input[key] = formText(formData, key);
  const values = { ...input } as Partial<Record<DraftFieldKey, string>>;
  try {
    const { fields, errors, warnings } = validateDraftFields(input);
    const fieldErrors: SmsSetupState["fieldErrors"] = { ...errors };

    const einInput = formText(formData, "ein").trim();
    let ein: ReturnType<typeof normalizeEin> | null = null;
    if (einInput) {
      ein = normalizeEin(einInput);
      if (!ein.ok) fieldErrors.ein = ein.error;
      else if (!einEncryptionConfigured()) {
        console.warn("sms_onboarding_ein_key_missing");
        return { ok: false, error: "Texting setup is temporarily unavailable. DanceFlow has been notified; please try again later.", values };
      }
    }
    if (Object.keys(fieldErrors).length > 0) {
      return { ok: false, error: "Check the highlighted fields.", fieldErrors, warnings, values };
    }

    // Only fields that were actually posted are written: a partial post never blanks the rest of the saved draft.
    const posted = Object.fromEntries(DRAFT_FIELD_KEYS.filter((key) => formData.has(key)).map((key) => [key, fields[key]])) as Partial<Record<DraftFieldKey, string>>;
    const saved = await saveOnboardingDraft(ctx.supabase, ctx.studioId, posted);
    let missing = saved.missing;
    if (ein && ein.ok) {
      try {
        const encrypted = encryptEin(ctx.studioId, { digits: ein.digits, last4: ein.last4 });
        await storeEinCiphertext(createAdminClient(), {
          studioId: ctx.studioId,
          actorUserId: ctx.user.id,
          ciphertext: encrypted.ciphertext,
          keyId: encrypted.keyId,
          last4: encrypted.last4,
        });
      } catch (error) {
        const refused = failure(error); // also logs the safe code for an encryption problem
        revalidatePath(PATH);
        if (refused.error === ALREADY_SUBMITTED) return { ...refused, values };
        return {
          ok: false,
          error: "Your other details were saved, but the EIN was not. If it fails again, contact DanceFlow support and do not send your EIN.",
          fieldErrors: { ein: "Not saved. Type the EIN again and try again." },
          values,
        };
      }
      missing = missing.filter((key) => key !== "ein");
    }
    revalidatePath(PATH);
    return { ok: true, notice: "Saved.", warnings, missing, values: posted };
  } catch (error) {
    return { ...failure(error), values };
  }
}

/** Optional: keep the answers and finish later. */
export async function saveSmsSetupAction(_previous: SmsSetupState, formData: FormData): Promise<SmsSetupState> {
  try {
    return { ...(await persistDraft(await ownerContext(), formData)), intent: "save" };
  } catch (error) {
    return { ...failure(error), intent: "save", values: typedValues(formData) };
  }
}

const alreadySubmitted = (): SmsSetupState => ({ ok: false, intent: "submit", error: "This setup was already submitted. Nothing in this window was changed." });

/**
 * Saves what is on screen, then submits it. Nothing is submitted unless the save succeeded, every statement is ticked and the database finds
 * no required field empty. The database allows one submission per setup, so a repeated request changes nothing.
 */
export async function submitSmsSetupAction(_previous: SmsSetupState, formData: FormData): Promise<SmsSetupState> {
  let values = typedValues(formData);
  try {
    const ctx = await ownerContext();
    const posted = DRAFT_FIELD_KEYS.some((key) => formData.has(key)) || formText(formData, "ein").trim() !== "";
    let warnings: SmsSetupState["warnings"];
    if (posted) {
      const saved = await persistDraft(ctx, formData);
      if (saved.error === ALREADY_SUBMITTED) {
        revalidatePath(PATH);
        return alreadySubmitted();
      }
      if (!saved.ok) return { ...saved, intent: "submit", error: `Nothing was submitted. ${saved.error}` };
      values = saved.values ?? values;
      warnings = saved.warnings;
    }
    const attestation = {
      authorized: formData.get("attest_authorized") === "on",
      accurate: formData.get("attest_accurate") === "on",
      opt_in_only: formData.get("attest_opt_in_only") === "on",
      fees_terms: formData.get("attest_fees_terms") === "on",
    };
    if (!Object.values(attestation).every(Boolean)) {
      return { ok: false, intent: "submit", error: `${posted ? "Your details are saved, but nothing was submitted. " : ""}Please confirm every statement before submitting.`, values, warnings };
    }
    const result = await submitOnboarding(ctx.supabase, ctx.studioId, attestation);
    if (!result.submitted) {
      return { ok: false, intent: "submit", error: `Nothing was submitted. Still needed: ${describeProblems(result.missing)}`, missing: result.missing, values, warnings };
    }
    revalidatePath(PATH);
    return { ok: true, intent: "submit", notice: "Submitted. We have your information and will take it from here." };
  } catch (error) {
    if (error instanceof OnboardingRpcError && error.friendly === ALREADY_SUBMITTED) {
      revalidatePath(PATH);
      return alreadySubmitted();
    }
    return { ...failure(error), intent: "submit", values };
  }
}

/** The wizard is one form with two buttons; the pressed button names the intent. Anything but "submit" only saves. */
export async function smsSetupAction(previous: SmsSetupState, formData: FormData): Promise<SmsSetupState> {
  return formData.get("intent") === "submit" ? submitSmsSetupAction(previous, formData) : saveSmsSetupAction(previous, formData);
}

export async function cancelSmsSetupAction(): Promise<SmsSetupState> {
  try {
    const ctx = await ownerContext();
    await cancelOnboarding(ctx.supabase, ctx.studioId);
    revalidatePath(PATH);
    return { ok: true, notice: "Setup cancelled." };
  } catch (error) {
    if (error instanceof OnboardingRpcError) return { ok: false, error: error.friendly };
    return { ok: false, error: friendlyOnboardingError(null).friendly };
  }
}
