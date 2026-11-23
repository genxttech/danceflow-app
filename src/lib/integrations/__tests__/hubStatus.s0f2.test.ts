import { describe, expect, it } from "vitest";
import { googleHubStatus, gustoHubStatus, isNeedsActionStatus, stripeHubStatus, waveHubStatus, waveNeedsReauthorization } from "../hubStatus";

const wave = (over: Partial<{ status: string | null; wave_business_id: string | null; scopes: string[] | null }> = {}) => ({ status: "connected", wave_business_id: "b", scopes: ["transaction:write"], ...over });
const google = (over: Partial<{ status: string | null; last_sync_status: string | null; last_sync_error: string | null }> = {}) => ({ status: "connected", last_sync_status: "succeeded", last_sync_error: null, ...over });

describe("integration hub status registry (S0-f2)", () => {
  it("Wave: locked without the feature, available when absent or disconnected", () => {
    expect(waveHubStatus(false, wave())).toBe("locked");
    expect(waveHubStatus(true, null)).toBe("available");
    expect(waveHubStatus(true, wave({ status: "disconnected" }))).toBe("available");
  });
  it("Wave: connected with a business and the write scope", () => {
    expect(waveHubStatus(true, wave())).toBe("connected");
  });
  it("Wave: attention for no business, missing write scope, and every needs-action status", () => {
    expect(waveHubStatus(true, wave({ wave_business_id: null }))).toBe("attention");
    expect(waveHubStatus(true, wave({ scopes: ["user:read"] }))).toBe("attention");
    for (const status of ["needs_reauth", "reauthorization_required", "error"]) expect(waveHubStatus(true, wave({ status }))).toBe("attention");
  });
  it("Wave: needs reauthorization only for needs-action status or a connected row without write scope", () => {
    expect(waveNeedsReauthorization(null)).toBe(false);
    expect(waveNeedsReauthorization(wave())).toBe(false);
    expect(waveNeedsReauthorization(wave({ scopes: null }))).toBe(true);
    expect(waveNeedsReauthorization(wave({ status: "disconnected", scopes: [] }))).toBe(false);
    expect(waveNeedsReauthorization(wave({ status: "needs_reauth" }))).toBe(true);
  });
  it("Google: connected, failed sync, error text, needs_reauth, disconnected, none", () => {
    expect(googleHubStatus(google())).toBe("connected");
    expect(googleHubStatus(google({ last_sync_status: "failed" }))).toBe("attention");
    expect(googleHubStatus(google({ last_sync_error: "boom" }))).toBe("attention");
    expect(googleHubStatus(google({ status: "needs_reauth" }))).toBe("attention");
    expect(googleHubStatus(google({ status: "disconnected" }))).toBe("available");
    expect(googleHubStatus(null)).toBe("available");
  });
  it("Gusto mirrors the same rules on its health fields", () => {
    expect(gustoHubStatus({ status: "connected", last_health_status: "ok", last_error: null })).toBe("connected");
    expect(gustoHubStatus({ status: "connected", last_health_status: "failed", last_error: null })).toBe("attention");
    expect(gustoHubStatus({ status: "error", last_health_status: null, last_error: null })).toBe("attention");
    expect(gustoHubStatus(null)).toBe("available");
  });
  it("Stripe: none, partially onboarded, ready", () => {
    const base = { stripe_connected_account_id: "acct", stripe_connect_onboarding_complete: true, stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true };
    expect(stripeHubStatus(null)).toBe("available");
    expect(stripeHubStatus({ ...base, stripe_connected_account_id: null })).toBe("available");
    expect(stripeHubStatus({ ...base, stripe_connect_payouts_enabled: false })).toBe("attention");
    expect(stripeHubStatus(base)).toBe("connected");
  });
  it("isNeedsActionStatus handles null", () => {
    expect(isNeedsActionStatus(null)).toBe(false);
    expect(isNeedsActionStatus("connected")).toBe(false);
  });
});
