import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

function getCronSecretFromRequest(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  return bearer || request.headers.get("x-cron-secret");
}

function requireCronAuth(request: NextRequest) {
  const provided = getCronSecretFromRequest(request);
  const expected = process.env.CRON_SECRET;

  if (!expected || !provided || provided !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

type DeliveryRow = {
  id: string;
  studio_id: string;
  user_id: string | null;
  client_id: string | null;
  delivery_type: string;
  channel: "email" | "sms" | "in_app";
  status: "pending" | "sent" | "failed" | "cancelled";
  subject: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
  scheduled_for: string;
};

async function resolveRecipientEmail(
  supabase: ReturnType<typeof createAdminClient>,
  delivery: DeliveryRow
) {
  const metadata = delivery.metadata ?? {};

  if (delivery.client_id) {
    const metadataEmail =
      typeof metadata.clientEmail === "string" ? metadata.clientEmail : null;

    if (metadataEmail) {
      return metadataEmail;
    }

    const { data: client } = await supabase
      .from("clients")
      .select("email")
      .eq("id", delivery.client_id)
      .single();

    return client?.email ?? null;
  }

  if (delivery.user_id) {
    const { data, error } = await supabase.auth.admin.getUserById(delivery.user_id);

    if (!error && data?.user?.email) {
      return data.user.email;
    }
  }

  return null;
}

async function sendEmail(params: {
  to: string;
  subject: string;
  text: string;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from =
    process.env.NOTIFICATION_FROM_EMAIL ||
    process.env.RESEND_FROM_EMAIL ||
    "DanceFlow <notifications@danceflow.app>";

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [params.to],
      subject: params.subject,
      text: params.text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Email send failed: ${errorText}`);
  }

  return response.json();
}

export async function POST(request: NextRequest) {
  const authFailure = requireCronAuth(request);
  if (authFailure) {
    return authFailure;
  }

  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data: deliveries, error: fetchError } = await supabase
    .from("notification_deliveries")
    .select(
      `
      id,
      studio_id,
      user_id,
      client_id,
      delivery_type,
      channel,
      status,
      subject,
      body,
      metadata,
      scheduled_for
    `
    )
    .eq("status", "pending")
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(100);

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  const pending = (deliveries ?? []) as DeliveryRow[];

  if (!pending.length) {
    return NextResponse.json({
      ok: true,
      sent: 0,
      failed: 0,
      message: "No pending deliveries were due.",
    });
  }

  let sent = 0;
  let failed = 0;

  for (const delivery of pending) {
    try {
      if (delivery.channel !== "email") {
        await supabase
          .from("notification_deliveries")
          .update({
            status: "failed",
            failed_at: new Date().toISOString(),
            failure_reason: `Unsupported channel: ${delivery.channel}`,
          })
          .eq("id", delivery.id);

        failed += 1;
        continue;
      }

      const recipientEmail = await resolveRecipientEmail(supabase, delivery);

      if (!recipientEmail) {
        await supabase
          .from("notification_deliveries")
          .update({
            status: "failed",
            failed_at: new Date().toISOString(),
            failure_reason: "No recipient email could be resolved.",
          })
          .eq("id", delivery.id);

        failed += 1;
        continue;
      }

      await sendEmail({
        to: recipientEmail,
        subject: delivery.subject || "DanceFlow notification",
        text: delivery.body || "You have a new notification from DanceFlow.",
      });

      await supabase
        .from("notification_deliveries")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          failure_reason: null,
        })
        .eq("id", delivery.id);

      sent += 1;
    } catch (error) {
      await supabase
        .from("notification_deliveries")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          failure_reason:
            error instanceof Error ? error.message : "Unknown send failure",
        })
        .eq("id", delivery.id);

      failed += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    processed: pending.length,
    sent,
    failed,
  });
}