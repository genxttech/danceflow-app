import { beforeEach, describe, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";

/**
 * TW-4F hardening: getCurrentStudioContext() answers "signed out / no studio / no selected studio" with a Next redirect. The send route is a JSON endpoint:
 * a redirect thrown inside its try block used to reach the generic catch and surface as HTTP 500 (found in the R+4 exact-tree smoke). It must be a refusal:
 * 401 for sign-in, 403 otherwise, with nothing read, sent, billed or recorded.
 */

const h = vi.hoisted(() => ({
  contextImpl: null as null | (() => Promise<unknown>),
  from: vi.fn(),
  rpc: vi.fn(),
  sendBilled: vi.fn(),
  twilio: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: h.from, rpc: h.rpc }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: h.from, rpc: h.rpc }) }));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: () => h.contextImpl!() }));
vi.mock("@/lib/sms/twilio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/twilio")>();
  return { ...actual, sendTwilioSms: (...args: unknown[]) => h.twilio(...args) };
});
vi.mock("@/lib/sms/usageBilling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/usageBilling")>();
  return { ...actual, sendBilledSms: (...args: unknown[]) => h.sendBilled(...args) };
});

import { POST } from "@/app/api/sms/send/route";

const CLIENT = "22222222-2222-4222-8222-222222222222";
const call = () =>
  POST(
    new Request("http://localhost/api/sms/send", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify({ clientId: CLIENT, body: "hello" }),
    }),
  );

describe("POST /api/sms/send: redirect-style auth refusals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("signed out (redirect to /login) is 401, not 500, and nothing is touched", async () => {
    h.contextImpl = async () => redirect("/login");
    const res = await call();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/NEXT_REDIRECT|stack/i);
    expect(h.from).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.sendBilled).not.toHaveBeenCalled();
    expect(h.twilio).not.toHaveBeenCalled();
  });

  it.each(["/account", "/platform/studios", "/app"])("signed in without a usable studio (redirect to %s) is 403", async (to) => {
    h.contextImpl = async () => redirect(to);
    const res = await call();
    expect(res.status).toBe(403);
    expect(h.from).not.toHaveBeenCalled();
    expect(h.sendBilled).not.toHaveBeenCalled();
    expect(h.twilio).not.toHaveBeenCalled();
  });

  it("a redirect to /login with a query string is still 401", async () => {
    h.contextImpl = async () => redirect("/login?next=%2Fapp");
    expect((await call()).status).toBe(401);
  });

  it("an unexpected error is still a generic 500 that leaks nothing", async () => {
    h.contextImpl = async () => {
      throw new Error("db password is hunter2");
    };
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("hunter2");
    expect(h.sendBilled).not.toHaveBeenCalled();
    expect(h.twilio).not.toHaveBeenCalled();
  });
});
