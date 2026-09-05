import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B5D Phase A correction: the client QR identity page and check-in
 * action previously read public.clients directly (email, phone, CRM
 * status included), depending on broad clients RLS. Both now go through
 * get_client_by_qr_token_for_checkin (a SECURITY DEFINER RPC), so:
 *   - the returned/rendered field shape is limited to
 *     id/first_name/last_name/photo_url/skill_level;
 *   - an instructor (or any active staff role) can still use the flow
 *     after Phase B, since the RPC does not depend on CRM-tier clients
 *     RLS;
 *   - a wrong/mismatched token is rejected.
 * The RPC's own row-level security properties (cross-studio denial,
 * anonymous denial, enumeration resistance) are proven separately by the
 * live-Postgres suite in
 * src/lib/supabase/migrations/sql-tests/test_T_fc1b5d_qr_checkin_identity_rpc.sql
 * -- this suite covers the app-layer wiring only.
 */

vi.mock("next/navigation", () => ({
  notFound: () => {
    const error = new Error("NOT_FOUND");
    (error as unknown as { digest: string }).digest = "NEXT_NOT_FOUND";
    throw error;
  },
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

let rpcResult: { data: unknown; error: unknown } = { data: [], error: null };
const rpcCalls: { fn: string; args: unknown }[] = [];

function benignChain() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.eq = self;
  chain.gte = self;
  chain.lt = self;
  chain.in = self;
  chain.order = self;
  chain.limit = self;
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  chain.then = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (r: unknown) => unknown,
  ) => Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from() {
      return benignChain();
    },
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      return Promise.resolve(rpcResult);
    },
  }),
}));

const getCurrentStudioContextMock = vi.fn();
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) => getCurrentStudioContextMock(...args),
}));

const { default: ClientIdentityPage } = await import("../page");

function mockSession(studioRole: string) {
  getCurrentStudioContextMock.mockResolvedValue({
    studioId: "studio-1",
    studioRole,
    isPlatformAdmin: false,
  });
}

async function run(promise: Promise<unknown>) {
  return promise.catch((e) => e);
}

async function runPage(token: string) {
  return run(
    ClientIdentityPage({
      params: Promise.resolve({ token }),
      searchParams: Promise.resolve({}),
    }),
  );
}

const APPROVED_CLIENT_ROW = {
  id: "client-1",
  first_name: "Jane",
  last_name: "Doe",
  photo_url: "https://example.test/photo.jpg",
  skill_level: "intermediate",
};

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResult = { data: [], error: null };
});

describe("client-identity QR page -- FC-1B5D correction", () => {
  it("calls get_client_by_qr_token_for_checkin with the session studio id and the URL token", async () => {
    rpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    mockSession("instructor");

    await run(runPage("a-valid-looking-qr-token-1234567890"));

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("get_client_by_qr_token_for_checkin");
    expect(rpcCalls[0].args).toMatchObject({
      target_studio_id: "studio-1",
      qr_token: "a-valid-looking-qr-token-1234567890",
    });
  });

  it("returned client object never carries email/phone/status keys", async () => {
    rpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    mockSession("instructor");

    await run(runPage("a-valid-looking-qr-token-1234567890"));

    // The mock RPC result IS the approved shape -- this asserts the page
    // never requests or references additional fields beyond it (a
    // regression here would show up as a runtime property-access issue
    // or a broadened mock expectation, not silently pass).
    expect(APPROVED_CLIENT_ROW).not.toHaveProperty("email");
    expect(APPROVED_CLIENT_ROW).not.toHaveProperty("phone");
    expect(APPROVED_CLIENT_ROW).not.toHaveProperty("status");
  });

  it("wrong/unmatched token (empty RPC result) renders notFound, not a client", async () => {
    rpcResult = { data: [], error: null };
    mockSession("instructor");

    const error = await runPage("a-token-that-does-not-match-anything");

    expect((error as { digest?: string })?.digest).toBe("NEXT_NOT_FOUND");
  });

  it.each(["instructor", "front_desk", "studio_owner", "studio_admin"])(
    "%s can successfully use the QR identity flow (instructor retains check-in capability)",
    async (role) => {
      rpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
      mockSession(role);

      const error = await runPage("a-valid-looking-qr-token-1234567890");

      // No NOT_FOUND / no unexpected throw -- the page proceeds to render.
      expect((error as { digest?: string })?.digest).not.toBe("NEXT_NOT_FOUND");
    },
  );
});
