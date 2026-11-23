import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TW-4F absorbed inbound cost controls (migration 20270222190000) in the inbound route: a business at its daily cap (database switch on) gets no NON-compliance
 * automatic reply; STOP / START / HELP confirmations are always sent and never consult the cap; the parent account is never asked; the check fails open.
 */

type Rpc = { name: string; args: Record<string, unknown> };
const state = vi.hoisted(() => ({
  signer: null as unknown,
  resolve: null as unknown,
  calls: [] as Rpc[],
  handlers: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit", "insert"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: { name: "Harbor Dance Studio" }, error: null });
      q.then = (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
      return q;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.calls.push({ name, args });
      const h = state.handlers[name];
      if (!h) return { data: null, error: { code: "PGRST202" } };
      return h(args);
    },
  }),
}));
vi.mock("@/lib/sms/twilioIsv/webhookRuntime", () => ({ buildWebhookAccountDeps: () => ({}), recordWebhookReceipt: async () => "new", receiptSeen: async () => "new" }));
vi.mock("@/lib/sms/twilioWebhookAccount", async (orig) => ({
  ...(await orig<typeof import("@/lib/sms/twilioWebhookAccount")>()),
  verifyTwilioWebhookAccount: async () => ({ ok: true, account: state.signer }),
}));
vi.mock("@/lib/sms/studioSender", () => ({
  resolveStudioFromInboundSender: (...args: unknown[]) => (state.resolve as (...a: unknown[]) => unknown)(...args),
}));

import { POST } from "@/app/api/sms/twilio/inbound/route";
import { inboundAutoReplyAllowed } from "@/lib/sms/inboundUsage";

const AC = `AC${"a1".repeat(16)}`;
const STUDIO = "11111111-1111-4111-8111-111111111111";
const EMPTY = "<Response></Response>";
let ip = 0;
const request = (body: string, extra: Record<string, string> = {}) =>
  new Request("https://www.idanceflow.com/api/sms/twilio/inbound", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `198.51.100.${++ip % 250}` },
    body: new URLSearchParams({ From: "+15550100123", To: "+15035550123", Body: body, MessageSid: `SM${"0a".repeat(16)}`, ...extra }).toString(),
  });
const named = (n: string) => state.calls.filter((c) => c.name === n);
const subaccount = () => ({ kind: "subaccount", accountSid: AC, legalEntityId: "e", studioIds: [STUDIO] });

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
  delete process.env.SMS_INBOUND_RECORDING;
  state.calls = [];
  state.signer = subaccount();
  state.resolve = vi.fn(async () => ({ ok: false, reason: "unknown_sender" }));   // unrouted: the error path
  state.handlers = {
    tw4_inbound_reply_allowed: () => ({ data: true, error: null }),
    tw4_inbound_auto_reply_allowed: () => ({ data: false, error: null }),            // the business is at its cap
    record_sms_inbound_opt_event: () => ({ data: { rows_changed: 1 }, error: null }),
    sms_pending_opt_out_supersede: () => ({ data: true, error: null }),
    sms_inbound_start_signal_record: () => ({ data: true, error: null }),
  };
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("non-compliance automatic replies at the cap", () => {
  it("an error reply is suppressed (empty TwiML) for a business at its cap, and the per-sender counter is not consumed", async () => {
    const res = await POST(request("hello there"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EMPTY);
    expect(named("tw4_inbound_auto_reply_allowed").map((c) => c.args)).toEqual([{ p_account_sid: AC, p_kind: "error_unrouted" }]);
    expect(named("tw4_inbound_reply_allowed")).toHaveLength(0);
  });

  it("the same error reply is sent when the business is under its cap (the check answers true)", async () => {
    state.handlers.tw4_inbound_auto_reply_allowed = () => ({ data: true, error: null });
    expect(await (await POST(request("hello there"))).text()).toContain("<Message>");
    expect(named("tw4_inbound_reply_allowed")).toHaveLength(1);
  });

  it.each([
    ["the function is not installed", () => ({ data: null, error: { code: "PGRST202" } })],
    ["a database error", () => ({ data: null, error: { code: "57014" } })],
    ["null", () => ({ data: null, error: null })],
    ["a non-boolean", () => ({ data: "false", error: null })],
  ])("fails open when the check answers %s (the reply goes exactly as before, through the counter)", async (_n, h) => {
    state.handlers.tw4_inbound_auto_reply_allowed = h;
    expect(await (await POST(request("hello there"))).text()).toContain("<Message>");
    expect(named("tw4_inbound_reply_allowed")).toHaveLength(1);
  });

  it("the parent account (legacy studios) is never asked and never suppressed", async () => {
    state.signer = { kind: "parent" };
    expect(await (await POST(request("hello there"))).text()).toContain("<Message>");
    expect(named("tw4_inbound_auto_reply_allowed")).toHaveLength(0);
  });
});

describe("compliance replies are never suppressed by the cap", () => {
  it.each(["STOP", "START", "HELP"])("an unrouted %s gets its compliance answer and never consults the cap", async (word) => {
    const xml = await (await POST(request(word))).text();
    expect(xml).toContain("<Message>");
    expect(named("tw4_inbound_auto_reply_allowed")).toHaveLength(0);
  });

  it.each(["STOP", "START", "HELP"])("a routed %s at the cap is confirmed and its consent effect runs; the cap is never consulted", async (word) => {
    state.resolve = vi.fn(async () => ({ ok: true, studioId: STUDIO }));
    const xml = await (await POST(request(word))).text();
    expect(xml).toContain("<Message>");
    expect(named("tw4_inbound_auto_reply_allowed")).toHaveLength(0);
    if (word !== "HELP") expect(named("record_sms_inbound_opt_event").map((c) => c.args.p_event)).toEqual([word.toLowerCase()]);
  });

  it("a routed ordinary text still gets no automatic reply and never consults the cap (D3 unchanged)", async () => {
    state.resolve = vi.fn(async () => ({ ok: true, studioId: STUDIO }));
    expect(await (await POST(request("see you tonight"))).text()).toBe(EMPTY);
    expect(named("tw4_inbound_auto_reply_allowed")).toHaveLength(0);
  });
});

describe("inboundAutoReplyAllowed (helper)", () => {
  it("only an exact false suppresses; no client, no account, errors and throws allow", async () => {
    const rpc = (r: unknown) => ({ rpc: async () => r }) as never;
    expect(await inboundAutoReplyAllowed(rpc({ data: false, error: null }), { accountSid: AC, kind: "error_invalid" })).toBe(false);
    expect(await inboundAutoReplyAllowed(rpc({ data: true, error: null }), { accountSid: AC, kind: "error_invalid" })).toBe(true);
    expect(await inboundAutoReplyAllowed(rpc({ data: false, error: { code: "x" } }), { accountSid: AC, kind: "error_invalid" })).toBe(true);
    expect(await inboundAutoReplyAllowed(null, { accountSid: AC, kind: "error_invalid" })).toBe(true);
    expect(await inboundAutoReplyAllowed(rpc({ data: false, error: null }), { accountSid: null, kind: "error_invalid" })).toBe(true);
    expect(await inboundAutoReplyAllowed({ rpc: async () => { throw new Error("net"); } } as never, { accountSid: AC, kind: "error_invalid" })).toBe(true);
  });
});
