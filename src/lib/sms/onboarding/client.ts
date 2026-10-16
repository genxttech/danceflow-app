import type { SupabaseClient } from "@supabase/supabase-js";
import type { DraftFieldKey } from "./fields";
import type { OnboardingDisplayState } from "./stateMachine";

/**
 * TW-4A: thin, typed wrappers over the TW-4A RPCs. Studio-facing calls take the SIGNED-IN USER's client: the database derives
 * the studio role from auth.uid() and enforces the pilot flag, so nothing here is a second authorization layer, only plumbing.
 * The three service-role calls take an admin client and are used only by server actions / routes after their own role check.
 * No wrapper returns, accepts or logs an EIN in clear text: `storeEinCiphertext` takes the already-encrypted token.
 */

type Rpc = { data: unknown; error: { message?: string; code?: string } | null };
type Client = Pick<SupabaseClient, "rpc">;

export class OnboardingRpcError extends Error {
  constructor(public readonly code: string, public readonly friendly: string) {
    super(`sms onboarding rpc failed (${code})`);
    this.name = "OnboardingRpcError";
  }
}

/** Database refusals are written for staff; anything unexpected stays generic and carries no raw text. */
export function friendlyOnboardingError(error: { message?: string; code?: string } | null | undefined): OnboardingRpcError {
  const code = String(error?.code ?? "unknown");
  const message = String(error?.message ?? "");
  if (code === "42501") return new OnboardingRpcError(code, "You do not have access to this setup.");
  if (code === "22023" && /already submitted|cannot be edited|locked/i.test(message)) {
    return new OnboardingRpcError(code, "This setup has been submitted and can no longer be edited.");
  }
  if (code === "22023") return new OnboardingRpcError(code, "Some information was not accepted. Check the highlighted fields and try again.");
  if (code === "23514") return new OnboardingRpcError(code, "A value is not in an accepted format. Check the highlighted fields.");
  return new OnboardingRpcError(code, "Something went wrong. Nothing was changed.");
}

function unwrap(result: Rpc): unknown {
  if (result.error) throw friendlyOnboardingError(result.error);
  return result.data;
}

export type StudioSmsStatus =
  | { available: false; textingOn: boolean }
  | {
      available: true;
      textingOn: boolean;
      role: string;
      /** The platform switch was turned off after a setup started: the setup is shown read-only and can only be cancelled. */
      paused: boolean;
      canEdit: boolean;
      canCancel: boolean;
      state: OnboardingDisplayState;
      needsInfoFields: string[];
      submittedAt: string | null;
      submissionSeq: number;
    };

/** Front desk receives only `{ texting_on }`; callers treat a missing `available` as "not available". */
export function parseStudioSmsStatus(data: unknown): StudioSmsStatus {
  const row = (data ?? {}) as Record<string, unknown>;
  const textingOn = row.texting_on === true;
  if (row.available !== true) return { available: false, textingOn };
  return {
    available: true,
    textingOn,
    role: String(row.role ?? ""),
    paused: row.paused === true,
    canEdit: row.can_edit === true,
    canCancel: row.can_cancel === true,
    state: String(row.state ?? "not_started") as OnboardingDisplayState,
    needsInfoFields: Array.isArray(row.needs_info_fields) ? (row.needs_info_fields as unknown[]).map(String) : [],
    submittedAt: typeof row.submitted_at === "string" ? row.submitted_at : null,
    submissionSeq: typeof row.submission_seq === "number" ? row.submission_seq : 0,
  };
}

export async function getStudioSmsStatus(supabase: Client, studioId: string): Promise<StudioSmsStatus> {
  return parseStudioSmsStatus(unwrap(await supabase.rpc("get_studio_sms_status", { p_studio_id: studioId }) as Rpc));
}

export type OnboardingDraft = {
  state: OnboardingDisplayState;
  fields: Record<DraftFieldKey, string>;
  einLast4: string | null;
  einOnFile: boolean;
  missing: string[];
  attestedAt: string | null;
  updatedAt: string | null;
};

