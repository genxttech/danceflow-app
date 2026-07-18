import { NextResponse } from "next/server";
import {
  getStudentApiUser,
  studentApiJsonError,
} from "@/lib/auth/studentApiAuth";
import { reactivateDanceFlowAccount } from "@/lib/student-identity/account-security";

export async function POST(request: Request) {
  const user = await getStudentApiUser(request);
  if (!user) return studentApiJsonError("Authentication required.", 401);

  try {
    const result = await reactivateDanceFlowAccount(user);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Student account reactivation failed", error);
    return studentApiJsonError(
      "Your account could not be reactivated.",
      500,
    );
  }
}
