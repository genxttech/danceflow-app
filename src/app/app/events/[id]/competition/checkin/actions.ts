"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { buildCompetitionCredentialTargets } from "@/lib/competition/checkin";

function text(formData: FormData, key: string) { return String(formData.get(key) ?? "").trim(); }

async function requireEventManager(eventId: string) {
  const context = await getCurrentStudioContext();
  const supabase = await createClient();
  const { data: event, error } = await supabase.from("events").select("id, studio_id, organizer_id").eq("id", eventId).eq("studio_id", context.studioId).maybeSingle();
  if (error || !event) throw new Error("Event not found.");
  const studioCanManage = ["studio_owner", "studio_admin", "front_desk"].includes(context.studioRole ?? "");
  let organizerCanManage = false;
  if (event.organizer_id) {
    const { data: organizerUser } = await supabase.from("organizer_users").select("role").eq("organizer_id", event.organizer_id).eq("user_id", context.userId).eq("active", true).maybeSingle();
    organizerCanManage = ["organizer_owner", "organizer_admin", "organizer_staff"].includes(organizerUser?.role ?? "");
  }
  if (!context.isPlatformAdmin && !studioCanManage && !organizerCanManage) throw new Error("You do not have permission to manage competition check-in.");
  return { supabase, context, event };
}

function refresh(eventId: string, sessionId?: string) {
  revalidatePath(`/app/events/${eventId}/competition/checkin`);
  if (sessionId) revalidatePath(`/app/events/${eventId}/competition/checkin/${sessionId}`);
  revalidatePath(`/app/events/${eventId}/competition/registrations`);
  revalidatePath(`/app/events/${eventId}/competition/readiness`);
}

async function recalculateSession(supabase: any, eventId: string, sessionId: string) {
  const { data: session } = await supabase.from("event_competition_checkin_sessions").select("id, registration_cart_id, registration_id, order_id, status").eq("id", sessionId).eq("event_id", eventId).single();
  if (!session) throw new Error("Check-in session not found.");
  const entryQuery = supabase.from("event_competition_entries").select("id, division_id, display_name, status, eligibility_status, verification_status").eq("event_id", eventId);
  if (session.registration_cart_id) entryQuery.eq("registration_cart_id", session.registration_cart_id); else entryQuery.eq("registration_id", session.registration_id);
  const [entryResult, entryParticipantResult, divisionResult, ruleResult, participantResult, requirementResult, waiverResult, credentialResult, orderResult, paymentResult] = await Promise.all([
    entryQuery,
    supabase.from("event_competition_entry_participants").select("entry_id, registration_attendee_id, participant_role, display_name").eq("event_id", eventId),
    supabase.from("event_competition_divisions").select("id, contest_id").eq("event_id", eventId),
    supabase.from("event_competition_contest_registration_rules").select("contest_id, number_assignment_mode, number_holder_role").eq("event_id", eventId),
    supabase.from("event_competition_checkin_participants").select("id, presence_status, waiver_status").eq("checkin_session_id", sessionId),
    supabase.from("event_document_requirements").select("template_id").eq("event_id", eventId).eq("active", true).eq("is_required", true),
    supabase.from("event_competition_participant_waivers").select("checkin_participant_id, template_id").eq("event_id", eventId),
    supabase.from("event_competition_credentials").select("holder_type, registration_attendee_id, entry_id, status").eq("checkin_session_id", sessionId).neq("status", "void"),
    session.order_id ? supabase.from("event_orders").select("total_amount, currency, payment_status").eq("id", session.order_id).maybeSingle() : Promise.resolve({ data: null }),
    session.registration_id ? supabase.from("event_payments").select("amount, refund_amount, status").eq("registration_id", session.registration_id) : Promise.resolve({ data: [] }),
  ]);
  const entries = entryResult.data ?? [];
  const requiredTemplateIds = new Set((requirementResult.data ?? []).map((item: any) => item.template_id));
  const waiverRows = waiverResult.data ?? [];
  const checkinParticipants = participantResult.data ?? [];
  const waiverComplete = requiredTemplateIds.size === 0 || checkinParticipants.every((participant: any) => participant.waiver_status === "waived" || [...requiredTemplateIds].every((templateId) => waiverRows.some((row: any) => row.checkin_participant_id === participant.id && row.template_id === templateId)));
  const entriesComplete = entries.length > 0 && entries.every((entry: any) => ["confirmed", "complete"].includes(entry.status) && ["eligible", "waived"].includes(entry.eligibility_status) && ["verified", "corrected"].includes(entry.verification_status));
  const entryBlocked = entries.some((entry: any) => entry.eligibility_status === "ineligible" || entry.verification_status === "disputed");
  const targets = buildCompetitionCredentialTargets({ entries, divisions: divisionResult.data ?? [], rules: ruleResult.data ?? [], participants: (entryParticipantResult.data ?? []).filter((item: any) => entries.some((entry: any) => entry.id === item.entry_id)) });
  const credentials = credentialResult.data ?? [];
  const credentialComplete = targets.length === 0 || targets.every((target) => credentials.some((credential: any) => credential.status === "issued" && ((target.holderType === "participant" && credential.registration_attendee_id === target.registrationAttendeeId) || (target.holderType === "entry" && credential.entry_id === target.entryId))));
  const orderTotal = Number(orderResult.data?.total_amount ?? 0);
  const paid = (paymentResult.data ?? []).filter((item: any) => item.status === "paid").reduce((sum: number, item: any) => sum + Number(item.amount ?? 0) - Number(item.refund_amount ?? 0), 0);
  const balanceDue = Math.max(0, Number((orderTotal - paid).toFixed(2)));
  const paymentComplete = balanceDue <= 0;
  const ready = paymentComplete && waiverComplete && entriesComplete && credentialComplete;
  await supabase.from("event_competition_checkin_sessions").update({
    status: session.status === "complete" ? "complete" : entryBlocked ? "blocked" : ready ? "ready" : "in_progress",
    payment_status: paymentComplete ? "complete" : "balance_due",
    waiver_status: waiverComplete ? "complete" : "missing",
    entry_status: entryBlocked ? "disputed" : entriesComplete ? "complete" : "needs_review",
    credential_status: targets.length === 0 ? "not_required" : credentialComplete ? "complete" : "missing",
    balance_due: balanceDue,
    currency: orderResult.data?.currency ?? "USD",
    started_at: new Date().toISOString(),
  }).eq("id", sessionId).eq("event_id", eventId);
  return { ready, checkinParticipants };
}

