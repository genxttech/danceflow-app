import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B5D Phase A correction: checkInClientIdentityAppointmentAction now
 * verifies the QR token via get_client_by_qr_token_for_checkin instead of
 * a raw clients read, and additionally checks that the RPC-resolved
 * client id matches the caller-supplied clientId -- closing off any
 * possibility of a mismatched/forged clientId being trusted directly.
 *
 * FC-1B5D2 D2C-0B addition: the subsequent appointment-ownership check
 * previously read `appointments` directly. It now goes through the
 * minimized get_client_appointment_for_checkin_validation RPC -- this
 * suite proves the action (1) calls the identity RPC before the
 * appointment validation RPC, (2) never queries the `appointments` table
 * directly any more, (3) still rejects a mismatched clientId before ever
 * reaching appointment validation, (4) rejects when the RPC reports the
 * appointment does not belong to the token-resolved client (covers both
 * "another client's appointment" and "another studio's appointment" --
 * both are denied by the RPC returning zero rows, proven independently at
 * the SQL level by test_T_fc1b5d2_d2c0b_qr_checkin_appointment_rpc.sql),
 * and (5) only ever reaches the attendance_records write after a
 * successful appointment RPC validation.
 *
 * CORRECTED (post-independent-review): an earlier version of the
 * validation RPC accepted a caller-supplied `target_client_id`, authorized
 * only by active studio membership -- letting any active studio member
 * validate/check in any other real client's appointment by supplying that
 * client's plain, non-secret UUID, bypassing the QR token entirely. The
 * RPC now takes the QR token itself and resolves the authorized client
 * internally. This suite explicitly asserts the action passes `qr_token`,
 * never `target_client_id`/`client_id`, to the validation RPC -- the
 * form-supplied `clientId` is still used ONLY for the pre-existing
 * cross-check against the token-resolved identity, never forwarded to the
 * appointment RPC as authority.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

type RpcResponse = { data: unknown; error: unknown };

let identityRpcResult: RpcResponse = { data: [], error: null };
let appointmentValidationRpcResult: RpcResponse = { data: [], error: null };
const rpcCalls: { fn: string; args: unknown }[] = [];
let appointmentsTableQueried = false;
let attendanceTableQueried = false;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      if (fn === "get_client_by_qr_token_for_checkin") return Promise.resolve(identityRpcResult);
      if (fn === "get_client_appointment_for_checkin_validation")
        return Promise.resolve(appointmentValidationRpcResult);
      return Promise.resolve({ data: null, error: { message: `unexpected rpc: ${fn}` } });
    },
    from(table: string) {
      if (table === "appointments") {
        appointmentsTableQueried = true;
      }
      if (table === "attendance_records") {
        attendanceTableQueried = true;
      }
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      // No pre-existing attendance row -- drives upsertAttendanceRecord
      // down the insert path.
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      chain.insert = () => Promise.resolve({ error: null });
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

const APPROVED_CLIENT_ROW = {
  id: CLIENT_ID,
  first_name: "Jane",
  last_name: "Doe",
  photo_url: null,
  skill_level: null,
};

const APPROVED_APPOINTMENT_ROW = {
  id: APPOINTMENT_ID,
  appointment_type: "private_lesson",
  status: "scheduled",
};

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
  appointmentsTableQueried = false;
  attendanceTableQueried = false;
  identityRpcResult = { data: [], error: null };
  appointmentValidationRpcResult = { data: [], error: null };
});

