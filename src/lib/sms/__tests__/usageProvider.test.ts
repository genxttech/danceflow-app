import { describe, expect, it } from "vitest";
import {
  billedRealSendAllowed, billedSmsProviderFromEnv, classifyTwilioSendResponse, FakeBilledSmsProvider, RealBilledSmsProvider,
  usageEvidenceReadsAllowed, type BilledSmsSendInput,
} from "../usageProvider";

const PARENT = `AC${"1".repeat(32)}`;
const TOKEN = "t0ken".repeat(6) + "ab";
const SUB = `AC${"a".repeat(32)}`;
const SERVICE = `MG${"b".repeat(32)}`;
const MSG = `SM${"c".repeat(32)}`;
const PHONE = "+15035550123";
const BODY = "Secret studio body text";
const input: BilledSmsSendInput = { accountSid: SUB, messagingServiceSid: SERVICE, to: PHONE, body: BODY, statusCallbackUrl: "https://app.example/cb" };
const basic = `Basic ${Buffer.from(`${PARENT}:${TOKEN}`).toString("base64")}`;

describe("classifyTwilioSendResponse", () => {
  const cases: Array<[string, number | null, unknown, unknown]> = [
    ["2xx with sid", 201, { sid: MSG }, { kind: "accepted", sid: MSG }],
    ["2xx MM sid", 200, { sid: `MM${"d".repeat(32)}` }, { kind: "accepted", sid: `MM${"d".repeat(32)}` }],
    ["2xx without sid", 201, {}, { kind: "uncertain", code: "no_sid" }],
    ["2xx bad sid", 201, { sid: "SMshort" }, { kind: "uncertain", code: "no_sid" }],
    ["2xx non-object", 200, "ok", { kind: "uncertain", code: "no_sid" }],
    ["400 with code", 400, { code: 21211, message: "bad number" }, { kind: "refused", code: "21211" }],
    ["400 with string code", 400, { code: "21610" }, { kind: "refused", code: "21610" }],
    ["401 with code", 401, { code: 20003 }, { kind: "refused", code: "20003" }],
    ["429 with code", 429, { code: 20429 }, { kind: "refused", code: "20429" }],
    ["408", 408, { code: 20408 }, { kind: "uncertain", code: "http_408" }],
    ["500", 500, { code: 20500 }, { kind: "uncertain", code: "http_500" }],
    ["503", 503, null, { kind: "uncertain", code: "http_503" }],
    ["400 without body", 400, null, { kind: "uncertain", code: "unreadable" }],
    ["400 non-object body", 400, "nope", { kind: "uncertain", code: "http_400" }],
    ["400 non-numeric code", 400, { code: "abc" }, { kind: "uncertain", code: "http_400" }],
    ["null status", null, null, { kind: "uncertain", code: "network" }],
    ["3xx", 302, null, { kind: "uncertain", code: "http_302" }],
  ];
  it.each(cases)("%s", (_name, status, body, expected) => {
    expect(classifyTwilioSendResponse(status, body)).toEqual(expected);
  });
});

describe("gates", () => {
  const prod = { VERCEL_ENV: "production", NODE_ENV: "production" };
  it("billedRealSendAllowed truth table", () => {
    expect(billedRealSendAllowed({ ...prod, SMS_BILLED_REAL_SEND: "on" })).toEqual({ allowed: true });
    expect(billedRealSendAllowed({ ...prod }).allowed).toBe(false);
    expect(billedRealSendAllowed({ ...prod, SMS_BILLED_REAL_SEND: "true" }).allowed).toBe(false);
    expect(billedRealSendAllowed({ ...prod, NODE_ENV: "development", SMS_BILLED_REAL_SEND: "on" }).allowed).toBe(false);
    expect(billedRealSendAllowed({ ...prod, VERCEL_ENV: "preview", SMS_BILLED_REAL_SEND: "on" }).allowed).toBe(false);
    expect(billedRealSendAllowed({ NODE_ENV: "production", SMS_BILLED_REAL_SEND: "on" }).allowed).toBe(false);
    expect(billedRealSendAllowed({ ...prod, SMS_USAGE_EVIDENCE_READS: "on" }).allowed).toBe(false);
  });
  it("usageEvidenceReadsAllowed truth table", () => {
    expect(usageEvidenceReadsAllowed({ ...prod, SMS_USAGE_EVIDENCE_READS: "on" })).toEqual({ allowed: true });
    expect(usageEvidenceReadsAllowed({ ...prod }).allowed).toBe(false);
    expect(usageEvidenceReadsAllowed({ ...prod, NODE_ENV: "test", SMS_USAGE_EVIDENCE_READS: "on" }).allowed).toBe(false);
    expect(usageEvidenceReadsAllowed({ ...prod, VERCEL_ENV: "preview", SMS_USAGE_EVIDENCE_READS: "on" }).allowed).toBe(false);
    expect(usageEvidenceReadsAllowed({ ...prod, SMS_BILLED_REAL_SEND: "on" }).allowed).toBe(false);
  });
});

