import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import {
  sendMobilePushToUser,
  type MobileNotificationCategory,
} from "@/lib/notifications/expoPush";

function normalizeCategory(value: unknown): MobileNotificationCategory {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (
    raw === "schedule" ||
    raw === "event" ||
    raw === "favorites" ||
    raw === "learning" ||
    raw === "account" ||
    raw === "partner" ||
    raw === "system"
  ) {
    return raw;
  }

  return "account";
}

export async function POST(request: NextRequest) {
  await requirePlatformAdmin();

  const body = await request.json().catch(() => ({}));

  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : "DanceFlow test notification";
  const messageBody =
    typeof body.body === "string" && body.body.trim()
      ? body.body.trim()
      : "Your DanceFlow mobile push setup is working.";
  const category = normalizeCategory(body.category);

  if (!userId) {
    return NextResponse.json(
      { error: "A dancer account is required." },
      { status: 400 }
    );
  }

  const result = await sendMobilePushToUser({
    userId,
    category,
    title,
    body: messageBody,
    data: {
      source: "platform_test",
    },
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