export function parseOnboardingDraft(data: unknown): OnboardingDraft | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const text = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : "");
  const keys: DraftFieldKey[] = [
    "legal_name", "entity_type", "industry", "website_choice", "website_url", "address_line1", "address_line2", "city", "region",
    "postal_code", "rep_first_name", "rep_last_name", "rep_title", "rep_position", "rep_email", "rep_phone", "preferred_area_code",
  ];
  return {
    state: String(row.state ?? "draft") as OnboardingDisplayState,
    fields: Object.fromEntries(keys.map((key) => [key, text(key)])) as Record<DraftFieldKey, string>,
    einLast4: typeof row.ein_last4 === "string" ? row.ein_last4 : null,
    einOnFile: row.ein_on_file === true,
    missing: Array.isArray(row.missing) ? (row.missing as unknown[]).map(String) : [],
    attestedAt: typeof row.attested_at === "string" ? row.attested_at : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

export async function getOnboardingDraft(supabase: Client, studioId: string): Promise<OnboardingDraft | null> {
  return parseOnboardingDraft(unwrap(await supabase.rpc("get_sms_onboarding_draft", { p_studio_id: studioId }) as Rpc));
}

export async function saveOnboardingDraft(
  supabase: Client,
  studioId: string,
  fields: Partial<Record<DraftFieldKey, string>>,
): Promise<{ state: string; missing: string[] }> {
  const data = unwrap(await supabase.rpc("save_sms_onboarding_draft", { p_studio_id: studioId, p_fields: fields }) as Rpc) as Record<string, unknown> | null;
  return { state: String(data?.state ?? "draft"), missing: Array.isArray(data?.missing) ? (data!.missing as unknown[]).map(String) : [] };
}

export const ATTESTATION_VERSION = "tw4a-v1";
export type Attestation = { authorized: boolean; accurate: boolean; opt_in_only: boolean; fees_terms: boolean };

export async function submitOnboarding(
  supabase: Client,
  studioId: string,
  attestation: Attestation,
): Promise<{ submitted: boolean; missing: string[]; state: string }> {
  const data = unwrap(
    await supabase.rpc("submit_sms_onboarding", { p_studio_id: studioId, p_attestation: { version: ATTESTATION_VERSION, ...attestation } }) as Rpc,
  ) as Record<string, unknown> | null;
  return {
    submitted: data?.submitted === true,
    missing: Array.isArray(data?.missing) ? (data!.missing as unknown[]).map(String) : [],
    state: String(data?.state ?? ""),
  };
}

export async function cancelOnboarding(supabase: Client, studioId: string): Promise<{ state: string }> {
  const data = unwrap(await supabase.rpc("cancel_sms_onboarding", { p_studio_id: studioId }) as Rpc) as Record<string, unknown> | null;
  return { state: String(data?.state ?? "") };
}

/** Service role only. `ciphertext` is the encrypted token from `encryptEin`; the clear EIN never reaches this function. */
export async function storeEinCiphertext(
  admin: Client,
  input: { studioId: string; actorUserId: string; ciphertext: string; keyId: string; last4: string },
): Promise<void> {
  unwrap(
    await admin.rpc("store_sms_onboarding_ein", {
      p_studio_id: input.studioId,
      p_actor: input.actorUserId,
      p_ciphertext: input.ciphertext,
      p_key_id: input.keyId,
      p_last4: input.last4,
    }) as Rpc,
  );
}

export async function purgeDueEins(admin: Client): Promise<number> {
  const data = unwrap(await admin.rpc("purge_due_sms_onboarding_eins") as Rpc);
  return typeof data === "number" ? data : 0;
}

export type SmsLegalContext = { displayName: string; legalName: string | null };

export async function getSmsLegalContext(admin: Client, slug: string): Promise<SmsLegalContext | null> {
  const data = unwrap(await admin.rpc("get_sms_legal_context", { p_studio_slug: slug }) as Rpc) as Record<string, unknown> | null;
  if (!data || typeof data.display_name !== "string") return null;
  return { displayName: data.display_name, legalName: typeof data.legal_name === "string" ? data.legal_name : null };
}

export type PlatformOnboardingRow = {
  studioId: string;
  studioName: string;
  accessEnabled: boolean;
  state: string | null;
  submissionSeq: number | null;
  submittedAt: string | null;
  updatedAt: string | null;
  einStored: boolean;
};

export async function listOnboardings(supabase: Client): Promise<PlatformOnboardingRow[]> {
  const data = unwrap(await supabase.rpc("list_sms_onboardings") as Rpc);
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  return rows.map((row) => ({
    studioId: String(row.studio_id),
    studioName: String(row.studio_name ?? ""),
    accessEnabled: row.access_enabled === true,
    state: typeof row.state === "string" ? row.state : null,
    submissionSeq: typeof row.submission_seq === "number" ? row.submission_seq : null,
    submittedAt: typeof row.submitted_at === "string" ? row.submitted_at : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    einStored: row.ein_stored === true,
  }));
}

export async function setPilotAccess(supabase: Client, studioId: string, enabled: boolean, reason: string): Promise<void> {
  unwrap(await supabase.rpc("set_sms_onboarding_access", { p_studio_id: studioId, p_enabled: enabled, p_reason: reason }) as Rpc);
}
