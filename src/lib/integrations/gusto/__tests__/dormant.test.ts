import { describe, expect, it } from "vitest";
import {
  GUSTO_DORMANT_STATUS,
  GUSTO_INTEGRATION_ENABLED,
  gustoDormantRouteResponse,
} from "@/lib/integrations/gusto/dormant";

/**
 * Guards the single source-of-truth flag for the Gusto dormant-integration
 * slice. If this flips to `true` without a deliberate reactivation decision,
 * every guarded entry point across the app changes behavior at once -- this
 * test exists to make that change loud, not to prevent it.
 */
describe("Gusto dormancy boundary", () => {
  it("is disabled by default", () => {
    expect(GUSTO_INTEGRATION_ENABLED).toBe(false);
  });

  it("uses a generic status string, not one that varies by connection state", () => {
    expect(GUSTO_DORMANT_STATUS).toBe("gusto_not_available");
  });

  it("the route response is a generic 404 that never inspects connection/credential state", async () => {
    const response = gustoDormantRouteResponse();
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: "This integration is not currently available." });
  });
});
