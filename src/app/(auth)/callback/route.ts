import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

async function hasActiveStudioRole(
  supabase: ReturnType<typeof createServerClient>,
  userId: string
) {
  const { data, error } = await supabase
    .from("user_studio_roles")
    .select("studio_id")
    .eq("user_id", userId)
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not determine account access: ${error.message}`);
  }

  return !!data?.studio_id;
}

async function upsertProfile(params: {
  supabase: ReturnType<typeof createServerClient>;
  userId: string;
  email: string;
  fullName?: string | null;
}) {
  const { supabase, userId, email, fullName } = params;

  const payload: {
    id: string;
    email: string;
    full_name?: string;
  } = {
    id: userId,
    email,
  };

  if (fullName?.trim()) {
    payload.full_name = fullName.trim();
  }

  const { error } = await supabase.from("profiles").upsert(payload, {
    onConflict: "id",
  });

  if (error) {
    throw new Error(`Profile creation failed: ${error.message}`);
  }
}

async function attachPortalAccessForEmail(params: {
  supabase: ReturnType<typeof createServerClient>;
  userId: string;
  email: string;
}) {
  const { supabase, userId, email } = params;

  if (!email) return;

  const { error } = await supabase.rpc("link_portal_client_by_email", {
    p_user_id: userId,
    p_email: email,
  });

  if (error) {
    throw new Error(`Portal auto-link failed: ${error.message}`);
  }
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = requestUrl.searchParams.get("next");

  if (!code) {
    return NextResponse.redirect(
      new URL("/login?error=missing-code", request.url)
    );
  }

  let response = NextResponse.redirect(new URL("/account", request.url));

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(exchangeError.message)}`, request.url)
    );
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.redirect(
      new URL("/login?error=missing-user-after-callback", request.url)
    );
  }

  const email = user.email?.trim().toLowerCase() ?? "";

  try {
    await upsertProfile({
      supabase,
      userId: user.id,
      email,
      fullName:
        typeof user.user_metadata?.full_name === "string"
          ? user.user_metadata.full_name
          : null,
    });

    await attachPortalAccessForEmail({
      supabase,
      userId: user.id,
      email,
    });
  } catch (syncError) {
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent(
          syncError instanceof Error ? syncError.message : "callback-sync-failed"
        )}`,
        request.url
      )
    );
  }

    const destination =
    next ||
    ((await hasActiveStudioRole(supabase, user.id)) ? "/app" : "/account");

  const finalResponse = NextResponse.redirect(new URL(destination, request.url));

  for (const cookie of response.cookies.getAll()) {
    finalResponse.cookies.set(cookie);
  }

  return finalResponse;
}