import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import { STRIPE_API_VERSION } from "../../d24-m3d-proof/config";
import { checkConnectedAccount } from "../../d24-m3d-proof/identity";
import type { ProofRequest } from "../../d24-m3d-proof/types";
import { AUTHORIZATION_PHRASE, ENV, PROVISION_API_VERSION, PROVISION_HARD_CALL_CAP, ProvisionAbort, allowProblem, buildCreateRequest, createFakeProvisionTransport, runProvision } from "../provision";
import { liveRefusals, main } from "../run";

const PLATFORM = "acct_FAKEPLATFORM01";
const ENVREF = "D24-ENV-20261108-abcdef123456";
const IDEM = "d24prov-0123456789abcdef0123";
const KEY = ["rk", "test", "abcdefghijklmnop1234"].join("_"); // built at run time: no key-shaped literal in the source
const REPO = join(__dirname, "..", "..", "..", "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "d24prov-"));
  dirs.push(d);
  return d;
};

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

describe("cannot run live without the owner envelope", () => {
  const good = { [ENV.key]: KEY, [ENV.platform]: PLATFORM, [ENV.envelope]: ENVREF, [ENV.phrase]: AUTHORIZATION_PHRASE };
  it("refuses with an empty environment and sends nothing", async () => {
    const f = createFakeProvisionTransport({ platformId: PLATFORM });
    const err: string[] = [];
    const code = await main(["--live"], {}, { out: () => {}, err: (s) => err.push(s) }, { transport: f.transport, repoRoot: REPO });
    expect(code).toBe(3);
    expect(f.calls).toHaveLength(0);
    expect(err.join("\n")).toMatch(/envelope reference/);
  });
  it.each([ENV.envelope, ENV.phrase, ENV.key, ENV.platform, ENV.evidenceDir])("refuses when %s alone is missing", (name) => {
    const env: Record<string, string | undefined> = { ...good, [ENV.evidenceDir]: tmp() };
    delete env[name];
    expect(liveRefusals(env, REPO).length).toBeGreaterThan(0);
  });
  it("refuses a malformed envelope reference and an evidence dir inside the repo", () => {
    expect(liveRefusals({ ...good, [ENV.envelope]: "D24-ENV-x", [ENV.evidenceDir]: tmp() }, REPO).join(" ")).toMatch(/envelope/);
    expect(liveRefusals({ ...good, [ENV.evidenceDir]: join(REPO, "evidence") }, REPO).join(" ")).toMatch(/outside|inside/);
  });
  it("refuses proxy environment like the proof", () => {
    expect(liveRefusals({ ...good, [ENV.evidenceDir]: tmp(), HTTPS_PROXY: "http://x" }, REPO).join(" ")).toMatch(/HTTPS_PROXY/);
  });
  it("with everything supplied it uses the injected fake, writes evidence outside git, and never prints the key or the full account id", async () => {
    const dir = tmp();
    const f = createFakeProvisionTransport({ platformId: PLATFORM });
    const out: string[] = [];
    const code = await main(["--live"], { ...good, [ENV.evidenceDir]: dir }, { out: (s) => out.push(s), err: (s) => out.push(s) }, { transport: f.transport, repoRoot: REPO, newIdempotencyKey: () => IDEM });
    expect(out.join("\n")).not.toContain(KEY);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).not.toContain("acct_FAKEPROVISION01");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const body = readFileSync(join(dir, files[0]), "utf8");
    expect(body).toContain("acct_FAKEPROVISION01");
    expect(body).not.toContain(KEY);
    expect(body).not.toContain(IDEM);
  });
  it("--plan and --dry-run need nothing and make no network call", async () => {
    const out: string[] = [];
    expect(await main(["--plan"], {}, { out: (s) => out.push(s), err: () => {} })).toBe(0);
    expect(await main(["--dry-run"], {}, { out: (s) => out.push(s), err: () => {} })).toBe(0);
    expect(await main(["--plan", "--live"], {}, { out: () => {}, err: () => {} })).toBe(2);
    expect(await main(["x"], {}, { out: () => {}, err: () => {} })).toBe(2);
  });
});