type Seen = { url: string; init: RequestInit };
function stubFetch(reply: (seen: Seen) => { status: number; body: unknown } | "throw") {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const entry = { url, init };
    seen.push(entry);
    const r = reply(entry);
    if (r === "throw") throw new Error(`down ${TOKEN} ${PHONE} ${BODY}`);
    return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}
const creds = { accountSid: PARENT, authToken: TOKEN };

describe("RealBilledSmsProvider.send", () => {
  it("posts to the SUBACCOUNT with parent Basic auth and form fields", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 201, body: { sid: MSG } }));
    const provider = new RealBilledSmsProvider(creds, { fetchImpl, allowSend: true });
    expect(await provider.send(input)).toEqual({ kind: "accepted", sid: MSG });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB}/Messages.json`);
    expect(seen[0].init.method).toBe("POST");
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe(basic);
    expect(seen[0].init.cache).toBe("no-store");
    const form = new URLSearchParams(String(seen[0].init.body));
    expect(Object.fromEntries(form)).toEqual({ To: PHONE, MessagingServiceSid: SERVICE, Body: BODY, StatusCallback: "https://app.example/cb" });
  });

  it("omits StatusCallback when null", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 201, body: { sid: MSG } }));
    await new RealBilledSmsProvider(creds, { fetchImpl, allowSend: true }).send({ ...input, statusCallbackUrl: null });
    expect(new URLSearchParams(String(seen[0].init.body)).has("StatusCallback")).toBe(false);
  });

  it("refuses without calling fetch when sending is not allowed", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 201, body: { sid: MSG } }));
    expect(await new RealBilledSmsProvider(creds, { fetchImpl }).send(input)).toEqual({ kind: "refused", code: "real_send_disabled" });
    expect(await new RealBilledSmsProvider(creds, { fetchImpl, allowSend: false, allowRead: true }).send(input)).toEqual({ kind: "refused", code: "real_send_disabled" });
    expect(seen).toHaveLength(0);
  });

  it("refuses invalid input without calling fetch", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 201, body: { sid: MSG } }));
    const provider = new RealBilledSmsProvider(creds, { fetchImpl, allowSend: true });
    for (const bad of [
      { ...input, accountSid: "AC123" }, { ...input, messagingServiceSid: SUB }, { ...input, to: "5035550123" }, { ...input, to: "+10035550123" }, { ...input, body: "" },
    ]) {
      expect(await provider.send(bad)).toEqual({ kind: "refused", code: "invalid_input" });
    }
    expect(seen).toHaveLength(0);
  });

  it("classifies definite refusals and uncertain answers", async () => {
    const refused = new RealBilledSmsProvider(creds, { fetchImpl: stubFetch(() => ({ status: 400, body: { code: 21211, message: PHONE } })).fetchImpl, allowSend: true });
    expect(await refused.send(input)).toEqual({ kind: "refused", code: "21211" });
    const down = new RealBilledSmsProvider(creds, { fetchImpl: stubFetch(() => ({ status: 503, body: "<html>" })).fetchImpl, allowSend: true });
    expect(await down.send(input)).toEqual({ kind: "uncertain", code: "unreadable" });
    const empty = new RealBilledSmsProvider(creds, { fetchImpl: stubFetch(() => ({ status: 503, body: {} })).fetchImpl, allowSend: true });
    expect(await empty.send(input)).toEqual({ kind: "uncertain", code: "http_503" });
  });

  it("a network error is uncertain and leaks nothing", async () => {
    const provider = new RealBilledSmsProvider(creds, { fetchImpl: stubFetch(() => "throw").fetchImpl, allowSend: true });
    const result = await provider.send(input);
    expect(result).toEqual({ kind: "uncertain", code: "network" });
    const text = JSON.stringify(result);
    for (const secret of [TOKEN, PHONE, BODY]) expect(text).not.toContain(secret);
  });

  it("a timeout is uncertain", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const provider = new RealBilledSmsProvider(creds, { fetchImpl, allowSend: true, timeoutMs: 10 });
    expect(await provider.send(input)).toEqual({ kind: "uncertain", code: "timeout" });
  });
});

describe("RealBilledSmsProvider.fetchMessage", () => {
  const good = { sid: MSG, account_sid: SUB, status: "delivered", num_segments: "2", num_media: 0, price: "-0.01660", price_unit: "USD" };

  it("maps the message and reads from the subaccount with parent auth", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 200, body: good }));
    const evidence = await new RealBilledSmsProvider(creds, { fetchImpl, allowRead: true }).fetchMessage(SUB, MSG);
    expect(evidence).toEqual({ sid: MSG, account_sid: SUB, status: "delivered", num_segments: "2", num_media: "0", price: "-0.01660", price_unit: "USD" });
    expect(seen[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB}/Messages/${MSG}.json`);
    expect(seen[0].init.method).toBe("GET");
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe(basic);
  });

  it("keeps null as null and numbers as strings", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 200, body: { ...good, num_segments: 3, price: null, price_unit: null, num_media: null } }));
    const evidence = await new RealBilledSmsProvider(creds, { fetchImpl, allowRead: true }).fetchMessage(SUB, MSG);
    expect(evidence).toMatchObject({ num_segments: "3", price: null, price_unit: null, num_media: null });
  });

  it("throws on mismatch, missing status, http errors, unreadable bodies and network failure", async () => {
    const run = (reply: Parameters<typeof stubFetch>[0]) =>
      new RealBilledSmsProvider(creds, { fetchImpl: stubFetch(reply).fetchImpl, allowRead: true }).fetchMessage(SUB, MSG);
    await expect(run(() => ({ status: 200, body: { ...good, sid: `SM${"e".repeat(32)}` } }))).rejects.toThrow("usage_evidence_mismatch");
    await expect(run(() => ({ status: 200, body: { ...good, account_sid: PARENT } }))).rejects.toThrow("usage_evidence_mismatch");
    await expect(run(() => ({ status: 200, body: { ...good, status: undefined } }))).rejects.toThrow("usage_evidence_no_status");
    await expect(run(() => ({ status: 404, body: { code: 20404 } }))).rejects.toThrow("usage_evidence_http_404");
    await expect(run(() => ({ status: 200, body: "<html>" }))).rejects.toThrow("usage_evidence_unreadable");
    await expect(run(() => ({ status: 200, body: "[]" }))).rejects.toThrow("usage_evidence_unreadable");
    await expect(run(() => "throw")).rejects.toThrow("usage_evidence_unreadable");
  });

  it("throws on invalid input without fetching", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 200, body: good }));
    const provider = new RealBilledSmsProvider(creds, { fetchImpl, allowRead: true });
    await expect(provider.fetchMessage("AC1", MSG)).rejects.toThrow("usage_evidence_invalid_input");
    await expect(provider.fetchMessage(SUB, "XX1")).rejects.toThrow("usage_evidence_invalid_input");
    expect(seen).toHaveLength(0);
  });

  it("throws without fetching unless allowRead is true", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 200, body: good }));
    await expect(new RealBilledSmsProvider(creds, { fetchImpl, allowSend: true }).fetchMessage(SUB, MSG)).rejects.toThrow("usage_evidence_reads_disabled");
    expect(seen).toHaveLength(0);
  });

  it("error messages never contain credentials, bodies or phone numbers", async () => {
    const provider = new RealBilledSmsProvider(creds, { fetchImpl: stubFetch(() => "throw").fetchImpl, allowRead: true });
    const error = await provider.fetchMessage(SUB, MSG).catch((e: Error) => e);
    const text = String((error as Error).message);
    for (const secret of [TOKEN, PHONE, BODY]) expect(text).not.toContain(secret);
  });
});

