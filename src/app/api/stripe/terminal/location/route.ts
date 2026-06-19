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

function canManageTerminal(role: string | null | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;
  return ["studio_owner", "studio_admin", "organizer_owner", "organizer_admin"].includes(role ?? "");
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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
    .select(`
      id,
      name,
      address_line_1,
      address_line_2,
      city,
      state,
      postal_code,
      country,
      stripe_connected_account_id
    `)
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
  if (!connectedAccount.charges_enabled || connectedAccount.capabilities?.card_payments !== "active") {
    return { response: NextResponse.redirect(billingUrl({ error: "terminal_stripe_not_ready" })) } as const;
  }

  return { supabase: adminSupabase, stripe, studio, connectedAccountId } as const;
}

export async function POST(_request: NextRequest) {
  try {
    const context = await getTerminalContext();
    if ("response" in context) return context.response;

    const { supabase, stripe, studio, connectedAccountId } = context;

    const { data: existingLocation, error: existingError } = await supabase
      .from("stripe_terminal_locations")
      .select("id, stripe_location_id")
      .eq("studio_id", studio.id)
      .eq("active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (existingError) {
      console.error("Terminal location lookup failed", existingError);
      return NextResponse.redirect(billingUrl({ error: "terminal_location_lookup_failed" }));
    }

    if (existingLocation?.stripe_location_id) {
      return NextResponse.redirect(billingUrl({ success: "terminal_location_ready" }));
    }

    const addressLine1 = clean(studio.address_line_1);
    const city = clean(studio.city);
    const state = clean(studio.state);
    const postalCode = clean(studio.postal_code);
    const country = clean(studio.country) || "US";

    if (!addressLine1 || !city || !state || !postalCode) {
      return NextResponse.redirect(billingUrl({ error: "terminal_location_missing_address" }));
    }

    const displayName = `${clean(studio.name) || "DanceFlow"} Front Desk`;

    const location = await stripe.terminal.locations.create(
      {
        display_name: displayName,
        address: {
          line1: addressLine1,
          line2: clean(studio.address_line_2) || undefined,
          city,
          state,
          postal_code: postalCode,
          country,
        },
      },
      { stripeAccount: connectedAccountId }
    );

    const { error: upsertError } = await supabase
      .from("stripe_terminal_locations")
      .upsert(
        {
          studio_id: studio.id,
          stripe_account_id: connectedAccountId,
          stripe_location_id: location.id,
          display_name: location.display_name ?? displayName,
          address_line1: addressLine1,
          address_line2: clean(studio.address_line_2) || null,
          city,
          state,
          postal_code: postalCode,
          country,
          active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "stripe_location_id" }
      );

    if (upsertError) {
      console.error("Terminal location save failed", upsertError);
      return NextResponse.redirect(billingUrl({ error: "terminal_location_save_failed" }));
    }

    return NextResponse.redirect(billingUrl({ success: "terminal_location_created" }));
  } catch (error) {
    console.error("Terminal location setup failed", error);
    return NextResponse.redirect(billingUrl({ error: "terminal_location_failed" }));
  }
}
