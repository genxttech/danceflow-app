import { createAdminClient } from "@/lib/supabase/admin";
import { Resend } from "resend";
import twilio from "twilio";

type OutboundPayload = Record<string, unknown> | null;

type OutboundDeliveryRow = {
  id: string;
  studio_id: string;
  channel: "email" | "sms";
  template_key: string;
  recipient_email: string | null;
  recipient_phone: string | null;
  subject: string | null;
  body_text: string | null;
  payload: OutboundPayload;
  status: "queued" | "sent" | "failed" | "skipped";
};

type DispatchResult =
  | { ok: true; providerMessageId?: string | null }
  | { ok: false; error: string };

type RenderedMessage = {
  subject: string;
  bodyText: string;
};

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Missing RESEND_API_KEY.");
  }
  return new Resend(apiKey);
}

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new Error("Missing Twilio credentials.");
  }

  return twilio(accountSid, authToken);
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function renderAppointmentMessage(row: OutboundDeliveryRow): RenderedMessage | null {
  const payload = row.payload ?? {};

  const appointmentLabel =
    asString(payload.appointmentLabel) || "Appointment";
  const startsAt = asString(payload.startsAt);
  const endsAt = asString(payload.endsAt);
  const clientFirstName = asString(payload.clientFirstName);
  const instructorFirstName = asString(payload.instructorFirstName);
  const instructorLastName = asString(payload.instructorLastName);
  const roomName = asString(payload.roomName);

  const whenText = startsAt ? formatDateTime(startsAt) : "your scheduled time";
  const endText = endsAt ? formatDateTime(endsAt) : "";
  const instructorText =
    instructorFirstName || instructorLastName
      ? [instructorFirstName, instructorLastName].filter(Boolean).join(" ")
      : "";
  const greetingName = clientFirstName || "there";

  let subject = "DanceFlow Appointment";
  let bodyText = `Hi ${greetingName},\n\nThis is an update about your appointment.`;

  if (row.template_key === "appointment_confirmed") {
    subject = `${appointmentLabel} Confirmed`;
    bodyText = [
      `Hi ${greetingName},`,
      "",
      `Your ${appointmentLabel.toLowerCase()} is confirmed for ${whenText}.`,
      endText ? `It is scheduled to end at ${endText}.` : "",
      instructorText ? `Instructor: ${instructorText}.` : "",
      roomName ? `Location: ${roomName}.` : "",
      "",
      "We look forward to seeing you.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (row.template_key === "appointment_rescheduled") {
    subject = `${appointmentLabel} Rescheduled`;
    bodyText = [
      `Hi ${greetingName},`,
      "",
      `Your ${appointmentLabel.toLowerCase()} has been rescheduled to ${whenText}.`,
      endText ? `It is scheduled to end at ${endText}.` : "",
      instructorText ? `Instructor: ${instructorText}.` : "",
      roomName ? `Location: ${roomName}.` : "",
      "",
      "Please contact the studio if you have any questions.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (row.template_key === "appointment_cancelled") {
    subject = `${appointmentLabel} Cancelled`;
    bodyText = [
      `Hi ${greetingName},`,
      "",
      `Your ${appointmentLabel.toLowerCase()} scheduled for ${whenText} has been cancelled.`,
      instructorText ? `Instructor: ${instructorText}.` : "",
      roomName ? `Location: ${roomName}.` : "",
      "",
      "Please contact the studio if you would like to reschedule.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (
    row.template_key !== "appointment_confirmed" &&
    row.template_key !== "appointment_rescheduled" &&
    row.template_key !== "appointment_cancelled"
  ) {
    return null;
  }

  return { subject, bodyText };
}

function renderMessage(row: OutboundDeliveryRow): RenderedMessage {
  if (row.subject && row.body_text) {
    return {
      subject: row.subject,
      bodyText: row.body_text,
    };
  }

  const appointmentMessage = renderAppointmentMessage(row);
  if (appointmentMessage) {
    return appointmentMessage;
  }

  return {
    subject: row.subject ?? "DanceFlow Notification",
    bodyText: row.body_text ?? "You have a new notification from DanceFlow.",
  };
}

async function sendEmail(row: OutboundDeliveryRow): Promise<DispatchResult> {
  if (!row.recipient_email) {
    return { ok: false, error: "Missing recipient email." };
  }

  const from = process.env.OUTBOUND_EMAIL_FROM;
  if (!from) {
    return { ok: false, error: "Missing OUTBOUND_EMAIL_FROM." };
  }

  const rendered = renderMessage(row);

  try {
    const resend = getResendClient();

    const response = await resend.emails.send({
      from,
      to: [row.recipient_email],
      subject: rendered.subject,
      text: rendered.bodyText,
    });

    if (response.error) {
      return {
        ok: false,
        error: response.error.message || "Resend send failed.",
      };
    }

    return {
      ok: true,
      providerMessageId: response.data?.id ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown email send error",
    };
  }
}

async function sendSms(row: OutboundDeliveryRow): Promise<DispatchResult> {
  if (!row.recipient_phone) {
    return { ok: false, error: "Missing recipient phone." };
  }

  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) {
    return { ok: false, error: "Missing TWILIO_FROM_NUMBER." };
  }

  const rendered = renderMessage(row);

  try {
    const client = getTwilioClient();

    const message = await client.messages.create({
      to: row.recipient_phone,
      from,
      body: rendered.bodyText,
    });

    return {
      ok: true,
      providerMessageId: message.sid ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown SMS send error",
    };
  }
}

async function markSent(id: string, providerMessageId?: string | null) {
  const supabase = createAdminClient();

  const { error } = await supabase
    .from("outbound_deliveries")
    .update({
      status: "sent",
      provider_message_id: providerMessageId ?? null,
      sent_at: new Date().toISOString(),
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to mark outbound delivery sent: ${error.message}`);
  }
}

async function markFailed(id: string, errorMessage: string) {
  const supabase = createAdminClient();

  const { error } = await supabase
    .from("outbound_deliveries")
    .update({
      status: "failed",
      error_message: errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to mark outbound delivery failed: ${error.message}`);
  }
}

export async function dispatchQueuedOutboundDeliveries(limit = 25) {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("outbound_deliveries")
    .select(`
      id,
      studio_id,
      channel,
      template_key,
      recipient_email,
      recipient_phone,
      subject,
      body_text,
      payload,
      status
    `)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load queued outbound deliveries: ${error.message}`);
  }

  const rows = (data ?? []) as OutboundDeliveryRow[];

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const result =
        row.channel === "email" ? await sendEmail(row) : await sendSms(row);

      if (!result.ok) {
        failed += 1;
        await markFailed(row.id, result.error);
        continue;
      }

      sent += 1;
      await markSent(row.id, result.providerMessageId ?? null);
    } catch (error) {
      failed += 1;
      await markFailed(
        row.id,
        error instanceof Error ? error.message : "Unknown outbound dispatch error"
      );
    }
  }

  return {
    processed: rows.length,
    sent,
    failed,
  };
}
