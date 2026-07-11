import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/payments/stripe";
import { calculateCompetitionRegistrationQuote, type CompetitionRegistrationDraft } from "@/lib/competition/registrationPricing";
import { loadCompetitionRegistrationCatalog } from "@/lib/competition/registrationServer";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

const FEE_STANDARD = 0.035;
const FEE_STUDIO = 0.0325;
const FEE_PRO = 0.03;

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Competition checkout is not configured.");
  return createSupabaseClient(url, key, { auth: { persistSession: false } });
}

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function splitName(value: string) {
  const [firstName = "", ...rest] = value.trim().replace(/\s+/g, " ").split(" ");
  return { firstName, lastName: rest.join(" ") };
}

function absoluteUrl(request: NextRequest, path: string) {
  return new URL(path, request.nextUrl.origin).toString();
}

function applicationFee(amount: number, percent: number) {
  return Math.round(Math.max(0, Math.round(amount * 100)) * Math.max(0, percent));
}

async function platformFeePercent(supabase: SupabaseClient, studioId: string) {
  const { data: subscription } = await supabase.from("studio_subscriptions").select("status, subscription_plans(code)").eq("studio_id", studioId).maybeSingle();
  if (!subscription || !["active", "trialing"].includes(subscription.status ?? "")) return 0;
  const plan = one(subscription.subscription_plans as any);
  const code = String(plan?.code ?? "").trim().toLowerCase();
  if (code === "organizer") return FEE_STANDARD;
  if (!["starter", "growth", "pro"].includes(code)) return 0;
  const { data: entitlement } = await supabase.from("usage_addon_entitlements").select("id").eq("studio_id", studioId).eq("feature_key", "organizer_suite").in("source", ["stripe_subscription_item", "manual_grant"]).eq("status", "active").limit(1);
  if (!entitlement?.length) return 0;
  return code === "pro" ? FEE_PRO : FEE_STUDIO;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const rateLimit = checkRateLimit(
    rateLimitKey("checkout:competition", getIpFromRequest(request)),
    { limit: 5, windowMs: 15 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  const { slug } = await params;
  let orderId: string | null = null;
  let cartId: string | null = null;
  try {
    const body = await request.json() as { draft?: CompetitionRegistrationDraft; documentConsent?: boolean; signatureName?: string };
    if (!body.draft) return NextResponse.json({ error: "Registration details are required." }, { status: 400 });
    const draft = body.draft;
    const supabase = adminClient();
    const { data: event, error: eventError } = await supabase.from("events").select("id, slug, name, studio_id, organizer_id, status, visibility, registration_required, registration_opens_at, registration_closes_at, account_required_for_registration, studios(id, name, subscription_status, stripe_connected_account_id, stripe_connect_charges_enabled, stripe_connect_payouts_enabled, stripe_connect_onboarding_complete)").eq("slug", slug).maybeSingle();
    if (eventError || !event || event.status !== "published" || !["public", "unlisted"].includes(event.visibility) || !event.registration_required) return NextResponse.json({ error: "Competition registration is unavailable." }, { status: 404 });
    const now = Date.now();
    if ((event.registration_opens_at && new Date(event.registration_opens_at).getTime() > now) || (event.registration_closes_at && new Date(event.registration_closes_at).getTime() < now)) return NextResponse.json({ error: "Competition registration is not currently open." }, { status: 409 });
    if (event.account_required_for_registration) {
      const sessionClient = await createClient();
      const { data: { user } } = await sessionClient.auth.getUser();
      if (!user) return NextResponse.json({ error: "Sign in before registering." }, { status: 401 });
    }

    const catalog = await loadCompetitionRegistrationCatalog(supabase, event.id);
    const quote = calculateCompetitionRegistrationQuote(catalog, draft);
    if (!quote.valid) return NextResponse.json({ error: quote.errors[0] ?? "Registration is incomplete.", errors: quote.errors }, { status: 400 });
    const { data: requirements, error: requirementError } = await supabase.from("event_document_requirements").select("id, template_id, template_version_id, document_templates:template_id(id, title, body, requires_signature)").eq("event_id", event.id).eq("active", true).eq("is_required", true).order("created_at");
    if (requirementError) throw new Error(requirementError.message);
    const requiredDocuments = (requirements ?? []).map((requirement: any) => ({ ...requirement, template: one(requirement.document_templates) })).filter((item: any) => item.template);
    if (requiredDocuments.length > 0 && !body.documentConsent) return NextResponse.json({ error: "Review and accept the required documents." }, { status: 400 });
    if (requiredDocuments.some((item: any) => item.template.requires_signature) && !body.signatureName?.trim()) return NextResponse.json({ error: "Type the signer’s full legal name." }, { status: 400 });

    const quoteChecksum = createHash("sha256").update(JSON.stringify({ draft, quote })).digest("hex");
    const { data: cart, error: cartError } = await supabase.from("event_competition_registration_carts").insert({ event_id: event.id, registration_mode: draft.registrationMode, buyer_name: draft.buyerName.trim(), buyer_email: draft.buyerEmail.trim().toLowerCase(), buyer_phone: draft.buyerPhone?.trim() || null, registering_studio_name: draft.registrationMode === "studio" ? draft.registeringStudioName?.trim() || null : null, status: "checkout_pending", currency: quote.currency, quoted_subtotal: quote.subtotal, quoted_discount: quote.discount, quoted_total: quote.total, quote_checksum: quoteChecksum, quoted_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() }).select("id, public_token").single();
    if (cartError || !cart) throw new Error(cartError?.message ?? "Could not create registration cart.");
    cartId = cart.id;

    const personIdMap = new Map<string, string>();
    for (const [index, person] of draft.people.entries()) {
      const { data: row, error } = await supabase.from("event_competition_registration_cart_people").insert({ event_id: event.id, cart_id: cart.id, first_name: person.firstName.trim(), last_name: person.lastName.trim(), email: person.email?.trim().toLowerCase() || null, phone: person.phone?.trim() || null, date_of_birth: person.dateOfBirth || null, person_type: person.personType, wsdc_competitor_id: person.wsdcCompetitorId?.trim() || null, primary_role: person.primaryRole || null, role_points_snapshot: {}, sort_order: index + 1 }).select("id").single();
      if (error || !row) throw new Error(error?.message ?? "Could not save roster.");
      personIdMap.set(person.clientId, row.id);
    }

    const cartEntryIdMap = new Map<string, string>();
    for (const [index, entry] of draft.entries.entries()) {
      const participantNames = entry.participantIds.map((id) => draft.people.find((person) => person.clientId === id)).filter(Boolean).map((person) => `${person?.firstName} ${person?.lastName}`);
      const contest = catalog.contests.find((item) => item.id === entry.contestId);
      const division = catalog.divisions.find((item) => item.id === entry.divisionId);
      const displayName = participantNames.join(" / ") || `${contest?.name ?? "Competition"} — ${division?.name ?? "Entry"}`;
      const { data: row, error } = await supabase.from("event_competition_registration_cart_entries").insert({ event_id: event.id, cart_id: cart.id, program_id: entry.programId, contest_id: entry.contestId, division_id: entry.divisionId, display_name: displayName, routine_title: entry.routineTitle?.trim() || null, routine_duration_seconds: entry.routineDurationSeconds || null, music_title: entry.musicTitle?.trim() || null, music_artist: entry.musicArtist?.trim() || null, notes: entry.notes?.trim() || null, status: "checkout_pending", sort_order: index + 1 }).select("id").single();
      if (error || !row) throw new Error(error?.message ?? "Could not save competition entry.");
      cartEntryIdMap.set(entry.clientId, row.id);
      const peopleRows = entry.participantIds.map((personClientId, personIndex) => ({ event_id: event.id, cart_id: cart.id, cart_entry_id: row.id, cart_person_id: personIdMap.get(personClientId), participant_role: entry.participantRoles[personClientId] || "dancer", sort_order: personIndex + 1 }));
      if (peopleRows.some((item) => !item.cart_person_id)) throw new Error("An entry references a missing roster person.");
      if (peopleRows.length > 0) {
        const { error: peopleError } = await supabase.from("event_competition_registration_cart_entry_people").insert(peopleRows);
        if (peopleError) throw new Error(peopleError.message);
      }
      const effectiveOfferingIds = quote.effectiveOfferingIdsByEntry[entry.clientId] ?? [];
      if (effectiveOfferingIds.length > 0) {
        const { error: danceError } = await supabase.from("event_competition_registration_cart_entry_dances").insert(effectiveOfferingIds.map((offeringId) => ({ event_id: event.id, cart_id: cart.id, cart_entry_id: row.id, division_dance_id: offeringId })));
        if (danceError) throw new Error(danceError.message);
      }
    }

    if (quote.lines.length > 0) {
      const { error: lineError } = await supabase.from("event_competition_registration_cart_price_lines").insert(quote.lines.map((line) => ({ event_id: event.id, cart_id: cart.id, cart_entry_id: line.clientEntryId ? cartEntryIdMap.get(line.clientEntryId) : null, fee_rule_id: line.feeRuleId, line_type: line.lineType, description: line.description, quantity: line.quantity, unit_amount: line.unitAmount, line_amount: line.lineAmount, currency: line.currency, metadata: line.metadata })));
      if (lineError) throw new Error(lineError.message);
    }

    const { data: order, error: orderError } = await supabase.from("event_orders").insert({ event_id: event.id, studio_id: event.studio_id, organizer_id: event.organizer_id, buyer_name: draft.buyerName.trim(), buyer_email: draft.buyerEmail.trim().toLowerCase(), buyer_phone: draft.buyerPhone?.trim() || null, buyer_notes: draft.registrationMode === "studio" ? `Studio registration: ${draft.registeringStudioName}` : null, subtotal_amount: quote.subtotal, discount_amount: quote.discount, total_amount: quote.total, currency: quote.currency, status: quote.total > 0 ? "pending" : "confirmed", payment_status: quote.total > 0 ? "pending" : "paid", expires_at: quote.total > 0 ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null, paid_at: quote.total === 0 ? new Date().toISOString() : null, metadata: { source: "competition_registration", registration_cart_id: cart.id, registration_mode: draft.registrationMode, registering_studio_name: draft.registeringStudioName || null } }).select("id").single();
    if (orderError || !order) throw new Error(orderError?.message ?? "Could not create order.");
    orderId = order.id;
    await supabase.from("event_competition_registration_carts").update({ order_id: order.id }).eq("id", cart.id);

    const buyer = splitName(draft.buyerName);
    const { data: registration, error: registrationError } = await supabase.from("event_registrations").insert({ studio_id: event.studio_id, event_id: event.id, ticket_type_id: null, client_id: null, user_id: null, order_id: order.id, status: quote.total > 0 ? "pending" : "confirmed", attendee_first_name: buyer.firstName || "Competition", attendee_last_name: buyer.lastName || "Registrant", attendee_email: draft.buyerEmail.trim().toLowerCase(), attendee_phone: draft.buyerPhone?.trim() || null, quantity: draft.entries.length, unit_price: quote.total, total_price: quote.total, total_amount: quote.total, currency: quote.currency, payment_status: quote.total > 0 ? "pending" : "paid", registration_source: "competition_registration", source: "competition_registration", notes: draft.registrationMode === "studio" ? `Studio: ${draft.registeringStudioName}` : null }).select("id").single();
    if (registrationError || !registration) throw new Error(registrationError?.message ?? "Could not create registration.");

    const attendeeIdMap = new Map<string, string>();
    for (const [index, person] of draft.people.entries()) {
      const { data: attendee, error: attendeeError } = await supabase.from("event_registration_attendees").insert({ registration_id: registration.id, event_id: event.id, ticket_type_id: null, first_name: person.firstName.trim(), last_name: person.lastName.trim(), email: person.email?.trim().toLowerCase() || null, phone: person.phone?.trim() || null, attendee_role: person.personType, sort_order: index + 1 }).select("id").single();
      if (attendeeError || !attendee) throw new Error(attendeeError?.message ?? "Could not save participant.");
      attendeeIdMap.set(person.clientId, attendee.id);
    }

    const officialEntryMap = new Map<string, string>();
    for (const [index, entry] of draft.entries.entries()) {
      const cartEntryId = cartEntryIdMap.get(entry.clientId);
      const participantNames = entry.participantIds.map((id) => draft.people.find((person) => person.clientId === id)).filter(Boolean).map((person) => `${person?.firstName} ${person?.lastName}`);
      const contest = catalog.contests.find((item) => item.id === entry.contestId);
      const division = catalog.divisions.find((item) => item.id === entry.divisionId);
      const displayName = participantNames.join(" / ") || `${contest?.name ?? "Competition"} — ${division?.name ?? "Entry"}`;
      const { data: official, error: officialError } = await supabase.from("event_competition_entries").insert({ event_id: event.id, program_id: entry.programId, division_id: entry.divisionId, registration_id: registration.id, order_id: order.id, registration_cart_id: cart.id, display_name: displayName, represented_studio_name: draft.registrationMode === "studio" ? draft.registeringStudioName?.trim() || null : null, status: quote.total > 0 ? "pending" : "confirmed", eligibility_status: "unverified", registration_channel: draft.registrationMode === "studio" ? "studio" : "student_self", submitted_at: new Date().toISOString(), confirmed_at: quote.total === 0 ? new Date().toISOString() : null, sort_order: index + 1, metadata: { cart_entry_id: cartEntryId, contest_id: entry.contestId, routine_title: entry.routineTitle || null, routine_duration_seconds: entry.routineDurationSeconds || null, music_title: entry.musicTitle || null, music_artist: entry.musicArtist || null } }).select("id").single();
      if (officialError || !official) throw new Error(officialError?.message ?? "Could not materialize competition entry.");
      officialEntryMap.set(entry.clientId, official.id);
      await supabase.from("event_competition_registration_cart_entries").update({ official_entry_id: official.id }).eq("id", cartEntryId);
      const participantRows = entry.participantIds.map((personClientId, personIndex) => { const person = draft.people.find((item) => item.clientId === personClientId); const registeredRole = entry.participantRoles[personClientId] || "dancer"; return { event_id: event.id, entry_id: official.id, registration_attendee_id: attendeeIdMap.get(personClientId), participant_role: registeredRole, display_name: person ? `${person.firstName} ${person.lastName}` : "Participant", registry_member_id: person?.wsdcCompetitorId?.trim() || null, competition_role_type: person?.primaryRole && ["leader", "follower"].includes(registeredRole) ? (person.primaryRole === registeredRole ? "primary" : "secondary") : null, role_level_snapshot: { primary_role: person?.primaryRole || null, registered_role: registeredRole }, sort_order: personIndex + 1 }; });
      if (participantRows.length > 0) {
        const { error: participantError } = await supabase.from("event_competition_entry_participants").insert(participantRows);
        if (participantError) throw new Error(participantError.message);
      }
      const offeringIds = quote.effectiveOfferingIdsByEntry[entry.clientId] ?? [];
      if (offeringIds.length > 0) {
        const { error: officialDanceError } = await supabase.from("event_competition_entry_dances").insert(offeringIds.map((divisionDanceId, danceIndex) => ({ event_id: event.id, entry_id: official.id, division_dance_id: divisionDanceId, dance_key: "pending", dance_label: "Pending", status: quote.total > 0 ? "registered" : "confirmed", sort_order: danceIndex + 1 })));
        if (officialDanceError) throw new Error(officialDanceError.message);
      }
    }

    const orderItems: any[] = draft.entries.map((entry) => {
      const contest = catalog.contests.find((item) => item.id === entry.contestId);
      const division = catalog.divisions.find((item) => item.id === entry.divisionId);
      const entryLines = quote.lines.filter((line) => line.clientEntryId === entry.clientId && line.lineType !== "discount");
      const entryTotal = Number(entryLines.reduce((sum, line) => sum + line.lineAmount, 0).toFixed(2));
      return { order_id: order.id, event_id: event.id, item_type: "competition_entry", reference_id: officialEntryMap.get(entry.clientId), ticket_type_id: null, coach_slot_id: null, description: `${event.name} — ${contest?.name ?? "Competition Entry"} — ${division?.name ?? "Division"}`, quantity: 1, unit_price: entryTotal, total_price: entryTotal, currency: quote.currency, attendee_names: entry.participantIds.map((id) => { const person = draft.people.find((item) => item.clientId === id); return person ? `${person.firstName} ${person.lastName}` : "Participant"; }), metadata: { registration_id: registration.id, registration_cart_id: cart.id, contest_id: entry.contestId, division_id: entry.divisionId, price_lines: entryLines } };
    });
    const cartLevelLines = quote.lines.filter((line) => !line.clientEntryId);
    for (const line of cartLevelLines) orderItems.push({ order_id: order.id, event_id: event.id, item_type: "add_on", reference_id: null, ticket_type_id: null, coach_slot_id: null, description: `${event.name} — ${line.description}`, quantity: line.quantity, unit_price: line.lineType === "discount" ? 0 : line.unitAmount, total_price: line.lineType === "discount" ? 0 : line.lineAmount, currency: quote.currency, attendee_names: [], metadata: { fee_rule_id: line.feeRuleId, line_type: line.lineType, discount_amount: line.lineType === "discount" ? line.lineAmount : 0 } });
    const { error: itemsError } = await supabase.from("event_order_items").insert(orderItems);
    if (itemsError) throw new Error(itemsError.message);

    if (requiredDocuments.length > 0) {
      const signerIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
      const userAgent = request.headers.get("user-agent") || null;
      for (const requirement of requiredDocuments as any[]) {
        const { data: assignment, error: assignmentError } = await supabase.from("document_assignments").insert({ template_id: requirement.template_id, template_version_id: requirement.template_version_id, studio_id: event.studio_id, organizer_id: event.organizer_id, event_id: event.id, event_registration_id: registration.id, assigned_to_email: draft.buyerEmail.trim().toLowerCase(), status: "signed", signed_at: new Date().toISOString() }).select("id").single();
        if (assignmentError || !assignment) throw new Error(assignmentError?.message ?? "Could not save document assignment.");
        const { error: signatureError } = await supabase.from("document_signatures").insert({ assignment_id: assignment.id, template_id: requirement.template_id, template_version_id: requirement.template_version_id, studio_id: event.studio_id, organizer_id: event.organizer_id, event_id: event.id, event_registration_id: registration.id, signer_name: body.signatureName?.trim() || draft.buyerName.trim(), signer_email: draft.buyerEmail.trim().toLowerCase(), signed_body: requirement.template.body, signature_text: body.signatureName?.trim() || draft.buyerName.trim(), consent_text: "I have reviewed the required event documents, agree to sign electronically, and confirm that my typed name is my signature.", ip_address: signerIp, user_agent: userAgent });
        if (signatureError) throw new Error(signatureError.message);
      }
    }

    const successUrl = absoluteUrl(request, `/events/${encodeURIComponent(slug)}/competition/register?success=paid&order=${encodeURIComponent(order.id)}`);
    if (quote.total === 0) {
      await supabase.from("event_competition_registration_carts").update({ status: "submitted", submitted_at: new Date().toISOString() }).eq("id", cart.id);
      await supabase.from("event_competition_registration_cart_entries").update({ status: "submitted" }).eq("cart_id", cart.id);
      return NextResponse.json({ url: successUrl });
    }

    const studio = one(event.studios as any);
    if (!studio?.stripe_connected_account_id || !studio.stripe_connect_charges_enabled || !studio.stripe_connect_payouts_enabled || !studio.stripe_connect_onboarding_complete) throw new Error("Online payments are not enabled for this event.");
    const feePercent = await platformFeePercent(supabase, event.studio_id);
    const appFee = applicationFee(quote.total, feePercent);
    const stripe = getStripe();
    const stripeItems = [{ quantity: 1, price_data: { currency: quote.currency.toLowerCase(), unit_amount: Math.round(quote.total * 100), product_data: { name: `${event.name} — Competition registration (${draft.entries.length} entries)` } } }];
    const session = await stripe.checkout.sessions.create({ mode: "payment", customer_email: draft.buyerEmail.trim().toLowerCase(), success_url: successUrl, cancel_url: absoluteUrl(request, `/api/events/cart/release?orderId=${encodeURIComponent(order.id)}&eventSlug=${encodeURIComponent(slug)}`), line_items: stripeItems, payment_intent_data: { ...(appFee > 0 ? { application_fee_amount: appFee } : {}), transfer_data: { destination: studio.stripe_connected_account_id }, metadata: { source: "event_cart_order", studio_id: event.studio_id, event_id: event.id, event_slug: slug, order_id: order.id, registration_id: registration.id, registration_ids: registration.id, registration_cart_id: cart.id, connected_account_id: studio.stripe_connected_account_id } }, metadata: { source: "event_cart_order", studio_id: event.studio_id, event_id: event.id, event_slug: slug, order_id: order.id, registration_id: registration.id, registration_ids: registration.id, registration_cart_id: cart.id, buyer_email: draft.buyerEmail.trim().toLowerCase(), connected_account_id: studio.stripe_connected_account_id } });
    if (!session.url) throw new Error("Stripe did not return a checkout URL.");
    await supabase.from("event_orders").update({ stripe_checkout_session_id: session.id }).eq("id", order.id);
    await supabase.from("event_registrations").update({ stripe_checkout_session_id: session.id }).eq("id", registration.id);
    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("competition checkout failed", error);
    const supabase = adminClient();
    if (orderId) {
      await supabase.from("event_registrations").update({ status: "cancelled", payment_status: "failed", cancelled_at: new Date().toISOString() }).eq("order_id", orderId).eq("status", "pending");
      await supabase.from("event_orders").update({ status: "cancelled", payment_status: "failed", cancelled_at: new Date().toISOString() }).eq("id", orderId);
    }
    if (cartId) {
      await supabase.from("event_competition_registration_carts").update({ status: "cancelled" }).eq("id", cartId);
      await supabase.from("event_competition_registration_cart_entries").update({ status: "cancelled" }).eq("cart_id", cartId);
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Competition checkout failed." }, { status: 500 });
  }
}
