import { NextResponse } from "next/server";
import {
  getStudentApiUser,
  studentApiJsonError,
} from "@/lib/auth/studentApiAuth";
import { leaveStudioRelationship } from "@/lib/student-identity/account-controls";

export async function POST(request: Request) {
  const user = await getStudentApiUser(request);
  if (!user) return studentApiJsonError("Authentication required.", 401);

  try {
    const body = (await request.json()) as {
      linkId?: unknown;
      studioId?: unknown;
      confirmation?: unknown;
      reason?: unknown;
    };

    const linkId = typeof body.linkId === "string" ? body.linkId.trim() : "";
    const studioId = typeof body.studioId === "string" ? body.studioId.trim() : "";
    const confirmation =
      typeof body.confirmation === "string" ? body.confirmation.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";

    if (!linkId || !studioId || confirmation !== "LEAVE") {
      return studentApiJsonError("Type LEAVE to confirm.", 400);
    }

    const result = await leaveStudioRelationship({
      user,
      linkId,
      studioId,
      reason,
    });
    return NextResponse.json({ ok: true, disconnected: result });
  } catch (error) {
    console.error("Student leave-studio failed", error);
    return studentApiJsonError(
      error instanceof Error ? error.message : "Studio access could not be removed.",
      400,
    );
  }
}
