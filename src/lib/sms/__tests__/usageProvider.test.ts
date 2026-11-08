import { describe, expect, it } from "vitest";
import { SubaccountTokenProvider } from "../twilioIsv/account";
import { createMessagingTokenParent, messagingTokenProvider, messagingTokenReadsAllowed } from "../twilioIsv/real";
import {
  billedRealSendAllowed, billedSmsProviderFromEnv, classifyTwilioSendResponse, FakeBilledSmsProvider, RealBilledSmsProvider,
  usageEvidenceReadsAllowed, type BilledSmsSendInput,
} from "../usageProvider";

const PARENT = `AC${"1".repeat(32)}`;
const PARENT_TOKEN = "p4rent".repeat(5) + "ab";
const SUB_TOKEN = "t0ken".repeat(6) + "ab";
const NEW_TOKEN = "n3wTk".repeat(6) + "ab";
const SUB = `AC${"a".repeat(32)}`;
const OTHER = `AC${"d".repeat(32)}`;
const SERVICE = `MG${"b".repeat(32)}`;
const MSG = `SM${"c".repeat(32)}`;
const PHONE = "+15035550123";
const FROM = "+15035550199";
const BODY = "Secret studio body text";
const input: BilledSmsSendInput = { accountSid: SUB, messagingServiceSid: SERVICE, to: PHONE, body: BODY, statusCallbackUrl: "https://app.example/cb", from: FROM };
const basicFor = (sid: string, token: string) => `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
const basic = basicFor(SUB, SUB_TOKEN);

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
    expect(billedRealSendAllowed({ ...prod, SMS_BILLED_REAL_SEND: "on", TW4_SUBACCOUNT_WEBHOOKS: "on" })).toEqual({ allowed: true });
    // replies (STOP / START / HELP) and delivery callbacks of subaccount numbers must be verifiable before a billed text goes out from one
    expect(billedRealSendAllowed({ ...prod, SMS_BILLED_REAL_SEND: "on" }).allowed).toBe(false);
    expect(billedRealSendAllowed({ ...prod, SMS_BILLED_REAL_SEND: "on", TW4_SUBACCOUNT_WEBHOOKS: "true" }).allowed).toBe(false);
    expect(billedRealSendAllowed({ ...prod, TW4_SUBACCOUNT_WEBHOOKS: "on" }).allowed).toBe(false);
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
function stubFetch(reply: (seen: Seen, n: number) => { status: number; body: unknown } | "throw") {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const entry = { url, init };
    seen.push(entry);
    const r = reply(entry, seen.length);
    if (r === "throw") throw new Error(`down ${SUB_TOKEN} ${PARENT_TOKEN} ${PHONE} ${BODY}`);
    return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

/** A real SubaccountTokenProvider over a scripted parent, with no caching, so each read is visible. */
function tokenSource(tokens: Record<string, string | (() => string)> = { [SUB]: SUB_TOKEN }, options: { refreshIntervalMs?: number; ttlMs?: number } = {}) {
  const reads: string[] = [];
  const provider = new SubaccountTokenProvider(
    {
      getSubaccountToken: async (sid: string) => {
        reads.push(sid);
        const t = tokens[sid];
        if (t === undefined) throw new Error(`no token for ${sid} ${PARENT_TOKEN}`);
        return typeof t === "function" ? t() : t;
      },
    },
    { ttlMs: options.ttlMs ?? 60_000, refreshIntervalMs: options.refreshIntervalMs ?? 0 },
  );
  return { provider, reads };
}
const real = (fetchImpl: typeof fetch, flags: { allowSend?: boolean; allowRead?: boolean } = { allowSend: true, allowRead: true }, source = tokenSource()) =>
  new RealBilledSmsProvider(source.provider, { fetchImpl, ...flags });

describe("RealBilledSmsProvider.send", () => {
  it("posts to the SUBACCOUNT signed with the subaccount SID and its own token (never the parent's), with From and the service", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 201, body: { sid: MSG } }));
    expect(await real(fetchImpl).send(input)).toEqual({ kind: "accepted", sid: MSG });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB}/Messages.json`);
    expect(seen[0].init.method).toBe("POST");
    const auth = (seen[0].init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(basic);
    expect(auth).not.toBe(basicFor(PARENT, PARENT_TOKEN));
    expect(seen[0].init.cache).toBe("no-store");
    const form = new URLSearchParams(String(seen[0].init.body));
    expect(Object.fromEntries(form)).toEqual({ To: PHONE, MessagingServiceSid: SERVICE, From: FROM, Body: BODY, StatusCallback: "https://app.example/cb" });
  });

  it("omits From when null and StatusCallback when null", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 201, body: { sid: MSG } }));
    await real(fetchImpl).send({ ...input, statusCallbackUrl: null, from: null });
    const form = new URLSearchParams(String(seen[0].init.body));
    expect(form.has("StatusCallback")).toBe(false);
    expect(form.has("From")).toBe(false);
    expect(form.get("MessagingServiceSid")).toBe(SERVICE);
  });

  it("a number that left the pool (Twilio 21711) is a definite refusal", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 400, body: { code: 21711, message: FROM } }));
    expect(await real(fetchImpl).send(input)).toEqual({ kind: "refused", code: "21711" });
  });

  it("refuses without calling fetch or reading a token when sending is not allowed", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 201, body: { sid: MSG } }));
    const source = tokenSource();
    expect(await real(fetchImpl, {}, source).send(input)).toEqual({ kind: "refused", code: "real_send_disabled" });
    expect(await real(fetchImpl, { allowSend: false, allowRead: true }, source).send(input)).toEqual({ kind: "refused", code: "real_send_disabled" });
    expect(seen).toHaveLength(0);
    expect(source.reads).toHaveLength(0);
  });

  it("refuses invalid input without calling fetch or reading a token", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 201, body: { sid: MSG } }));
    const source = tokenSource();
    const provider = real(fetchImpl, undefined, source);
    for (const bad of [
      { ...input, accountSid: "AC123" }, { ...input, messagingServiceSid: SUB }, { ...input, to: "5035550123" }, { ...input, to: "+10035550123" }, { ...input, body: "" },
      { ...input, from: "5035550199" },
    ]) {
      expect(await provider.send(bad)).toEqual({ kind: "refused", code: "invalid_input" });
    }
    expect(seen).toHaveLength(0);
    expect(source.reads).toHaveLength(0);
  });

  it("classifies definite refusals and uncertain answers", async () => {
    expect(await real(stubFetch(() => ({ status: 400, body: { code: 21211, message: PHONE } })).fetchImpl).send(input)).toEqual({ kind: "refused", code: "21211" });
    expect(await real(stubFetch(() => ({ status: 503, body: "<html>" })).fetchImpl).send(input)).toEqual({ kind: "uncertain", code: "unreadable" });
    expect(await real(stubFetch(() => ({ status: 503, body: {} })).fetchImpl).send(input)).toEqual({ kind: "uncertain", code: "http_503" });
  });

  it("a network error is uncertain and leaks nothing", async () => {
    const result = await real(stubFetch(() => "throw").fetchImpl).send(input);
    expect(result).toEqual({ kind: "uncertain", code: "network" });
    const text = JSON.stringify(result);
    for (const secret of [SUB_TOKEN, PARENT_TOKEN, PHONE, BODY]) expect(text).not.toContain(secret);
  });

  it("a timeout is uncertain", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const provider = new RealBilledSmsProvider(tokenSource().provider, { fetchImpl, allowSend: true, timeoutMs: 10 });
    expect(await provider.send(input)).toEqual({ kind: "uncertain", code: "timeout" });
  });

  it("no token available: a definite refusal (credentials_unavailable), nothing sent, nothing leaked", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 201, body: { sid: MSG } }));
    const result = await real(fetchImpl, undefined, tokenSource({})).send(input);
    expect(result).toEqual({ kind: "refused", code: "credentials_unavailable" });
    expect(seen).toHaveLength(0);
    for (const secret of [SUB_TOKEN, PARENT_TOKEN]) expect(JSON.stringify(result)).not.toContain(secret);
  });

  describe("HTTP 401", () => {
    it("re-reads the token once and retries the same request once when it changed", async () => {
      let current = SUB_TOKEN;
      const source = tokenSource({ [SUB]: () => current });
      const { fetchImpl, seen } = stubFetch((entry) =>
        (entry.init.headers as Record<string, string>).Authorization === basicFor(SUB, NEW_TOKEN) ? { status: 201, body: { sid: MSG } } : { status: 401, body: { code: 20003 } });
      const provider = real(fetchImpl, undefined, source);
      await provider.prepare(SUB); // caches the old token
      current = NEW_TOKEN; // rotated at Twilio
      expect(await provider.send(input)).toEqual({ kind: "accepted", sid: MSG });
      expect(seen).toHaveLength(2);
      expect((seen[0].init.headers as Record<string, string>).Authorization).toBe(basicFor(SUB, SUB_TOKEN));
      expect((seen[1].init.headers as Record<string, string>).Authorization).toBe(basicFor(SUB, NEW_TOKEN));
      expect(seen[1].init.body).toBe(seen[0].init.body);
      expect(seen[1].url).toBe(seen[0].url);
    });

    it("an unchanged token after the re-read is refused (credentials_rejected) with no retry", async () => {
      const { fetchImpl, seen } = stubFetch(() => ({ status: 401, body: { code: 20003, message: SUB_TOKEN } }));
      const result = await real(fetchImpl).send(input);
      expect(result).toEqual({ kind: "refused", code: "credentials_rejected" });
      expect(seen).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(SUB_TOKEN);
    });

    it("a second 401 with a changed token is refused after exactly one retry", async () => {
      let current = SUB_TOKEN;
      const source = tokenSource({ [SUB]: () => current });
      const { fetchImpl, seen } = stubFetch(() => ({ status: 401, body: { code: 20003 } }));
      const provider = real(fetchImpl, undefined, source);
      await provider.prepare(SUB);
      current = NEW_TOKEN;
      expect(await provider.send(input)).toEqual({ kind: "refused", code: "credentials_rejected" });
      expect(seen).toHaveLength(2);
    });

    it("a throttled or failed re-read is refused (credentials_rejected), not retried", async () => {
      const source = tokenSource({ [SUB]: SUB_TOKEN }, { refreshIntervalMs: 60_000 });
      const { fetchImpl, seen } = stubFetch(() => ({ status: 401, body: { code: 20003 } }));
      expect(await real(fetchImpl, undefined, source).send(input)).toEqual({ kind: "refused", code: "credentials_rejected" });
      expect(seen).toHaveLength(1);
    });

    it("never falls back to the parent's credentials", async () => {
      const { fetchImpl, seen } = stubFetch(() => ({ status: 401, body: { code: 20003 } }));
      await real(fetchImpl).send(input);
      for (const entry of seen) expect((entry.init.headers as Record<string, string>).Authorization).not.toBe(basicFor(PARENT, PARENT_TOKEN));
    });
  });
});