describe("checkInClientIdentityAppointmentAction -- FC-1B5D correction", () => {
  it("verifies the token via the RPC, not a raw clients read", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    expect(rpcCalls[0].fn).toBe("get_client_by_qr_token_for_checkin");
  });

  it("rejects when the RPC returns a client id that does not match the supplied clientId", async () => {
    identityRpcResult = {
      data: [{ ...APPROVED_CLIENT_ROW, id: OTHER_CLIENT_ID, first_name: "Someone", last_name: "Else" }],
      error: null,
    };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    // Verification failed before the appointment RPC (and any subsequent
    // check-in mutation) was ever reached.
    expect(rpcCalls).toHaveLength(1);
    expect(attendanceTableQueried).toBe(false);
  });

  it("rejects when the token does not resolve to any client (empty RPC result)", async () => {
    identityRpcResult = { data: [], error: null };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    expect(rpcCalls).toHaveLength(1);
    expect(attendanceTableQueried).toBe(false);
  });
});

describe("checkInClientIdentityAppointmentAction -- FC-1B5D2 D2C-0B appointment RPC boundary", () => {
  it("calls get_client_by_qr_token_for_checkin BEFORE get_client_appointment_for_checkin_validation", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    appointmentValidationRpcResult = { data: [APPROVED_APPOINTMENT_ROW], error: null };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    expect(rpcCalls.map((c) => c.fn)).toEqual([
      "get_client_by_qr_token_for_checkin",
      "get_client_appointment_for_checkin_validation",
    ]);
  });

  it("never queries the appointments table directly", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    appointmentValidationRpcResult = { data: [APPROVED_APPOINTMENT_ROW], error: null };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    expect(appointmentsTableQueried).toBe(false);
  });

  it("passes the session-resolved studioId, the normalized QR token, and the appointment id to the validation RPC -- never a client id, and never a caller-supplied value used as authority merely because it is present in form data", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    appointmentValidationRpcResult = { data: [APPROVED_APPOINTMENT_ROW], error: null };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    const validationArgs = rpcCalls[1].args as Record<string, unknown>;

    expect(validationArgs).toMatchObject({
      target_studio_id: "00000000-0000-0000-0000-000000000001",
      qr_token: VALID_TOKEN,
      target_appointment_id: APPOINTMENT_ID,
    });
    // The corrected design authorizes by the QR token, resolved internally
    // by the RPC -- the form-supplied clientId is used only for the
    // earlier cross-check against the token-resolved identity, never
    // forwarded to the appointment RPC as authority.
    expect(validationArgs).not.toHaveProperty("target_client_id");
    expect(validationArgs).not.toHaveProperty("client_id");
    expect(validationArgs).not.toHaveProperty("clientId");
  });

  it("proceeds to the attendance write once the appointment RPC validation succeeds", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    appointmentValidationRpcResult = { data: [APPROVED_APPOINTMENT_ROW], error: null };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    expect(attendanceTableQueried).toBe(true);
  });

  it("another client's appointment cannot be checked in -- the validation RPC returning zero rows blocks the mutation", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    // Simulates the RPC's own client_id = target_client_id predicate
    // excluding a real appointment that belongs to a different client --
    // proven directly at the SQL level in
    // test_T_fc1b5d2_d2c0b_qr_checkin_appointment_rpc.sql CASE 4.
    appointmentValidationRpcResult = { data: [], error: null };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    expect(attendanceTableQueried).toBe(false);
  });

  it("another studio's appointment cannot be checked in -- the validation RPC returning zero rows blocks the mutation", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    // Simulates the RPC's own studio_id = target_studio_id predicate
    // excluding a real appointment that belongs to a different studio --
    // proven directly at the SQL level in
    // test_T_fc1b5d2_d2c0b_qr_checkin_appointment_rpc.sql CASE 5.
    appointmentValidationRpcResult = { data: [], error: null };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    expect(attendanceTableQueried).toBe(false);
  });

  it("an RPC-level error also blocks the attendance write", async () => {
    identityRpcResult = { data: [APPROVED_CLIENT_ROW], error: null };
    appointmentValidationRpcResult = { data: null, error: { message: "simulated RPC failure" } };

    await run(checkInClientIdentityAppointmentAction(baseFormData()));

    expect(attendanceTableQueried).toBe(false);
  });
});
