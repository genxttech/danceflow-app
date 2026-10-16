"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUserStudioContext } from "@/lib/auth/serverRoleGuard";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  cancelOnboarding,
  friendlyOnboardingError,
  OnboardingRpcError,
  saveOnboardingDraft,
  storeEinCiphertext,
  submitOnboarding,
} from "@/lib/sms/onboarding/client";
import { EinCryptoError, einEncryptionConfigured, encryptEin } from "@/lib/sms/onboarding/ein";
import { DRAFT_FIELD_KEYS, FIELD_LABELS, normalizeEin, validateDraftFields, type DraftFieldKey, type WizardFieldKey } from "@/lib/sms/onboarding/fields";

/**
 * TW-4A server actions for Settings -> Texting. Owner only (the database re-checks the role and the pilot flag on every call).
 * No action talks to Twilio. The EIN is validated, encrypted here with the environment key, and stored through a service-role
 * RPC that re-verifies the actor is an active owner; the clear value is never logged, returned, or placed in an error.
 */

export type SmsSetupState = {
  ok?: boolean;
  error?: string;
  notice?: string;
  fieldErrors?: Partial<Record<WizardFieldKey, string>>;
  /** The submitted NON-SECRET field values, returned on a failed save so the form keeps what the owner typed. Never the EIN. */
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
  if (error instanceof OnboardingRpcError) return { ok: false, error: error.friendly };
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

export async function saveSmsSetupAction(_previous: SmsSetupState, formData: FormData): Promise<SmsSetupState> {
  const input: Record<string, string> = {};
  for (const key of DRAFT_FIELD_KEYS) input[key] = formText(formData, key);
  const values = { ...input } as Partial<Record<DraftFieldKey, string>>;
  try {
    const ctx = await ownerContext();

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
      const encrypted = encryptEin(ctx.studioId, { digits: ein.digits, last4: ein.last4 });
      await storeEinCiphertext(createAdminClient(), {
        studioId: ctx.studioId,
        actorUserId: ctx.user.id,
        ciphertext: encrypted.ciphertext,
        keyId: encrypted.keyId,
        last4: encrypted.last4,
      });
      missing = missing.filter((key) => key !== "ein");
    }
    revalidatePath(PATH);
    return { ok: true, notice: "Saved.", warnings, missing };
  } catch (error) {
    return { ...failure(error), values };
  }
}

export async function submitSmsSetupAction(_previous: SmsSetupState, formData: FormData): Promise<SmsSetupState> {
  try {
    const ctx = await ownerContext();
    const attestation = {
      authorized: formData.get("attest_authorized") === "on",
      accurate: formData.get("attest_accurate") === "on",
      opt_in_only: formData.get("attest_opt_in_only") === "on",
      fees_terms: formData.get("attest_fees_terms") === "on",
    };
    if (!Object.values(attestation).every(Boolean)) {
      return { ok: false, error: "Please confirm every statement before submitting." };
    }
    const result = await submitOnboarding(ctx.supabase, ctx.studioId, attestation);
    if (!result.submitted) {
      const labels = result.missing.map((key) => FIELD_LABELS[key as WizardFieldKey] ?? key);
      return { ok: false, error: `Finish the form first. Still needed: ${labels.join(", ")}.`, missing: result.missing };
    }
    revalidatePath(PATH);
    return { ok: true, notice: "Submitted. We have your information and will take it from here." };
  } catch (error) {
    return failure(error);
  }
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
