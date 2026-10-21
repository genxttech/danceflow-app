import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RedactedSecret } from "@/lib/sms/twilioIsv/account";
import {
  FakeSenderReadProvider, RealSenderReadProvider, SenderReadError, buildSenderEvidence, digestOf, expectedInboundUrl, reverifyDueSenders,
  senderReadProviderFromEnv, senderVerifyReadsAllowed, verifySender, type SenderOverviewRow, type SenderTokenProvider,
} from "@/lib/sms/senderVerification";

const AC = `AC${"a1".repeat(16)}`;
const MG = `MG${"b2".repeat(16)}`;
const QE = `QE${"c3".repeat(16)}`;
const PN = `PN${"d4".repeat(16)}`;
const BN = `BN${"e5".repeat(16)}`;
const E164 = "+15035550123";
const URL_IN = "https://www.idanceflow.com/api/sms/twilio/inbound";
const IDS = { accountSid: AC, messagingServiceSid: MG, campaignSid: QE, phoneNumberSid: PN };
const STUDIO = "11111111-1111-4111-8111-111111111111";
const SENDER = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";

function healthyFake(overrides: { service?: object; number?: object } = {}) {
  return new FakeSenderReadProvider()
    .script("account", AC, { sid: AC, status: "active" })
    .script("service", MG, { sid: MG, account_sid: AC, us_app_to_person_registered: true, inbound_request_url: URL_IN, use_inbound_webhook_on_number: false, ...overrides.service })
    .script("campaign", QE, { sid: QE, account_sid: AC, messaging_service_sid: MG, campaign_status: "VERIFIED", mock: false, brand_registration_sid: BN, us_app_to_person_usecase: "MIXED" })
    .script("brand", BN, { sid: BN, status: "APPROVED", mock: false })
    .script("number", PN, { sid: PN, account_sid: AC, phone_number: E164, sms_capable: true, status: "in-use", sms_url: null, ...overrides.number })
    .script("service_number", PN, { sid: PN, service_sid: MG, account_sid: AC });
}

describe("buildSenderEvidence", () => {
  it("returns exactly the shape the database judge reads, with digests and no raw bodies", async () => {
    const e = await buildSenderEvidence(healthyFake(), IDS, URL_IN);
    expect(Object.keys(e).sort()).toEqual(["account", "brand", "campaign", "digests", "number", "read_errors", "service", "service_number"]);
    expect(e.account).toEqual({ sid: AC, status: "active" });
    expect(Object.keys(e.service!).sort()).toEqual(["account_sid", "inbound_request_url", "inbound_route_ok", "sid", "us_app_to_person_registered", "use_inbound_webhook_on_number"]);
    expect(Object.keys(e.campaign!).sort()).toEqual(["account_sid", "brand_registration_sid", "campaign_status", "messaging_service_sid", "mock", "sid", "us_app_to_person_usecase"]);
    expect(Object.keys(e.brand!).sort()).toEqual(["mock", "sid", "status"]);
    expect(Object.keys(e.number!).sort()).toEqual(["account_sid", "phone_number", "sid", "sms_capable", "sms_url", "status"]);
    expect(Object.keys(e.service_number!).sort()).toEqual(["account_sid", "service_sid", "sid"]);
    expect(e.read_errors).toEqual([]);
    expect(Object.keys(e.digests).sort()).toEqual(["account", "brand", "campaign", "number", "service", "service_number"]);
    expect(e.digests.account).toBe(digestOf({ status: "active", sid: AC }));
    expect(e.digests.account).toMatch(/^[0-9a-f]{64}$/);
    expect((await buildSenderEvidence(healthyFake(), IDS, URL_IN)).digests).toEqual(e.digests);
  });

  it("reports a failing resource with its kind and still reads the others", async () => {
    const fake = healthyFake();
    fake.script("number", PN, new SenderReadError("timeout")).script("campaign", QE, new SenderReadError("not_found"));
    const e = await buildSenderEvidence(fake, IDS, URL_IN);
    expect(e.read_errors).toEqual(expect.arrayContaining([{ resource: "number", kind: "timeout" }, { resource: "campaign", kind: "not_found" }]));
    expect(e.read_errors).toHaveLength(2);
    expect(e.account).not.toBeNull();
    expect(e.service_number).not.toBeNull();
    expect(e.number).toBeNull();
    expect(e.brand).toBeNull(); // no campaign, so no brand to name
    expect(e.digests.number).toBeUndefined();
  });

  it("an unexpected exception is reported as unreadable", async () => {
    const fake = healthyFake();
    vi.spyOn(fake, "fetchAccount").mockRejectedValue(new Error("boom with secret"));
    const e = await buildSenderEvidence(fake, IDS, URL_IN);
    expect(e.read_errors).toContainEqual({ resource: "account", kind: "unreadable" });
    expect(JSON.stringify(e)).not.toContain("secret");
  });

  it("inbound_route_ok: service-level URL when the service handles inbound", async () => {
    expect((await buildSenderEvidence(healthyFake(), IDS, URL_IN)).service!.inbound_route_ok).toBe(true);
    expect((await buildSenderEvidence(healthyFake({ service: { inbound_request_url: "https://evil.example/x" } }), IDS, URL_IN)).service!.inbound_route_ok).toBe(false);
    expect((await buildSenderEvidence(healthyFake({ service: { inbound_request_url: null } }), IDS, URL_IN)).service!.inbound_route_ok).toBe(false);
  });

  it("inbound_route_ok: number-level URL when the number handles inbound", async () => {
    const on = { use_inbound_webhook_on_number: true, inbound_request_url: "https://ignored.example" };
    expect((await buildSenderEvidence(healthyFake({ service: on, number: { sms_url: URL_IN } }), IDS, URL_IN)).service!.inbound_route_ok).toBe(true);
    expect((await buildSenderEvidence(healthyFake({ service: on, number: { sms_url: "https://other.example" } }), IDS, URL_IN)).service!.inbound_route_ok).toBe(false);
    expect((await buildSenderEvidence(healthyFake({ service: { ...on, inbound_request_url: URL_IN }, number: { sms_url: null } }), IDS, URL_IN)).service!.inbound_route_ok).toBe(false);
  });
});

