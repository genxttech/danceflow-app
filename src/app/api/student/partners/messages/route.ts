import { NextRequest, NextResponse } from "next/server";
import { getStudentApiUser } from "@/lib/auth/studentApiAuth";
import { sendMobilePushToUser } from "@/lib/notifications/expoPush";
import { createAdminClient } from "@/lib/supabase/admin";

type PartnerMessageBody = {
  body?: string;
  partnerProfileId?: string;
  threadId?: string;
};


const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

function cleanInput(value: unknown, maxLength = 2000) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/\n{4,}/g, "\n\n\n")
        .trim()
        .slice(0, maxLength)
    : "";
}

function normalizeOptionalUuid(value: unknown) {
  const id = cleanInput(value, 36);
  return id && UUID_PATTERN.test(id) ? id : "";
}


type PartnerProfileRow = {
  id: string;
  display_name: string | null;
  user_id: string;
};

type PartnerThreadRow = {
  id: string;
  partner_profile_id: string;
  partner_user_id: string;
  requester_user_id: string;
  status: string | null;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function cleanBody(value: unknown) {
  return cleanInput(value, 2000);
}

function previewMessage(value: string) {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

async function sendPartnerPush(params: {
  body: string;
  messageId: string | null;
  recipientUserId: string;
  senderUserId: string;
  threadId: string;
}) {
  if (params.recipientUserId === params.senderUserId) return;

  try {
    await sendMobilePushToUser({
      userId: params.recipientUserId,
      category: "partner",
      title: "New partner message",
      body: previewMessage(params.body),
      data: {
        source: "partner_message",
        threadId: params.threadId,
        messageId: params.messageId,
        senderUserId: params.senderUserId,
      },
    });
  } catch (pushError) {
    console.error(
      "Failed to send partner message mobile push",
      pushError instanceof Error ? pushError.message : pushError
    );
  }
}

export async function POST(request: NextRequest) {
  const user = await getStudentApiUser(request);

  if (!user) {
    return jsonError("Authentication required.", 401);
  }

  const payload = (await request.json().catch(() => null)) as PartnerMessageBody | null;
  const body = cleanBody(payload?.body);
  const partnerProfileId = normalizeOptionalUuid(payload?.partnerProfileId);
  const threadIdFromPayload = normalizeOptionalUuid(payload?.threadId);

  if (!body) {
    return jsonError("Add a message first.");
  }

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  if (partnerProfileId) {
    const { data: partnerProfile, error: profileError } = await supabase
      .from("dancer_partner_profiles")
      .select("id, display_name, user_id")
      .eq("id", partnerProfileId)
      .single<PartnerProfileRow>();

    if (profileError || !partnerProfile) {
      return jsonError("Partner profile was not found.", 404);
    }

    if (partnerProfile.user_id === user.id) {
      return jsonError("You cannot message your own partner listing.");
    }

    const { data: requestRow, error: requestError } = await supabase
      .from("partner_connection_requests")
      .insert({
        partner_profile_id: partnerProfile.id,
        requester_user_id: user.id,
        message: body,
      })
      .select("id")
      .single<{ id: string }>();

    if (requestError || !requestRow) {
      return jsonError(requestError?.message ?? "Could not create partner request.", 500);
    }

    const { data: existingThread, error: existingThreadError } = await supabase
      .from("partner_conversation_threads")
      .select("id")
      .eq("partner_profile_id", partnerProfile.id)
      .eq("requester_user_id", user.id)
      .eq("partner_user_id", partnerProfile.user_id)
      .maybeSingle<{ id: string }>();

    if (existingThreadError) {
      return jsonError(existingThreadError.message, 500);
    }

    let threadId = existingThread?.id ?? null;

    if (!threadId) {
      const { data: threadRow, error: threadError } = await supabase
        .from("partner_conversation_threads")
        .insert({
          connection_request_id: requestRow.id,
          partner_profile_id: partnerProfile.id,
          partner_user_id: partnerProfile.user_id,
          requester_user_id: user.id,
          status: "active",
          last_message_at: now,
        })
        .select("id")
        .single<{ id: string }>();

      if (threadError || !threadRow) {
        return jsonError(threadError?.message ?? "Could not create partner conversation.", 500);
      }

      threadId = threadRow.id;
    }

    const { data: messageRow, error: messageError } = await supabase
      .from("partner_conversation_messages")
      .insert({
        body,
        sender_user_id: user.id,
        thread_id: threadId,
      })
      .select("id")
      .single<{ id: string }>();

    if (messageError || !messageRow) {
      return jsonError(messageError?.message ?? "Could not send partner message.", 500);
    }

    await supabase
      .from("partner_conversation_threads")
      .update({
        last_message_at: now,
        updated_at: now,
      })
      .eq("id", threadId);

    await sendPartnerPush({
      body,
      messageId: messageRow.id,
      recipientUserId: partnerProfile.user_id,
      senderUserId: user.id,
      threadId,
    });

    return NextResponse.json({ messageId: messageRow.id, threadId });
  }

  if (!threadIdFromPayload) {
    return jsonError("A partner profile or conversation thread is required.");
  }

  const { data: thread, error: threadError } = await supabase
    .from("partner_conversation_threads")
    .select("id, partner_profile_id, partner_user_id, requester_user_id, status")
    .eq("id", threadIdFromPayload)
    .single<PartnerThreadRow>();

  if (threadError || !thread) {
    return jsonError("Partner conversation was not found.", 404);
  }

  if (thread.requester_user_id !== user.id && thread.partner_user_id !== user.id) {
    return jsonError("You do not have access to this conversation.", 403);
  }

  if (thread.status === "blocked") {
    return jsonError("Messaging is paused for this partner conversation.", 409);
  }

  const { data: messageRow, error: messageError } = await supabase
    .from("partner_conversation_messages")
    .insert({
      body,
      sender_user_id: user.id,
      thread_id: thread.id,
    })
    .select("id")
    .single<{ id: string }>();

  if (messageError || !messageRow) {
    return jsonError(messageError?.message ?? "Could not send partner message.", 500);
  }

  await supabase
    .from("partner_conversation_threads")
    .update({
      last_message_at: now,
      updated_at: now,
    })
    .eq("id", thread.id);

  await sendPartnerPush({
    body,
    messageId: messageRow.id,
    recipientUserId:
      thread.requester_user_id === user.id ? thread.partner_user_id : thread.requester_user_id,
    senderUserId: user.id,
    threadId: thread.id,
  });

  return NextResponse.json({ messageId: messageRow.id, threadId: thread.id });
}