describe("FakeBilledSmsProvider", () => {
  it("records sends and generates valid, distinct sids", async () => {
    const fake = new FakeBilledSmsProvider();
    const a = await fake.send(input);
    const b = await fake.send(input);
    expect(a.kind === "accepted" && /^SM[0-9a-f]{32}$/.test(a.sid)).toBe(true);
    expect(a).not.toEqual(b);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[0]).toEqual(input);
  });

  it("serves scripted sends in order then defaults", async () => {
    const fake = new FakeBilledSmsProvider().nextSend({ kind: "refused", code: "21211" }).nextSend({ kind: "uncertain", code: "timeout" });
    expect(await fake.send(input)).toEqual({ kind: "refused", code: "21211" });
    expect(await fake.send(input)).toEqual({ kind: "uncertain", code: "timeout" });
    expect((await fake.send(input)).kind).toBe("accepted");
  });

  it("scripts evidence and fetch failure", async () => {
    const fake = new FakeBilledSmsProvider().setEvidence(MSG, { status: "undelivered", num_segments: "3" }).failFetch(`SM${"f".repeat(32)}`);
    expect(await fake.fetchMessage(SUB, MSG)).toMatchObject({ sid: MSG, account_sid: SUB, status: "undelivered", num_segments: "3", price_unit: "USD" });
    await expect(fake.fetchMessage(SUB, `SM${"f".repeat(32)}`)).rejects.toThrow();
  });
});

