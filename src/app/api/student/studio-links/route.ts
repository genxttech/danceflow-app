import { NextResponse } from "next/server";
import {
  getStudentApiUser,
  studentApiJsonError,
} from "@/lib/auth/studentApiAuth";
import { getStudentStudioLinks } from "@/lib/student-identity/links";

export async function GET(request: Request) {
  const user = await getStudentApiUser(request);
  if (!user) return studentApiJsonError("Authentication required.", 401);

  try {
    const linkedStudios = await getStudentStudioLinks(user);

    return NextResponse.json({
      hasPortalAccess: linkedStudios.length > 0,
      linkedStudios,
      primaryStudio: linkedStudios[0] ?? null,
      lumiEnabled: linkedStudios.some((studio) => studio.lumiEnabled),
    });
  } catch (error) {
    console.error("Student studio-link load failed", error);
    return studentApiJsonError("Connected studios could not be loaded.", 500);
  }
}