describe("RealBilledSmsProvider.prepare", () => {
  it("obtains the account's token without sending", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 201, body: { sid: MSG } }));
    const source = tokenSource();
    expect(await real(fetchImpl, undefined, source).prepare(SUB)).toEqual({ ok: true });
    expect(source.reads).toEqual([SUB]);
    expect(seen).toHaveLength(0);
  });
  it("fails closed with a fixed code when the token cannot be read, an invalid SID or sending is off", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 201, body: { sid: MSG } }));
    const failed = await real(fetchImpl, undefined, tokenSource({})).prepare(SUB);
    expect(failed).toEqual({ ok: false, code: "credentials_unavailable" });
    expect(JSON.stringify(failed)).not.toContain(PARENT_TOKEN);
    expect(await real(fetchImpl).prepare("AC1")).toEqual({ ok: false, code: "invalid_input" });
    expect(await real(fetchImpl, { allowRead: true }).prepare(SUB)).toEqual({ ok: false, code: "real_send_disabled" });
  });
});

describe("RealBilledSmsProvider.fetchMessage", () => {
  const good = { sid: MSG, account_sid: SUB, status: "delivered", num_segments: "2", num_media: 0, price: "-0.01660", price_unit: "USD" };

  it("maps the message and reads from the subaccount with that subaccount's credentials", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 200, body: good }));
    const evidence = await real(fetchImpl).fetchMessage(SUB, MSG);
    expect(evidence).toEqual({
      sid: MSG, account_sid: SUB, status: "delivered", num_segments: "2", num_media: "0", price: "-0.01660", price_unit: "USD",
      direction: null, messaging_service_sid: null, from: null, to: null, date_created: null, date_sent: null, error_code: null,
    });
    expect(seen[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB}/Messages/${MSG}.json`);
    expect(seen[0].init.method).toBe("GET");
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe(basic);
  });

  it("uses the credentials of the account passed in, never another", async () => {
    const OTHER_TOKEN = "0therT".repeat(5) + "ab";
    const source = tokenSource({ [SUB]: SUB_TOKEN, [OTHER]: OTHER_TOKEN });
    const { fetchImpl, seen } = stubFetch((entry) => ({ status: 200, body: { ...good, account_sid: entry.url.includes(OTHER) ? OTHER : SUB } }));
    const provider = real(fetchImpl, undefined, source);
    await provider.fetchMessage(OTHER, MSG);
    await provider.fetchMessage(SUB, MSG);
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe(basicFor(OTHER, OTHER_TOKEN));
    expect((seen[1].init.headers as Record<string, string>).Authorization).toBe(basicFor(SUB, SUB_TOKEN));
  });

  it("keeps null as null and numbers as strings", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 200, body: { ...good, num_segments: 3, price: null, price_unit: null, num_media: null } }));
    expect(await real(fetchImpl).fetchMessage(SUB, MSG)).toMatchObject({ num_segments: "3", price: null, price_unit: null, num_media: null });
  });

  it("throws on mismatch, missing status, http errors, unreadable bodies and network failure", async () => {
    const run = (reply: Parameters<typeof stubFetch>[0]) => real(stubFetch(reply).fetchImpl, { allowRead: true }).fetchMessage(SUB, MSG);
    await expect(run(() => ({ status: 200, body: { ...good, sid: `SM${"e".repeat(32)}` } }))).rejects.toThrow("usage_evidence_mismatch");
    await expect(run(() => ({ status: 200, body: { ...good, account_sid: PARENT } }))).rejects.toThrow("usage_evidence_mismatch");
    await expect(run(() => ({ status: 200, body: { ...good, status: undefined } }))).rejects.toThrow("usage_evidence_no_status");
    await expect(run(() => ({ status: 404, body: { code: 20404 } }))).rejects.toThrow("usage_evidence_http_404");
    await expect(run(() => ({ status: 200, body: "<html>" }))).rejects.toThrow("usage_evidence_unreadable");
    await expect(run(() => ({ status: 200, body: "[]" }))).rejects.toThrow("usage_evidence_unreadable");
    await expect(run(() => "throw")).rejects.toThrow("usage_evidence_unreadable");
  });

  it("a 401 re-reads once and retries once only when the token changed, else throws credentials_rejected", async () => {
    let current = SUB_TOKEN;
    const source = tokenSource({ [SUB]: () => current });
    const { fetchImpl, seen } = stubFetch((entry) =>
      (entry.init.headers as Record<string, string>).Authorization === basicFor(SUB, NEW_TOKEN) ? { status: 200, body: good } : { status: 401, body: { code: 20003 } });
    const provider = real(fetchImpl, undefined, source);
    await provider.prepare(SUB);
    current = NEW_TOKEN;
    expect((await provider.fetchMessage(SUB, MSG)).status).toBe("delivered");
    expect(seen).toHaveLength(2);

    const stuck = stubFetch(() => ({ status: 401, body: { code: 20003 } }));
    await expect(real(stuck.fetchImpl).fetchMessage(SUB, MSG)).rejects.toThrow("usage_evidence_credentials_rejected");
    expect(stuck.seen).toHaveLength(1);
  });

  it("throws on invalid input without fetching or reading a token", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 200, body: good }));
    const source = tokenSource();
    const provider = real(fetchImpl, undefined, source);
    await expect(provider.fetchMessage("AC1", MSG)).rejects.toThrow("usage_evidence_invalid_input");
    await expect(provider.fetchMessage(SUB, "XX1")).rejects.toThrow("usage_evidence_invalid_input");
    expect(seen).toHaveLength(0);
    expect(source.reads).toHaveLength(0);
  });

  it("throws without fetching unless allowRead is true", async () => {
    const { fetchImpl, seen } = stubFetch(() => ({ status: 200, body: good }));
    await expect(real(fetchImpl, { allowSend: true }).fetchMessage(SUB, MSG)).rejects.toThrow("usage_evidence_reads_disabled");
    expect(seen).toHaveLength(0);
  });

  it("error messages never contain credentials, bodies or phone numbers", async () => {
    const error = await real(stubFetch(() => "throw").fetchImpl).fetchMessage(SUB, MSG).catch((e: Error) => e);
    const failedToken = await real(stubFetch(() => ({ status: 200, body: good })).fetchImpl, undefined, tokenSource({})).fetchMessage(SUB, MSG).catch((e: Error) => e);
    for (const e of [error, failedToken]) {
      for (const secret of [SUB_TOKEN, PARENT_TOKEN, PHONE, BODY]) expect(String((e as Error).message)).not.toContain(secret);
    }
    expect((failedToken as Error).message).toBe("usage_evidence_credentials_unavailable");
  });
});

describe("FakeBilledSmsProvider", () => {
  it("records sends (including From) and generates valid, distinct sids", async () => {
    const fake = new FakeBilledSmsProvider();
    const a = await fake.send(input);
    const b = await fake.send(input);
    expect(a.kind === "accepted" && /^SM[0-9a-f]{32}$/.test(a.sid)).toBe(true);
    expect(a).not.toEqual(b);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[0]).toEqual(input);
    expect(fake.sent[0].from).toBe(FROM);
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

  it("prepare needs no tokens and can be scripted to fail per account", async () => {
    const fake = new FakeBilledSmsProvider().failPrepare(OTHER);
    expect(await fake.prepare(SUB)).toEqual({ ok: true });
    expect(await fake.prepare(OTHER)).toEqual({ ok: false, code: "credentials_unavailable" });
    expect(fake.prepared).toEqual([SUB, OTHER]);
  });
});

describe("messaging token-read parent", () => {
  const prod = { VERCEL_ENV: "production", NODE_ENV: "production" };
  it("gate truth table: production + production build + a send or verify (or evidence) flag; TW4_ISV_REAL_CALLS plays no part", () => {
    expect(messagingTokenReadsAllowed({ ...prod, SMS_BILLED_REAL_SEND: "on" })).toEqual({ allowed: true });
    expect(messagingTokenReadsAllowed({ ...prod, SMS_SENDER_VERIFY_READS: "on" })).toEqual({ allowed: true });
    expect(messagingTokenReadsAllowed({ ...prod, SMS_USAGE_EVIDENCE_READS: "on" })).toEqual({ allowed: true });
    expect(messagingTokenReadsAllowed({ ...prod, SMS_BILLED_REAL_SEND: "on", TW4_ISV_REAL_CALLS: "off" }).allowed).toBe(true);
    expect(messagingTokenReadsAllowed({ ...prod, TW4_ISV_REAL_CALLS: "on" }).allowed).toBe(false);
    expect(messagingTokenReadsAllowed({ ...prod }).allowed).toBe(false);
    expect(messagingTokenReadsAllowed({ ...prod, SMS_BILLED_REAL_SEND: "true" }).allowed).toBe(false);
    expect(messagingTokenReadsAllowed({ ...prod, NODE_ENV: "development", SMS_BILLED_REAL_SEND: "on" }).allowed).toBe(false);
    expect(messagingTokenReadsAllowed({ ...prod, VERCEL_ENV: "preview", SMS_SENDER_VERIFY_READS: "on" }).allowed).toBe(false);
    expect(messagingTokenReadsAllowed({ NODE_ENV: "production", SMS_BILLED_REAL_SEND: "on" }).allowed).toBe(false);
    expect(messagingTokenReadsAllowed({ ...prod, TW4_SUBACCOUNT_WEBHOOKS: "on" }).allowed).toBe(false);
  });

  const accountReply = (over: Record<string, unknown> = {}) => ({ sid: SUB, status: "active", auth_token: SUB_TOKEN, ...over });
  const parent = (reply: Parameters<typeof stubFetch>[0], env: Record<string, string> = { ...prod, SMS_SENDER_VERIFY_READS: "on" }) => {
    const stub = stubFetch(reply);
    return { ...stub, parent: createMessagingTokenParent({ accountSid: PARENT, authToken: PARENT_TOKEN }, env, stub.fetchImpl as never) };
  };

  it("reads the account with PARENT credentials and returns the token", async () => {
    const { parent: p, seen } = parent(() => ({ status: 200, body: accountReply() }));
    expect(await p.getSubaccountToken(SUB)).toBe(SUB_TOKEN);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB}.json`);
    expect(seen[0].init.method).toBe("GET");
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe(basicFor(PARENT, PARENT_TOKEN));
  });

  it("works without TW4_ISV_REAL_CALLS and is refused when the gate is closed", () => {
    expect(() => parent(() => ({ status: 200, body: accountReply() }), { ...prod, SMS_BILLED_REAL_SEND: "on" })).not.toThrow();
    expect(() => parent(() => ({ status: 200, body: accountReply() }), { ...prod, TW4_ISV_REAL_CALLS: "on" })).toThrow();
    expect(() => parent(() => ({ status: 200, body: accountReply() }), { NODE_ENV: "development", SMS_BILLED_REAL_SEND: "on" })).toThrow();
  });

  it("refuses the parent's own SID and malformed SIDs without a request", async () => {
    const { parent: p, seen } = parent(() => ({ status: 200, body: accountReply() }));
    await expect(p.getSubaccountToken(PARENT)).rejects.toThrow();
    await expect(p.getSubaccountToken("AC123")).rejects.toThrow();
    await expect(p.getSubaccountToken(`${SUB}/../x`)).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it("refuses suspended and closed accounts, mismatched replies and replies without a token", async () => {
    for (const body of [accountReply({ status: "suspended" }), accountReply({ status: "closed" }), accountReply({ status: undefined }), accountReply({ sid: OTHER }), accountReply({ auth_token: undefined }), accountReply({ auth_token: "short" })]) {
      const { parent: p } = parent(() => ({ status: 200, body }));
      await expect(p.getSubaccountToken(SUB)).rejects.toThrow();
    }
  });

  it("through the token provider an error carries no token, whatever Twilio echoed", async () => {
    const { parent: p } = parent(() => ({ status: 401, body: { code: 20003, message: PARENT_TOKEN } }));
    const message = String(await new SubaccountTokenProvider(p).tokenFor(SUB).catch((e: Error) => e.message));
    expect(message).not.toContain(PARENT_TOKEN);
    expect(message).not.toContain(SUB_TOKEN);
  });

  it("messagingTokenProvider is null when gated off or unconfigured and process-wide otherwise", () => {
    expect(messagingTokenProvider({ ...prod })).toBeNull();
    expect(messagingTokenProvider({ ...prod, SMS_SENDER_VERIFY_READS: "on", TWILIO_ACCOUNT_SID: PARENT, TWILIO_AUTH_TOKEN: "" })).toBeNull();
    const env = { ...prod, SMS_SENDER_VERIFY_READS: "on", TWILIO_ACCOUNT_SID: PARENT, TWILIO_AUTH_TOKEN: PARENT_TOKEN };
    const one = messagingTokenProvider(env);
    expect(one).toBeInstanceOf(SubaccountTokenProvider);
    expect(messagingTokenProvider(env)).toBe(one);
  });
});

