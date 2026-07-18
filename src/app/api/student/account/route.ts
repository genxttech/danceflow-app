import { NextResponse } from "next/server";
import {
  getStudentApiUser,
  studentApiJsonError,
} from "@/lib/auth/studentApiAuth";
import { deleteDanceFlowAccount } from "@/lib/student-identity/account-controls";

export async function DELETE(request: Request) {
  const user = await getStudentApiUser(request);
  if (!user) return studentApiJsonError("Authentication required.", 401);

  try {
    const body = (await request.json()) as { confirmation?: unknown };
    const confirmation =
      typeof body.confirmation === "string" ? body.confirmation.trim() : "";

    if (confirmation !== "DELETE") {
      return studentApiJsonError("Type DELETE to confirm.", 400);
    }

    const result = await deleteDanceFlowAccount(user);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Student account deletion failed", error);
    return studentApiJsonError(
      "Your DanceFlow account could not be deleted.",
      500,
    );
  }
}
