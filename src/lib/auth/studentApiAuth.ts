import type { User } from "@supabase/supabase-js";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

export function extractStudentBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export function normalizeStudentApiUuid(value: string | null | undefined) {
  const id = String(value ?? "").trim();
  return UUID_PATTERN.test(id) ? id : null;
}

export function studentApiJsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export function sameStudentEmail(
  user: Pick<User, "email"> | null | undefined,
  email: string | null | undefined,
) {
  const userEmail = user?.email?.trim().toLowerCase() ?? "";
  const candidate = email?.trim().toLowerCase() ?? "";
  return Boolean(userEmail && candidate && userEmail === candidate);
}

function createStudentTokenValidationClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  return createSupabaseClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

export async function getStudentApiUser(request: Request) {
  const bearerToken = extractStudentBearerToken(request);

  if (bearerToken) {
    const authClient = createStudentTokenValidationClient();
    const {
      data: { user: bearerUser },
      error: bearerError,
    } = await authClient.auth.getUser(bearerToken);

    if (bearerError || !bearerUser) {
      console.error("Student bearer-token validation failed", {
        code: bearerError?.code ?? null,
        status: bearerError?.status ?? null,
        message: bearerError?.message ?? "No user returned.",
        hasAuthorizationHeader: true,
      });
      return null;
    }

    return bearerUser;
  }

  const authClient = await createClient();
  const {
    data: { user },
    error,
  } = await authClient.auth.getUser();

  if (error || !user) return null;
  return user;
}

export async function requireStudentApiUser(request: Request) {
  const user = await getStudentApiUser(request);

  if (!user) {
    return {
      ok: false as const,
      response: studentApiJsonError("Authentication required.", 401),
    };
  }

  return { ok: true as const, user };
}
