import type { createClient } from "@/lib/supabase/server";
import { GUSTO_INTEGRATION_ENABLED } from "@/lib/integrations/gusto/dormant";
import { googleHubStatus, gustoHubStatus, stripeHubStatus, waveHubStatus, type IntegrationStatus } from "@/lib/integrations/hubStatus";

/**
 * Static registry of the providers behind the Studio Integration Hub status cards: one entry per provider with its id, label and
 * status loader. It only reads. Providers keep their own tables, clients and settings pages; nothing here is a generic provider layer.
 */
export type StripeHubRow = {
  stripe_connected_account_id: string | null;
  stripe_connect_details_submitted: boolean | null;
  stripe_connect_charges_enabled: boolean | null;
  stripe_connect_payouts_enabled: boolean | null;
  stripe_connect_onboarding_complete: boolean | null;
};

export type WaveHubRow = {
  id: string;
  status: string | null;
  wave_business_id: string | null;
  wave_business_name: string | null;
  posting_enabled: boolean | null;
  posting_mode: string | null;
  scopes: string[] | null;
  updated_at: string | null;
};

export type GoogleCalendarHubRow = {
  id: string;
  status: string | null;
  google_account_email: string | null;
  calendar_id: string | null;
  calendar_summary: string | null;
  sync_lessons: boolean | null;
  sync_classes: boolean | null;
  sync_events: boolean | null;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
};

export type GustoHubRow = {
  id: string;
  status: string | null;
  environment: string | null;
  gusto_company_name: string | null;
  last_health_check_at: string | null;
  last_health_status: string | null;
  last_error: string | null;
};

export type HubLoadContext = {
  /** The caller's own (RLS-bound) client, never the service-role client. */
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  waveAvailable: boolean;
};

export type HubCard<Row> = { status: IntegrationStatus; row: Row | null };

type HubProvider<Row> = {
  id: string;
  label: string;
  /** A disabled provider is not queried and is left out of the summary counts. */
  enabled: boolean;
  query: (context: HubLoadContext) => PromiseLike<{ data: Row | null; error: { message: string } | null }>;
  status: (row: Row | null, context: HubLoadContext) => IntegrationStatus;
};

const stripe: HubProvider<StripeHubRow> = {
  id: "stripe",
  label: "Stripe",
  enabled: true,
  query: ({ supabase, studioId }) =>
    supabase
      .from("studios")
      .select(
        "stripe_connected_account_id, stripe_connect_details_submitted, stripe_connect_charges_enabled, stripe_connect_payouts_enabled, stripe_connect_onboarding_complete",
      )
      .eq("id", studioId)
      .maybeSingle<StripeHubRow>(),
  status: (row) => stripeHubStatus(row),
};

const wave: HubProvider<WaveHubRow> = {
  id: "wave",
  label: "Wave",
  enabled: true,
  query: ({ supabase, studioId }) =>
    supabase
      .from("studio_wave_connections")
      .select("id, status, wave_business_id, wave_business_name, posting_enabled, posting_mode, scopes, updated_at")
      .eq("studio_id", studioId)
      .maybeSingle<WaveHubRow>(),
  status: (row, { waveAvailable }) => waveHubStatus(waveAvailable, row),
};

const googleCalendar: HubProvider<GoogleCalendarHubRow> = {
  id: "google_calendar",
  label: "Google Calendar",
  enabled: true,
  query: ({ supabase, studioId }) =>
    supabase
      .from("studio_google_calendar_connections")
      .select("id, status, google_account_email, calendar_id, calendar_summary, sync_lessons, sync_classes, sync_events, last_sync_at, last_sync_status, last_sync_error")
      .eq("studio_id", studioId)
      // Personal instructor connections share the studio_id; without this an admin sees several rows and the page throws.
      .eq("connection_scope", "studio")
      .maybeSingle<GoogleCalendarHubRow>(),
  status: (row) => googleHubStatus(row),
};

const gusto: HubProvider<GustoHubRow> = {
  id: "gusto",
  label: "Gusto",
  enabled: GUSTO_INTEGRATION_ENABLED,
  query: ({ supabase, studioId }) =>
    supabase
      .from("studio_gusto_connections")
      .select("id, status, environment, gusto_company_name, last_health_check_at, last_health_status, last_error")
      .eq("studio_id", studioId)
      .maybeSingle<GustoHubRow>(),
  status: (row) => gustoHubStatus(row),
};

export const HUB_PROVIDERS = { stripe, wave, googleCalendar, gusto } as const;

async function loadCard<Row>(provider: HubProvider<Row>, context: HubLoadContext): Promise<HubCard<Row>> {
  if (!provider.enabled) return { status: provider.status(null, context), row: null };
  const { data, error } = await provider.query(context);
  // A failed read must surface: showing "Available" would invite the studio to reconnect something that is connected.
  if (error) throw new Error(`Failed to load ${provider.label} status: ${error.message}`);
  return { status: provider.status(data, context), row: data };
}

export async function loadIntegrationHub(context: HubLoadContext) {
  const [stripeCard, waveCard, googleCard, gustoCard] = await Promise.all([
    loadCard(stripe, context),
    loadCard(wave, context),
    loadCard(googleCalendar, context),
    loadCard(gusto, context),
  ]);
  const tracked = [
    [stripe, stripeCard],
    [wave, waveCard],
    [googleCalendar, googleCard],
    [gusto, gustoCard],
  ] as const;
  const statuses = tracked.filter(([provider]) => provider.enabled).map(([, card]) => card.status);
  const connected = statuses.filter((status) => status === "connected").length;
  const attention = statuses.filter((status) => status === "attention").length;

  return {
    stripe: stripeCard,
    wave: waveCard,
    googleCalendar: googleCard,
    gusto: gustoCard,
    counts: { connected, attention, available: Math.max(0, statuses.length - connected - attention) },
  };
}
