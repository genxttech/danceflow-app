import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Proves the two Gusto OAuth routes are blocked at the server-action/route
 * boundary -- not merely unlinked from the UI -- while the integration is
 * dormant. Every Gusto client/token export is mocked to throw if called at
 * all, so a regression that accidentally moves the dormancy check past any
 * real OAuth logic fails loudly here rather than silently reopening the
 * connect flow.
 */

function throwingClientExport(name: string) {
  return (..._args: unknown[]) => {
    throw new Error(`Unexpected call to Gusto client export "${name}" while dormant`);
  };
}

vi.mock("@/lib/integrations/gusto/client", () => ({
  buildGustoAuthorizationUrl: throwingClientExport("buildGustoAuthorizationUrl"),
  exchangeGustoAuthorizationCode: throwingClientExport("exchangeGustoAuthorizationCode"),
  getGustoCompany: throwingClientExport("getGustoCompany"),
  getGustoTokenInfo: throwingClientExport("getGustoTokenInfo"),
  gustoCompanyUuid: throwingClientExport("gustoCompanyUuid"),
  gustoEnvironment: throwingClientExport("gustoEnvironment"),
  normalizedGustoScopes: throwingClientExport("normalizedGustoScopes"),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("Unexpected Supabase client creation while dormant");
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("Unexpected admin client creation while dormant");
  },
}));

// Both routes' non-dormancy code paths transitively import "server-only"
// (via these two modules), which errors outside Next's server runtime.
// Neither module's exports should ever be reached while dormant -- if they
// are, that itself indicates the guard ran too late -- so both are mocked
// to throw.
vi.mock("@/lib/security/oauth", () => ({
  createOAuthStateCookieValue: throwingClientExport("createOAuthStateCookieValue"),
  oauthStateCookieOptions: throwingClientExport("oauthStateCookieOptions"),
  isValidOAuthState: throwingClientExport("isValidOAuthState"),
  parseOAuthStateCookie: throwingClientExport("parseOAuthStateCookie"),
  safeOAuthErrorCode: throwingClientExport("safeOAuthErrorCode"),
}));

vi.mock("@/lib/integrations/wave/secrets", () => ({
  encryptIntegrationSecret: throwingClientExport("encryptIntegrationSecret"),
}));

describe("Gusto OAuth routes while dormant", () => {
  it("connect route returns the dormant response before generating an authorization URL", async () => {
    const { GET } = await import("../connect/route");
    const response = await GET(new Request("https://app.example.com/api/integrations/gusto/connect"));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: "This integration is not currently available." });
  });

  it("callback route returns the dormant response before exchanging any authorization code", async () => {
    const { GET } = await import("../callback/route");
    const request = new NextRequest(
      "https://app.example.com/api/integrations/gusto/callback?code=some-code&state=some-state",
    );
    const response = await GET(request);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: "This integration is not currently available." });
  });
});
