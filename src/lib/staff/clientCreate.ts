import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CLIENT_REFERRAL_SOURCE_OPTIONS,
  CLIENT_SKILL_LEVEL_OPTIONS,
  CLIENT_STATUS_OPTIONS,
  normalizeOptionValue,
} from "@/lib/forms/options";

/**
 * Client create core, shared by the web `createClientAction` / `updateClientAction` (payload builder, duplicate-email check, insert) and the Staff
 * API quick-add (`POST /api/staff/workspaces/{studioId}/clients`). The web action used to hold these inline. Authorization is the caller's:
 * web requireClientEditAccess, API requireStaffApi + canEditClients. Writes use the caller's own Supabase client, so RLS applies.
 */

/** Verbatim extraction of the web action's payload builder: the columns a client row is created or updated with. */
export function normalizeClientPayload(params: {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  birthday: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  danceStyles: string[];
  danceInterests?: string;
  danceGoals?: string[];
  includeDanceGoals?: boolean;
  skillLevel: string;
  notes: string;
  referralSource: string;
  status: string;
  linkedInstructorId: string | null;
  isIndependentInstructor: boolean;
}) {
  const {
    firstName,
    lastName,
    email,
    phone,
    birthday,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    country,
    danceStyles,
    danceInterests,
    danceGoals,
    includeDanceGoals = false,
    skillLevel,
    notes,
    referralSource,
    status,
    linkedInstructorId,
    isIndependentInstructor,
  } = params;

  const normalizedLinkedInstructorId = isIndependentInstructor ? linkedInstructorId : null;
  const normalizedDanceInterests = danceStyles.length ? danceStyles.join(", ") : danceInterests ?? "";

  return {
    first_name: firstName,
    last_name: lastName,
    email: email || null,
    phone: phone || null,
    birthday: birthday || null,
    address_line1: addressLine1 || null,
    address_line2: addressLine2 || null,
    city: city || null,
    state: state || null,
    postal_code: postalCode || null,
    country: country || null,
    dance_interests: normalizedDanceInterests || null,
    ...(includeDanceGoals ? { dance_goals: danceGoals?.length ? danceGoals : null } : {}),
    skill_level: skillLevel ? normalizeOptionValue(CLIENT_SKILL_LEVEL_OPTIONS, skillLevel) : null,
    notes: notes || null,
    referral_source: referralSource ? normalizeOptionValue(CLIENT_REFERRAL_SOURCE_OPTIONS, referralSource) : null,
    status: normalizeOptionValue(CLIENT_STATUS_OPTIONS, status) ?? "lead",
    is_independent_instructor: isIndependentInstructor,
    linked_instructor_id: normalizedLinkedInstructorId,
  };
}

export type DuplicateClient = { id: string; matchedOn: "email" | "phone" };

/**
 * The web action's duplicate check, extracted: an existing client of THIS studio with the same (already normalized, lower-cased) email.
 * Matching is exact; the studio filter is explicit on top of RLS.
 */
export async function findClientByEmail(params: {
  supabase: SupabaseClient;
  studioId: string;
  email: string;
}): Promise<{ id: string } | null> {
  const { data } = await params.supabase
    .from("clients")
    .select("id")
    .eq("studio_id", params.studioId)
    .eq("email", params.email)
    .limit(1)
    .maybeSingle();
  return data ? { id: (data as { id: string }).id } : null;
}

/**
 * Phone variants a normalized phone (`+1XXXXXXXXXX`, the form every new client is stored in) may also be stored as on older rows.
 * Only plain NANP numbers have variants; other numbers match exactly.
 */
export function phoneMatchVariants(normalizedPhone: string): string[] {
  const variants = new Set([normalizedPhone]);
  const nanp = normalizedPhone.match(/^\+1(\d{10})$/);
  if (nanp) {
    variants.add(nanp[1]);
    variants.add(`1${nanp[1]}`);
  }
  return [...variants];
}

/**
 * API-only: an existing client of this studio with the same phone number (a household may share a phone, so callers treat this as a soft
 * match). Oldest match first so the answer is stable.
 */
export async function findClientByPhone(params: {
  supabase: SupabaseClient;
  studioId: string;
  phone: string;
}): Promise<{ id: string } | null> {
  const { data } = await params.supabase
    .from("clients")
    .select("id")
    .eq("studio_id", params.studioId)
    .in("phone", phoneMatchVariants(params.phone))
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data ? { id: (data as { id: string }).id } : null;
}

/** The web action's insert, extracted: one clients row with the caller's own client (RLS applies). */
export async function insertClient(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string;
  payload: ReturnType<typeof normalizeClientPayload>;
  photoPath?: string | null;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await params.supabase.from("clients").insert({
    id: params.clientId,
    studio_id: params.studioId,
    ...params.payload,
    ...(params.photoPath !== undefined ? { photo_url: params.photoPath } : {}),
  });
  return error ? { ok: false, message: error.message } : { ok: true };
}

export type QuickAddInput = {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  note: string;
  /** A household may share a phone: when true a phone-only match no longer blocks creation. An email match always blocks (as on the web). */
  allowDuplicatePhone?: boolean;
};

export type QuickAddResult =
  | { ok: true; client: { id: string; firstName: string; lastName: string; status: string } }
  | { ok: false; reason: "duplicate_client"; existingClientId: string; matchedOn: "email" | "phone" }
  | { ok: false; reason: "insert_failed"; message: string };

/**
 * Staff API quick add: the web action's create path with the minimal field set. Same duplicate-email rule, same payload builder (so the
 * stored row has exactly the columns and defaults a web-created lead has: status "lead", no source columns set), same insert. Adds a
 * phone match (soft) on top of the web's email rule.
 */
export async function quickAddClient(params: {
  supabase: SupabaseClient;
  studioId: string;
  input: QuickAddInput;
  newClientId: string;
}): Promise<QuickAddResult> {
  const { supabase, studioId, input, newClientId } = params;

  if (input.email) {
    const byEmail = await findClientByEmail({ supabase, studioId, email: input.email });
    if (byEmail) return { ok: false, reason: "duplicate_client", existingClientId: byEmail.id, matchedOn: "email" };
  }

  if (input.phone && !input.allowDuplicatePhone) {
    const byPhone = await findClientByPhone({ supabase, studioId, phone: input.phone });
    if (byPhone) return { ok: false, reason: "duplicate_client", existingClientId: byPhone.id, matchedOn: "phone" };
  }

  const payload = normalizeClientPayload({
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    birthday: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    country: "",
    danceStyles: [],
    danceGoals: [],
    includeDanceGoals: true,
    skillLevel: "",
    notes: input.note,
    referralSource: "",
    status: "lead",
    linkedInstructorId: null,
    isIndependentInstructor: false,
  });

  const inserted = await insertClient({ supabase, studioId, clientId: newClientId, payload });
  if (!inserted.ok) return { ok: false, reason: "insert_failed", message: inserted.message };

  return { ok: true, client: { id: newClientId, firstName: input.firstName, lastName: input.lastName, status: payload.status } };
}
