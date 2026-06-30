import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";

function getBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function billingUrl(params: Record<string, string>) {
  const url = new URL("/app/settings/billing", getBaseUrl());
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function canManageTerminal(role: string | null | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;
  return ["studio_owner", "studio_admin", "organizer_owner", "organizer_admin"].includes(role ?? "");
}

async function getTerminalContext() {
  const supabase = await createClient();
  const adminSupabase = createAdminClient();
  const stripe = getStripe();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { response: NextResponse.redirect(new URL("/login", getBaseUrl())) } as const;
  }

  const context = await getCurrentStudioContext();
  if (!context?.studioId) {
    return { response: NextResponse.redirect(billingUrl({ error: "no_studio_context" })) } as const;
  }

  if (!canManageTerminal(context.studioRole, context.isPlatformAdmin)) {
    return { response: NextResponse.redirect(billingUrl({ error: "billing_access_denied" })) } as const;
  }

  const { data: studio, error: studioError } = await adminSupabase
    .from("studios")
    .select("id, stripe_connected_account_id")
    .eq("id", context.studioId)
    .single();

  if (studioError || !studio) {
    return { response: NextResponse.redirect(billingUrl({ error: "studio_not_found" })) } as const;
  }

  const connectedAccountId = clean(studio.stripe_connected_account_id);
  if (!connectedAccountId) {
    return { response: NextResponse.redirect(billingUrl({ error: "terminal_stripe_not_connected" })) } as const;
  }

  const connectedAccount = await stripe.accounts.retrieve(connectedAccountId);
  if (
    !connectedAccount.charges_enabled ||
    connectedAccount.capabilities?.card_payments !== "active"
  ) {
    return { response: NextResponse.redirect(billingUrl({ error: "terminal_stripe_not_ready" })) } as const;
  }

  return { supabase: adminSupabase, stripe, studio, connectedAccountId } as const;
}

export async function POST(request: NextRequest) {
  try {
    const context = await getTerminalContext();
    if ("response" in context) return context.response;

    const formData = await request.formData();
    const registrationCode = clean(formData.get("registrationCode"));
    const readerLabel = clean(formData.get("readerLabel"));
    const terminalLocationId = clean(formData.get("terminalLocationId"));

    if (!registrationCode) {
      return NextResponse.redirect(billingUrl({ error: "terminal_reader_missing_code" }));
    }

    const { supabase, stripe, studio, connectedAccountId } = context;

    let locationQuery = supabase
      .from("stripe_terminal_locations")
      .select("id, stripe_location_id, display_name")
      .eq("studio_id", studio.id)
      .eq("active", true)
      .order("created_at", { ascending: true })
      .limit(1);

    if (terminalLocationId) {
      locationQuery = supabase
        .from("stripe_terminal_locations")
        .select("id, stripe_location_id, display_name")
        .eq("studio_id", studio.id)
        .eq("id", terminalLocationId)
        .eq("active", true)
        .limit(1);
    }

    const { data: location, error: locationError } = await locationQuery.maybeSingle();

    if (locationError || !location?.stripe_location_id) {
      return NextResponse.redirect(billingUrl({ error: "terminal_location_required" }));
    }

    const reader = await stripe.terminal.readers.create(
      {
        registration_code: registrationCode,
        label: readerLabel || undefined,
        location: location.stripe_location_id,
      },
      { stripeAccount: connectedAccountId }
    );

    const stripeLocationId = typeof reader.location === "string" ? reader.location : reader.location?.id ?? location.stripe_location_id;

    const { error: upsertError } = await supabase
      .from("stripe_terminal_readers")
      .upsert(
        {
          studio_id: studio.id,
          terminal_location_id: location.id,
          stripe_account_id: connectedAccountId,
          stripe_reader_id: reader.id,
          stripe_location_id: stripeLocationId,
          label: reader.label ?? (readerLabel || "Front desk reader"),
          device_type: reader.device_type ?? null,
          status: reader.status ?? null,
          ip_address: reader.ip_address ?? null,
          last_seen_at: new Date().toISOString(),
          active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "stripe_reader_id" }
      );

    if (upsertError) {
      console.error("Terminal reader save failed", upsertError);
      return NextResponse.redirect(billingUrl({ error: "terminal_reader_save_failed" }));
    }

    return NextResponse.redirect(billingUrl({ success: "terminal_reader_registered" }));
  } catch (error) {
    console.error("Terminal reader registration failed", error);
    return NextResponse.redirect(billingUrl({ error: "terminal_reader_failed" }));
  }
}