describe("billedSmsProviderFromEnv", () => {
  const prod = { VERCEL_ENV: "production", NODE_ENV: "production", TWILIO_ACCOUNT_SID: PARENT, TWILIO_AUTH_TOKEN: PARENT_TOKEN };
  it("returns a real provider when a production gate is on", () => {
    expect(billedSmsProviderFromEnv({ ...prod, SMS_BILLED_REAL_SEND: "on", TW4_SUBACCOUNT_WEBHOOKS: "on" })).toBeInstanceOf(RealBilledSmsProvider);
    expect(billedSmsProviderFromEnv({ ...prod, SMS_USAGE_EVIDENCE_READS: "on" })).toBeInstanceOf(RealBilledSmsProvider);
  });
  it("real sends stay off while subaccount webhooks are off, even with SMS_BILLED_REAL_SEND=on", async () => {
    expect(billedSmsProviderFromEnv({ ...prod, SMS_BILLED_REAL_SEND: "on" })).toBeNull();
    const readsOnly = billedSmsProviderFromEnv({ ...prod, SMS_BILLED_REAL_SEND: "on", SMS_USAGE_EVIDENCE_READS: "on" });
    expect(await readsOnly?.send(input)).toEqual({ kind: "refused", code: "real_send_disabled" });
  });
  it("returns null with missing or malformed parent credentials", () => {
    expect(billedSmsProviderFromEnv({ ...prod, SMS_BILLED_REAL_SEND: "on", TWILIO_AUTH_TOKEN: "" })).toBeNull();
    expect(billedSmsProviderFromEnv({ ...prod, SMS_BILLED_REAL_SEND: "on", TWILIO_ACCOUNT_SID: "bad" })).toBeNull();
  });
  it("a read-only gate does not let the real provider send", async () => {
    const readOnly = billedSmsProviderFromEnv({ ...prod, SMS_USAGE_EVIDENCE_READS: "on" });
    expect(await readOnly?.send(input)).toEqual({ kind: "refused", code: "real_send_disabled" });
    expect(await readOnly?.prepare(SUB)).toEqual({ ok: false, code: "real_send_disabled" });
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
