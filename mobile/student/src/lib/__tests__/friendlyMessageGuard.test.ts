// F1 (Student readiness audit): a screen must never render a raw caught message. Only text written for people
// (UserFacingError: the DanceFlow web API's own `error` string and the app's own sentences) may reach the screen.
process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL = "https://app.example.test";

jest.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: jest.fn(), refreshSession: jest.fn(), signOut: jest.fn(async () => ({ error: null })) } },
}));

import { danceflowApiFetch } from "@/lib/danceflowApi";
import { friendlyMessage } from "@/lib/errorKind";
import { paymentSheetError, PaymentCancelledError, PAYMENT_CANCELLED_MESSAGE, PAYMENT_NOT_COMPLETED_MESSAGE } from "@/lib/paymentSheetOutcome";
import { UserFacingError } from "@/lib/userFacingError";
import { supabase } from "@/lib/supabase";

const FALLBACK = "Could not submit the request.";
const mockAuth = supabase.auth as unknown as Record<"getSession", jest.Mock>;
const reply = (status: number, body: unknown) =>
  ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) }) as Response;

describe("friendlyMessage: raw messages never render", () => {
  it.each([
    ["a Postgres error", new Error('duplicate key value violates unique constraint "event_registrations_pkey"')],
    ["a PostgREST error object", Object.assign(new Error("permission denied for table event_registrations"), { code: "42501" })],
    ["a function error", new Error('function public.claim_my_event_registrations() does not exist')],
    ["a payment SDK message", new Error("Your card was declined. stripe_error: card_declined req_abc123")],
    ["a plain thrown string", "relation \"payments\" does not exist"],
    ["a plain object with a message", { message: "SQLSTATE 23505 internal detail" }],
    ["an error with a vendor name", new Error("Supabase request failed: row-level security")],
  ])("%s uses the screen's fallback", (_name, error) => {
    expect(friendlyMessage(error, FALLBACK)).toBe(FALLBACK);
  });

  it("offline and signed-out failures keep their shared copy", () => {
    expect(friendlyMessage(new TypeError("Network request failed"), FALLBACK)).toMatch(/offline/i);
    expect(friendlyMessage(new Error("JWT expired"), FALLBACK)).toMatch(/Sign in again/);
  });
});

describe("friendlyMessage: wording written for people still shows", () => {
  it("shows a UserFacingError's text", () => {
    expect(friendlyMessage(new UserFacingError("That time was just taken."), FALLBACK)).toBe("That time was just taken.");
  });

  it("shows the web API's own error text for a refused request (e.g. a slot that was just taken)", async () => {
    mockAuth.getSession.mockResolvedValue({ data: { session: { access_token: "t", expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null });
    global.fetch = jest.fn().mockResolvedValueOnce(reply(409, { error: "That time was just taken." }));
    const error = await danceflowApiFetch("/api/student/self-service/actions", { method: "POST" }).catch((e) => e);
    expect(error).toBeInstanceOf(UserFacingError);
    expect(friendlyMessage(error, FALLBACK)).toBe("That time was just taken.");
  });

  it("an API refusal without an error text shows the app's own generic sentence, not a status or body", async () => {
    mockAuth.getSession.mockResolvedValue({ data: { session: { access_token: "t", expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null });
    global.fetch = jest.fn().mockResolvedValueOnce(reply(500, { stack: "at line 3" }));
    const error = await danceflowApiFetch("/api/x").catch((e) => e);
    expect(friendlyMessage(error, FALLBACK)).toBe("DanceFlow request failed. Please try again.");
  });

  it("a cancelled payment sheet keeps its own notice, a failed one shows plain wording, not the SDK text", () => {
    expect(friendlyMessage(paymentSheetError({ code: "Canceled", message: "The payment flow has been canceled" }), FALLBACK)).toBe(PAYMENT_CANCELLED_MESSAGE);
    expect(paymentSheetError({ code: "Canceled" })).toBeInstanceOf(PaymentCancelledError);
    expect(friendlyMessage(paymentSheetError({ code: "Failed", message: "card_declined req_abc123" }), FALLBACK)).toBe(PAYMENT_NOT_COMPLETED_MESSAGE);
  });
});

describe("source guard", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");

  it("friendlyMessage decides on UserFacingError, never on `instanceof Error`", () => {
    const src = readFileSync(join(__dirname, "..", "errorKind.ts"), "utf8");
    const body = src.slice(src.indexOf("export function friendlyMessage"), src.indexOf("export function failureMessage"));
    expect(body).toContain("isUserFacingError(error)");
    expect(body).not.toMatch(/instanceof Error/);
  });
});
