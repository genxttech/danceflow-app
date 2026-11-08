import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeTransport } from "../../d24-m3d-proof/transport";
import type { ProofRequest, Transport } from "../../d24-m3d-proof/types";
import { PROOF_KEY_ENV, SUMMARY_ENV, main, preconditionProblem } from "../live";
import { AUTHORIZATION_PHRASE, ENV, PROVISION_API_VERSION, buildCreateRequest, createFakeProvisionTransport } from "../provision";

const PLATFORM = "acct_SANDBOXPLATFORM01";
const KEY = "rk_test_unitTestKeyOnly0000";
const REF = "D24-ENV-20261109-12345678901";

function env(over: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "d24prov-"));
  const summary = join(dir, "summary.md");
  const e: Record<string, string | undefined> = {
    [ENV.key]: KEY,
    [ENV.platform]: PLATFORM,
    [ENV.phrase]: AUTHORIZATION_PHRASE,
    [ENV.envelope]: REF,
    [SUMMARY_ENV]: summary,
    ...over,
  };
  return { e, summary };
}
const io = () => {
  const lines: string[] = [];
  return { io: { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s) }, lines };
};
const never: Transport = async () => {
  throw new Error("transport must not be called");
};

describe("live entry: refuses before any request", () => {
  const cases: Array<[string, string[], Record<string, string | undefined>]> = [
    ["no argument", [], {}],
    ["an extra argument", ["--live", "x"], {}],
    ["--dry-run is not live", ["--dry-run"], {}],
    ["wrong authorization sentence", ["--live"], { [ENV.phrase]: "yes" }],
    ["missing authorization sentence", ["--live"], { [ENV.phrase]: undefined }],
    ["placeholder platform id", ["--live"], { [ENV.platform]: "acct_PLACEHOLDERPLATFORM" }],
    ["malformed platform id", ["--live"], { [ENV.platform]: "platform" }],
    ["malformed run reference", ["--live"], { [ENV.envelope]: "nope" }],
    ["missing key", ["--live"], { [ENV.key]: undefined }],
    ["a live restricted key", ["--live"], { [ENV.key]: "rk_live_notReal0000000000" }],
    ["a secret key", ["--live"], { [ENV.key]: "sk_test_notRestricted0000" }],
    ["the proof key present in the process", ["--live"], { [PROOF_KEY_ENV]: "rk_test_otherKey0000000000" }],
    ["any variable that looks like a live key", ["--live"], { SOME_OTHER: "sk_live_abcdef0123456789" }],
    ["no summary file", ["--live"], { [SUMMARY_ENV]: undefined }],
  ];
  it.each(cases)("%s -> exit 2 and the transport is never built or called", async (_n, argv, over) => {
    const { e } = env(over);
    const { io: i, lines } = io();
    const code = await main(argv, e, i, { transport: never });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("REFUSED before any request");
    expect(lines.join("\n")).not.toContain(KEY);
  });
  it("the refusal never echoes a key", () => {
    const p = preconditionProblem(["--live"], { ...env().e, [ENV.key]: "rk_live_SECRETVALUE123456" });
    expect(p).not.toContain("SECRETVALUE");
  });
});

