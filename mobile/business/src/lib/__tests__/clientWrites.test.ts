import { createStaffApi, StaffApiError, staffErrorKind } from "@/lib/staffApi";
import { newEntityId } from "@/lib/uuid";

/* Phase 1A client writes in the staff API client (P0-5a): add note, quick-add client. */

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}
function setup(responses: Response[]) {
  const fetchImpl = jest.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  });
  const api = createStaffApi({
    baseUrl: "https://danceflow.test",
    getAccessToken: async () => "t",
    refreshAccessToken: async () => "t2",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: async () => {},
    appHeader: "business/0.2.0/3/android",
  });
  return { api, fetchImpl };
}
const reqOf = (fetchImpl: jest.Mock, i = 0) => {
  const [url, init] = fetchImpl.mock.calls[i] as unknown as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
};

const NOTE = { id: "11111111-1111-4111-8111-111111111111", clientId: "c1", noteType: "follow_up", body: "Call back Friday", occurredAt: "2026-11-20T15:00:00.000Z", createdAt: "2026-11-20T15:00:01.000Z" };

describe("addClientNote", () => {
  it("POSTs noteId, body and type with the Idempotency-Key and the version header", async () => {
    const { api, fetchImpl } = setup([res(201, { note: NOTE })]);
    const out = await api.addClientNote("s1", "c1", { noteId: NOTE.id, body: "Call back Friday", noteType: "follow_up" }, "df-bus-key-12345678");
    const { url, init, headers, body } = reqOf(fetchImpl);
    expect(url).toBe("https://danceflow.test/api/staff/workspaces/s1/clients/c1/notes");
    expect(init.method).toBe("POST");
    expect(headers["Idempotency-Key"]).toBe("df-bus-key-12345678");
    expect(headers["X-DanceFlow-App"]).toBe("business/0.2.0/3/android");
    expect(body).toEqual({ noteId: NOTE.id, body: "Call back Friday", noteType: "follow_up" });
    expect(out.note).toEqual(NOTE);
  });
  it("leaves the type out when none is chosen (the server defaults to general)", async () => {
    const { api, fetchImpl } = setup([res(200, { note: NOTE })]);
    await api.addClientNote("s1", "c1", { noteId: NOTE.id, body: "x" }, "df-bus-key-12345678");
    expect(reqOf(fetchImpl).body).toEqual({ noteId: NOTE.id, body: "x" });
  });
  it("treats a body without a note as an unexpected response, not a success", async () => {
    const { api } = setup([res(201, { nope: true })]);
    await expect(api.addClientNote("s1", "c1", { noteId: NOTE.id, body: "x" }, "df-bus-key-12345678")).rejects.toMatchObject({ code: "unexpected_response" });
  });
  it("409 idempotency_conflict keeps the stored note as the server's current state", async () => {
    const { api } = setup([res(409, { error: "used", code: "idempotency_conflict", current: { note: NOTE } })]);
    const error = (await api.addClientNote("s1", "c1", { noteId: NOTE.id, body: "other" }, "df-bus-key-12345678").catch((e: unknown) => e)) as StaffApiError;
    expect(staffErrorKind(error)).toBe("conflict");
    expect(error.extra?.serverCode).toBe("idempotency_conflict");
    expect(error.extra?.current).toEqual({ note: NOTE });
  });
  it("403 for an instructor and 403 writes_disabled are different kinds", async () => {
    const a = (await setup([res(403, { error: "r", code: "role_not_permitted" })]).api.addClientNote("s", "c", { noteId: NOTE.id, body: "x" }, "df-bus-key-12345678").catch((e: unknown) => e)) as StaffApiError;
    const b = (await setup([res(403, { error: "off", code: "writes_disabled" })]).api.addClientNote("s", "c", { noteId: NOTE.id, body: "x" }, "df-bus-key-12345678").catch((e: unknown) => e)) as StaffApiError;
    expect(staffErrorKind(a)).toBe("not_permitted");
    expect(staffErrorKind(b)).toBe("writes_disabled");
  });
});

describe("createClient", () => {
  const input = { clientId: "22222222-2222-4222-8222-222222222222", firstName: "Ana", lastName: "Rivera", phone: "(555) 010-0100" };
  it("POSTs the details with clientId and reports a replay", async () => {
    const { api, fetchImpl } = setup([res(201, { client: { id: input.clientId, firstName: "Ana", lastName: "Rivera", status: "lead" } }), res(200, { client: { id: input.clientId, firstName: "Ana", lastName: "Rivera", status: "lead" }, replayed: true })]);
    const first = await api.createClient("s1", input, "df-bus-key-12345678");
    expect(reqOf(fetchImpl).url).toBe("https://danceflow.test/api/staff/workspaces/s1/clients");
    expect(reqOf(fetchImpl).body).toEqual(input);
    expect(first).toEqual({ client: { id: input.clientId, firstName: "Ana", lastName: "Rivera", status: "lead" }, replayed: false });
    const again = await api.createClient("s1", input, "df-bus-key-12345678");
    expect(again.replayed).toBe(true);
  });
  it("409 duplicate_client is a conflict that exposes existingClientId and matchedOn as details, never as text", async () => {
    const { api } = setup([res(409, { error: "A client with this phone number already exists in this studio.", code: "duplicate_client", existingClientId: "c9", matchedOn: "phone" })]);
    const error = (await api.createClient("s1", input, "df-bus-key-12345678").catch((e: unknown) => e)) as StaffApiError;
    expect(staffErrorKind(error)).toBe("conflict");
    expect(error.extra?.serverCode).toBe("duplicate_client");
    expect(error.extra?.details).toEqual({ existingClientId: "c9", matchedOn: "phone" });
  });
  it("400 invalid_request is a client bug kind", async () => {
    const { api } = setup([res(400, { error: "A phone number or an email is required.", code: "invalid_request" })]);
    const error = (await api.createClient("s1", input, "df-bus-key-12345678").catch((e: unknown) => e)) as StaffApiError;
    expect(staffErrorKind(error)).toBe("client_bug");
    expect(error.message).toBe("A phone number or an email is required.");
  });
});

describe("newEntityId", () => {
  it("makes distinct RFC 4122 v4 UUIDs", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newEntityId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("falls back to Math.random when crypto.randomUUID is absent", () => {
    const original = (globalThis as { crypto?: unknown }).crypto;
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      expect(newEntityId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });
});
