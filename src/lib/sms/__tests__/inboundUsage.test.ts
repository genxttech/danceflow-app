import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  inboundReplyAllowed,
  inboundSenderHash,
  parseInboundCounts,
  recordInboundUsage,
  smsInboundRecordingEnabled,
} from "@/lib/sms/inboundUsage";

type RpcResult = { data: unknown; error: unknown };

function client(handler: (name: string, args: Record<string, unknown>) => RpcResult | Promise<RpcResult>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    rpc: (async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return handler(name, args);
    }) as never,
  };
}

const NUMBER = "+15550100123";

describe("smsInboundRecordingEnabled", () => {
  it.each([
    ["on", true],
    [" ON ", true],
    ["On", true],
    ["off", false],
    ["true", false],
    ["1", false],
    ["", false],
    [undefined, false],
  ])("SMS_INBOUND_RECORDING=%j -> %s", (value, expected) => {
    expect(smsInboundRecordingEnabled({ SMS_INBOUND_RECORDING: value })).toBe(expected);
  });
});

describe("inboundSenderHash", () => {
  it("is 64 hex characters, stable, per-sender, and does not contain the number", () => {
    const hash = inboundSenderHash(NUMBER);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inboundSenderHash(NUMBER)).toBe(hash);
    expect(inboundSenderHash("+15550100124")).not.toBe(hash);
    expect(hash).not.toContain("5550100123");
  });
});

describe("parseInboundCounts", () => {
  it.each([
    [undefined, undefined, { segments: 1, media: 0 }],
    [null, null, { segments: 1, media: 0 }],
    ["", "", { segments: 1, media: 0 }],
    ["0", "0", { segments: 1, media: 0 }],
    ["3", "1", { segments: 3, media: 1 }],
    ["25", "25", { segments: 20, media: 10 }],
    ["abc", "xyz", { segments: 1, media: 0 }],
    ["-2", "-1", { segments: 1, media: 0 }],
    ["1.5", "2.5", { segments: 1, media: 0 }],
    ["100", "100", { segments: 1, media: 0 }],
    [" 4 ", " 2 ", { segments: 4, media: 2 }],
    ["20", "10", { segments: 20, media: 10 }],
  ])("(%j, %j) -> %j", (segments, media, expected) => {
    expect(parseInboundCounts(segments as never, media as never)).toEqual(expected);
  });
});

describe("inboundReplyAllowed", () => {
  const errorKinds = ["error_unavailable", "error_invalid", "error_unrecognized", "error_unrouted"] as const;
  const answers: Array<[string, () => RpcResult | never, boolean, boolean]> = [
    // [label, handler, error reply allowed?, compliance confirmation allowed?]
    ["true", () => ({ data: true, error: null }), true, true],
    ["false", () => ({ data: false, error: null }), false, false],
    ["null", () => ({ data: null, error: null }), false, true],
    ["a string", () => ({ data: "true", error: null }), false, true],
    ["an rpc error", () => ({ data: null, error: { code: "XX001" } }), false, true],
    [
      "a thrown exception",
      () => {
        throw new Error("down");
      },
      false,
      true,
    ],
  ];

  it.each(answers)("error replies, counter answers %s -> %s", async (_label, handler, errorAllowed) => {
    for (const kind of errorKinds) {
      const c = client(handler);
      expect(await inboundReplyAllowed(c, { accountSid: null, sender: NUMBER, kind }), kind).toBe(errorAllowed);
    }
  });

  it.each(answers)("help/start confirmations, counter answers %s -> %s", async (_label, handler, _errorAllowed, complianceAllowed) => {
    for (const kind of ["help", "start"] as const) {
      const c = client(handler);
      expect(await inboundReplyAllowed(c, { accountSid: null, sender: NUMBER, kind }), kind).toBe(complianceAllowed);
    }
  });

  it("a null client fails closed for errors and open for compliance", async () => {
    expect(await inboundReplyAllowed(null, { accountSid: null, sender: NUMBER, kind: "error_unrouted" })).toBe(false);
    expect(await inboundReplyAllowed(null, { accountSid: null, sender: NUMBER, kind: "help" })).toBe(true);
  });

  it("an empty sender fails closed / open without calling the database", async () => {
    const c = client(() => ({ data: true, error: null }));
    expect(await inboundReplyAllowed(c, { accountSid: null, sender: "  ", kind: "error_invalid" })).toBe(false);
    expect(await inboundReplyAllowed(c, { accountSid: null, sender: "", kind: "start" })).toBe(true);
    expect(c.calls).toHaveLength(0);
  });

  it("sends the account, a hashed sender, the kind and the per-kind limit", async () => {
    const c = client(() => ({ data: true, error: null }));
    await inboundReplyAllowed(c, { accountSid: `AC${"1".repeat(32)}`, sender: NUMBER, kind: "error_unavailable" });
    await inboundReplyAllowed(c, { accountSid: null, sender: NUMBER, kind: "help" });
    expect(c.calls[0]).toEqual({
      name: "tw4_inbound_reply_allowed",
      args: { p_account_sid: `AC${"1".repeat(32)}`, p_sender_hash: inboundSenderHash(NUMBER), p_kind: "error_unavailable", p_limit: 1 },
    });
    expect(c.calls[1].args).toMatchObject({ p_account_sid: null, p_kind: "help", p_limit: 5 });
    expect(JSON.stringify(c.calls)).not.toContain("5550100123");
  });
});

