import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyMuxWebhookSignature } from "@/lib/mux/server";

export const runtime = "nodejs";

type MuxPlaybackId = {
  id?: string;
  policy?: string;
};

type MuxWebhookEvent = {
  id: string;
  type: string;
  created_at?: string;
  data: {
    id?: string;
    asset_id?: string;
    upload_id?: string;
    status?: string;
    passthrough?: string;
    new_asset_settings?: {
      passthrough?: string;
    };
    duration?: number;
    aspect_ratio?: string;
    playback_ids?: MuxPlaybackId[];
    errors?: {
      type?: string;
      messages?: string[];
    };
    error?: {
      type?: string;
      message?: string;
    };
  };
};

function parsePassthrough(value: string | undefined) {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as {
      catalogItemId?: string;
      digitalContentId?: string;
      studioId?: string;
    };

    return parsed;
  } catch {
    return null;
  }
}

function webhookErrorMessage(event: MuxWebhookEvent) {
  return (
    event.data.errors?.messages?.join(", ") ||
    event.data.error?.message ||
    event.data.errors?.type ||
    event.data.error?.type ||
    "Mux could not process this video."
  );
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("mux-signature");

  if (
    !verifyMuxWebhookSignature({
      rawBody,
      signatureHeader: signature,
    })
  ) {
    return NextResponse.json(
      { ok: false, error: "Invalid Mux signature." },
      { status: 401 },
    );
  }

  let event: MuxWebhookEvent;

  try {
    event = JSON.parse(rawBody) as MuxWebhookEvent;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid webhook payload." },
      { status: 400 },
    );
  }

  if (!event.id || !event.type) {
    return NextResponse.json(
      { ok: false, error: "Incomplete webhook payload." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const receivedAt = new Date().toISOString();
  let webhookEventRowId: string | null = null;

  const { data: insertedEvent, error: eventInsertError } = await admin
    .from("commerce_mux_webhook_events")
    .insert({
      mux_event_id: event.id,
      event_type: event.type,
      payload: event,
      processing_status: "processing",
      received_at: receivedAt,
    })
    .select("id")
    .maybeSingle();

  if (eventInsertError?.code === "23505") {
    const { data: existingEvent, error: existingEventError } = await admin
      .from("commerce_mux_webhook_events")
      .select("id, processing_status")
      .eq("mux_event_id", event.id)
      .maybeSingle();

    if (existingEventError || !existingEvent) {
      console.error("Mux duplicate webhook lookup failed:", existingEventError);
      return NextResponse.json(
        { ok: false, error: "Webhook could not be reconciled." },
        { status: 500 },
      );
    }

    if (existingEvent.processing_status === "processed") {
      return NextResponse.json({ ok: true, duplicate: true });
    }

    webhookEventRowId = existingEvent.id;

    const { error: retryUpdateError } = await admin
      .from("commerce_mux_webhook_events")
      .update({
        payload: event,
        event_type: event.type,
        processing_status: "processing",
        error_message: null,
        processed_at: null,
        received_at: receivedAt,
      })
      .eq("id", existingEvent.id);

    if (retryUpdateError) {
      console.error("Mux webhook retry reset failed:", retryUpdateError);
      return NextResponse.json(
        { ok: false, error: "Webhook retry could not be prepared." },
        { status: 500 },
      );
    }
  } else if (eventInsertError || !insertedEvent) {
    console.error("Mux webhook event insert failed:", eventInsertError);
    return NextResponse.json(
      { ok: false, error: "Webhook could not be recorded." },
      { status: 500 },
    );
  } else {
    webhookEventRowId = insertedEvent.id;
  }

  if (!webhookEventRowId) {
    return NextResponse.json(
      { ok: false, error: "Webhook event could not be identified." },
      { status: 500 },
    );
  }

  try {
    const passthrough = parsePassthrough(
      event.data.passthrough ??
        event.data.new_asset_settings?.passthrough,
    );
    const uploadId =
      event.type.startsWith("video.upload.")
        ? event.data.id
        : event.data.upload_id;
    const assetId =
      event.type === "video.upload.asset_created"
        ? event.data.asset_id
        : event.data.id;

    let contentId = passthrough?.digitalContentId ?? null;

    if (!contentId && uploadId) {
      const { data } = await admin
        .from("commerce_digital_content")
        .select("id")
        .eq("mux_upload_id", uploadId)
        .maybeSingle();
      contentId = data?.id ?? null;
    }

    if (!contentId && assetId) {
      const { data } = await admin
        .from("commerce_digital_content")
        .select("id")
        .eq("mux_asset_id", assetId)
        .maybeSingle();
      contentId = data?.id ?? null;
    }

    if (!contentId) {
      throw new Error(
        `No digital content matched Mux event ${event.id}.`,
      );
    }

    const now = new Date().toISOString();

    if (event.type === "video.upload.created") {
      const { error } = await admin
        .from("commerce_digital_content")
        .update({
          mux_upload_id: event.data.id ?? null,
          mux_upload_status: event.data.status ?? "waiting",
          mux_error_message: null,
          external_provider: "mux",
          updated_at: now,
        })
        .eq("id", contentId);

      if (error) throw new Error(error.message);
    } else if (event.type === "video.upload.asset_created") {
      const { error } = await admin
        .from("commerce_digital_content")
        .update({
          mux_upload_status: "asset_created",
          mux_asset_id: event.data.asset_id ?? null,
          mux_asset_status: "preparing",
          mux_error_message: null,
          external_provider: "mux",
          external_asset_id: event.data.asset_id ?? null,
          updated_at: now,
        })
        .eq("id", contentId);

      if (error) throw new Error(error.message);
    } else if (event.type === "video.asset.ready") {
      const signedPlaybackId =
        event.data.playback_ids?.find(
          (playbackId) => playbackId.policy === "signed",
        )?.id ?? null;

      if (!signedPlaybackId) {
        throw new Error("Mux ready event did not contain a signed playback ID.");
      }

      const { error } = await admin
        .from("commerce_digital_content")
        .update({
          mux_upload_status: "ready",
          mux_asset_id: event.data.id ?? null,
          mux_asset_status: "ready",
          mux_playback_id: signedPlaybackId,
          mux_error_message: null,
          duration_seconds:
            typeof event.data.duration === "number"
              ? Math.round(event.data.duration)
              : null,
          mux_aspect_ratio: event.data.aspect_ratio ?? null,
          external_provider: "mux",
          external_asset_id: event.data.id ?? null,
          external_playback_id: signedPlaybackId,
          updated_at: now,
        })
        .eq("id", contentId);

      if (error) throw new Error(error.message);
    } else if (event.type === "video.asset.errored") {
      const { error } = await admin
        .from("commerce_digital_content")
        .update({
          mux_upload_status: "errored",
          mux_asset_id: event.data.id ?? null,
          mux_asset_status: "errored",
          mux_error_message: webhookErrorMessage(event),
          updated_at: now,
        })
        .eq("id", contentId);

      if (error) throw new Error(error.message);
    } else if (event.type === "video.asset.deleted") {
      const { error } = await admin
        .from("commerce_digital_content")
        .update({
          mux_upload_status: "deleted",
          mux_asset_status: "deleted",
          mux_playback_id: null,
          external_playback_id: null,
          updated_at: now,
        })
        .eq("id", contentId);

      if (error) throw new Error(error.message);
    } else if (
      event.type === "video.upload.errored" ||
      event.type === "video.upload.cancelled" ||
      event.type === "video.upload.timed_out"
    ) {
      const { error } = await admin
        .from("commerce_digital_content")
        .update({
          mux_upload_status: event.type.split(".").at(-1) ?? "errored",
          mux_error_message: webhookErrorMessage(event),
          updated_at: now,
        })
        .eq("id", contentId);

      if (error) throw new Error(error.message);
    }

    await admin
      .from("commerce_mux_webhook_events")
      .update({
        digital_content_id: contentId,
        processing_status: "processed",
        processed_at: now,
      })
      .eq("id", webhookEventRowId);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Mux webhook processing failed:", error);

    await admin
      .from("commerce_mux_webhook_events")
      .update({
        processing_status: "failed",
        error_message:
          error instanceof Error ? error.message : "Unknown processing error.",
        processed_at: new Date().toISOString(),
      })
      .eq("id", webhookEventRowId);

    return NextResponse.json(
      { ok: false, error: "Webhook processing failed." },
      { status: 500 },
    );
  }
}