describe("billedSmsProviderFromEnv", () => {
  const prod = { VERCEL_ENV: "production", NODE_ENV: "production", TWILIO_ACCOUNT_SID: PARENT, TWILIO_AUTH_TOKEN: TOKEN };
  it("returns a real provider when a production gate is on", () => {
    expect(billedSmsProviderFromEnv({ ...prod, SMS_BILLED_REAL_SEND: "on" })).toBeInstanceOf(RealBilledSmsProvider);
    expect(billedSmsProviderFromEnv({ ...prod, SMS_USAGE_EVIDENCE_READS: "on" })).toBeInstanceOf(RealBilledSmsProvider);
  });
  it("returns null with missing or malformed credentials", () => {
    expect(billedSmsProviderFromEnv({ ...prod, SMS_BILLED_REAL_SEND: "on", TWILIO_AUTH_TOKEN: "" })).toBeNull();
    expect(billedSmsProviderFromEnv({ ...prod, SMS_BILLED_REAL_SEND: "on", TWILIO_ACCOUNT_SID: "bad" })).toBeNull();
  });
  it("a read-only gate does not let the real provider send", async () => {
    const readOnly = billedSmsProviderFromEnv({ ...prod, SMS_USAGE_EVIDENCE_READS: "on" });
    expect(await readOnly?.send(input)).toEqual({ kind: "refused", code: "real_send_disabled" });
  });
  it("returns the fake singleton only where the fake adapter is allowed, else null", () => {
    const dev = { NODE_ENV: "development", TW4_ISV_FAKE: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" };
    const one = billedSmsProviderFromEnv(dev);
    expect(one).toBeInstanceOf(FakeBilledSmsProvider);
    expect(billedSmsProviderFromEnv(dev)).toBe(one);
    expect(billedSmsProviderFromEnv({ NODE_ENV: "development" })).toBeNull();
    expect(billedSmsProviderFromEnv({ ...dev, VERCEL_ENV: "production" })).toBeNull();
  });
});
