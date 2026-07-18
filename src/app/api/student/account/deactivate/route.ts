import { NextResponse } from "next/server";
import {
  getStudentApiUser,
  studentApiJsonError,
} from "@/lib/auth/studentApiAuth";
import { deactivateDanceFlowAccount } from "@/lib/student-identity/account-security";

export async function POST(request: Request) {
  const user = await getStudentApiUser(request);
  if (!user) return studentApiJsonError("Authentication required.", 401);

  try {
    const body = (await request.json()) as {
      confirmation?: unknown;
      reason?: unknown;
    };
    const confirmation =
      typeof body.confirmation === "string" ? body.confirmation.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";

    if (confirmation !== "DEACTIVATE") {
      return studentApiJsonError("Type DEACTIVATE to confirm.", 400);
    }

    const result = await deactivateDanceFlowAccount({ user, reason });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Student account deactivation failed", error);
    return studentApiJsonError(
      "Your account could not be deactivated.",
      500,
    );
  }
}
