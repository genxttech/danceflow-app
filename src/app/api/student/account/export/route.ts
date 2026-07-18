import {
  getStudentApiUser,
  studentApiJsonError,
} from "@/lib/auth/studentApiAuth";
import {
  buildDanceFlowAccountExport,
  buildDanceFlowAccountHtmlReport,
  buildDanceFlowAccountTextReport,
} from "@/lib/student-identity/account-data";

export async function GET(request: Request) {
  const user = await getStudentApiUser(request);
  if (!user) return studentApiJsonError("Authentication required.", 401);

  try {
    const payload = await buildDanceFlowAccountExport(user);
    const format = new URL(request.url).searchParams.get("format") ?? "report";
    const date = new Date().toISOString().slice(0, 10);

    if (format === "json") {
      return new Response(JSON.stringify(payload, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="danceflow-technical-data-${date}.json"`,
          "Cache-Control": "private, no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (format === "summary") {
      return Response.json(
        { report: buildDanceFlowAccountTextReport(payload) },
        {
          headers: {
            "Cache-Control": "private, no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }

    return new Response(buildDanceFlowAccountHtmlReport(payload), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="danceflow-account-data-${date}.html"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
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