describe("recordInboundUsage", () => {
  const input = {
    studioId: "11111111-1111-4111-8111-111111111111",
    signerAccountSid: null as string | null,
    providerSid: `SM${"0a".repeat(16)}`,
    segments: 2,
    media: 1,
    classification: "ordinary" as const,
    replyBody: null as string | null,
  };
  const on = { SMS_INBOUND_RECORDING: "on" };

  it("is disabled by default and makes no rpc", async () => {
    const c = client(() => ({ data: { recorded: true }, error: null }));
    expect(await recordInboundUsage(c, input, {})).toEqual({ recorded: false, reason: "disabled" });
    expect(await recordInboundUsage(c, input, { SMS_INBOUND_RECORDING: "off" })).toEqual({ recorded: false, reason: "disabled" });
    expect(c.calls).toHaveLength(0);
  });

  it("sends the exact rpc arguments", async () => {
    const c = client(() => ({ data: { recorded: true }, error: null }));
    await recordInboundUsage(c, { ...input, signerAccountSid: `AC${"2".repeat(32)}`, classification: "compliance", replyBody: "bye" }, on);
    expect(c.calls).toEqual([
      {
        name: "tw4_inbound_record",
        args: {
          p_studio_id: input.studioId,
          p_signer_account: `AC${"2".repeat(32)}`,
          p_provider_sid: input.providerSid,
          p_segments: 2,
          p_media: 1,
          p_classification: "compliance",
          p_reply_body: "bye",
          p_received_at: null,
          p_source: "webhook",
        },
      },
    ]);
  });

  it("maps a legacy answer", async () => {
    const c = client(() => ({ data: { recorded: false, reason: "legacy" }, error: null }));
    expect(await recordInboundUsage(c, input, on)).toEqual({ recorded: false, reason: "legacy" });
  });

  it("maps a first recording with charged and uncollected cents", async () => {
    const c = client(() => ({ data: { recorded: true, replayed: false, charged_cents: 4, uncollected_cents: 2 }, error: null }));
    expect(await recordInboundUsage(c, input, on)).toEqual({ recorded: true, replayed: false, chargedCents: 4, uncollectedCents: 2 });
  });

  it("maps a replayed recording and ignores non-numeric cents", async () => {
    const c = client(() => ({ data: { recorded: true, replayed: true, charged_cents: "4", uncollected_cents: null }, error: null }));
    expect(await recordInboundUsage(c, input, on)).toEqual({ recorded: true, replayed: true, chargedCents: 0, uncollectedCents: 0 });
  });

  it("maps an rpc error to failed with its code", async () => {
    const c = client(() => ({ data: null, error: { code: "42883", message: `leak ${NUMBER}` } }));
    const outcome = await recordInboundUsage(c, input, on);
    expect(outcome).toEqual({ recorded: false, reason: "failed", code: "42883" });
    expect(JSON.stringify(outcome)).not.toContain("5550100123");
  });

  it("maps an rpc error without a code to 'unknown'", async () => {
    const c = client(() => ({ data: null, error: { message: "x" } }));
    expect(await recordInboundUsage(c, input, on)).toEqual({ recorded: false, reason: "failed", code: "unknown" });
  });

  it("maps a thrown exception to failed 'exception'", async () => {
    const c = client(() => {
      throw new Error("network");
    });
    expect(await recordInboundUsage(c, input, on)).toEqual({ recorded: false, reason: "failed", code: "exception" });
  });

  it.each([
    ["null", null],
    ["a string", "ok"],
    ["an empty object", {}],
    ["recorded false without legacy", { recorded: false, reason: "other" }],
  ])("maps %s to failed 'unreadable'", async (_n, data) => {
    const c = client(() => ({ data, error: null }));
    expect(await recordInboundUsage(c, input, on)).toEqual({ recorded: false, reason: "failed", code: "unreadable" });
  });
});

describe("inboundSenderHash with a server key (review P3-8)", () => {
  it("is an HMAC when SMS_SENDER_HASH_KEY is set (16+ characters): different from the unkeyed hash and from another key", () => {
    const keyed = inboundSenderHash("+15550100123", { SMS_SENDER_HASH_KEY: "a-long-enough-secret-key" });
    const other = inboundSenderHash("+15550100123", { SMS_SENDER_HASH_KEY: "another-long-enough-secret" });
    const plain = inboundSenderHash("+15550100123", {});
    expect(keyed).toMatch(/^[0-9a-f]{64}$/);
    expect(keyed).not.toBe(plain);
    expect(keyed).not.toBe(other);
    expect(inboundSenderHash("+15550100123", { SMS_SENDER_HASH_KEY: "short" })).toBe(plain); // a key too short is not used
  });
});