describe("expectedInboundUrl", () => {
  it("is the app origin plus the inbound route, and null without an origin", () => {
    expect(expectedInboundUrl({ NEXT_PUBLIC_APP_URL: "https://www.idanceflow.com/" })).toBe(URL_IN);
    expect(expectedInboundUrl({})).toBeNull();
  });
});

describe("RealSenderReadProvider", () => {
  const TOKEN = "super-secret-subaccount-token";
  function tokens(overrides: Partial<SenderTokenProvider> = {}): SenderTokenProvider {
    return {
      tokenFor: vi.fn(async () => new RedactedSecret(TOKEN)),
      refresh: vi.fn(async () => ({ secret: new RedactedSecret("rotated"), changed: true })),
      ...overrides,
    };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("signs each read with the subaccount's SID and token against the exact URLs", async () => {
    const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockImplementation(async () => json(200, { sid: "x", capabilities: { sms: true }, extra_raw_field: "must not survive" }));
    const p = new RealSenderReadProvider(tokens(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    await p.fetchAccount(AC);
    await p.fetchService(AC, MG);
    await p.fetchCampaign(AC, MG, QE);
    await p.fetchBrand(AC, BN);
    const number = await p.fetchNumber(AC, PN);
    await p.fetchServiceNumber(AC, MG, PN);
    const calls = fetchImpl.mock.calls;
    expect(calls.map((c) => c[0])).toEqual([
      `https://api.twilio.com/2010-04-01/Accounts/${AC}.json`,
      `https://messaging.twilio.com/v1/Services/${MG}`,
      `https://messaging.twilio.com/v1/Services/${MG}/Compliance/Usa2p/${QE}`,
      `https://messaging.twilio.com/v1/a2p/BrandRegistrations/${BN}`,
      `https://api.twilio.com/2010-04-01/Accounts/${AC}/IncomingPhoneNumbers/${PN}.json`,
      `https://messaging.twilio.com/v1/Services/${MG}/PhoneNumbers/${PN}`,
    ]);
    for (const [, init] of calls) {
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${AC}:${TOKEN}`).toString("base64")}`);
    }
    expect(number.sms_capable).toBe(true);
    expect(JSON.stringify(number)).not.toContain("extra_raw_field");
  });

  it("refreshes the token once on 401 and retries; a second 401 or an unchanged token is forbidden", async () => {
    const t = tokens();
    const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { sid: AC, status: "active" }));
    const ok = await new RealSenderReadProvider(t, { fetchImpl: fetchImpl as unknown as typeof fetch }).fetchAccount(AC);
    expect(ok).toEqual({ sid: AC, status: "active" });
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[1][1].headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${AC}:rotated`).toString("base64")}`);

    const twice = vi.fn(async () => json(401, {}));
    await expect(new RealSenderReadProvider(tokens(), { fetchImpl: twice as unknown as typeof fetch }).fetchAccount(AC)).rejects.toMatchObject({ kind: "forbidden" });
    expect(twice).toHaveBeenCalledTimes(2);
    const same = vi.fn(async () => json(401, {}));
    await expect(new RealSenderReadProvider(tokens({ refresh: async () => ({ secret: new RedactedSecret(TOKEN), changed: false }) }), { fetchImpl: same as unknown as typeof fetch }).fetchAccount(AC)).rejects.toMatchObject({ kind: "forbidden" });
    expect(same).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, "not_found"], [403, "forbidden"], [429, "rate_limited"], [500, "server"], [503, "server"], [400, "unreadable"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const p = new RealSenderReadProvider(tokens(), { fetchImpl: (async () => json(status, {})) as unknown as typeof fetch });
    await expect(p.fetchService(AC, MG)).rejects.toMatchObject({ kind });
  });

  it("maps network, timeout, bad JSON, non-object and missing credentials; never leaks the token", async () => {
    const mk = (fetchImpl: unknown, t = tokens()) => new RealSenderReadProvider(t, { fetchImpl: fetchImpl as typeof fetch });
    await expect(mk(async () => { throw new TypeError("connect ECONNREFUSED " + TOKEN); }).fetchAccount(AC)).rejects.toMatchObject({ kind: "network", message: "sender read failed: network" });
    await expect(mk(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }).fetchAccount(AC)).rejects.toMatchObject({ kind: "timeout" });
    await expect(mk(async () => new Response("not json", { status: 200 })).fetchAccount(AC)).rejects.toMatchObject({ kind: "unreadable" });
    await expect(mk(async () => json(200, [1])).fetchAccount(AC)).rejects.toMatchObject({ kind: "unreadable" });
    await expect(mk(async () => json(200, {}), tokens({ tokenFor: async () => { throw new Error("nope"); } })).fetchAccount(AC)).rejects.toMatchObject({ kind: "credentials_unavailable" });
    await expect(mk(async () => json(200, {})).fetchService(AC, "MGbad")).rejects.toMatchObject({ kind: "unreadable" });
  });
});

