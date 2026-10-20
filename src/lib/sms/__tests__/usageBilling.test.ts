import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BILLED_REFUSAL_MESSAGE, replayMeaning, sendBilledSms, smsUsageBillingEnabled, type BilledSendInput } from "@/lib/sms/usageBilling";
import { FakeBilledSmsProvider } from "@/lib/sms/usageProvider";

const ATTEMPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT = `AC${"1".repeat(32)}`;
const SERVICE = `MG${"2".repeat(32)}`;

type RpcResult = { data: unknown; error: { code?: string } | null };

function fakeRpc(handlers: Record<string, RpcResult | ((args: Record<string, unknown>) => RpcResult)> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const defaults: Record<string, RpcResult> = {
    tw4_usage_begin: {
      data: { decision: "send", attempt_id: ATTEMPT, message_log_id: LOG, account_sid: ACCOUNT, messaging_service_sid: SERVICE },
      error: null,
    },
    tw4_usage_dispatching: { data: { dispatch: true }, error: null },
    tw4_usage_submitted: { data: {}, error: null },
    tw4_usage_rejected: { data: {}, error: null },
    tw4_usage_uncertain: { data: {}, error: null },
  };
  return {
    calls,
    count: (name: string) => calls.filter((c) => c.name === name).length,
    client: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        const h = handlers[name] ?? defaults[name];
        if (!h) return { data: null, error: { code: "PGRST202" } };
        return typeof h === "function" ? h(args) : h;
      },
    } as never,
  };
}

