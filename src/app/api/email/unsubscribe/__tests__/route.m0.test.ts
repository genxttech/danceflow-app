import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Marketing M-0 ROLLBACK-COMPAT build: the pre-M-0 application plus only the M-0 RFC 8058 one-click endpoint, so
 * List-Unsubscribe POSTs in emails already sent by M-0 keep working if the application is rolled back. The footer links
 * of those emails open the pre-M-0 confirmation pages, which keep working through the M-0 stage-1 compatibility SQL.
 * The endpoint needs M-0 stage 1 (marketing_unsubscribe_by_token) to be installed.
 */

const h = vi.hoisted(() => ({ rpc: vi.fn(), adminCreated: 0 }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    h.adminCreated += 1;
    return { rpc: (...args: unknown[]) => h.rpc(...args) };
  },
}));

const { GET, POST } = await import("../[token]/route");

const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
let ip = 0;

function post(token: string, body: string | null, contentType = "application/x-www-form-urlencoded") {
  ip += 1;
  const request = new Request(`https://www.idanceflow.com/api/email/unsubscribe/${token}`, {
    method: "POST",
    headers: { "content-type": contentType, "x-forwarded-for": `10.0.0.${ip}` },
    body,
  });
  return POST(request, { params: Promise.resolve({ token }) });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.idanceflow.com";
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: { ok: true, scope_kind: "studio" }, error: null });
  h.adminCreated = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/email/unsubscribe/[token]", () => {
  it("RFC 8058 one-click: unsubscribes with no login or cookies and answers 200", async () => {
    const response = await post(TOKEN, "List-Unsubscribe=One-Click");
    expect(response.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("marketing_unsubscribe_by_token", { p_token: TOKEN, p_method: "one_click" });
  });

  it("accepts the token case-insensitively and normalizes it", async () => {
    await post(TOKEN.toUpperCase(), "List-Unsubscribe=One-Click");
    expect(h.rpc).toHaveBeenCalledWith("marketing_unsubscribe_by_token", { p_token: TOKEN, p_method: "one_click" });
  });

  it("is idempotent from the caller's side: a repeat is processed the same way", async () => {
    expect((await post(TOKEN, "List-Unsubscribe=One-Click")).status).toBe(200);
    expect((await post(TOKEN, "List-Unsubscribe=One-Click")).status).toBe(200);
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });

  it("does not disclose whether a token exists: an unknown token gets the same answer", async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, reason: "not_found" }, error: null });
    const unknown = await post(TOKEN, "List-Unsubscribe=One-Click");
    h.rpc.mockResolvedValue({ data: { ok: true, scope_kind: "organizer" }, error: null });
    const known = await post(TOKEN, "List-Unsubscribe=One-Click");
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
  });

  it("a malformed token never reaches the database and still looks processed", async () => {
    const response = await post("x' or 1=1 --", "List-Unsubscribe=One-Click");
    expect(response.status).toBe(200);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("if the unsubscribe cannot be recorded it says so (503) instead of claiming success", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "db down" } });
    const response = await post(TOKEN, "List-Unsubscribe=One-Click");
    expect(response.status).toBe(503);
  });

  it("the confirmation page form posts back here and is redirected to the done state", async () => {
    const response = await post(TOKEN, "df_source=page&df_kind=organizer");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`https://www.idanceflow.com/unsubscribe/organizer-marketing/${TOKEN}?done=1`);
    expect(h.rpc).toHaveBeenCalledWith("marketing_unsubscribe_by_token", { p_token: TOKEN, p_method: "page_form" });
  });

  it("page form failure redirects with an error instead of a false confirmation", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "57014" } });
    const response = await post(TOKEN, "df_source=page&df_kind=studio");
    expect(response.headers.get("location")).toBe(`https://www.idanceflow.com/unsubscribe/marketing/${TOKEN}?error=unavailable`);
  });

  it("rate limits a single client", async () => {
    const request = () =>
      POST(
        new Request(`https://www.idanceflow.com/api/email/unsubscribe/${TOKEN}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.9.9.9" },
          body: "List-Unsubscribe=One-Click",
        }),
        { params: Promise.resolve({ token: TOKEN }) },
      );
    const statuses: number[] = [];
    for (let i = 0; i < 32; i += 1) statuses.push((await request()).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("GET never unsubscribes", () => {
  it("GET on the endpoint only redirects to the confirmation page", async () => {
    const response = await GET(new Request(`https://www.idanceflow.com/api/email/unsubscribe/${TOKEN}`), {
      params: Promise.resolve({ token: TOKEN }),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`https://www.idanceflow.com/unsubscribe/marketing/${TOKEN}`);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.adminCreated).toBe(0);
  });

});
