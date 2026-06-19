import { NextResponse } from "next/server";
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

export async function POST() {
  try {
    const supabase = await createClient();
    const adminSupabase = createAdminClient();
    const stripe = getStripe();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.redirect(new URL("/login", getBaseUrl()));
    }

    const context = await getCurrentStudioContext();
    if (!context?.studioId) {
      return NextResponse.redirect(billingUrl({ error: "no_studio_context" }));
    }

    if (!canManageTerminal(context.studioRole, context.isPlatformAdmin)) {
      return NextResponse.redirect(billingUrl({ error: "billing_access_denied" }));
    }

    const { data: studio, error: studioError } = await adminSupabase
      .from("studios")
      .select("id, stripe_connected_account_id")
      .eq("id", context.studioId)
      .single();

    if (studioError || !studio) {
      return NextResponse.redirect(billingUrl({ error: "studio_not_found" }));
    }

    const connectedAccountId = clean(studio.stripe_connected_account_id);
    if (!connectedAccountId) {
      return NextResponse.redirect(billingUrl({ error: "terminal_stripe_not_connected" }));
    }

    const { data: localLocations } = await adminSupabase
      .from("stripe_terminal_locations")
      .select("id, stripe_location_id")
      .eq("studio_id", studio.id);

    const localLocationByStripeId = new Map(
      (localLocations ?? []).map((location) => [location.stripe_location_id, location.id])
    );

    const readers = await stripe.terminal.readers.list(
      { limit: 100 },
      { stripeAccount: connectedAccountId }
    );

    for (const reader of readers.data) {
      const stripeLocationId = typeof reader.location === "string" ? reader.location : reader.location?.id ?? null;
      const terminalLocationId = stripeLocationId ? localLocationByStripeId.get(stripeLocationId) ?? null : null;

      const { error: upsertError } = await adminSupabase
        .from("stripe_terminal_readers")
        .upsert(
          {
            studio_id: studio.id,
            terminal_location_id: terminalLocationId,
            stripe_account_id: connectedAccountId,
            stripe_reader_id: reader.id,
            stripe_location_id: stripeLocationId,
            label: reader.label ?? "Card reader",
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
        console.error("Terminal reader sync failed", upsertError);
        return NextResponse.redirect(billingUrl({ error: "terminal_reader_sync_failed" }));
      }
    }

    return NextResponse.redirect(billingUrl({ success: "terminal_readers_synced" }));
  } catch (error) {
    console.error("Terminal reader sync failed", error);
    return NextResponse.redirect(billingUrl({ error: "terminal_reader_sync_failed" }));
  }
}