export async function startCompetitionCheckinAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const cartId = text(formData, "cartId");
  const registrationIdInput = text(formData, "registrationId");
  if (!eventId || (!cartId && !registrationIdInput)) throw new Error("Registration batch is required.");
  const { supabase } = await requireEventManager(eventId);
  const { data: existing } = cartId
    ? await (supabase as any).from("event_competition_checkin_sessions").select("id").eq("registration_cart_id", cartId).maybeSingle()
    : await (supabase as any).from("event_competition_checkin_sessions").select("id").eq("registration_id", registrationIdInput).is("registration_cart_id", null).maybeSingle();
  if (existing) redirect(`/app/events/${eventId}/competition/checkin/${existing.id}`);
  let registrationId = registrationIdInput || null;
  let orderId: string | null = null;
  if (cartId) {
    const { data: cart } = await (supabase as any).from("event_competition_registration_carts").select("order_id").eq("id", cartId).eq("event_id", eventId).single();
    if (!cart?.order_id) throw new Error("Registration cart has no order.");
    orderId = cart.order_id;
    const { data: registration } = await (supabase as any).from("event_registrations").select("id").eq("order_id", orderId).eq("event_id", eventId).maybeSingle();
    registrationId = registration?.id ?? null;
  } else {
    const { data: registration } = await (supabase as any).from("event_registrations").select("order_id").eq("id", registrationId).eq("event_id", eventId).single();
    orderId = registration?.order_id ?? null;
  }
  if (!registrationId) throw new Error("Registration record not found.");
  const { data: session, error } = await (supabase as any).from("event_competition_checkin_sessions").insert({ event_id: eventId, registration_cart_id: cartId || null, registration_id: registrationId, order_id: orderId, status: "in_progress", started_at: new Date().toISOString() }).select("id").single();
  if (error || !session) throw new Error(error?.message ?? "Could not start check-in.");
  const [{ data: attendees }, { count: requirementCount }] = await Promise.all([
    (supabase as any).from("event_registration_attendees").select("id, first_name, last_name, attendee_role").eq("registration_id", registrationId).eq("event_id", eventId).order("sort_order"),
    (supabase as any).from("event_document_requirements").select("id", { count: "exact", head: true }).eq("event_id", eventId).eq("active", true).eq("is_required", true),
  ]);
  if ((attendees ?? []).length > 0) {
    const { error: participantError } = await (supabase as any).from("event_competition_checkin_participants").insert((attendees ?? []).map((attendee: any) => ({ event_id: eventId, checkin_session_id: session.id, registration_attendee_id: attendee.id, display_name: `${attendee.first_name ?? ""} ${attendee.last_name ?? ""}`.trim() || "Participant", participant_type: attendee.attendee_role || "dancer", waiver_status: (requirementCount ?? 0) > 0 ? "missing" : "not_required" })));
    if (participantError) throw new Error(participantError.message);
  }
  await recalculateSession(supabase, eventId, session.id);
  refresh(eventId, session.id);
  redirect(`/app/events/${eventId}/competition/checkin/${session.id}`);
}

export async function updateCompetitionCheckinPresenceAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId"), sessionId = text(formData, "sessionId"), participantId = text(formData, "participantId"), presenceStatus = text(formData, "presenceStatus");
  if (!eventId || !sessionId || !participantId || !["not_arrived", "present", "absent", "excused"].includes(presenceStatus)) throw new Error("Valid participant presence is required.");
  const { supabase, context } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_checkin_participants").update({ presence_status: presenceStatus, checked_in_at: presenceStatus === "present" ? new Date().toISOString() : null, checked_in_by: presenceStatus === "present" ? context.userId : null }).eq("id", participantId).eq("checkin_session_id", sessionId).eq("event_id", eventId);
  if (error) throw new Error(error.message);
  await recalculateSession(supabase, eventId, sessionId); refresh(eventId, sessionId);
}

export async function recordCompetitionParticipantWaiverAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId"), sessionId = text(formData, "sessionId"), participantId = text(formData, "participantId"), templateId = text(formData, "templateId"), signerName = text(formData, "signerName"), signerEmail = text(formData, "signerEmail");
  if (!eventId || !sessionId || !participantId || !templateId || !signerName) throw new Error("Participant, waiver, and signature are required.");
  const { supabase, context } = await requireEventManager(eventId);
  const [{ data: participant }, { data: requirement }] = await Promise.all([
    (supabase as any).from("event_competition_checkin_participants").select("id").eq("id", participantId).eq("checkin_session_id", sessionId).eq("event_id", eventId).single(),
    (supabase as any).from("event_document_requirements").select("template_id, template_version_id, document_templates:template_id(body)").eq("event_id", eventId).eq("template_id", templateId).eq("active", true).eq("is_required", true).single(),
  ]);
  if (!participant || !requirement) throw new Error("Required participation waiver not found.");
  const template = Array.isArray(requirement.document_templates) ? requirement.document_templates[0] : requirement.document_templates;
  const headerList = await headers();
  const consentText = "I have reviewed this participation waiver, agree to sign electronically, and confirm that my typed name is my signature.";
  const { error: waiverError } = await (supabase as any).from("event_competition_participant_waivers").upsert({ event_id: eventId, checkin_participant_id: participantId, template_id: templateId, template_version_id: requirement.template_version_id, document_signature_id: null, signer_name: signerName, signer_email: signerEmail || null, signature_text: signerName, consent_text: consentText, signed_body: template?.body ?? "", signed_by_staff: context.userId, ip_address: headerList.get("x-forwarded-for")?.split(",")[0]?.trim() || null, user_agent: headerList.get("user-agent") || null }, { onConflict: "checkin_participant_id,template_id" });
  if (waiverError) throw new Error(waiverError.message);
  await (supabase as any).from("event_competition_checkin_participants").update({ waiver_status: "signed" }).eq("id", participantId);
  await recalculateSession(supabase, eventId, sessionId); refresh(eventId, sessionId);
}

export async function verifyCompetitionCheckinEntryAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId"), sessionId = text(formData, "sessionId"), entryId = text(formData, "entryId"), verificationStatus = text(formData, "verificationStatus");
  if (!eventId || !sessionId || !entryId || !["verified", "disputed", "corrected", "unverified"].includes(verificationStatus)) throw new Error("Valid entry verification is required.");
  const { supabase, context } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_entries").update({ verification_status: verificationStatus, verified_at: ["verified", "corrected"].includes(verificationStatus) ? new Date().toISOString() : null, verified_by: ["verified", "corrected"].includes(verificationStatus) ? context.userId : null }).eq("id", entryId).eq("event_id", eventId);
  if (error) throw new Error(error.message);
  await recalculateSession(supabase, eventId, sessionId); refresh(eventId, sessionId);
}

export async function issueCompetitionCredentialAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId"), sessionId = text(formData, "sessionId"), holderType = text(formData, "holderType"), credentialNumber = text(formData, "credentialNumber"), displayName = text(formData, "displayName"), attendeeId = text(formData, "registrationAttendeeId"), entryId = text(formData, "entryId"), credentialType = text(formData, "credentialType");
  if (!eventId || !sessionId || !credentialNumber || !displayName || !["participant", "entry"].includes(holderType)) throw new Error("Credential holder and number are required.");
  const { supabase, context } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_credentials").insert({ event_id: eventId, checkin_session_id: sessionId, credential_type: credentialType === "team_number" ? "team_number" : "competitor_number", credential_number: credentialNumber.toUpperCase(), holder_type: holderType, registration_attendee_id: holderType === "participant" ? attendeeId : null, entry_id: holderType === "entry" ? entryId : null, display_name: displayName, status: "issued", assigned_by: context.userId, issued_at: new Date().toISOString(), issued_by: context.userId });
  if (error) throw new Error(`Could not issue credential: ${error.message}`);
  await recalculateSession(supabase, eventId, sessionId); refresh(eventId, sessionId);
}

export async function recordCompetitionCheckinPaymentAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId"), sessionId = text(formData, "sessionId"), paymentMethod = text(formData, "paymentMethod");
  const amount = Number(text(formData, "amount"));
  if (!eventId || !sessionId || !Number.isFinite(amount) || amount <= 0 || !["cash", "check", "external_card", "other"].includes(paymentMethod)) throw new Error("Valid payment details are required.");
  const { supabase } = await requireEventManager(eventId);
  const { data: session } = await (supabase as any).from("event_competition_checkin_sessions").select("registration_id, order_id, balance_due, currency").eq("id", sessionId).eq("event_id", eventId).single();
  if (!session?.registration_id || amount > Number(session.balance_due) + 0.001) throw new Error("Payment exceeds the current balance or registration is missing.");
  const { error } = await (supabase as any).from("event_payments").insert({ event_id: eventId, registration_id: session.registration_id, amount, currency: session.currency, payment_method: paymentMethod, status: "paid", source: "competition_checkin", notes: "Collected at competition registration-desk check-in." });
  if (error) throw new Error(error.message);
  const remaining = Number((Number(session.balance_due) - amount).toFixed(2));
  await (supabase as any).from("event_registrations").update({ payment_status: remaining <= 0 ? "paid" : "partial", status: remaining <= 0 ? "confirmed" : "pending" }).eq("id", session.registration_id);
  if (session.order_id && remaining <= 0) await (supabase as any).from("event_orders").update({ payment_status: "paid", status: "confirmed", paid_at: new Date().toISOString() }).eq("id", session.order_id);
  await recalculateSession(supabase, eventId, sessionId); refresh(eventId, sessionId);
}

export async function completeCompetitionCheckinAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId"), sessionId = text(formData, "sessionId");
  if (!eventId || !sessionId) throw new Error("Check-in session is required.");
  const { supabase, context } = await requireEventManager(eventId);
  const state = await recalculateSession(supabase, eventId, sessionId);
  const presenceComplete = state.checkinParticipants.every((participant: any) => ["present", "excused"].includes(participant.presence_status));
  if (!state.ready || !presenceComplete) throw new Error("Payment, waivers, entries, credentials, and participant arrival must be complete.");
  const { error } = await (supabase as any).from("event_competition_checkin_sessions").update({ status: "complete", completed_at: new Date().toISOString(), completed_by: context.userId }).eq("id", sessionId).eq("event_id", eventId);
  if (error) throw new Error(error.message);
  refresh(eventId, sessionId);
}
