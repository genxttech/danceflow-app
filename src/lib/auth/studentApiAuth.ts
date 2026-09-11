import type { User } from "@supabase/supabase-js";
import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function extractStudentBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const bearerToken = match?.[1]?.trim() || "";

  if (bearerToken) {
    return bearerToken;
  }

  return request.headers.get("x-danceflow-access-token")?.trim() || "";
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

export async function getStudentApiUser(request: Request) {
  const bearerToken = extractStudentBearerToken(request);
  const path = new URL(request.url).pathname;

  if (bearerToken) {
    const adminClient = createAdminClient();
    const {
      data: { user: bearerUser },
      error: bearerError,
    } = await adminClient.auth.getUser(bearerToken);

    if (bearerError || !bearerUser) {
      console.warn("Student API bearer authentication failed", {
        path,
        code: bearerError?.code ?? null,
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

  if (error || !user) {
    console.warn("Student API authentication failed", {
      path,
      hasAuthorizationHeader: request.headers.has("authorization"),
      hasDanceFlowTokenHeader: request.headers.has("x-danceflow-access-token"),
      hasCookieHeader: request.headers.has("cookie"),
      code: error?.code ?? null,
    });
    return null;
  }

  return user;
}

// GC-1.4A: some student API routes need to invoke a SECURITY DEFINER RPC
// whose authorization contract depends on auth.uid() resolving to the real
// caller (e.g. check_in_own_class_attendance) -- createAdminClient() cannot
// be used for that call, since a service-role connection carries no
// per-request user identity and auth.uid() would resolve to null inside
// the function. This builds a fresh, lightweight client that carries
// exactly this request's own bearer token (for mobile, bearer-token
// callers) or falls back to the existing cookie/session-scoped client
// (for the rare cookie-authenticated caller) -- never the admin client.
// Every other read/write in these routes keeps using createAdminClient()
// exactly as before; this helper exists only for that one class of call.
export async function createStudentApiUserScopedClient(request: Request) {
  const bearerToken = extractStudentBearerToken(request);

  if (bearerToken) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL.");
    if (!anonKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY.");

    return createSupabaseJsClient(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
        },
      },
    });
  }

  return createClient();
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