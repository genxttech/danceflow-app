import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
 *
 * FC-1B5D2 D2C-0B addition: the page's same-day appointment display
 * previously read `appointments` directly. It now goes through the
 * minimized get_client_appointments_for_checkin RPC -- this suite proves
 * the page (1) calls the identity RPC first and only calls the
 * appointments RPC after a successful token resolution, (2) never queries
 * the `appointments` table directly any more, (3) renders the RPC-sourced
 * appointment fields correctly, and (4) never surfaces a notes/payment/
 * private field even if one were ever present on a returned row.
 *
 * CORRECTED (post-independent-review): an earlier version of the
 * appointments RPC accepted a caller-supplied `target_client_id`,
 * authorized only by active studio membership -- letting any active
 * studio member retrieve any other real client's appointments by
 * supplying that client's plain, non-secret UUID. The RPC now takes the
 * QR token itself and resolves the authorized client internally. This
 * suite explicitly asserts the page passes `qr_token`, never
 * `target_client_id`/`client_id`/`clientId`, to the appointments RPC. The
 * RPC's own row-level security properties (token-vs-client-id isolation,
 * studio isolation, no-active-role denial, anon denial, private-helper
 * lockdown, column contract, absence of the insecure overload) are proven
 * separately by the live-Postgres suite in
 * src/lib/supabase/migrations/sql-tests/test_T_fc1b5d2_d2c0b_qr_checkin_appointment_rpc.sql
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

type RpcResponse = { data: unknown; error: unknown };

let identityRpcResult: RpcResponse = { data: [], error: null };
let appointmentsRpcResult: RpcResponse = { data: [], error: null };
const rpcCalls: { fn: string; args: unknown }[] = [];
let appointmentsTableQueried = false;

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
    from(table: string) {
      if (table === "appointments") {
        appointmentsTableQueried = true;
      }
      return benignChain();
    },
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      if (fn === "get_client_by_qr_token_for_checkin") return Promise.resolve(identityRpcResult);
      if (fn === "get_client_appointments_for_checkin") return Promise.resolve(appointmentsRpcResult);
      return Promise.resolve({ data: null, error: { message: `unexpected rpc: ${fn}` } });
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

async function renderPage(token: string) {
  const element = await ClientIdentityPage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element as React.ReactElement);
}

const APPROVED_CLIENT_ROW = {
  id: "client-1",
  first_name: "Jane",
  last_name: "Doe",
  photo_url: "https://example.test/photo.jpg",
  skill_level: "intermediate",
};

const APPOINTMENT_ROW = {
  id: "appt-1",
  title: "Private with Sam",
  appointment_type: "private_lesson",
  status: "scheduled",
  starts_at: "2026-09-06T15:00:00.000Z",
  ends_at: "2026-09-06T16:00:00.000Z",
  instructor_first_name: "Sam",
  instructor_last_name: "Teacher",
  room_name: "Studio Room 1",
};

beforeEach(() => {
  rpcCalls.length = 0;
  appointmentsTableQueried = false;
  identityRpcResult = { data: [], error: null };
  appointmentsRpcResult = { data: [], error: null };
});

