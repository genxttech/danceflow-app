import { describe, expect, it } from "vitest";
import { HUB_PROVIDERS, loadIntegrationHub, type HubLoadContext } from "../hubRegistry";

type Query = { table: string; columns: string; filters: Array<[string, unknown]> };

function context(rows: Record<string, unknown> = {}, errors: Record<string, string> = {}, waveAvailable = true) {
  const queries: Query[] = [];
  const supabase = {
    from(table: string) {
      const query: Query = { table, columns: "", filters: [] };
      queries.push(query);
      const builder = {
        select(columns: string) { query.columns = columns; return builder; },
        eq(column: string, value: unknown) { query.filters.push([column, value]); return builder; },
        maybeSingle: async () => (errors[table] ? { data: null, error: { message: errors[table] } } : { data: rows[table] ?? null, error: null }),
      };
      return builder;
    },
  };
  return { queries, ctx: { supabase: supabase as unknown as HubLoadContext["supabase"], studioId: "s1", waveAvailable } };
}

const stripeReady = { stripe_connected_account_id: "acct", stripe_connect_onboarding_complete: true, stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true };

describe("integration hub registry (S0-g3)", () => {
  it("has unique ids and labels, and Gusto stays disabled while dormant", () => {
    const providers = Object.values(HUB_PROVIDERS);
    expect(new Set(providers.map((p) => p.id)).size).toBe(providers.length);
    expect(new Set(providers.map((p) => p.label)).size).toBe(providers.length);
    expect(HUB_PROVIDERS.gusto.enabled).toBe(false);
  });

  it("scopes every query to the studio, and Google to the studio-scope connection", async () => {
    const { ctx, queries } = context();
    await loadIntegrationHub(ctx);
    expect(Object.fromEntries(queries.map((q) => [q.table, q.filters]))).toEqual({
      studios: [["id", "s1"]],
      studio_wave_connections: [["studio_id", "s1"]],
      studio_google_calendar_connections: [["studio_id", "s1"], ["connection_scope", "studio"]],
    });
  });

  it("never selects a token or secret column", async () => {
    const { ctx, queries } = context();
    await loadIntegrationHub(ctx);
    for (const q of queries) expect(q.columns).not.toMatch(/token|secret|encrypted/i);
  });

  it("does not query a disabled provider and leaves it out of the counts", async () => {
    const { ctx, queries } = context();
    const hub = await loadIntegrationHub(ctx);
    expect(queries.some((q) => q.table === "studio_gusto_connections")).toBe(false);
    expect(hub.gusto).toEqual({ status: "available", row: null });
    expect(hub.counts).toEqual({ connected: 0, attention: 0, available: 3 });
  });

  it("returns each row with its status and counts them", async () => {
    const wave = { id: "w", status: "needs_reauth", wave_business_id: "b", scopes: [] };
    const google = { id: "g", status: "connected", last_sync_status: "success", last_sync_error: null };
    const { ctx } = context({ studios: stripeReady, studio_wave_connections: wave, studio_google_calendar_connections: google });
    const hub = await loadIntegrationHub(ctx);
    expect(hub.stripe).toEqual({ status: "connected", row: stripeReady });
    expect(hub.wave).toEqual({ status: "attention", row: wave });
    expect(hub.googleCalendar).toEqual({ status: "connected", row: google });
    expect(hub.counts).toEqual({ connected: 2, attention: 1, available: 0 });
  });

  it("shows Wave as locked without the plan feature, counted with the not-connected cards", async () => {
    const { ctx } = context({}, {}, false);
    const hub = await loadIntegrationHub(ctx);
    expect(hub.wave.status).toBe("locked");
    expect(hub.counts.available).toBe(3);
  });

  it.each([
    ["studios", "Stripe"],
    ["studio_wave_connections", "Wave"],
    ["studio_google_calendar_connections", "Google Calendar"],
  ])("surfaces a failed %s read instead of showing it as available", async (table, label) => {
    const { ctx } = context({}, { [table]: "boom" });
    await expect(loadIntegrationHub(ctx)).rejects.toThrow(`Failed to load ${label} status: boom`);
  });
});