describe("gating and provider selection", () => {
  const prod = { VERCEL_ENV: "production", NODE_ENV: "production", SMS_SENDER_VERIFY_READS: "on" };
  const t: SenderTokenProvider = { tokenFor: async () => new RedactedSecret("x"), refresh: async () => ({ secret: new RedactedSecret("y"), changed: true }) };
  it("real reads need a production deployment, a production build and the switch", () => {
    expect(senderVerifyReadsAllowed(prod).allowed).toBe(true);
    expect(senderVerifyReadsAllowed({ ...prod, VERCEL_ENV: "preview" }).allowed).toBe(false);
    expect(senderVerifyReadsAllowed({ ...prod, NODE_ENV: "development" }).allowed).toBe(false);
    expect(senderVerifyReadsAllowed({ ...prod, SMS_SENDER_VERIFY_READS: "" }).allowed).toBe(false);
    expect(senderVerifyReadsAllowed({ ...prod, SMS_SENDER_VERIFY_READS: undefined, TW4_ISV_REAL_CALLS: "on" }).allowed).toBe(false);
  });
  it("selects real only when gated and given tokens; the fake only where the fake adapter is allowed", () => {
    expect(senderReadProviderFromEnv(prod, t)).toBeInstanceOf(RealSenderReadProvider);
    expect(senderReadProviderFromEnv(prod, null)).toBeNull();
    expect(senderReadProviderFromEnv({ NODE_ENV: "development" }, t)).toBeNull();
    const local = senderReadProviderFromEnv({ NODE_ENV: "development", TW4_ISV_FAKE: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }, null);
    expect(local).toBeInstanceOf(FakeSenderReadProvider);
    expect(senderReadProviderFromEnv({ ...prod, TW4_ISV_FAKE: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }, t)).toBeInstanceOf(RealSenderReadProvider);
  });
});