describe("live entry: the happy path through the fake", () => {
  it("sends exactly the three allowed requests and writes a non-secret summary", async () => {
    const { e, summary } = env();
    const fake = createFakeProvisionTransport({ platformId: PLATFORM, createdId: "acct_NEWEXPRESS0001" });
    const { io: i, lines } = io();
    const code = await main(["--live"], e, i, { transport: fake.transport, newIdempotencyKey: () => "d24prov-0123456789abcdef0123456789" });
    expect(code).toBe(0);
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/account", "POST /v1/accounts", "GET /v1/accounts/acct_NEWEXPRESS0001"]);
    const text = readFileSync(summary, "utf8");
    expect(text).toContain("PROVISIONED AND VERIFIED");
    expect(text).toContain("acct_NEWEXPRESS0001");
    expect(text).toContain(REF);
    expect(text).toContain("losses.payments");
    for (const secret of [KEY, "d24prov-0123456789abcdef0123456789", "Bearer"]) expect(text + lines.join("\n")).not.toContain(secret);
  });
  it("the create it sends is the production Express body plus the three markers, carrying the run reference", async () => {
    const { e } = env();
    const fake = createFakeProvisionTransport({ platformId: PLATFORM });
    await main(["--live"], e, io().io, { transport: fake.transport });
    const create = fake.calls.find((c) => c.method === "POST") as ProofRequest;
    expect(create.stripeVersion).toBe(PROVISION_API_VERSION);
    expect(create.body).toEqual(buildCreateRequest({ envelopeRef: REF, idempotencyKey: "x" }).body);
    expect(create.stripeAccount).toBeUndefined();
  });
});

describe("live entry: aborts are reported, never retried", () => {
  it("a platform that is not the pinned sandbox aborts before the create", async () => {
    const { e, summary } = env();
    const fake = createFakeProvisionTransport({ platformId: "acct_SOMEOTHERPLATFORM" });
    const code = await main(["--live"], e, io().io, { transport: fake.transport });
    expect(code).toBe(1);
    expect(fake.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(readFileSync(summary, "utf8")).toContain("ABORTED");
  });
  it("a lost create is not retried and the summary says so", async () => {
    const { e, summary } = env();
    const fake = createFakeProvisionTransport({ platformId: PLATFORM, throwOnCreate: true });
    const code = await main(["--live"], e, io().io, { transport: fake.transport });
    expect(code).toBe(1);
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(readFileSync(summary, "utf8")).toContain("transport_error");
  });
  it("an account that is not Express-equivalent (the old negative shape) is rejected by the proof's gate", async () => {
    const { e, summary } = env();
    const old = { type: "application", is_controller: true, stripe_dashboard: { type: "express" }, requirement_collection: "stripe", losses: { payments: "stripe" }, fees: { payer: "account" } };
    const fake = createFakeProvisionTransport({ platformId: PLATFORM, accountType: "none", controller: old });
    const code = await main(["--live"], e, io().io, { transport: fake.transport });
    expect(code).toBe(1);
    expect(readFileSync(summary, "utf8")).toContain("observed_mismatch");
  });
  it("livemode:true aborts", async () => {
    const { e } = env();
    const fake = createFakeProvisionTransport({ platformId: PLATFORM, livemode: true });
    expect(await main(["--live"], e, io().io, { transport: fake.transport })).toBe(1);
  });
});

describe("the live file is the only place a real transport is wired", () => {
  const dir = join(__dirname, "..");
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  it("run.ts and provision.ts still have no path to a real transport (run.ts --live stays refused)", () => {
    for (const f of ["run.ts", "provision.ts"]) for (const bad of ["createNodeTransport", "node:https", "node:http", "d24-m3d-proof/transport"]) expect(read(f), `${f} ${bad}`).not.toContain(bad);
  });
  it("live.ts uses the proof's pinned-origin transport and nothing else on the network", () => {
    const src = read("live.ts");
    expect(src).toContain("createNodeTransport()");
    for (const bad of ["fetch(", "node:https", "node:http", "node:net", "node:child_process", "XMLHttpRequest", "process.env["]) expect(src, bad).not.toContain(bad);
  });
  it("only live.ts and the reconcile CLI (if any) import the transport module", () => {
    const importers = readdirSync(dir).filter((f) => f.endsWith(".ts") && /d24-m3d-proof\/transport/.test(read(f)));
    expect(importers).toEqual(["live.ts"]);
  });
  it("the transport refuses any origin other than api.stripe.com", () => {
    expect(() => createNodeTransport({ origin: "https://example.com" })).toThrow();
  });
});
