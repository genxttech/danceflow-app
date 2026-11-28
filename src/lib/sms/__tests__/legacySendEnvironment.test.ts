import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { legacySendEnvironmentAllowed, sendTwilioSms } from "../twilio";

/** The older sender has no fake: outside the live production deployment it must never reach the provider, even fully configured. */
const SERVICE = `MG${"a".repeat(32)}`;
const clear = { rpc: async () => ({ data: false, error: null }) } as never;
const send = () => sendTwilioSms({ studioId: "studio-1", admin: clear, to: "+15550100123", body: "Synthetic", messagingServiceSid: SERVICE });
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 }));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"0".repeat(32)}`);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "synthetic-token");
  vi.stubEnv("SMS_PLATFORM_STATUS", "approved");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("older send path: production only", () => {
  it.each([
    ["preview", "production"], ["development", "production"], ["", "production"], ["production", "development"], ["production", "test"],
  ])("VERCEL_ENV=%j NODE_ENV=%j never calls the provider", async (vercel, node) => {
    vi.stubEnv("VERCEL_ENV", vercel);
    vi.stubEnv("NODE_ENV", node);
    expect(await send()).toMatchObject({ ok: false, errorCode: "sms_environment_blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("the live production build sends", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NODE_ENV", "production");
    expect(await send()).toMatchObject({ ok: true, sid: "SM1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("is closed when nothing says production", () => {
    expect(legacySendEnvironmentAllowed({})).toBe(false);
  });
});
