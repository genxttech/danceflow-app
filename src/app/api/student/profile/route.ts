import { NextResponse } from "next/server";
import {
  getStudentApiUser,
  studentApiJsonError,
} from "@/lib/auth/studentApiAuth";
import {
  getDancerProfile,
  normalizeDancerProfileUpdate,
  updateDancerProfile,
} from "@/lib/student-identity/profile";

export async function GET(request: Request) {
  const user = await getStudentApiUser(request);
  if (!user) return studentApiJsonError("Authentication required.", 401);

  try {
    const profile = await getDancerProfile(user);
    return NextResponse.json({ profile });
  } catch (error) {
    console.error("Student profile load failed", error);
    return studentApiJsonError("Your profile could not be loaded.", 500);
  }
}

export async function PATCH(request: Request) {
  const user = await getStudentApiUser(request);
  if (!user) return studentApiJsonError("Authentication required.", 401);

  try {
    const payload = await request.json();
    const input = normalizeDancerProfileUpdate(payload);
    const profile = await updateDancerProfile(user, input);
    return NextResponse.json({ profile });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Your profile could not be updated.";
    const status =
      message.startsWith("Choose ") || message.startsWith("Enter ") ? 400 : 500;

    if (status === 500) console.error("Student profile update failed", error);
    return studentApiJsonError(message, status);
  }
}