describe("verifySender / reverifyDueSenders", () => {
  const row: SenderOverviewRow = {
    studioId: STUDIO, legalEntityId: "e", senderId: SENDER, status: "pending", accountSid: AC, messagingServiceSid: MG, campaignSid: QE, phoneNumberSid: PN,
    senderE164: E164, recordedAt: null, verificationOutcome: null, verificationCode: null, verifiedAt: null, verificationSource: null, ready: false,
  };
  function admin(handlers: Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = { rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return handlers[name]?.(args) ?? { data: null, error: { code: "x" } }; } };
    return { client: client as unknown as SupabaseClient, calls };
  }

  it("sends server-built evidence to the database with the fake or real source and returns the database's outcome", async () => {
    const a = admin({ tw4_sender_verify: () => ({ data: { outcome: "verified", code: null }, error: null }) });
    const r = await verifySender(a.client, healthyFake(), { studioId: STUDIO, senderId: SENDER, actorId: ACTOR, attestedOptOut: true, sender: row, inboundUrl: URL_IN });
    expect(r).toEqual({ outcome: "verified", code: null });
    const args = a.calls[0].args;
    expect(args).toMatchObject({ p_studio_id: STUDIO, p_sender_id: SENDER, p_actor: ACTOR, p_attested_opt_out: true, p_source: "fake" });
    expect((args.p_evidence as { service: { inbound_route_ok: boolean } }).service.inbound_route_ok).toBe(true);

    const real = new RealSenderReadProvider({ tokenFor: async () => new RedactedSecret("t"), refresh: async () => ({ secret: new RedactedSecret("t"), changed: false }) }, { fetchImpl: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch });
    const b = admin({ tw4_sender_verify: () => ({ data: { outcome: "failed", code: "read_not_found:account" }, error: null }) });
    expect(await verifySender(b.client, real, { studioId: STUDIO, senderId: SENDER, actorId: ACTOR, attestedOptOut: false, sender: row, inboundUrl: URL_IN })).toEqual({ outcome: "failed", code: "read_not_found:account" });
    expect(b.calls[0].args.p_source).toBe("provider_read");
    expect(b.calls[0].args.p_attested_opt_out).toBe(false);
  });

  it("refuses a stale sender id, an incomplete row, a missing app URL and a database rejection", async () => {
    const a = admin({ tw4_sender_overview: () => ({ data: [], error: null }), tw4_sender_verify: () => ({ data: null, error: { code: "40001" } }) });
    const base = { studioId: STUDIO, senderId: SENDER, actorId: ACTOR, attestedOptOut: true, inboundUrl: URL_IN };
    expect(await verifySender(a.client, healthyFake(), { ...base, sender: { ...row, senderId: "other" } })).toEqual({ outcome: "error", code: "sender_not_current" });
    expect(await verifySender(a.client, healthyFake(), { ...base, sender: { ...row, campaignSid: null } })).toEqual({ outcome: "error", code: "sender_incomplete" });
    expect(await verifySender(a.client, healthyFake(), { ...base, sender: row, inboundUrl: null })).toEqual({ outcome: "error", code: "app_url_not_configured" });
    expect(await verifySender(a.client, healthyFake(), base)).toEqual({ outcome: "error", code: "sender_unreadable" });
    expect(await verifySender(a.client, healthyFake(), { ...base, sender: row })).toEqual({ outcome: "error", code: "verify_rejected" });
  });

  it("re-verifies every due sender, never stops on one failure, and counts outcomes", async () => {
    const due = [1, 2, 3, 4].map((n) => ({ studio_id: `s${n}`, sender_id: `x${n}`, account_sid: AC, messaging_service_sid: MG, campaign_sid: QE, phone_number_sid: PN, sender_e164: E164 }));
    const answers = [{ outcome: "verified" }, { outcome: "failed", code: "c" }, { outcome: "inconclusive", code: "d" }];
    let i = 0;
    const a = admin({
      tw4_sender_due_reverify: () => ({ data: due, error: null }),
      tw4_sender_reverify_run: () => {
        const n = i++;
        if (n === 3) throw new Error("db down");
        return { data: answers[n], error: null };
      },
    });
    const counts = await reverifyDueSenders(a.client, healthyFake(), { runId: "run-1", limit: 10, inboundUrl: URL_IN });
    expect(counts).toEqual({ due: 4, verified: 1, failed: 1, inconclusive: 1, skipped: 0, errors: 1, truncated: false });
    expect(a.calls.filter((c) => c.name === "tw4_sender_reverify_run")).toHaveLength(4);
    expect(a.calls[0].args).toEqual({ p_limit: 10 });
    expect(a.calls[1].args).toMatchObject({ p_run_id: "run-1", p_source: "fake", p_studio_id: "s1", p_sender_id: "x1" });
  });
});