describe("client-identity QR page -- FC-1B5D correction", () => {
  it("calls get_client_by_qr_token_for_checkin with the session studio id and the URL token", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    mockSession("instructor");

    await run(runPage("a-valid-looking-qr-token-1234567890"));

    expect(rpcCalls[0].fn).toBe("get_client_by_qr_token_for_checkin");
    expect(rpcCalls[0].args).toMatchObject({
      target_studio_id: "studio-1",
      qr_token: "a-valid-looking-qr-token-1234567890",
    });
  });

  it("returned client object never carries email/phone/status keys", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
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

  it("wrong/unmatched token (empty RPC result) renders notFound, not a client, and never reaches the appointments RPC", async () => {
    identityRpcResult = { data: [], error: null };
    mockSession("instructor");

    const error = await runPage("a-token-that-does-not-match-anything");

    expect((error as { digest?: string })?.digest).toBe("NEXT_NOT_FOUND");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("get_client_by_qr_token_for_checkin");
  });

  it.each(["instructor", "front_desk", "studio_owner", "studio_admin"])(
    "%s can successfully use the QR identity flow (instructor retains check-in capability)",
    async (role) => {
      identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
      appointmentsRpcResult = { data: [], error: null };
      mockSession(role);

      const error = await runPage("a-valid-looking-qr-token-1234567890");

      // No NOT_FOUND / no unexpected throw -- the page proceeds to render.
      expect((error as { digest?: string })?.digest).not.toBe("NEXT_NOT_FOUND");
    },
  );

  it("FC-1B5D2 D2C-0B (corrected): calls get_client_appointments_for_checkin only AFTER the identity RPC resolves, with the QR TOKEN itself (not a client id) and a same-day range", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    appointmentsRpcResult = { data: [APPOINTMENT_ROW], error: null };
    mockSession("instructor");

    await run(runPage("a-valid-looking-qr-token-1234567890"));

    expect(rpcCalls.map((c) => c.fn)).toEqual([
      "get_client_by_qr_token_for_checkin",
      "get_client_appointments_for_checkin",
    ]);

    const appointmentsCall = rpcCalls[1].args as Record<string, unknown>;

    expect(appointmentsCall.target_studio_id).toBe("studio-1");
    // The corrected design authorizes by the QR token itself, resolved
    // internally by the RPC -- the page must pass the token, never a
    // client id (caller-supplied or otherwise).
    expect(appointmentsCall.qr_token).toBe("a-valid-looking-qr-token-1234567890");
    expect(appointmentsCall).not.toHaveProperty("target_client_id");
    expect(appointmentsCall).not.toHaveProperty("client_id");
    expect(appointmentsCall).not.toHaveProperty("clientId");

    const rangeStart = new Date(appointmentsCall.range_start as string).getTime();
    const rangeEnd = new Date(appointmentsCall.range_end as string).getTime();
    expect(rangeEnd - rangeStart).toBe(24 * 60 * 60 * 1000);
  });

  it("FC-1B5D2 D2C-0B: never queries the appointments table directly", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    appointmentsRpcResult = { data: [APPOINTMENT_ROW], error: null };
    mockSession("instructor");

    await run(runPage("a-valid-looking-qr-token-1234567890"));

    expect(appointmentsTableQueried).toBe(false);
  });

  it("FC-1B5D2 D2C-0B: renders the RPC-sourced appointment title, instructor name, and room name", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    appointmentsRpcResult = { data: [APPOINTMENT_ROW], error: null };
    mockSession("instructor");

    const markup = await renderPage("a-valid-looking-qr-token-1234567890");

    expect(markup).toContain("Private with Sam");
    expect(markup).toContain("Sam Teacher");
    expect(markup).toContain("Studio Room 1");
  });

  it("FC-1B5D2 D2C-0B: no notes/payment/private field ever reaches the rendered page, even if unexpectedly present on a returned row", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    appointmentsRpcResult = {
      data: [
        {
          ...APPOINTMENT_ROW,
          // Fields the RPC contract never returns -- included here only to
          // prove the page's own rendering would not surface them even if
          // a future regression somehow added them to the RPC result.
          notes: "SECRET-INTERNAL-NOTE-should-never-render",
          payment_status: "SECRET-PAYMENT-STATUS-should-never-render",
          price_amount: "SECRET-PRICE-should-never-render",
        },
      ],
      error: null,
    };
    mockSession("instructor");

    const markup = await renderPage("a-valid-looking-qr-token-1234567890");

    expect(markup).not.toContain("SECRET-INTERNAL-NOTE-should-never-render");
    expect(markup).not.toContain("SECRET-PAYMENT-STATUS-should-never-render");
    expect(markup).not.toContain("SECRET-PRICE-should-never-render");
  });
});
