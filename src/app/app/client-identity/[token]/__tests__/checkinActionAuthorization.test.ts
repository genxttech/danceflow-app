import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B5D Phase A correction: checkInClientIdentityAppointmentAction now
 * verifies the QR token via get_client_by_qr_token_for_checkin instead of
 * a raw clients read, and additionally checks that the RPC-resolved
 * client id matches the caller-supplied clientId -- closing off any
 * possibility of a mismatched/forged clientId being trusted directly.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

let rpcResult: { data: unknown; error: unknown } = { data: [], error: null };
const rpcCalls: { fn: string; args: unknown }[] = [];
let appointmentQueried = false;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      return Promise.resolve(rpcResult);
    },
    from(table: string) {
      if (table === "appointments") {
        appointmentQueried = true;
      }
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({
    studioId: "00000000-0000-0000-0000-000000000001",
    userId: "user-1",
  }),
}));

const { checkInClientIdentityAppointmentAction } = await import("../actions");

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function run(promise: Promise<unknown>) {
  return promise.catch((e) => e);
}

const CLIENT_ID = "11111111-1111-1111-8111-111111111111";
const OTHER_CLIENT_ID = "22222222-2222-2222-8222-222222222222";
const APPOINTMENT_ID = "33333333-3333-3333-8333-333333333333";
const VALID_TOKEN = "a-valid-looking-qr-token-1234567890";

function baseFormData(overrides: Record<string, string> = {}) {
  return formDataFor({
    appointmentId: APPOINTMENT_ID,
    clientId: CLIENT_ID,
    token: VALID_TOKEN,
    ...overrides,
  });
}

beforeEach(() => {
  rpcCalls.length = 0;
  appointmentQueried = false;
  rpcResult = { data: [], error: null };
});

describe("checkInClientIdentityAppointmentAction -- FC-1B5D correction", () => {
  it("verifies the token via the RPC, not a raw clients read", async () => {
    rpcResult = {
      data: [{ id: CLIENT_ID, first_name: "Jane", last_name: "Doe", photo_url: null, skill_level: null }],
      error: null,
    };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("get_client_by_qr_token_for_checkin");
  });

  it("rejects when the RPC returns a client id that does not match the supplied clientId", async () => {
    rpcResult = {
      data: [{ id: OTHER_CLIENT_ID, first_name: "Someone", last_name: "Else", photo_url: null, skill_level: null }],
      error: null,
    };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    // Verification failed before the appointment (and any subsequent
    // check-in mutation) was ever reached.
    expect(appointmentQueried).toBe(false);
  });

  it("rejects when the token does not resolve to any client (empty RPC result)", async () => {
    rpcResult = { data: [], error: null };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    expect(appointmentQueried).toBe(false);
  });

  it("proceeds to the appointment lookup once the RPC-resolved client id matches", async () => {
    rpcResult = {
      data: [{ id: CLIENT_ID, first_name: "Jane", last_name: "Doe", photo_url: null, skill_level: null }],
      error: null,
    };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    expect(appointmentQueried).toBe(true);
  });
});
