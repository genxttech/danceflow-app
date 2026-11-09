import { readFileSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { STRIPE_API_VERSION } from "../../d24-m3d-proof/config";
import { checkConnectedAccount } from "../../d24-m3d-proof/identity";
import type { ProofRequest } from "../../d24-m3d-proof/types";
import { AUTHORIZATION_PHRASE, ENV, PROVISION_API_VERSION, PROVISION_HARD_CALL_CAP, ProvisionAbort, allowProblem, buildCreateRequest, createFakeProvisionTransport, runProvision } from "../provision";
import { main } from "../run";

const PLATFORM = "acct_FAKEPLATFORM01";
const ENVREF = "D24-ENV-20261108-abcdef123456";
const IDEM = "d24prov-0123456789abcdef0123";
const KEY = ["rk", "test", "abcdefghijklmnop1234"].join("_"); // built at run time: no key-shaped literal in the source
const REPO = join(__dirname, "..", "..", "..", "..");

const run = (transport: ReturnType<typeof createFakeProvisionTransport>["transport"], over: Partial<Parameters<typeof runProvision>[0]> = {}) =>
  runProvision({ transport, apiKey: KEY, expectPlatformAcct: PLATFORM, envelopeRef: ENVREF, idempotencyKey: IDEM, ...over });

describe("pins and production equivalence", () => {
  it("API version equals the proof pin and the installed SDK default", () => {
    expect(PROVISION_API_VERSION).toBe(STRIPE_API_VERSION);
    expect((Stripe as unknown as { API_VERSION: string }).API_VERSION).toBe(PROVISION_API_VERSION);
  });
  it("the create body is the production onboarding shape (route.ts) plus fixture markers only", () => {
    const route = readFileSync(join(REPO, "src/app/api/stripe/connect/onboarding/route.ts"), "utf8");
    expect(route).toMatch(/stripe\.accounts\.create\(\{\s*type: "express",\s*capabilities: \{\s*card_payments: \{ requested: true \},\s*transfers: \{ requested: true \},\s*\},\s*metadata: \{\s*studioId,/);
    const body = buildCreateRequest({ envelopeRef: ENVREF, idempotencyKey: IDEM }).body!;
    expect(Object.keys(body).sort()).toEqual(["capabilities[card_payments][requested]", "capabilities[transfers][requested]", "metadata[d24_envelope_ref]", "metadata[d24_fixture_role]", "metadata[d24_proof_fixture]", "type"]);
    expect(body.type).toBe("express");
    expect(Object.keys(body).some((k) => /country|business_type|controller|email/.test(k))).toBe(false);
  });
});

describe("flow against the fake", () => {
  it("makes exactly three calls: platform read, one create, one readback; no Stripe-Account", async () => {
    const f = createFakeProvisionTransport({ platformId: PLATFORM });
    const r = await run(f.transport);
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/account", "POST /v1/accounts", "GET /v1/accounts/acct_FAKEPROVISION01"]);
    expect(f.calls.length).toBeLessThanOrEqual(PROVISION_HARD_CALL_CAP);
    expect(f.calls.every((c) => c.stripeAccount === undefined && c.stripeVersion === PROVISION_API_VERSION)).toBe(true);
    expect(f.calls[1].idempotencyKey).toBe(IDEM);
    expect(r.accountId).toBe("acct_FAKEPROVISION01");
    expect(r.observedController["controller.fees.payer"]).toBe("application_express");
    expect(JSON.stringify(r)).not.toContain(IDEM); // only a hash of the key is kept
  });
  it("accepts a controller-model Express account (type none) that is exactly Express-equivalent", async () => {
    const f = createFakeProvisionTransport({ platformId: PLATFORM, accountType: "none" });
    await expect(run(f.transport)).resolves.toMatchObject({ facts: { model: "controller_express" } });
  });
  it("aborts BEFORE the create when the platform is not the pinned sandbox", async () => {
    const f = createFakeProvisionTransport({ platformId: "acct_SOMEONEELSE99" });
    await expect(run(f.transport)).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(f.calls.map((c) => c.method)).toEqual(["GET"]);
  });
  it("rejects the OLD mismatched account (negative fixture shape) via the proof's unchanged gate", async () => {
    const old = { type: "application", is_controller: true, stripe_dashboard: { type: "express" }, requirement_collection: "stripe", losses: { payments: "stripe" }, fees: { payer: "account" } };
    expect(checkConnectedAccount({ type: "none", controller: old })).toMatchObject({ ok: false });
    const f = createFakeProvisionTransport({ platformId: PLATFORM, accountType: "none", controller: old });
    await expect(run(f.transport)).rejects.toMatchObject({ code: "observed_mismatch" });
  });
  it("rejects losses.payments or fees.payer variants one by one", () => {
    const base = { type: "application", is_controller: true, stripe_dashboard: { type: "express" }, requirement_collection: "stripe", losses: { payments: "application" }, fees: { payer: "application" } };
    expect(checkConnectedAccount({ type: "none", controller: base })).toMatchObject({ ok: true });
    expect(checkConnectedAccount({ type: "none", controller: { ...base, losses: { payments: "stripe" } } })).toMatchObject({ ok: false });
    expect(checkConnectedAccount({ type: "none", controller: { ...base, fees: { payer: "account" } } })).toMatchObject({ ok: false });
  });
  it("never retries a lost create", async () => {
    const f = createFakeProvisionTransport({ platformId: PLATFORM, throwOnCreate: true });
    const err = (await run(f.transport).catch((e) => e)) as ProvisionAbort;
    expect(err).toMatchObject({ code: "transport_error" });
    expect(String(err.message)).toMatch(/do NOT retry/);
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
  it("a 500 on create aborts without a readback", async () => {
    const f = createFakeProvisionTransport({ platformId: PLATFORM, createStatus: 500 });
    await expect(run(f.transport)).rejects.toMatchObject({ code: "unexpected_status" });
    expect(f.calls).toHaveLength(2);
  });
  it("aborts on livemode:true and on a different reported API version", async () => {
    await expect(run(createFakeProvisionTransport({ platformId: PLATFORM, livemode: true }).transport)).rejects.toMatchObject({ code: "livemode_true" });
    const f = createFakeProvisionTransport({ platformId: PLATFORM });
    const wrapped: typeof f.transport = async (req, key) => ({ ...(await f.transport(req, key)), stripeVersion: "2020-08-27" });
    await expect(run(wrapped)).rejects.toMatchObject({ code: "version_mismatch" });
  });
  it("refuses a non-restricted or live key before any call", async () => {
    const f = createFakeProvisionTransport({ platformId: PLATFORM });
    for (const k of [["sk", "test", "abcdefghijklmnop1234"].join("_"), ["rk", "live", "abcdefghijklmnop1234"].join("_")]) {
      await expect(run(f.transport, { apiKey: k })).rejects.toBeInstanceOf(ProvisionAbort);
    }
    expect(f.calls).toHaveLength(0);
  });
});

describe("allow-list is default deny", () => {
  const ok = { platformId: PLATFORM as string | null, createdId: "acct_FAKEPROVISION01" as string | null, createSent: true };
  const v = PROVISION_API_VERSION;
  const create = () => buildCreateRequest({ envelopeRef: ENVREF, idempotencyKey: IDEM });
  const refused: Array<[string, ProofRequest, Partial<typeof ok>]> = [
    ["DELETE account", { method: "DELETE", path: "/v1/accounts/acct_FAKEPROVISION01", stripeVersion: v }, {}],
    ["update account", { method: "POST", path: "/v1/accounts/acct_FAKEPROVISION01", stripeVersion: v, body: { "metadata[x]": "y" } }, {}],
    ["account link", { method: "POST", path: "/v1/account_links", stripeVersion: v, body: { account: "acct_FAKEPROVISION01" } }, {}],
    ["login link", { method: "POST", path: "/v1/accounts/acct_FAKEPROVISION01/login_links", stripeVersion: v }, {}],
    ["balance", { method: "GET", path: "/v1/balance", stripeVersion: v }, {}],
    ["readback of another account", { method: "GET", path: "/v1/accounts/acct_OTHERACCOUNT01", stripeVersion: v }, {}],
    ["readback before any create", { method: "GET", path: "/v1/accounts/acct_FAKEPROVISION01", stripeVersion: v }, { createdId: null }],
    ["Stripe-Account header", { method: "GET", path: "/v1/account", stripeVersion: v, stripeAccount: "acct_FAKEPROVISION01" }, {}],
    ["query string", { method: "GET", path: "/v1/account", stripeVersion: v, query: { a: "b" } }, {}],
    ["missing version", { method: "GET", path: "/v1/account" }, {}],
    ["second create", create(), {}],
    ["create before platform verified", create(), { platformId: null, createSent: false }],
    ["create with extra controller key", { ...create(), body: { ...create().body!, "controller[fees][payer]": "application" } }, { createSent: false }],
    ["create without idempotency key", { ...create(), idempotencyKey: undefined }, { createSent: false }],
    ["create with bad envelope ref", buildCreateRequest({ envelopeRef: "nope", idempotencyKey: IDEM }), { createSent: false }],
  ];
  it.each(refused)("refuses %s", (_n, req, over) => {
    expect(allowProblem(req, { ...ok, ...over })).not.toBeNull();
  });
  it("permits the single create when the platform is verified", () => {
    expect(allowProblem(create(), { platformId: PLATFORM, createdId: null, createSent: false })).toBeNull();
  });
});

describe("controller-model variant (legacy Express direct charges are blocked for new platforms)", () => {
  const ctl = () => buildCreateRequest({ envelopeRef: ENVREF, idempotencyKey: IDEM, variant: "controller_express" });
  const st = { platformId: PLATFORM as string | null, createdId: null as string | null, createSent: false };
  type Body = Record<string, string>;
  it("sends the Stripe-documented Express-dashboard controller properties and no type", () => {
    const b = ctl().body as Body;
    expect(b).not.toHaveProperty("type");
    expect(Object.fromEntries(Object.entries(b).filter(([k]) => k.startsWith("controller[")))).toEqual({ "controller[stripe_dashboard][type]": "express", "controller[requirement_collection]": "stripe", "controller[losses][payments]": "application", "controller[fees][payer]": "application" });
    expect(b["capabilities[card_payments][requested]"]).toBe("true");
    expect(b["capabilities[transfers][requested]"]).toBe("true");
    expect(b["metadata[d24_fixture_role]"]).toBe("express_controller_equivalent");
  });
  it("is permitted, and the original legacy body is still permitted", () => {
    expect(allowProblem(ctl(), st)).toBeNull();
    expect(allowProblem(buildCreateRequest({ envelopeRef: ENVREF, idempotencyKey: IDEM }), st)).toBeNull();
  });
  it.each([
    ["type mixed with controller keys", (b: Body) => ({ ...b, type: "express" })],
    ["fees payer account", (b: Body) => ({ ...b, "controller[fees][payer]": "account" })],
    ["losses stripe", (b: Body) => ({ ...b, "controller[losses][payments]": "stripe" })],
    ["dashboard full", (b: Body) => ({ ...b, "controller[stripe_dashboard][type]": "full" })],
    ["an extra key (country)", (b: Body) => ({ ...b, country: "US" })],
    ["an extra controller key", (b: Body) => ({ ...b, "controller[fees][include_stripe_fees]": "x" })],
  ])("refuses %s", (_n, mut) => {
    const r = ctl();
    expect(allowProblem({ ...r, body: mut(r.body as Body) }, st)).not.toBeNull();
  });
  it("refuses a controller body carrying the legacy role marker (and vice versa)", () => {
    const r = ctl();
    expect(allowProblem({ ...r, body: { ...(r.body as Body), "metadata[d24_fixture_role]": "express_prod_equivalent" } }, st)).not.toBeNull();
    const l = buildCreateRequest({ envelopeRef: ENVREF, idempotencyKey: IDEM });
    expect(allowProblem({ ...l, body: { ...(l.body as Body), "metadata[d24_fixture_role]": "express_controller_equivalent" } }, st)).not.toBeNull();
  });
  it("the whole flow against the faithful fake: three calls, a controller-model (type none) account, accepted by the unchanged proof gate", async () => {
    const f = createFakeProvisionTransport({ platformId: PLATFORM });
    const r = await runProvision({ transport: f.transport, apiKey: KEY, expectPlatformAcct: PLATFORM, envelopeRef: ENVREF, idempotencyKey: IDEM, variant: "controller_express" });
    expect(f.calls).toHaveLength(3);
    expect(r.facts.model).toBe("controller_express");
    expect(r.observedController["account.type"]).toBe("none");
    expect(r.observedController["controller.fees.payer"]).toBe("application");
  });
  it("rejects a legacy express account coming back from a controller-variant request", async () => {
    const f = createFakeProvisionTransport({ platformId: PLATFORM, accountType: "express" });
    await expect(runProvision({ transport: f.transport, apiKey: KEY, expectPlatformAcct: PLATFORM, envelopeRef: ENVREF, idempotencyKey: IDEM, variant: "controller_express" })).rejects.toThrow(/legacy Express/);
  });
});

describe("--live is permanently disabled", () => {
  const everything = { [ENV.key]: KEY, [ENV.platform]: PLATFORM, [ENV.envelope]: ENVREF, [ENV.phrase]: AUTHORIZATION_PHRASE, [ENV.evidenceDir]: "/somewhere" };
  it("exits 3 and never touches any transport, even with every variable set and a transport injected", async () => {
    const f = createFakeProvisionTransport({ platformId: PLATFORM });
    let envReads = 0;
    const env = new Proxy(everything as Record<string, string | undefined>, { get: (t, k) => { envReads += 1; return t[k as string]; } });
    const err: string[] = [];
    const out: string[] = [];
    const code = await main(["--live"], env, { out: (s) => out.push(s), err: (s) => err.push(s) }, { transport: f.transport });
    expect(code).toBe(3);
    expect(f.calls).toHaveLength(0);
    expect(envReads).toBe(0);
    expect(out).toHaveLength(0);
    expect(err.join("\n")).toMatch(/disabled/);
    expect(err.join("\n")).toMatch(/owner-signed envelope/);
    expect(err.join("\n")).not.toContain(KEY);
  });
  it("exits 3 with an empty environment too", async () => {
    expect(await main(["--live"], {}, { out: () => {}, err: () => {} })).toBe(3);
  });
  it("the CLI source has no path to a real transport, key, filesystem or network", () => {
    const src = readFileSync(join(__dirname, "..", "run.ts"), "utf8");
    for (const bad of ["createNodeTransport", "node:https", "node:http", "node:fs", "d24-m3d-proof/transport", "process.env[", "ENV.key"]) expect(src).not.toContain(bad);
    const prov = readFileSync(join(__dirname, "..", "provision.ts"), "utf8");
    expect(prov).not.toContain("createNodeTransport");
    expect(prov).not.toContain("node:https");
  });
  it("--plan and --dry-run need nothing and make no network call", async () => {
    const out: string[] = [];
    expect(await main(["--plan"], {}, { out: (s) => out.push(s), err: () => {} })).toBe(0);
    expect(await main(["--dry-run"], {}, { out: (s) => out.push(s), err: () => {} })).toBe(0);
    expect(out.join("\n")).toMatch(/cannot run live/);
    expect(await main(["--plan", "--live"], {}, { out: () => {}, err: () => {} })).toBe(2);
    expect(await main(["x"], {}, { out: () => {}, err: () => {} })).toBe(2);
  });
});