const input = (over: Partial<BilledSendInput> = {}): BilledSendInput => ({
  source: { kind: "manual", id: "key-1" },
  studioId: "studio-1",
  clientId: "client-1",
  phoneE164: "+15550100123",
  body: "Hello there",
  messageType: "manual",
  relatedTable: "clients",
  relatedId: "client-1",
  sentBy: "user-1",
  statusCallbackBase: "https://app.test/api/sms/twilio/status?secret=s3",
  ...over,
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("sendBilledSms: begin refusals", () => {
  it.each([
    ["TW007", "insufficient_credit"],
    ["TW012", "monthly_limit"],
    ["TW015", "no_billed_sender"],
    ["TW016", "suspended"],
    ["TW018", "switched_off"],
    ["TW008", "no_price"],
    ["TW010", "not_billed"],
    ["22023", "invalid"],
    ["42501", "forbidden"],
    ["XX000", "unavailable"],
    ["PGRST202", "unavailable"],
  ])("begin error %s -> refused %s, provider never called", async (code, reason) => {
    const rpc = fakeRpc({ tw4_usage_begin: { data: null, error: { code } } });
    const provider = new FakeBilledSmsProvider();
    expect(await sendBilledSms(rpc.client, provider, input())).toEqual({ outcome: "refused", reason });
    expect(provider.sent).toHaveLength(0);
    expect(rpc.count("tw4_usage_dispatching")).toBe(0);
  });

  it("an error without a code is unavailable", async () => {
    const rpc = fakeRpc({ tw4_usage_begin: { data: null, error: {} } });
    const provider = new FakeBilledSmsProvider();
    expect(await sendBilledSms(rpc.client, provider, input())).toEqual({ outcome: "refused", reason: "unavailable" });
    expect(provider.sent).toHaveLength(0);
  });

  it.each([
    ["no data", null],
    ["unknown decision", { decision: "maybe", attempt_id: ATTEMPT, message_log_id: LOG, account_sid: ACCOUNT, messaging_service_sid: SERVICE }],
    ["missing account sid", { decision: "send", attempt_id: ATTEMPT, message_log_id: LOG, messaging_service_sid: SERVICE }],
    ["missing service sid", { decision: "send", attempt_id: ATTEMPT, message_log_id: LOG, account_sid: ACCOUNT }],
    ["missing attempt", { decision: "send", message_log_id: LOG, account_sid: ACCOUNT, messaging_service_sid: SERVICE }],
  ])("a malformed begin answer (%s) is unavailable and sends nothing", async (_n, data) => {
    const rpc = fakeRpc({ tw4_usage_begin: { data, error: null } });
    const provider = new FakeBilledSmsProvider();
    expect(await sendBilledSms(rpc.client, provider, input())).toEqual({ outcome: "refused", reason: "unavailable" });
    expect(provider.sent).toHaveLength(0);
    expect(rpc.count("tw4_usage_dispatching")).toBe(0);
  });

  it("passes the whole input to begin", async () => {
    const rpc = fakeRpc();
    await sendBilledSms(rpc.client, new FakeBilledSmsProvider(), input());
    expect(rpc.calls[0]).toEqual({
      name: "tw4_usage_begin",
      args: {
        p_source_kind: "manual",
        p_source_id: "key-1",
        p_studio_id: "studio-1",
        p_client_id: "client-1",
        p_phone_e164: "+15550100123",
        p_body: "Hello there",
        p_message_type: "manual",
        p_related_table: "clients",
        p_related_id: "client-1",
        p_sent_by: "user-1",
      },
    });
  });
});

describe("sendBilledSms: replay and dispatch marker", () => {
  it("a replay returns replay with its state and never dispatches or calls the provider", async () => {
    const rpc = fakeRpc({
      tw4_usage_begin: { data: { decision: "replay", attempt_id: ATTEMPT, message_log_id: LOG, state: "submitted", provider_sid: "SM1" }, error: null },
    });
    const provider = new FakeBilledSmsProvider();
    expect(await sendBilledSms(rpc.client, provider, input())).toEqual({ outcome: "replay", logId: LOG, state: "submitted", providerSid: "SM1" });
    expect(rpc.count("tw4_usage_dispatching")).toBe(0);
    expect(provider.sent).toHaveLength(0);
  });

  it("a replay without a SID reports null", async () => {
    const rpc = fakeRpc({
      tw4_usage_begin: { data: { decision: "replay", attempt_id: ATTEMPT, message_log_id: LOG, state: "unknown" }, error: null },
    });
    expect(await sendBilledSms(rpc.client, new FakeBilledSmsProvider(), input())).toEqual({ outcome: "replay", logId: LOG, state: "unknown", providerSid: null });
  });

  it("a dispatching error is a replay (state reserved) and the provider is not called", async () => {
    const rpc = fakeRpc({ tw4_usage_dispatching: { data: null, error: { code: "XX000" } } });
    const provider = new FakeBilledSmsProvider();
    expect(await sendBilledSms(rpc.client, provider, input())).toEqual({ outcome: "replay", logId: LOG, state: "reserved", providerSid: null });
    expect(provider.sent).toHaveLength(0);
  });

  it("dispatch:false is a replay carrying the reported state and the provider is not called", async () => {
    const rpc = fakeRpc({ tw4_usage_dispatching: { data: { dispatch: false, state: "submitting" }, error: null } });
    const provider = new FakeBilledSmsProvider();
    expect(await sendBilledSms(rpc.client, provider, input())).toEqual({ outcome: "replay", logId: LOG, state: "submitting", providerSid: null });
    expect(provider.sent).toHaveLength(0);
    expect(rpc.count("tw4_usage_submitted")).toBe(0);
  });

  it("dispatch:false without a state falls back to reserved", async () => {
    const rpc = fakeRpc({ tw4_usage_dispatching: { data: { dispatch: false }, error: null } });
    const result = await sendBilledSms(rpc.client, new FakeBilledSmsProvider(), input());
    expect(result).toMatchObject({ outcome: "replay", state: "reserved" });
  });

  it("the marker is written before the provider call", async () => {
    const order: string[] = [];
    const rpc = fakeRpc({
      tw4_usage_dispatching: () => {
        order.push("marker");
        return { data: { dispatch: true }, error: null };
      },
    });
    const provider = new FakeBilledSmsProvider();
    const send = provider.send.bind(provider);
    provider.send = async (i) => {
      order.push("provider");
      return send(i);
    };
    await sendBilledSms(rpc.client, provider, input());
    expect(order).toEqual(["marker", "provider"]);
    expect(rpc.calls.find((c) => c.name === "tw4_usage_dispatching")?.args).toEqual({ p_attempt_id: ATTEMPT });
  });
});

describe("sendBilledSms: provider outcomes", () => {
  it("accepted -> submitted recorded with the SID, outcome sent", async () => {
    const rpc = fakeRpc();
    const provider = new FakeBilledSmsProvider().nextSend({ kind: "accepted", sid: "SMabc" });
    expect(await sendBilledSms(rpc.client, provider, input())).toEqual({ outcome: "sent", logId: LOG, providerSid: "SMabc" });
    expect(rpc.calls.find((c) => c.name === "tw4_usage_submitted")?.args).toEqual({ p_attempt_id: ATTEMPT, p_provider_sid: "SMabc" });
    expect(rpc.count("tw4_usage_rejected")).toBe(0);
    expect(rpc.count("tw4_usage_uncertain")).toBe(0);
  });

  it("accepted is still sent when recording the SID fails", async () => {
    const rpc = fakeRpc({ tw4_usage_submitted: { data: null, error: { code: "XX000" } } });
    const provider = new FakeBilledSmsProvider().nextSend({ kind: "accepted", sid: "SMabc" });
    expect(await sendBilledSms(rpc.client, provider, input())).toEqual({ outcome: "sent", logId: LOG, providerSid: "SMabc" });
  });

  it("refused -> rejected recorded with the code, outcome rejected", async () => {
    const rpc = fakeRpc();
    const provider = new FakeBilledSmsProvider().nextSend({ kind: "refused", code: "21211" });
    expect(await sendBilledSms(rpc.client, provider, input())).toEqual({ outcome: "rejected", logId: LOG, code: "21211" });
    expect(rpc.calls.find((c) => c.name === "tw4_usage_rejected")?.args).toEqual({ p_attempt_id: ATTEMPT, p_error_code: "21211" });
    expect(rpc.count("tw4_usage_submitted")).toBe(0);
  });

  it("refused but the release cannot be recorded -> uncertain", async () => {
    const rpc = fakeRpc({ tw4_usage_rejected: { data: null, error: { code: "XX000" } } });
    const provider = new FakeBilledSmsProvider().nextSend({ kind: "refused", code: "21211" });
    expect(await sendBilledSms(rpc.client, provider, input())).toEqual({ outcome: "uncertain", logId: LOG });
  });

  it("uncertain -> tw4_usage_uncertain recorded, outcome uncertain", async () => {
    const rpc = fakeRpc();
    const provider = new FakeBilledSmsProvider().nextSend({ kind: "uncertain", code: "network" });
    expect(await sendBilledSms(rpc.client, provider, input())).toEqual({ outcome: "uncertain", logId: LOG });
    expect(rpc.calls.find((c) => c.name === "tw4_usage_uncertain")?.args).toEqual({ p_attempt_id: ATTEMPT, p_error_code: "network" });
    expect(rpc.count("tw4_usage_submitted")).toBe(0);
    expect(rpc.count("tw4_usage_rejected")).toBe(0);
  });

  it("uncertain stays uncertain when recording fails", async () => {
    const rpc = fakeRpc({ tw4_usage_uncertain: { data: null, error: { code: "XX000" } } });
    const provider = new FakeBilledSmsProvider().nextSend({ kind: "uncertain", code: "http_500" });
    expect(await sendBilledSms(rpc.client, provider, input())).toEqual({ outcome: "uncertain", logId: LOG });
  });
});

describe("sendBilledSms: what the provider receives", () => {
  it("gets the account and service from begin, the recipient and the exact body, with the attempt id on the callback", async () => {
    const rpc = fakeRpc();
    const provider = new FakeBilledSmsProvider();
    await sendBilledSms(rpc.client, provider, input());
    expect(provider.sent).toHaveLength(1);
    const sent = provider.sent[0];
    expect(Object.keys(sent).sort()).toEqual(["accountSid", "body", "messagingServiceSid", "statusCallbackUrl", "to"]);
    expect(sent.accountSid).toBe(ACCOUNT);
    expect(sent.messagingServiceSid).toBe(SERVICE);
    expect(sent.to).toBe("+15550100123");
    expect(sent.body).toBe("Hello there");
    const url = new URL(String(sent.statusCallbackUrl));
    expect(url.searchParams.get("attempt")).toBe(ATTEMPT);
    expect(url.searchParams.get("secret")).toBe("s3");
    expect(url.pathname).toBe("/api/sms/twilio/status");
  });

  it("replaces an attempt parameter already present rather than duplicating it", async () => {
    const provider = new FakeBilledSmsProvider();
    await sendBilledSms(fakeRpc().client, provider, input({ statusCallbackBase: "https://app.test/s?secret=x&attempt=other" }));
    expect(new URL(String(provider.sent[0].statusCallbackUrl)).searchParams.getAll("attempt")).toEqual([ATTEMPT]);
  });

  it("a null callback base gives a null callback URL", async () => {
    const provider = new FakeBilledSmsProvider();
    await sendBilledSms(fakeRpc().client, provider, input({ statusCallbackBase: null }));
    expect(provider.sent[0].statusCallbackUrl).toBeNull();
  });

  it("an unparseable callback base gives a null callback URL", async () => {
    const provider = new FakeBilledSmsProvider();
    await sendBilledSms(fakeRpc().client, provider, input({ statusCallbackBase: "not a url" }));
    expect(provider.sent[0].statusCallbackUrl).toBeNull();
  });
});

describe("replayMeaning", () => {
  it.each([
    ["submitted", "accepted"],
    ["settled", "accepted"],
    ["released", "not_sent"],
    ["reserved", "not_yet"],
    ["submitting", "unknown"],
    ["unknown", "unknown"],
    ["review", "unknown"],
    ["", "unknown"],
    ["something_new", "unknown"],
  ])("%s -> %s", (state, meaning) => {
    expect(replayMeaning(state)).toBe(meaning);
  });
});

describe("smsUsageBillingEnabled", () => {
  it.each([
    ["on", true],
    ["ON", true],
    [" on ", true],
    ["true", false],
    ["1", false],
    ["off", false],
    ["", false],
    [undefined, false],
  ])("%s -> %s", (value, expected) => {
    expect(smsUsageBillingEnabled({ SMS_USAGE_BILLING: value })).toBe(expected);
  });

  it("reads process.env by default", () => {
    const saved = process.env.SMS_USAGE_BILLING;
    process.env.SMS_USAGE_BILLING = "on";
    expect(smsUsageBillingEnabled()).toBe(true);
    delete process.env.SMS_USAGE_BILLING;
    expect(smsUsageBillingEnabled()).toBe(false);
    if (saved !== undefined) process.env.SMS_USAGE_BILLING = saved;
  });
});

describe("BILLED_REFUSAL_MESSAGE", () => {
  it("has a plain message for every refusal and never a provider detail", () => {
    for (const reason of ["insufficient_credit", "monthly_limit", "no_billed_sender", "suspended", "switched_off", "no_price", "not_billed", "invalid", "forbidden", "unavailable"] as const) {
      expect(BILLED_REFUSAL_MESSAGE[reason].length).toBeGreaterThan(10);
      expect(BILLED_REFUSAL_MESSAGE[reason]).not.toMatch(/twilio|TW0|AC[0-9a-f]{8}/i);
    }
  });
});

describe("sendBilledSms: a replay of an attempt that never reached its dispatch marker", () => {
  const reservedReplay = (over: Record<string, unknown> = {}) => ({
    data: { decision: "replay", attempt_id: ATTEMPT, message_log_id: LOG, state: "reserved", provider_sid: null, account_sid: ACCOUNT, messaging_service_sid: SERVICE,
      body: "The stored body", phone_e164: "+15550100999", ...over },
    error: null,
  });
  it("proceeds through the exclusive marker and sends the STORED body to the STORED number", async () => {
    const rpc = fakeRpc({ tw4_usage_begin: reservedReplay() });
    const provider = new FakeBilledSmsProvider();
    expect(await sendBilledSms(rpc.client, provider, input({ body: "A different body now", phoneE164: "+15550100123" }))).toMatchObject({ outcome: "sent", logId: LOG });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({ body: "The stored body", to: "+15550100999", accountSid: ACCOUNT, messagingServiceSid: SERVICE });
    expect(rpc.count("tw4_usage_dispatching")).toBe(1);
  });
  it("another caller holding the marker: no send, the replay is reported", async () => {
    const rpc = fakeRpc({ tw4_usage_begin: reservedReplay(), tw4_usage_dispatching: { data: { dispatch: false, state: "submitting" }, error: null } });
    const provider = new FakeBilledSmsProvider();
    expect(await sendBilledSms(rpc.client, provider, input())).toMatchObject({ outcome: "replay", state: "submitting" });
    expect(provider.sent).toHaveLength(0);
  });
  it("a reserved replay without its stored body or number is only reported, never sent", async () => {
    for (const over of [{ body: null }, { phone_e164: null }, { account_sid: null }]) {
      const rpc = fakeRpc({ tw4_usage_begin: reservedReplay(over) });
      const provider = new FakeBilledSmsProvider();
      expect(await sendBilledSms(rpc.client, provider, input())).toMatchObject({ outcome: "replay", state: "reserved" });
      expect(provider.sent).toHaveLength(0);
      expect(rpc.count("tw4_usage_dispatching")).toBe(0);
    }
  });
});
