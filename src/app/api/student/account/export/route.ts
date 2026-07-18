import {
  getStudentApiUser,
  studentApiJsonError,
} from "@/lib/auth/studentApiAuth";
import { buildDanceFlowAccountExport } from "@/lib/student-identity/account-data";

export async function GET(request: Request) {
  const user = await getStudentApiUser(request);
  if (!user) return studentApiJsonError("Authentication required.", 401);

  try {
    const payload = await buildDanceFlowAccountExport(user);
    const date = new Date().toISOString().slice(0, 10);

    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="danceflow-account-data-${date}.json"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Student account export failed", error);
    return studentApiJsonError(
      "Your DanceFlow data could not be prepared.",
      500,
    );
  }
}
