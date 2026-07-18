import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import {
  extractStudentBearerToken,
  getStudentApiUser,
  studentApiJsonError,
} from "@/lib/auth/studentApiAuth";
import { normalizeAccountEmail } from "@/lib/student-identity/account-security";

function authenticatedSupabaseClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Supabase authentication configuration is unavailable.");
  }

  return createSupabaseClient(url, anonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export async function POST(request: Request) {
  const user = await getStudentApiUser(request);
  if (!user) return studentApiJsonError("Authentication required.", 401);

  try {
    const body = (await request.json()) as { email?: unknown };
    const email = normalizeAccountEmail(body.email);

    if (email === user.email?.trim().toLowerCase()) {
      return studentApiJsonError(
        "That is already your DanceFlow login email.",
        400,
      );
    }

    const accessToken = extractStudentBearerToken(request);
    if (!accessToken) {
      return studentApiJsonError(
        "A secure mobile session is required for this change.",
        401,
      );
    }

    const supabase = authenticatedSupabaseClient(accessToken);
    const redirectTo = `${
      process.env.NEXT_PUBLIC_APP_URL ?? "https://idanceflow.com"
    }/account?success=email_change_confirmed`;

    const { error } = await supabase.auth.updateUser(
      { email },
      { emailRedirectTo: redirectTo },
    );

    if (error) {
      console.error("Student login email update request failed", {
        userId: user.id,
        message: error.message,
      });
      return studentApiJsonError(
        "The email change could not be requested. Check the address and try again.",
        400,
      );
    }

    return NextResponse.json({
      requested: true,
      email,
      message:
        "Check the confirmation email or emails required by your studio's secure email-change settings.",
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The email change could not be requested.";
    const status = message.startsWith("Enter ") ? 400 : 500;

    if (status === 500) {
      console.error("Student login email update failed", error);
    }

    return studentApiJsonError(message, status);
  }
}
