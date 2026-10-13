import type { SupabaseClient } from "@supabase/supabase-js";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import {
  buildEventConfirmedEmailTemplate,
  buildEventConfirmedSmsTemplate,
} from "@/lib/notifications/templates";
import { resolveEventEmailBranding } from "@/lib/notifications/event-email-branding";
import { resolveEventMerchantLine } from "@/lib/notifications/merchantIdentity";

/**
 * Post-payment side effects for event registrations and event cart orders (studio CRM lead, organizer contact,
 * branded confirmations). Moved verbatim from src/app/api/payments/webhook/route.ts in PAY-WH-1 so they can run from
 * the durable settlement outbox (src/lib/events/settlementOutbox.ts) as well as from the legacy registration paths.
 */

function getAppUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "http://localhost:3000"
  );
}

type EventRegistrationCrmCaptureRow = {
  id: string;
  event_id: string;
  studio_id: string | null;
  client_id: string | null;
  organizer_contact_id?: string | null;
  order_id?: string | null;
  ticket_type_id?: string | null;
  status?: string | null;
  payment_status?: string | null;
  total_amount?: number | null;
  total_price?: number | null;
  currency?: string | null;
  checked_in_at?: string | null;
  created_at?: string | null;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  events:
    | {
        id: string;
        name: string;
        slug: string | null;
        studio_id: string | null;
        organizer_id: string | null;
      }
    | {
        id: string;
        name: string;
        slug: string | null;
        studio_id: string | null;
        organizer_id: string | null;
      }[]
    | null;
};

function getSingleRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function normalizeEmail(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

export async function safeCaptureStudioEventRegistrationLead(params: {
  supabase: SupabaseClient;
  registrationId: string;
}) {
  try {
    const { data: registration, error: registrationError } =
      await params.supabase
        .from("event_registrations")
        .select(
          `
        id,
        event_id,
        studio_id,
        client_id,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        events (
          id,
          name,
          slug,
          studio_id,
          organizer_id
        )
      `,
        )
        .eq("id", params.registrationId)
        .maybeSingle();

    if (registrationError || !registration) {
      console.error(
        "event registration CRM capture lookup failed:",
        registrationError?.message ?? "Registration not found",
      );
      return;
    }

    const typedRegistration = registration as EventRegistrationCrmCaptureRow;
    const event = getSingleRelation(typedRegistration.events);

    if (!event) {
      console.error("event registration CRM capture missing event");
      return;
    }

    // Organizer-owned events are intentionally not pushed into the linked studio CRM yet.
    // They should remain organizer-scoped until Organizer Contacts/Campaigns is built.
    if (event.organizer_id) {
      return;
    }

    const studioId = event.studio_id ?? typedRegistration.studio_id;
    const email = normalizeEmail(typedRegistration.attendee_email);

    if (!studioId || !email) {
      return;
    }

    const firstName =
      (typedRegistration.attendee_first_name ?? "").trim() || "Event";
    const lastName =
      (typedRegistration.attendee_last_name ?? "").trim() || "Registrant";

    let clientId = typedRegistration.client_id;

    if (!clientId) {
      const { data: existingClients, error: existingClientError } =
        await params.supabase
          .from("clients")
          .select("id, referral_source, source_system, status")
          .eq("studio_id", studioId)
          .ilike("email", email)
          .order("created_at", { ascending: true })
          .limit(1);

      if (existingClientError) {
        console.error(
          "event registration CRM capture client lookup failed:",
          existingClientError.message,
        );
        return;
      }

      const existingClient = existingClients?.[0] ?? null;

      if (existingClient) {
        clientId = existingClient.id;

        const clientUpdatePayload: Record<string, string | null> = {};

        if (!existingClient.referral_source) {
          clientUpdatePayload.referral_source = "Event Registration";
        }

        if (!existingClient.source_system) {
          clientUpdatePayload.source_system = "event_registration";
        }

        if (Object.keys(clientUpdatePayload).length > 0) {
          const { error: clientUpdateError } = await params.supabase
            .from("clients")
            .update(clientUpdatePayload)
            .eq("id", existingClient.id);

          if (clientUpdateError) {
            console.error(
              "event registration CRM capture client update failed:",
              clientUpdateError.message,
            );
          }
        }
      } else {
        const { data: insertedClient, error: insertClientError } =
          await params.supabase
            .from("clients")
            .insert({
              studio_id: studioId,
              first_name: firstName,
              last_name: lastName,
              email,
              phone: typedRegistration.attendee_phone || null,
              status: "lead",
              referral_source: "Event Registration",
              source_system: "event_registration",
              notes: `Created from event registration for ${event.name}.`,
            })
            .select("id")
            .single();

        if (insertClientError || !insertedClient) {
          console.error(
            "event registration CRM capture client insert failed:",
            insertClientError?.message ?? "Client not created",
          );
          return;
        }

        clientId = insertedClient.id;
      }
    }

    if (clientId) {
      const { error: registrationClientUpdateError } = await params.supabase
        .from("event_registrations")
        .update({ client_id: clientId })
        .eq("id", typedRegistration.id)
        .is("client_id", null);

      if (registrationClientUpdateError) {
        console.error(
          "event registration CRM capture registration link failed:",
          registrationClientUpdateError.message,
        );
      }

      const { error: notificationError } = await params.supabase
        .from("notifications")
        .insert({
          studio_id: studioId,
          client_id: clientId,
          type: "event_registration",
          title: "New event registration",
          body: `${firstName} ${lastName} registered for ${event.name}.`,
        });

      // Keep webhook finalization safe even if notification type constraints need a later schema update.
      if (notificationError) {
        console.error(
          "event registration notification insert failed:",
          notificationError.message,
        );
      }
    }
  } catch (error) {
    console.error("event registration CRM capture failed:", error);
  }
}

export async function safeCaptureOrganizerEventRegistrationContact(params: {
  supabase: SupabaseClient;
  registrationId: string;
}) {
  try {
    const { data: registration, error: registrationError } =
      await params.supabase
        .from("event_registrations")
        .select(
          `
        id,
        event_id,
        studio_id,
        client_id,
        organizer_contact_id,
        order_id,
        ticket_type_id,
        status,
        payment_status,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        total_amount,
        total_price,
        currency,
        checked_in_at,
        created_at,
        events (
          id,
          name,
          slug,
          studio_id,
          organizer_id
        )
      `,
        )
        .eq("id", params.registrationId)
        .maybeSingle();

    if (registrationError || !registration) {
      console.error(
        "organizer contact capture lookup failed:",
        registrationError?.message ?? "Registration not found",
      );
      return;
    }

    const typedRegistration = registration as EventRegistrationCrmCaptureRow;
    const event = getSingleRelation(typedRegistration.events);
    const organizerId = event?.organizer_id ?? null;
    const email = normalizeEmail(typedRegistration.attendee_email);

    if (!event || !organizerId || !email) {
      return;
    }

    const firstName =
      (typedRegistration.attendee_first_name ?? "").trim() || null;
    const lastName =
      (typedRegistration.attendee_last_name ?? "").trim() || null;
    const phone = (typedRegistration.attendee_phone ?? "").trim() || null;
    const nowIso = new Date().toISOString();
    const amount = Number(
      typedRegistration.total_amount ?? typedRegistration.total_price ?? 0,
    );
    const currency = (typedRegistration.currency || "USD").toUpperCase();

    const { data: existingContacts, error: existingContactError } =
      await params.supabase
        .from("organizer_contacts")
        .select("id, first_seen_at, first_name, last_name, phone")
        .eq("organizer_id", organizerId)
        .ilike("email", email)
        .order("created_at", { ascending: true })
        .limit(1);

    if (existingContactError) {
      console.error(
        "organizer contact lookup failed:",
        existingContactError.message,
      );
      return;
    }

    let contactId = existingContacts?.[0]?.id ?? null;

    if (contactId) {
      const existingContact = existingContacts?.[0];
      const { error: contactUpdateError } = await params.supabase
        .from("organizer_contacts")
        .update({
          first_name: existingContact?.first_name || firstName,
          last_name: existingContact?.last_name || lastName,
          phone: existingContact?.phone || phone,
          last_seen_at: nowIso,
          last_event_id: event.id,
          last_registration_id: typedRegistration.id,
          currency,
          updated_at: nowIso,
        })
        .eq("id", contactId);

      if (contactUpdateError) {
        console.error(
          "organizer contact update failed:",
          contactUpdateError.message,
        );
        return;
      }
    } else {
      const { data: insertedContact, error: contactInsertError } =
        await params.supabase
          .from("organizer_contacts")
          .insert({
            organizer_id: organizerId,
            email,
            first_name: firstName,
            last_name: lastName,
            phone,
            source: "event_registration",
            first_seen_at: nowIso,
            last_seen_at: nowIso,
            last_event_id: event.id,
            last_registration_id: typedRegistration.id,
            currency,
            metadata: {
              event_name: event.name,
              event_slug: event.slug,
            },
          })
          .select("id")
          .single();

      if (contactInsertError || !insertedContact) {
        console.error(
          "organizer contact insert failed:",
          contactInsertError?.message ?? "Contact not created",
        );
        return;
      }

      contactId = insertedContact.id;
    }

    if (!contactId) {
      return;
    }

    const { error: linkError } = await params.supabase
      .from("organizer_contact_registrations")
      .upsert(
        {
          organizer_contact_id: contactId,
          organizer_id: organizerId,
          event_id: typedRegistration.event_id,
          registration_id: typedRegistration.id,
          order_id: typedRegistration.order_id ?? null,
          ticket_type_id: typedRegistration.ticket_type_id ?? null,
          status: typedRegistration.status ?? null,
          payment_status: typedRegistration.payment_status ?? null,
          total_amount: amount,
          currency,
          checked_in_at: typedRegistration.checked_in_at ?? null,
          registered_at: typedRegistration.created_at ?? nowIso,
          updated_at: nowIso,
        },
        { onConflict: "registration_id" },
      );

    if (linkError) {
      console.error(
        "organizer contact registration link failed:",
        linkError.message,
      );
    }

    const { error: registrationUpdateError } = await params.supabase
      .from("event_registrations")
      .update({ organizer_contact_id: contactId })
      .eq("id", typedRegistration.id)
      .is("organizer_contact_id", null);

    if (registrationUpdateError) {
      console.error(
        "organizer contact registration update failed:",
        registrationUpdateError.message,
      );
    }

    const { data: contactRollupRows, error: rollupError } =
      await params.supabase
        .from("organizer_contact_registrations")
        .select("payment_status, total_amount, currency")
        .eq("organizer_contact_id", contactId);

    if (rollupError) {
      console.error("organizer contact rollup failed:", rollupError.message);
      return;
    }

    const totalRegistrations = contactRollupRows?.length ?? 0;
    const paidRows = (contactRollupRows ?? []).filter(
      (row) =>
        row.payment_status === "paid" || row.payment_status === "partial",
    );
    const totalPaidRegistrations = paidRows.length;
    const totalSpend = paidRows.reduce(
      (sum, row) => sum + Number(row.total_amount ?? 0),
      0,
    );

    const { error: rollupUpdateError } = await params.supabase
      .from("organizer_contacts")
      .update({
        total_registrations: totalRegistrations,
        total_paid_registrations: totalPaidRegistrations,
        total_spend: totalSpend,
        currency,
        last_seen_at: nowIso,
        last_event_id: event.id,
        last_registration_id: typedRegistration.id,
        updated_at: nowIso,
      })
      .eq("id", contactId);

    if (rollupUpdateError) {
      console.error(
        "organizer contact rollup update failed:",
        rollupUpdateError.message,
      );
    }
  } catch (error) {
    console.error("organizer contact capture failed:", error);
  }
}

type PaidEventRegistrationConfirmationRow = {
  id: string;
  studio_id: string;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  quantity: number;
  total_price: number;
  currency: string;
  payment_status: string | null;
  events:
    | { id: string; slug: string; name: string; organizer_id: string | null }
    | { id: string; slug: string; name: string; organizer_id: string | null }[]
    | null;
  event_ticket_types: { name: string } | { name: string }[] | null;
  event_registration_attendees: Array<{
    first_name: string;
    last_name: string;
    ticket_code: string | null;
  }> | null;
};

export async function safeQueuePaidEventRegistrationConfirmation(params: {
  supabase: SupabaseClient;
  registrationId: string;
}) {
  try {
    const { data, error } = await params.supabase
      .from("event_registrations")
      .select(
        `
        id,
        studio_id,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        quantity,
        total_price,
        currency,
        payment_status,
        events (
          id,
          slug,
          name,
          organizer_id
        ),
        event_ticket_types (
          name
        ),
        event_registration_attendees (
          first_name,
          last_name,
          ticket_code
        )
      `,
      )
      .eq("id", params.registrationId)
      .single();

    if (error || !data) {
      console.error(
        "paid event confirmation lookup failed:",
        error?.message ?? "Registration not found",
      );
      return;
    }

    const registration = data as PaidEventRegistrationConfirmationRow;

    const eventValue = Array.isArray(registration.events)
      ? registration.events[0]
      : registration.events;

    const ticketTypeValue = Array.isArray(registration.event_ticket_types)
      ? registration.event_ticket_types[0]
      : registration.event_ticket_types;

    if (!eventValue) {
      console.error("paid event confirmation lookup missing event");
      return;
    }

    const eventUrl = `${getAppUrl()}/events/${encodeURIComponent(
      eventValue.slug,
    )}`;

    const attendeeRows = Array.isArray(registration.event_registration_attendees)
      ? registration.event_registration_attendees
      : [];

    const ticketCodes = attendeeRows
      .map((attendee) => {
        const name = `${attendee.first_name ?? ""} ${
          attendee.last_name ?? ""
        }`.trim();

        const code =
          typeof attendee.ticket_code === "string"
            ? attendee.ticket_code.trim()
            : "";

        return code ? { name: name || "Attendee", code } : null;
      })
      .filter(Boolean) as Array<{ name: string; code: string }>;

    const branding = await resolveEventEmailBranding({
      eventId: eventValue.id,
      studioId: registration.studio_id,
      organizerId: eventValue.organizer_id ?? null,
    });

    // PAY-DC-3: merchant line from persisted facts only (paid status, total, stored event_payments owner).
    const merchantLine = await resolveEventMerchantLine({
      supabase: params.supabase,
      registrationIds: [registration.id],
      paymentStatus: registration.payment_status,
      totalAmount: registration.total_price,
      branding,
    });

    const emailTemplate = buildEventConfirmedEmailTemplate({
      eventName: eventValue.name,
      attendeeFirstName: registration.attendee_first_name,
      attendeeLastName: registration.attendee_last_name,
      ticketTypeName: ticketTypeValue?.name ?? "Event ticket",
      quantity: registration.quantity ?? 1,
      totalPrice: Number(registration.total_price ?? 0),
      currency: registration.currency || "USD",
      eventUrl,
      ticketCodes,
      brandName: branding.name,
      brandLogoUrl: branding.logoUrl,
      merchantLine,
    });

    const smsBody = buildEventConfirmedSmsTemplate({
      eventName: eventValue.name,
      attendeeFirstName: registration.attendee_first_name,
      attendeeLastName: registration.attendee_last_name,
      ticketTypeName: ticketTypeValue?.name ?? "Event ticket",
      quantity: registration.quantity ?? 1,
      totalPrice: Number(registration.total_price ?? 0),
      currency: registration.currency || "USD",
      eventUrl,
    });

    await Promise.allSettled([
      queueOutboundDelivery({
        studioId: registration.studio_id,
        channel: "email",
        templateKey: "event_registration_confirmed",
        recipientEmail: registration.attendee_email,
        subject: emailTemplate.subject,
        bodyText: emailTemplate.bodyText,
        bodyHtml: emailTemplate.bodyHtml,
        relatedTable: "event_registrations",
        relatedId: registration.id,
        dedupeKey: `event_registration_confirmed:email:${registration.id}`,
        senderDisplayName: branding.senderDisplayName,
      }),
      queueOutboundDelivery({
        studioId: registration.studio_id,
        channel: "sms",
        templateKey: "event_registration_confirmed",
        recipientPhone: registration.attendee_phone,
        bodyText: smsBody,
        relatedTable: "event_registrations",
        relatedId: registration.id,
        dedupeKey: `event_registration_confirmed:sms:${registration.id}`,
      }),
    ]);
  } catch (error) {
    console.error("queue paid event confirmation failed:", error);
  }
}

type EventOrderItemConfirmationRow = {
  item_type: string | null;
  description: string | null;
  quantity: number | null;
  total_price: number | null;
  currency: string | null;
  attendee_names: unknown;
};

type EventOrderRegistrationConfirmationRow = {
  id: string;
  studio_id: string | null;
  attendee_first_name: string | null;
  attendee_last_name: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
  quantity: number | null;
  total_price: number | null;
  total_amount: number | null;
  currency: string | null;
  event_ticket_types:
    { name: string | null } | { name: string | null }[] | null;
  event_registration_attendees: Array<{
    first_name: string | null;
    last_name: string | null;
    ticket_code: string | null;
  }> | null;
};

export async function safeQueuePaidEventCartOrderConfirmation(params: {
  supabase: SupabaseClient;
  orderId: string;
}) {
  try {
    const { data: order, error: orderError } = await params.supabase
      .from("event_orders")
      .select(
        `
        id,
        studio_id,
        buyer_name,
        buyer_email,
        buyer_phone,
        total_amount,
        currency,
        payment_status,
        events (
          id,
          slug,
          name,
          organizer_id
        )
      `,
      )
      .eq("id", params.orderId)
      .maybeSingle();

    if (orderError || !order) {
      console.error(
        "paid event cart confirmation order lookup failed:",
        orderError?.message ?? "Order not found",
      );
      return;
    }

    const eventValue = Array.isArray(order.events)
      ? order.events[0]
      : order.events;

    if (!eventValue) {
      console.error("paid event cart confirmation missing event");
      return;
    }

    const { data: registrations, error: registrationsError } =
      await params.supabase
        .from("event_registrations")
        .select(
          `
        id,
        studio_id,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        quantity,
        total_price,
        total_amount,
        currency,
        event_ticket_types (
          name
        ),
        event_registration_attendees (
          first_name,
          last_name,
          ticket_code
        )
      `,
        )
        .eq("order_id", params.orderId)
        .order("created_at", { ascending: true });

    if (registrationsError) {
      console.error(
        "paid event cart confirmation registrations lookup failed:",
        registrationsError.message,
      );
      return;
    }

    const typedRegistrations = (registrations ??
      []) as EventOrderRegistrationConfirmationRow[];
    const primaryRegistration = typedRegistrations[0] ?? null;

    if (!primaryRegistration) {
      console.error("paid event cart confirmation missing registrations");
      return;
    }

    const { data: orderItems, error: orderItemsError } = await params.supabase
      .from("event_order_items")
      .select(
        "item_type, description, quantity, total_price, currency, attendee_names, created_at",
      )
      .eq("order_id", params.orderId)
      .order("created_at", { ascending: true });

    if (orderItemsError) {
      console.error(
        "paid event cart confirmation order items lookup failed:",
        orderItemsError.message,
      );
      return;
    }

    const typedOrderItems = (orderItems ??
      []) as EventOrderItemConfirmationRow[];
    const currency = (
      order.currency ||
      primaryRegistration.currency ||
      "USD"
    ).toUpperCase();
    const eventUrl = `${getAppUrl()}/events/${encodeURIComponent(eventValue.slug)}`;
    const buyerName = String(order.buyer_name || "").trim();
    const firstName =
      buyerName.split(/\s+/)[0] ||
      primaryRegistration.attendee_first_name ||
      "there";
    const lastName =
      buyerName.split(/\s+/).slice(1).join(" ") ||
      primaryRegistration.attendee_last_name ||
      "";

    const purchasedItems = typedOrderItems.map((item) => ({
      name:
        item.description ||
        (item.item_type === "coach_slot" ? "Private lesson" : "Event ticket"),
      quantity: Number(item.quantity ?? 1),
      totalPrice: Number(item.total_price ?? 0),
    }));

    const registrationItems = typedRegistrations.map((registration) => {
      const ticketType = Array.isArray(registration.event_ticket_types)
        ? registration.event_ticket_types[0]
        : registration.event_ticket_types;

      return {
        name: ticketType?.name || "Event ticket",
        quantity: Number(registration.quantity ?? 1),
        totalPrice: Number(
          registration.total_price ?? registration.total_amount ?? 0,
        ),
      };
    });

    const finalPurchasedItems =
      purchasedItems.length > 0 ? purchasedItems : registrationItems;
    const ticketCodes = typedRegistrations.flatMap((registration) => {
      const attendeeRows = Array.isArray(
        registration.event_registration_attendees,
      )
        ? registration.event_registration_attendees
        : [];

      return attendeeRows
        .map((attendee) => {
          const code =
            typeof attendee.ticket_code === "string"
              ? attendee.ticket_code.trim()
              : "";
          if (!code) return null;

          const name =
            `${attendee.first_name ?? ""} ${attendee.last_name ?? ""}`.trim();
          return { name: name || "Attendee", code };
        })
        .filter(Boolean) as Array<{ name: string; code: string }>;
    });

    const ticketQuantity = registrationItems.reduce(
      (sum, item) => sum + Number(item.quantity ?? 0),
      0,
    );
    const coachSlotQuantity = typedOrderItems
      .filter((item) => item.item_type === "coach_slot")
      .reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
    const totalQuantity = ticketQuantity + coachSlotQuantity || 1;
    const totalPrice = Number(order.total_amount ?? 0);
    const firstTicketName = registrationItems[0]?.name ?? "Event registration";

    const branding = await resolveEventEmailBranding({
      eventId: eventValue.id,
      studioId: order.studio_id ?? primaryRegistration.studio_id,
      organizerId: eventValue.organizer_id ?? null,
    });

    // PAY-DC-3: merchant line from persisted facts only (order paid status/total, stored event_payments owners).
    const merchantLine = await resolveEventMerchantLine({
      supabase: params.supabase,
      registrationIds: typedRegistrations.map((registration) => registration.id),
      paymentStatus: order.payment_status,
      totalAmount: order.total_amount,
      branding,
    });

    const emailTemplate = buildEventConfirmedEmailTemplate({
      eventName: eventValue.name,
      attendeeFirstName: firstName,
      attendeeLastName: lastName,
      ticketTypeName: firstTicketName,
      quantity: totalQuantity,
      totalPrice,
      currency,
      eventUrl,
      ticketCodes,
      purchasedItems: finalPurchasedItems,
      brandName: branding.name,
      brandLogoUrl: branding.logoUrl,
      merchantLine,
    });

    const smsBody = buildEventConfirmedSmsTemplate({
      eventName: eventValue.name,
      attendeeFirstName: firstName,
      attendeeLastName: lastName,
      ticketTypeName: firstTicketName,
      quantity: totalQuantity,
      totalPrice,
      currency,
      eventUrl,
    });

    await Promise.allSettled([
      queueOutboundDelivery({
        studioId: order.studio_id ?? primaryRegistration.studio_id,
        channel: "email",
        templateKey: "event_registration_confirmed",
        recipientEmail: order.buyer_email ?? primaryRegistration.attendee_email,
        subject: emailTemplate.subject,
        bodyText: emailTemplate.bodyText,
        bodyHtml: emailTemplate.bodyHtml,
        relatedTable: "event_registrations",
        relatedId: primaryRegistration.id,
        dedupeKey: `event_cart_order_confirmed:email:${order.id}`,
        senderDisplayName: branding.senderDisplayName,
      }),
      queueOutboundDelivery({
        studioId: order.studio_id ?? primaryRegistration.studio_id,
        channel: "sms",
        templateKey: "event_registration_confirmed",
        recipientPhone: order.buyer_phone ?? primaryRegistration.attendee_phone,
        bodyText: smsBody,
        relatedTable: "event_registrations",
        relatedId: primaryRegistration.id,
        dedupeKey: `event_cart_order_confirmed:sms:${order.id}`,
      }),
    ]);
  } catch (error) {
    console.error("queue paid event cart order confirmation failed:", error);
  }
}
