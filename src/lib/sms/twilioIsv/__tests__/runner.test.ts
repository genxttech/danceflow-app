import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptEin } from "@/lib/sms/onboarding/ein";
import type { IsvConfig } from "../config";
import { FakeIsvAdapter } from "../fake";
import type { RunnerInputs } from "../payloads";
import { checkRegistrationStatus, classifyBundleStatus, classifyEvaluation, refreshBrandStatus, runBrandSubmission, safeFieldNames, STEPS, SUBMISSION_STEPS, type RunResult, type SubmissionStepKey } from "../runner";
import { describeOutcome } from "../outcomes";
import { RunnerStoreError } from "../store";
import { MemoryRunnerStore } from "./memoryStore";

const STUDIO = "a5700000-0000-4000-8000-00000000000a";
const OTHER_STUDIO = "a5700000-0000-4000-8000-00000000000b";
const ADMIN = "a5700000-0000-4000-8000-000000000401";
const PRIMARY = `BU${"e".repeat(32)}`;
const PRIMARY_POLICY = `RN${"4".repeat(32)}`;
const EIN_DIGITS = "987654321";

const config: IsvConfig = {
  accountSid: `AC${"1".repeat(32)}`, authToken: "t".repeat(32), primaryProfileSid: PRIMARY, primaryProfilePolicySid: PRIMARY_POLICY,
  secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms-compliance@isv.example", envName: "test", mockBrand: false,
};

const inputs = (over: Partial<RunnerInputs> = {}): RunnerInputs => ({
  studio_id: STUDIO, submission_seq: 1, state: "submitted_for_checks", studio_name: "E2E Studio", studio_slug: "confidance-studio", studio_public_name: null,
  legal_name: "ConfiDance Test LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: null,
  address_line1: "12 Harbor Way", address_line2: null, city: "Portland", region: "OR", postal_code: "97201", country: "US",
  rep_first_name: "Pat", rep_last_name: "Morgan", rep_title: "Owner", rep_position: "ceo", rep_email: "pat@confidance.example", rep_phone: "+15035550123",
  preferred_area_code: "503", ein_last4: "4321", missing: [], ...over,
});

let adapter: FakeIsvAdapter;
let store: MemoryRunnerStore;

function setup(over: Partial<RunnerInputs> = {}) {
  process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.SMS_EIN_ENCRYPTION_KEY_ID;
  adapter = new FakeIsvAdapter(PRIMARY, { captureSensitive: true, primaryPolicySid: PRIMARY_POLICY });
  const token = encryptEin(STUDIO, { digits: EIN_DIGITS, last4: "4321" }).ciphertext;
  store = new MemoryRunnerStore(inputs(over), token);
  store.platformAdmins.add(ADMIN);
}

const run = async (over: { confirmFee?: boolean; maxSteps?: number; config?: IsvConfig; studioId?: string; actorId?: string; confirmSubmit?: readonly SubmissionStepKey[] } = {}) => {
  // The production runner stops once at each submission so the admin can read the evaluation; these older tests want the whole journey,
  // so the helper plays the admin: it re-runs with the same confirmations after every "review" stop and merges the steps run.
  const merged: RunResult["stepsRun"] = [];
  let result!: RunResult;
  for (let pass = 0; pass < 4; pass++) {
    result = await runBrandSubmission({ store, adapter, config: over.config ?? config, studioId: over.studioId ?? STUDIO, actorId: over.actorId ?? ADMIN, confirmFee: over.confirmFee ?? true, maxSteps: over.maxSteps, confirmSubmit: over.confirmSubmit ?? ["S11", "T6"] });
    merged.push(...result.stepsRun);
    if (result.outcome !== "waiting_submission_confirmation" || !String(result.detail).endsWith(":review")) break;
  }
  return { ...result, stepsRun: merged };
};

beforeEach(() => setup());

describe("happy path", () => {
  it("runs every step in order, creates ONE paid brand, mirrors it, and lands in brand_pending", async () => {
    const result = await run();
    expect(result.outcome).toBe("brand_submitted");
    expect(result.stepsRun).toEqual(STEPS.map((step) => step.key));
    expect(adapter.count("createBrand")).toBe(1);
    expect(adapter.count("createCustomerProfile")).toBe(1);
    expect(adapter.count("createTrustProduct")).toBe(1);
    expect(store.state).toBe("brand_pending");
    expect(store.registration).toMatchObject({ brand_status: "in_review" });
    expect(store.ledger.every((row) => row.status === "succeeded")).toBe(true);
    expect(store.leaseOwner).toBeNull();
  });
  it("creates a STANDARD brand with automatic secondary vetting left on, and honors the mock-brand switch", async () => {
    await run();
    const call = adapter.calls.find((c) => c.method === "createBrand")!.input as { brandType: string; skipAutomaticSecVet: boolean; mock: boolean };
    expect(call).toMatchObject({ brandType: "STANDARD", skipAutomaticSecVet: false, mock: false });
    setup();
    await run({ config: { ...config, mockBrand: true } });
    expect((adapter.calls.find((c) => c.method === "createBrand")!.input as { mock: boolean }).mock).toBe(true);
  });
  it("the Primary ISV profile is checked first and assigned to the new profile; the compliance mailbox is the ISV's, not the studio's", async () => {
    await run();
    expect(adapter.calls[0].method).toBe("getCustomerProfile");
    expect((adapter.calls[0].input as { profileSid: string }).profileSid).toBe(PRIMARY);
    const profileSid = [...adapter.profiles.keys()].find((sid) => sid !== PRIMARY)!;
    expect(adapter.profiles.get(profileSid)!.assigned).toContain(PRIMARY);
    expect(adapter.profiles.get(profileSid)!.email).toBe("sms-compliance@isv.example");
    expect([...adapter.trustProducts.values()][0].email).toBe("sms-compliance@isv.example");
  });
  it("the brand is created only after the profile and the trust product were both submitted", async () => {
    await run();
    const order = adapter.calls.map((c) => c.method);
    expect(order.indexOf("submitCustomerProfile")).toBeLessThan(order.indexOf("createTrustProduct"));
    expect(order.indexOf("submitTrustProduct")).toBeLessThan(order.indexOf("createBrand"));
    expect(order.indexOf("evaluateCustomerProfile")).toBeLessThan(order.indexOf("submitCustomerProfile"));
  });
  it("a second run creates nothing again (every step skipped) and just reports the brand status", async () => {
    await run();
    const before = adapter.calls.length;
    const again = await run();
    expect(again.outcome).toBe("brand_in_review");
    expect(again.stepsRun).toEqual([]);
    const creates = adapter.calls.slice(before).map((c) => c.method).filter((m) => m.startsWith("create") || m.startsWith("assign") || m.startsWith("submit"));
    expect(creates).toEqual([]);
  });
});

describe("the fee gate", () => {
  it("without the platform confirmation it stops before the brand: nothing paid, no ledger row for B1", async () => {
    const result = await run({ confirmFee: false });
    expect(result.outcome).toBe("waiting_fee_confirmation");
    expect(adapter.count("createBrand")).toBe(0);
    expect(store.ledger.some((row) => row.step_key === "B1")).toBe(false);
    expect(store.state).toBe("profile_review");
  });
  it("the confirmation is recorded on the ledger with who gave it, and a later confirmed run creates the brand exactly once", async () => {
    await run({ confirmFee: false });
    const result = await run({ confirmFee: true });
    expect(result.outcome).toBe("brand_submitted");
    expect(store.ledger.find((row) => row.step_key === "B1")).toMatchObject({ fee_bearing: true, fee_confirmed_by: ADMIN });
    expect(adapter.count("createBrand")).toBe(1);
  });
});

describe("crash and retry safety", () => {
  it("a lost response on the profile create (Twilio created it, we saw an error) is reconciled by FriendlyName: no duplicate profile", async () => {
    adapter.failNext("createCustomerProfile", { kind: "transient", lostResponse: true });
    const first = await run();
    expect(first.outcome).toBe("retry_later");
    expect(store.ledger.find((row) => row.step_key === "S1")?.status).toBe("unknown_outcome");
    const second = await run();
    expect(second.outcome).toBe("brand_submitted");
    expect([...adapter.profiles.values()].filter((p) => p.friendlyName.includes(":S1:")).length).toBe(1);
    expect(adapter.count("createCustomerProfile")).toBe(1);
  });
  it("a transient failure BEFORE the create leaves nothing behind; the rerun reconciles (nothing found) and creates once", async () => {
    adapter.failNext("createCustomerProfile", { kind: "transient" });
    expect((await run()).outcome).toBe("retry_later");
    expect(adapter.profiles.size).toBe(1); // only the primary
    expect((await run()).outcome).toBe("brand_submitted");
    expect(adapter.count("createCustomerProfile")).toBe(2);
    expect([...adapter.profiles.keys()].length).toBe(2);
  });
  it("a lost response on the PAID brand create is adopted by linkage on the rerun: still exactly one brand", async () => {
    adapter.failNext("createBrand", { kind: "transient", lostResponse: true });
    expect((await run()).outcome).toBe("retry_later");
    expect(store.ledger.find((row) => row.step_key === "B1")?.status).toBe("unknown_outcome");
    const second = await run();
    expect(second.outcome).toBe("brand_submitted"); // adopted by reconciliation: the brand counts as submitted in this run
    expect(adapter.brands.size).toBe(1);
    expect(adapter.count("createBrand")).toBe(1);
    expect(store.registration?.brand_status).toBe("in_review");
  });
  it("an ambiguous PAID step where Twilio shows no brand is NEVER re-created: it becomes an exception for a human", async () => {
    adapter.failNext("createBrand", { kind: "transient" });
    expect((await run()).outcome).toBe("retry_later");
    const second = await run();
    expect(second.outcome).toBe("exception");
    expect(second.detail).toContain("ambiguous_fee_step");
    expect(adapter.count("createBrand")).toBe(1);
    expect(store.state).toBe("exception");
  });
  it("a step that is repeated after an ambiguous outcome and then rejected by Twilio goes to an exception, not to the owner", async () => {
    adapter.failNext("assignToCustomerProfile", { kind: "transient", lostResponse: true });
    expect((await run()).outcome).toBe("retry_later");
    adapter.failNext("assignToCustomerProfile", { kind: "validation", code: "21000" });
    const second = await run();
    expect(second.outcome).toBe("exception");
    expect(store.ledger.find((row) => row.status === "failed")?.error_code).toBe("ambiguous_rejected");
    expect(store.state).toBe("exception");
  });
  it("the step limit stops cleanly and the next run continues where it stopped", async () => {
    const first = await run({ maxSteps: 4 });
    expect(first.outcome).toBe("retry_later");
    expect(first.stepsRun).toHaveLength(4);
    const second = await run();
    expect(second.outcome).toBe("brand_submitted");
    expect(adapter.count("createCustomerProfile")).toBe(1);
  });
});

describe("owner-fixable problems never reach submission", () => {
  it("a noncompliant profile evaluation sends the owner back with the failing wizard field highlighted and submits nothing", async () => {
    adapter.evaluationFailures.profile = ["email", "business_name"];
    const result = await run();
    expect(result.outcome).toBe("needs_info");
    expect(store.state).toBe("needs_info");
    expect(store.lastErrorField).toBe("rep_email");
    expect(adapter.count("submitCustomerProfile")).toBe(0);
    expect(adapter.count("createTrustProduct")).toBe(0);
    expect(adapter.count("createBrand")).toBe(0);
    expect(store.ledger.find((row) => row.step_key === "S10")).toMatchObject({ status: "failed", error_code: "noncompliant" });
  });
  it("an evaluation failure Twilio names in a way we cannot map is an exception for a human, not a guess", async () => {
    adapter.evaluationFailures.profile = ["mystery_field"];
    const result = await run();
    expect(result.outcome).toBe("exception");
    expect(store.state).toBe("exception");
  });
  it("a noncompliant TrustProduct stops before the brand", async () => {
    adapter.evaluationFailures.trustProduct = ["company_type"];
    const result = await run();
    expect(["exception", "needs_info"]).toContain(result.outcome);
    expect(adapter.count("createBrand")).toBe(0);
  });
  it("an unsupported entity type is caught by our own mapping before anything is created for it", async () => {
    setup({ entity_type: "sole_prop" });
    const result = await run();
    expect(result.outcome).toBe("needs_info");
    expect(store.lastErrorField).toBe("entity_type");
    expect(adapter.count("createEndUser")).toBe(0);
  });
  it("an incomplete draft goes back to the owner with the first missing field and no Twilio write", async () => {
    setup({ missing: ["rep_email", "ein"] });
    const result = await run();
    expect(result.outcome).toBe("needs_info");
    expect(adapter.calls.map((c) => c.method)).toEqual(["getCustomerProfile"]);
    expect(store.lastErrorField).toBe("rep_email");
  });
  it("after the owner fixes it and resubmits (new generation) the pipeline starts clean", async () => {
    adapter.evaluationFailures.profile = ["email"];
    await run();
    adapter.evaluationFailures.profile = [];
    store.state = "submitted_for_checks";
    store.seq = 2;
    const result = await run();
    expect(result.outcome).toBe("brand_submitted");
    expect(store.ledger.filter((row) => row.seq === 2 && row.status === "succeeded")).toHaveLength(STEPS.length);
  });
});

describe("preflight, authorization and isolation", () => {
  it("nothing is created unless the ISV Primary profile is Twilio-approved right now", async () => {
    adapter.primaryStatus = "twilio-rejected";
    adapter.profiles.get(PRIMARY)!.status = "twilio-rejected";
    const result = await run();
    expect(result).toMatchObject({ outcome: "exception", detail: "preflight:primary_profile_not_approved" });
    expect(adapter.calls.map((c) => c.method)).toEqual(["getCustomerProfile"]);
    expect(store.ledger).toHaveLength(0);
  });
  it("a Twilio outage during preflight is retry_later, not an exception", async () => {
    adapter.failNext("getCustomerProfile", { kind: "transient" });
    expect((await run()).outcome).toBe("retry_later");
    expect(store.ledger).toHaveLength(0);
  });
  it("only a platform admin can run it; the pilot switch must be on; another studio's id cannot be run", async () => {
    expect((await run({ actorId: "someone-else" })).outcome).toBe("not_runnable");
    store.switchOn = false;
    expect((await run()).outcome).toBe("not_runnable");
    store.switchOn = true;
    expect((await run({ studioId: OTHER_STUDIO })).outcome).toBe("not_runnable");
    expect(adapter.calls).toHaveLength(0);
  });
  it("a live lease held by another run is respected", async () => {
    store.leaseOwner = "another-run";
    expect((await run()).outcome).toBe("lease_busy");
    expect(adapter.calls).toHaveLength(0);
  });
  it("the runner never touches the Messaging Service, campaign, number or SMS layers (R2 and later)", async () => {
    await run();
    const methods = new Set(adapter.calls.map((c) => c.method));
    for (const forbidden of ["createMessagingService", "createCampaign", "purchaseNumber", "sendSms"]) expect(methods.has(forbidden as never)).toBe(false);
  });
});

describe("the EIN", () => {
  it("is decrypted exactly once, only for the business EndUser, and appears in no other call, result, ledger row or audit entry", async () => {
    const result = await run();
    expect(store.einReads).toBe(1);
    const withEin = adapter.calls.filter((c) => JSON.stringify(c.input).includes(EIN_DIGITS));
    expect(withEin.map((c) => c.method)).toEqual(["createEndUser"]);
    expect(JSON.stringify([result, store.ledger, store.audit])).not.toContain(EIN_DIGITS);
    expect(JSON.stringify([result, store.ledger, store.audit])).not.toMatch(/987-?65-?4321/);
  });
  it("a ciphertext that cannot be decrypted (wrong studio or key) stops with a sanitized code and nothing is created for that step", async () => {
    store.einCiphertext = encryptEin(OTHER_STUDIO, { digits: EIN_DIGITS, last4: "4321" }).ciphertext;
    const result = await run();
    expect(result.outcome).toBe("exception");
    expect(JSON.stringify(result)).not.toContain(EIN_DIGITS);
    expect(adapter.count("createEndUser")).toBe(0);
  });
  it("it is purged when the brand is approved, and not before", async () => {
    await run();
    expect(store.einCiphertext).not.toBeNull();
    const brandSid = [...adapter.brands.keys()][0];
    adapter.setBrandStatus(brandSid, "APPROVED");
    const refreshed = await refreshBrandStatus({ store, adapter, studioId: STUDIO, actorId: ADMIN });
    expect(refreshed.outcome).toBe("brand_approved");
    expect(store.state).toBe("service_setup");
    expect(store.einCiphertext).toBeNull();
    expect(store.einPurged).toBe(true);
    expect(store.registration?.brand_status).toBe("approved");
  });
});

describe("following the brand", () => {
  it("pending and in-review brands change nothing; a rejected or suspended brand is an exception, not an approval", async () => {
    await run();
    const brandSid = [...adapter.brands.keys()][0];
    adapter.setBrandStatus(brandSid, "IN_REVIEW");
    expect((await refreshBrandStatus({ store, adapter, studioId: STUDIO, actorId: ADMIN })).outcome).toBe("brand_in_review");
    expect(store.state).toBe("brand_pending");
    adapter.setBrandStatus(brandSid, "FAILED");
    const failed = await refreshBrandStatus({ store, adapter, studioId: STUDIO, actorId: ADMIN });
    expect(failed.outcome).toBe("exception");
    expect(store.state).toBe("exception");
    expect(store.registration?.brand_status).toBe("rejected");
  });
  it("an unexpected brand status is an exception and is not recorded", async () => {
    await run();
    adapter.setBrandStatus([...adapter.brands.keys()][0], "DELETION_PENDING");
    expect((await refreshBrandStatus({ store, adapter, studioId: STUDIO, actorId: ADMIN })).outcome).toBe("exception");
    expect(store.registration?.brand_status).toBe("in_review");
  });
  it("refresh needs a created brand, and it is GET-only (no create, assign or submit calls)", async () => {
    expect((await refreshBrandStatus({ store, adapter, studioId: STUDIO, actorId: ADMIN })).outcome).toBe("not_runnable");
    await run();
    const before = adapter.calls.length;
    await refreshBrandStatus({ store, adapter, studioId: STUDIO, actorId: ADMIN });
    expect(adapter.calls.slice(before).map((c) => c.method)).toEqual(["getBrandStatus"]);
  });
});

describe("what leaves the building", () => {
  it("no result, ledger row, audit entry or error detail carries the owner's email, phone, address or legal name", async () => {
    adapter.evaluationFailures.profile = ["email"];
    const result = await run();
    const blob = JSON.stringify([result, store.ledger, store.audit]);
    for (const secret of ["pat@confidance.example", "+15035550123", "12 Harbor Way", "ConfiDance Test LLC", "Morgan"]) expect(blob).not.toContain(secret);
  });
});

describe("review fixes: unclear outcomes, lookups before creating, one brand, the window, mock brands", () => {
  it("an unrecognized error type after the paid brand was created is an UNKNOWN outcome (never a definite failure): the rerun adopts the brand, still exactly one", async () => {
    adapter.failNext("createBrand", { kind: "unexpected", lostResponse: true });
    expect((await run()).outcome).toBe("retry_later");
    expect(store.ledger.find((row) => row.step_key === "B1")?.status).toBe("unknown_outcome");
    expect((await run()).outcome).toBe("brand_submitted");
    expect(adapter.brands.size).toBe(1);
    expect(adapter.count("createBrand")).toBe(1);
  });
  it("a definite refusal (parsed 4xx) is the only thing recorded as failed", async () => {
    adapter.failNext("createCustomerProfile", { kind: "validation", code: "20001" });
    expect((await run()).outcome).toBe("exception");
    expect(store.ledger.find((row) => row.step_key === "S1")?.status).toBe("failed");
  });
  it("before creating the paid brand it ALWAYS looks for an existing one, even on a first attempt: a brand that already exists is adopted, never duplicated", async () => {
    await run({ confirmFee: false });
    const profile = store.ledger.find((row) => row.step_key === "S1")!.provider_sid!;
    const product = store.ledger.find((row) => row.step_key === "T1")!.provider_sid!;
    adapter.brands.set(`BN${"9".repeat(32)}`, { customerProfileSid: profile, trustProductSid: product, status: "PENDING", mock: false });
    const result = await run({ confirmFee: true });
    expect(result.outcome).toBe("brand_submitted");
    expect(adapter.count("createBrand")).toBe(0);
    expect(adapter.count("findBrand")).toBeGreaterThanOrEqual(1);
    expect(store.registration?.brand_sid).toBe(`BN${"9".repeat(32)}`);
  });
  it("two brands matching the same profile and trust product are never guessed between: exception", async () => {
    await run({ confirmFee: false });
    const profile = store.ledger.find((row) => row.step_key === "S1")!.provider_sid!;
    const product = store.ledger.find((row) => row.step_key === "T1")!.provider_sid!;
    for (const digit of ["8", "9"]) adapter.brands.set(`BN${digit.repeat(32)}`, { customerProfileSid: profile, trustProductSid: product, status: "PENDING", mock: false });
    const result = await run({ confirmFee: true });
    expect(result.outcome).toBe("exception");
    expect(result.detail).toContain("ambiguous_match");
    expect(adapter.count("createBrand")).toBe(0);
  });
  it("a failed lookup before the paid create stops the run: nothing is created blind", async () => {
    await run({ confirmFee: false });
    adapter.failNext("findBrand", { kind: "transient" });
    const result = await run({ confirmFee: true });
    expect(result.outcome).toBe("retry_later");
    expect(adapter.count("createBrand")).toBe(0);
  });
  it("a studio that already has a brand or an unresolved earlier brand attempt can never buy another (resubmission, exception recovery)", async () => {
    store.priorBrandAttempt = true;
    const result = await run({ confirmFee: true });
    expect(result.outcome).toBe("exception");
    expect(result.detail).toContain("brand_exists");
    expect(adapter.count("createBrand")).toBe(0);
    expect(store.state).toBe("exception");
  });
  it("outside an open runner window nothing is created at all; a status refresh still works", async () => {
    store.windowOpen = false;
    const closed = await run();
    expect(closed.outcome).toBe("runner_closed");
    expect(adapter.calls).toHaveLength(0);
    store.windowOpen = true;
    await run();
    store.windowOpen = false;
    const refreshed = await refreshBrandStatus({ store, adapter, studioId: STUDIO, actorId: ADMIN });
    expect(refreshed.outcome).toBe("brand_in_review");
    expect(store.claimModes.at(-1)).toBe("refresh");
  });
  it("a MOCK brand (dry run) is never mirrored into the registration and never approves the onboarding, even if Twilio approves it", async () => {
    const result = await run({ config: { ...config, mockBrand: true } });
    expect(result.outcome).toBe("brand_submitted");
    expect(result.detail).toBe("mock_brand");
    expect(store.ledger.find((row) => row.step_key === "B1")?.mock).toBe(true);
    expect(adapter.calls.find((c) => c.method === "createBrand")!.input).toMatchObject({ mock: true });
    expect(store.registration).toBeNull();
    adapter.setBrandStatus([...adapter.brands.keys()][0], "APPROVED");
    const refreshed = await refreshBrandStatus({ store, adapter, studioId: STUDIO, actorId: ADMIN });
    expect(refreshed.outcome).toBe("brand_in_review");
    expect(store.state).toBe("brand_pending");
    expect(store.einCiphertext).not.toBeNull();
    expect(store.registration).toBeNull();
  });
  it("the Primary profile must carry the Primary policy: an approved profile with another policy is refused before anything is created", async () => {
    adapter.profiles.get(PRIMARY)!.policySid = `RN${"5".repeat(32)}`;
    const result = await run();
    expect(result).toMatchObject({ outcome: "exception", detail: "preflight:primary_profile_policy_mismatch" });
    expect(adapter.calls.map((c) => c.method)).toEqual(["getCustomerProfile"]);
  });
  it("the key id stored beside the EIN token must be the one inside it, or the step fails before anything is sent", async () => {
    // the database row says key v2 while the token itself is a perfectly decryptable v1 token: the two must agree
    const original = store.getEin.bind(store);
    store.getEin = async (id, owner, actor) => ({ ...(await original(id, owner, actor)), keyId: "v2" });
    const result = await run();
    expect(result.outcome).toBe("exception");
    expect(adapter.count("createEndUser")).toBe(0);
    expect(JSON.stringify(result)).not.toContain(EIN_DIGITS);
  });
  it("a default fake never holds a plaintext EIN: calls and end users are redacted unless capture is switched on", async () => {
    adapter = new FakeIsvAdapter(PRIMARY, { primaryPolicySid: PRIMARY_POLICY });
    await run();
    expect(JSON.stringify(adapter.calls)).not.toContain(EIN_DIGITS);
    expect(JSON.stringify([...adapter.endUsers.values()])).not.toContain(EIN_DIGITS);
    expect(JSON.stringify([...adapter.endUsers.values()])).toContain("[redacted]");
  });
  it("closing the runner window WHILE a run is in progress stops it before the next step and before the paid brand (R1.1)", async () => {
    class ClosingFake extends FakeIsvAdapter {
      async createCustomerProfile(input: { friendlyName: string; email: string }) {
        store.windowOpen = false; // an admin pulls the switch while the first resource is being created
        return super.createCustomerProfile(input);
      }
    }
    adapter = new ClosingFake(PRIMARY, { captureSensitive: true, primaryPolicySid: PRIMARY_POLICY });
    const result = await run();
    expect(result.outcome).toBe("runner_closed");
    expect(adapter.count("createBrand")).toBe(0);
    expect(adapter.count("createTrustProduct")).toBe(0);
    expect(store.ledger.find((row) => row.step_key === "S1")?.status).toBe("succeeded"); // the step that had begun was recorded
    expect(store.ledger.some((row) => row.step_key === "S2")).toBe(false);
    expect(store.leaseOwner).toBeNull();
    store.windowOpen = true;
    expect((await run()).outcome).toBe("brand_submitted"); // reopening lets the next run continue where it stopped
    expect(adapter.count("createCustomerProfile")).toBe(1);
  });
});

describe("PR review fixes: state sync after S11, and store failures after the paid brand", () => {
  it("a crash between recording S11 and moving the onboarding to profile_review heals on the next run: the brand is recorded and the studio ends in brand_pending (no thrown error)", async () => {
    await run({ confirmFee: false });
    expect(store.state).toBe("profile_review");
    store.state = "submitted_for_checks"; // simulate the lost state change; the ledger still has S11 succeeded
    const result = await run({ confirmFee: true });
    expect(result.outcome).toBe("brand_submitted");
    expect(store.state).toBe("brand_pending");
    expect(store.registration?.brand_status).toBe("in_review");
    expect(adapter.count("submitCustomerProfile")).toBe(1);
  });
  it("a heal also works when the brand is already approved at Twilio: submitted_for_checks -> profile_review -> brand_pending -> service_setup, EIN erased", async () => {
    await run();
    store.state = "submitted_for_checks";
    adapter.setBrandStatus([...adapter.brands.keys()][0], "APPROVED");
    const refreshed = await run();
    expect(refreshed.outcome).toBe("brand_approved");
    expect(store.state).toBe("service_setup");
    expect(store.einPurged).toBe(true);
  });
  it("when the step limit ends the run right after S11, the state still moves to profile_review", async () => {
    await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: true, stopAfter: "S10" }); // evaluation first (the admin reads it)
    const result = await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: true, maxSteps: 1, confirmSubmit: ["S11"] });
    expect(result.outcome).toBe("retry_later");
    expect(result.stepsRun.at(-1)).toBe("S11");
    expect(store.state).toBe("profile_review");
  });
  it("if the database refuses to record a brand that Twilio already created, the run reports an exception with a code instead of throwing, and the ledger still holds the brand", async () => {
    const original = store.recordBrand.bind(store);
    store.recordBrand = async () => {
      throw new RunnerStoreError("22023");
    };
    const result = await run();
    store.recordBrand = original;
    expect(result.outcome).toBe("exception");
    expect(result.detail).toBe("brand_mirror_failed:22023");
    expect(store.ledger.find((row) => row.step_key === "B1")?.status).toBe("succeeded");
    expect(adapter.brands.size).toBe(1);
    expect(store.leaseOwner).toBeNull();
  });
});

describe("evaluation status integrity: only an explicit compliant evaluation lets a profile or trust product be submitted", () => {
  const bad = (status: unknown, failedFields: unknown = []) => ({ status, failedFields }) as never;
  const submits = () => adapter.count("submitCustomerProfile") + adapter.count("createTrustProduct") + adapter.count("submitTrustProduct") + adapter.count("createBrand");

  it("an explicitly compliant evaluation is the only thing that proceeds to submission", async () => {
    const result = await run();
    expect(result.outcome).toBe("brand_submitted");
    expect(adapter.count("evaluateCustomerProfile")).toBe(2); // S10, then the fresh re-check on the confirming run
    expect(store.ledger.find((row) => row.step_key === "S10")).toMatchObject({ status: "succeeded" });
    expect(store.ledger.find((row) => row.step_key === "S11")).toMatchObject({ status: "succeeded" });
  });
  it("noncompliant WITH named fields keeps the actionable field and submits nothing", async () => {
    adapter.evaluationRaw.profile = { status: "noncompliant", failedFields: ["email"] };
    const result = await run();
    expect(result.outcome).toBe("needs_info");
    expect(store.lastErrorField).toBe("rep_email");
    expect(store.ledger.find((row) => row.step_key === "S10")).toMatchObject({ status: "failed", error_code: "noncompliant" });
    expect(submits()).toBe(0);
  });
  it("noncompliant with ZERO named fields is NOT success: it fails closed for a human and submits nothing (the Stage B defect)", async () => {
    adapter.evaluationRaw.profile = { status: "noncompliant", failedFields: [] };
    const result = await run();
    expect(result.outcome).toBe("exception");
    expect(store.state).toBe("exception");
    expect(result.stepsRun).not.toContain("S10");
    expect(store.ledger.find((row) => row.step_key === "S10")).toMatchObject({ status: "failed", error_code: "noncompliant" });
    expect(store.ledger.some((row) => row.step_key === "S11")).toBe(false);
    expect(submits()).toBe(0);
  });
  it.each([
    ["missing status", bad(undefined)],
    ["null status", bad(null)],
    ["empty status", bad("")],
    ["wrong case", bad("Compliant")],
    ["unknown status", bad("pending")],
    ["non-string status", bad(1)],
    ["object status", bad({ status: "compliant" })],
    ["compliant but names failing fields (contradictory)", bad("compliant", ["email"])],
    ["compliant with failedFields missing", { status: "compliant" } as never],
    ["compliant with malformed failedFields", bad("compliant", [1, null])],
  ])("%s is unrecognized: exception, nothing submitted", async (_label, reply) => {
    adapter.evaluationRaw.profile = reply;
    const result = await run();
    expect(result.outcome).toBe("exception");
    expect(result.detail).toBe("S10:evaluation_unrecognized");
    expect(store.ledger.find((row) => row.step_key === "S10")).toMatchObject({ status: "failed", error_code: "evaluation_unrecognized" });
    expect(submits()).toBe(0);
  });
  it("a malformed reply (not an object) is unrecognized too", async () => {
    for (const reply of ["compliant", []]) {
      setup();
      adapter.evaluationRaw.profile = reply as never;
      expect((await run()).outcome).toBe("exception");
      expect(submits()).toBe(0);
    }
  });
  it("API success (an evaluation SID came back) does not establish compliance", async () => {
    adapter.evaluationRaw.profile = bad("in-progress");
    await run();
    expect(adapter.count("evaluateCustomerProfile")).toBe(1);
    expect(store.ledger.find((row) => row.step_key === "S10")?.status).not.toBe("succeeded");
    expect(submits()).toBe(0);
  });
  it("the same rule guards the TrustProduct (T5) before its submission", async () => {
    adapter.evaluationRaw.trustProduct = { status: "noncompliant", failedFields: [] };
    const result = await run();
    expect(result.outcome).toBe("exception");
    expect(store.ledger.find((row) => row.step_key === "T5")).toMatchObject({ status: "failed" });
    expect(adapter.count("submitTrustProduct")).toBe(0);
    expect(adapter.count("createBrand")).toBe(0);
    setup();
    adapter.evaluationRaw.trustProduct = bad(undefined);
    const second = await run();
    expect(second.detail).toBe("T5:evaluation_unrecognized");
    expect(adapter.count("createBrand")).toBe(0);
  });
  it("a failed evaluation is not retried automatically", async () => {
    adapter.evaluationRaw.profile = { status: "noncompliant", failedFields: [] };
    await run();
    expect(adapter.count("evaluateCustomerProfile")).toBe(1);
    expect(adapter.count("createCustomerProfile")).toBe(1);
  });
  it("classifyEvaluation: only exact compliant with no failing field is compliant", () => {
    expect(classifyEvaluation({ status: "compliant", failedFields: [] })).toEqual({ kind: "compliant", failedFields: [] });
    expect(classifyEvaluation({ status: "noncompliant", failedFields: ["a", 1] })).toEqual({ kind: "noncompliant", failedFields: ["a"] });
    expect(classifyEvaluation({ status: "noncompliant" })).toEqual({ kind: "noncompliant", failedFields: [] });
    for (const value of [undefined, null, "compliant", 1, [], {}, { status: "COMPLIANT", failedFields: [] }, { status: "compliant" }, { status: "compliant", failedFields: ["x"] }]) {
      expect(classifyEvaluation(value).kind, JSON.stringify(value)).toBe("unrecognized");
    }
  });
});

describe("submission re-verifies the evaluation when the S10 / T5 row comes from an earlier run (Opus review P2-1)", () => {
  const upToS10 = () => runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: true, stopAfter: "S10" });
  const submits = () => adapter.count("submitCustomerProfile") + adapter.count("createTrustProduct") + adapter.count("submitTrustProduct") + adapter.count("createBrand");

  it("a stale 'succeeded' S10 row does not authorize S11: a fresh noncompliant answer (even with no named field) stops before submission", async () => {
    const first = await upToS10();
    expect(first.stepsRun).toContain("S10");
    expect(store.ledger.find((row) => row.step_key === "S10")?.status).toBe("succeeded");
    adapter.evaluationRaw.profile = { status: "noncompliant", failedFields: [] };
    const second = await run();
    expect(second.outcome).toBe("exception");
    expect(second.detail).toBe("S11:preverify_noncompliant");
    expect(adapter.count("evaluateCustomerProfile")).toBe(2);
    expect(submits()).toBe(0);
    expect(store.ledger.some((row) => row.step_key === "S11")).toBe(false);
  });
  it("an unrecognized fresh answer stops before submission too", async () => {
    await upToS10();
    adapter.evaluationRaw.profile = { status: "weird", failedFields: [] } as never;
    const second = await run();
    expect(second.detail).toBe("S11:preverify_unrecognized");
    expect(submits()).toBe(0);
  });
  it("a named failing field sends the owner back instead of submitting", async () => {
    await upToS10();
    adapter.evaluationRaw.profile = { status: "noncompliant", failedFields: ["email"] };
    const second = await run();
    expect(second.outcome).toBe("needs_info");
    expect(store.lastErrorField).toBe("rep_email");
    expect(submits()).toBe(0);
  });
  it("a fresh explicit compliant answer proceeds (one extra evaluation, not one per step)", async () => {
    await upToS10();
    const second = await run();
    expect(second.outcome).toBe("brand_submitted");
    expect(adapter.count("evaluateCustomerProfile")).toBe(2);
    expect(adapter.count("submitCustomerProfile")).toBe(1);
  });
  it("a failed verification call stops without submitting and without any automatic retry", async () => {
    await upToS10();
    adapter.failNext("evaluateCustomerProfile", { kind: "transient" });
    const second = await run();
    expect(second.outcome).toBe("retry_later");
    expect(adapter.count("evaluateCustomerProfile")).toBe(2);
    expect(submits()).toBe(0);
  });
  it("a stale T5 row is re-verified before the TrustProduct is submitted", async () => {
    await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: false, stopAfter: "S10" });
    const first = await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: false, stopAfter: "T5", confirmSubmit: ["S11"] });
    expect(first.stepsRun).toContain("T5");
    expect(adapter.count("submitTrustProduct")).toBe(0);
    adapter.evaluationRaw.trustProduct = { status: "noncompliant", failedFields: [] };
    const second = await run();
    expect(second.detail).toBe("T6:preverify_noncompliant");
    expect(adapter.count("submitTrustProduct")).toBe(0);
    expect(adapter.count("createBrand")).toBe(0);
  });
  it("safeFieldNames keeps plain Twilio field names only (no EIN-shaped, spaced or emailed strings)", () => {
    expect(safeFieldNames(["business_name", "email", "authorized_representative_1.first_name", "123456789", "12-3456789", "a b", "x@y.z", "a".repeat(90), ""])).toEqual(["business_name", "email", "authorized_representative_1.first_name"]);
  });
});

describe("pre-submission verification tolerates a non-object adapter reply (Opus re-review P3-C)", () => {
  it.each([["undefined", undefined], ["null", null], ["a string", "compliant"]])("%s reply: no throw, no submission", async (_label, reply) => {
    await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: true, stopAfter: "S10" });
    adapter.evaluateCustomerProfile = (async () => reply) as never;
    const second = await run();
    expect(second.outcome).toBe("exception");
    expect(second.detail).toBe("S11:preverify_unrecognized");
    expect(adapter.count("submitCustomerProfile") + adapter.count("createTrustProduct") + adapter.count("createBrand")).toBe(0);
  });
});

describe("TW-4F-1: each irreversible submission needs its own confirmation on every run, and follows a visible evaluation", () => {
  const count = (method: string) => adapter.count(method as never);
  const ledgerHas = (step: string) => store.ledger.some((row) => row.step_key === step);
  const production = (confirmSubmit?: readonly SubmissionStepKey[], confirmFee = true) =>
    runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee, ...(confirmSubmit ? { confirmSubmit } : {}) });
  /** The admin's first pass: the profile is evaluated and the run stops at the submission. */
  const evaluated = async () => {
    const first = await production(["S11", "T6"]);
    expect(first.detail).toBe("S11:review");
    return first;
  };

  it("the submission steps are exactly S11 (profile) and T6 (trust product)", () => {
    expect([...SUBMISSION_STEPS]).toEqual(["S11", "T6"]);
  });
  it("a first run that has to perform the evaluation stops at S11 even if confirmed: the admin must see the evaluation first", async () => {
    const result = await production(["S11", "T6"]);
    expect(result.outcome).toBe("waiting_submission_confirmation");
    expect(result.detail).toBe("S11:review");
    expect(result.stepsRun).toContain("S10");
    expect(result.stepsRun).not.toContain("S11");
    expect(count("submitCustomerProfile")).toBe(0);
    expect(count("createTrustProduct")).toBe(0);
    expect(count("createBrand")).toBe(0);
    expect(count("evaluateCustomerProfile")).toBe(1); // S10 only: no extra re-check before the gate
    expect(ledgerHas("S11")).toBe(false);
    expect(store.state).toBe("submitted_for_checks");
  });
  it("with no confirmation (the default) a run after the evaluation stops at S11: nothing submitted, no ledger row, no extra Twilio call", async () => {
    await evaluated();
    const result = await production();
    expect(result.outcome).toBe("waiting_submission_confirmation");
    expect(result.detail).toBe("S11");
    expect(count("submitCustomerProfile")).toBe(0);
    expect(count("evaluateCustomerProfile")).toBe(1);
    expect(ledgerHas("S11")).toBe(false);
  });
  it("an empty confirmation list behaves exactly like none", async () => {
    await evaluated();
    const result = await production([]);
    expect(result.detail).toBe("S11");
    expect(count("submitCustomerProfile")).toBe(0);
  });
  it("confirming only the profile submits it, builds and evaluates the trust product, then stops at T6 for review", async () => {
    await evaluated();
    const result = await production(["S11"]);
    expect(result.outcome).toBe("waiting_submission_confirmation");
    expect(result.detail).toBe("T6"); // not confirmed in this run
    expect(count("submitCustomerProfile")).toBe(1);
    expect(count("createTrustProduct")).toBe(1);
    expect(count("submitTrustProduct")).toBe(0);
    expect(count("createBrand")).toBe(0);
    expect(ledgerHas("T6")).toBe(false);
  });
  it("confirming only the trust product does not submit the profile: S11 comes first and is unconfirmed", async () => {
    await evaluated();
    const result = await production(["T6"]);
    expect(result.detail).toBe("S11");
    expect(count("submitCustomerProfile")).toBe(0);
    expect(count("createTrustProduct")).toBe(0);
    expect(count("submitTrustProduct")).toBe(0);
  });
  it("the admin journey: evaluate, confirm the profile, confirm the trust product; each submission happens exactly once", async () => {
    await evaluated();
    expect((await production(["S11"])).detail).toBe("T6");
    const last = await production(["T6"]);
    expect(last.outcome).toBe("brand_submitted");
    expect(count("submitCustomerProfile")).toBe(1);
    expect(count("submitTrustProduct")).toBe(1);
    expect(count("createBrand")).toBe(1);
  });
  it("a confirmation covers one run only: the next run without it stops at the next submission again", async () => {
    await evaluated();
    await production(["S11"]);
    const second = await production([]);
    expect(second.outcome).toBe("waiting_submission_confirmation");
    expect(second.detail).toBe("T6");
    expect(count("submitTrustProduct")).toBe(0);
  });
  it("the fee is still its own gate after both submissions", async () => {
    await evaluated();
    await production(["S11"]);
    const result = await production(["T6"], false);
    expect(result.outcome).toBe("waiting_fee_confirmation");
    expect(count("submitTrustProduct")).toBe(1);
    expect(count("createBrand")).toBe(0);
  });
  it("anything that is not exactly S11 or T6 confirms nothing", async () => {
    await evaluated();
    const result = await production(["S10", "B1", "s11", "T5", ""] as never);
    expect(result.outcome).toBe("waiting_submission_confirmation");
    expect(result.detail).toBe("S11");
    expect(count("submitCustomerProfile")).toBe(0);
  });
  it("the gate comes before the evaluation re-check, and a confirmation does not bypass the re-check", async () => {
    await evaluated();
    adapter.evaluationRaw.profile = { status: "noncompliant", failedFields: [] };
    const unconfirmed = await production([]);
    expect(unconfirmed.detail).toBe("S11"); // stopped by the gate, no extra evaluation
    expect(count("evaluateCustomerProfile")).toBe(1);
    const confirmed = await production(["S11", "T6"]);
    expect(confirmed.outcome).toBe("exception");
    expect(confirmed.detail).toBe("S11:preverify_noncompliant");
    expect(count("submitCustomerProfile")).toBe(0);
  });
  it("only the validation harness can lift the same-run rule, and it still needs the confirmations", async () => {
    const withoutList = await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: true, allowSubmitInSameRunAsEvaluation: true });
    expect(withoutList.detail).toBe("S11");
    expect(count("submitCustomerProfile")).toBe(0);
    const single = await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: true, confirmSubmit: ["S11", "T6"], allowSubmitInSameRunAsEvaluation: true });
    expect(single.outcome).toBe("brand_submitted");
    expect(count("submitCustomerProfile")).toBe(1);
    expect(count("submitTrustProduct")).toBe(1);
  });
  it("the platform action never lifts the same-run rule", () => {
    const source = readFileSync(resolve(__dirname, "../../../../app/platform/sms/actions.ts"), "utf8");
    expect(source).not.toContain("allowSubmitInSameRunAsEvaluation");
  });
});

describe("TW-4F-1b: gate evidence (verdicts, confirmations, stale evaluations, unresolved attempts)", () => {
  const count = (method: string) => adapter.count(method as never);
  const production = (confirmSubmit?: readonly SubmissionStepKey[]) =>
    runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: true, ...(confirmSubmit ? { confirmSubmit } : {}) });
  const evaluateFirst = () => runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: true, stopAfter: "S10" });
  const verdictOf = (step: string) => store.ledger.find((row) => row.step_key === step)?.verdict;

  it("every evaluation step records its verdict on its ledger row, and every fresh re-check is recorded as evidence", async () => {
    const result = await run();
    expect(result.outcome).toBe("brand_submitted");
    expect(verdictOf("S10")).toBe("compliant");
    expect(verdictOf("T5")).toBe("compliant");
    expect(store.evaluationEvents).toEqual(expect.arrayContaining(["S10:compliant:step", "T5:compliant:step", "S10:compliant:preverify", "T5:compliant:preverify"]));
  });
  it("a noncompliant or unrecognized evaluation records that verdict on the failed row", async () => {
    adapter.evaluationRaw.profile = { status: "noncompliant", failedFields: [] };
    await run();
    expect(verdictOf("S10")).toBe("noncompliant");
    setup();
    adapter.evaluationRaw.profile = { status: "mystery", failedFields: [] } as never;
    await run();
    expect(verdictOf("S10")).toBe("unrecognized");
    expect(store.ledger.find((row) => row.step_key === "S11")).toBeUndefined();
  });
  it("each submission leaves a confirmation record (who, which step), consumed once", async () => {
    await run();
    expect(store.confirmations.map((c) => `${c.step}:${c.by}:${c.consumed}`)).toEqual([`S11:${ADMIN}:true`, `T6:${ADMIN}:true`]);
  });
  it("a refused fresh re-check is recorded as evidence and nothing is confirmed or submitted", async () => {
    await evaluateFirst();
    adapter.evaluationRaw.profile = { status: "noncompliant", failedFields: [] };
    const result = await production(["S11"]);
    expect(result.detail).toBe("S11:preverify_noncompliant");
    expect(store.evaluationEvents).toContain("S10:noncompliant:preverify");
    expect(store.confirmations).toHaveLength(0);
    expect(count("submitCustomerProfile")).toBe(0);
  });
  it("a succeeded evaluation row with no recorded compliant verdict (older code) cannot authorize a submission", async () => {
    await evaluateFirst();
    store.ledger.find((row) => row.step_key === "S10")!.verdict = null;
    const result = await production(["S11"]);
    expect(result.outcome).toBe("needs_info"); // sent back to the owner: resubmitting starts a fresh generation and evaluation
    expect(store.state).toBe("needs_info");
    expect(result.detail).toBe("S11:evaluation_stale");
    expect(describeOutcome(result.outcome, result.detail)).toContain("can no longer authorize a submission");
    expect(count("submitCustomerProfile")).toBe(0);
    expect(store.confirmations).toHaveLength(0);
  });
  it("an evaluation followed by a send-back is stale: the runner refuses, the confirmation is never recorded", async () => {
    await evaluateFirst();
    store.sendBackAfterEvaluation("needs_info");
    const result = await production(["S11"]);
    expect(result.detail).toBe("S11:evaluation_stale");
    expect(store.state).toBe("needs_info");
    expect(count("submitCustomerProfile")).toBe(0);
    expect(store.confirmations).toHaveLength(0);
  });
  it("after a stale send-back the owner resubmits (new generation): a fresh evaluation is made and the journey proceeds", async () => {
    await evaluateFirst();
    store.ledger.find((row) => row.step_key === "S10")!.verdict = null;
    expect((await production(["S11"])).outcome).toBe("needs_info");
    store.seq = 2; // the owner's resubmission bumps the generation
    store.state = "submitted_for_checks";
    const first = await production(["S11", "T6"]);
    expect(first.detail).toBe("S11:review"); // the new evaluation is made, then the run stops for review
    const second = await production(["S11", "T6"]);
    expect(second.detail).toBe("T6:review");
    const third = await production(["S11", "T6"]);
    expect(third.outcome).toBe("brand_submitted");
    expect(count("submitCustomerProfile")).toBe(1);
  });
  it("a window closed between the checks and the confirmation stops the run without submitting", async () => {
    await evaluateFirst();
    store.confirmSubmission = async () => { throw new RunnerStoreError("TW001"); };
    const result = await production(["S11"]);
    expect(result.outcome).toBe("runner_closed");
    expect(count("submitCustomerProfile")).toBe(0);
  });
  it("an unexpected confirmation failure is not swallowed", async () => {
    await evaluateFirst();
    store.confirmSubmission = async () => { throw new RunnerStoreError("XX000"); };
    await expect(production(["S11"])).rejects.toThrow("runner store failure (XX000)");
    expect(count("submitCustomerProfile")).toBe(0);
  });
  it("if the evidence cannot be recorded the run fails closed: nothing is submitted", async () => {
    await evaluateFirst();
    store.recordEvaluation = async () => { throw new RunnerStoreError("XX001"); };
    await expect(production(["S11"])).rejects.toThrow("runner store failure (XX001)");
    expect(count("submitCustomerProfile")).toBe(0);
  });
  it("an evaluation step cannot finish as succeeded without a recorded compliant verdict, and a re-begun step loses its old verdict (parity of the SQL functions)", async () => {
    await store.claim(STUDIO, ADMIN, "owner-2");
    await store.beginStep("onb-1", "owner-2", "S10", "df:x", false, null);
    await expect(store.finishStep("onb-1", "owner-2", "S10", { status: "succeeded", providerSid: `EL${"a".repeat(32)}` })).rejects.toThrow("(22023)");
    await store.recordEvaluation("onb-1", "owner-2", "S10", "noncompliant", "step");
    await expect(store.finishStep("onb-1", "owner-2", "S10", { status: "succeeded", providerSid: `EL${"a".repeat(32)}` })).rejects.toThrow("(22023)");
    await store.finishStep("onb-1", "owner-2", "S10", { status: "failed", errorCode: "noncompliant" });
    await store.beginStep("onb-1", "owner-2", "S10", "df:x", false, null);
    expect(verdictOf("S10")).toBeNull();
    await store.recordEvaluation("onb-1", "owner-2", "S10", "compliant", "step");
    await expect(store.finishStep("onb-1", "owner-2", "S10", { status: "succeeded", providerSid: `EL${"a".repeat(32)}` })).resolves.toBeUndefined();
    await store.release("onb-1", "owner-2");
  });
  it("the database refuses S11 / T6 without a confirmation held by the same lease, once, even if the runner asked (parity of the SQL functions)", async () => {
    await evaluateFirst();
    const claim = await store.claim(STUDIO, ADMIN, "owner-1");
    await expect(store.beginStep("onb-1", "owner-1", "S11", "df:x", false, null)).rejects.toThrow("(TW003)");
    await store.confirmSubmission("onb-1", "owner-1", "S11", ADMIN);
    expect(claim.steps.length).toBeGreaterThan(0);
    await expect(store.beginStep("onb-1", "owner-1", "S11", "df:x", false, null)).resolves.toEqual({ action: "execute" });
    await expect(store.beginStep("onb-1", "owner-1", "S11", "df:x", false, null)).rejects.toThrow("(TW003)"); // a retry needs a new confirmation
    await store.release("onb-1", "owner-1");
  });
  it("a previous submission attempt that never finished is called out instead of looking like a fresh submission", async () => {
    await evaluateFirst();
    adapter.failNext("submitCustomerProfile", { kind: "transient" });
    const crashed = await production(["S11"]);
    expect(crashed.outcome).toBe("retry_later");
    expect(store.ledger.find((row) => row.step_key === "S11")?.status).toBe("unknown_outcome");
    const next = await production([]);
    expect(next.outcome).toBe("waiting_submission_confirmation");
    expect(next.detail).toBe("S11:attempt_unresolved");
    expect(describeOutcome(next.outcome, next.detail)).toContain("may already have reached Twilio");
    expect(count("submitCustomerProfile")).toBe(1);
  });
});

describe("TW-4F-2b: read-only registration status check", () => {
  const check = () => checkRegistrationStatus({ store, adapter, studioId: STUDIO, actorId: ADMIN });
  const writes = () => ["createCustomerProfile", "createEndUser", "createAddress", "createSupportingDocument", "assignToCustomerProfile", "submitCustomerProfile", "createTrustProduct", "assignToTrustProduct", "submitTrustProduct", "createBrand"].reduce((n, m) => n + adapter.count(m as never), 0);
  const profileSid = () => store.ledger.find((row) => row.step_key === "S1")!.provider_sid!;
  const trustSid = () => store.ledger.find((row) => row.step_key === "T1")!.provider_sid!;
  /** The admin journey up to and including the profile submission (the trust product is built, T6 not yet confirmed). */
  const submittedProfile = async () => {
    await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: true, stopAfter: "S10" });
    await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: true, confirmSubmit: ["S11"] });
  };

  it("classifies bundle statuses from a closed set; anything else is unknown", () => {
    expect(["draft", "pending-review", "in-review", "twilio-approved", "twilio-rejected"].map(classifyBundleStatus)).toEqual(["draft", "pending-review", "in-review", "twilio-approved", "twilio-rejected"]);
    expect(classifyBundleStatus(" Twilio-Approved ")).toBe("twilio-approved");
    for (const odd of [undefined, null, "", "approved", "weird", 7, {}]) expect(classifyBundleStatus(odd)).toBe("unknown");
  });
  it("with nothing created yet there is nothing to check", async () => {
    expect((await check()).outcome).toBe("not_runnable");
    expect(writes()).toBe(0);
  });
  it("reports where the review of the profile and the trust product stands, and creates, submits and pays nothing", async () => {
    await submittedProfile();
    const before = writes();
    adapter.setProfileStatus(profileSid(), "in-review");
    adapter.setTrustProductStatus(trustSid(), "pending-review");
    const result = await check();
    expect(result.outcome).toBe("status_checked");
    expect(result.detail).toBe("profile=in-review;trust_product=pending-review");
    expect(writes()).toBe(before);
    expect(describeOutcome(result.outcome, result.detail)).toContain("Nothing was created, submitted or paid");
    expect(store.claimModes.at(-1)).toBe("refresh"); // needs no runner window
    expect(store.leaseOwner).toBeNull();
  });
  it("an approved or unknown status changes nothing", async () => {
    await submittedProfile();
    const state = store.state;
    adapter.setProfileStatus(profileSid(), "twilio-approved");
    adapter.setTrustProductStatus(trustSid(), "something-new");
    const result = await check();
    expect(result.detail).toBe("profile=twilio-approved;trust_product=unknown");
    expect(store.state).toBe(state);
  });
  it("a REJECTED profile or trust product sends the setup to a human (exception) and resubmits nothing", async () => {
    await submittedProfile();
    adapter.setProfileStatus(profileSid(), "twilio-rejected");
    const before = writes();
    const result = await check();
    expect(result.outcome).toBe("exception");
    expect(result.detail).toContain("profile_rejected");
    expect(store.state).toBe("exception");
    expect(writes()).toBe(before);
    expect(describeOutcome(result.outcome, result.detail)).toContain("Next: Read Twilio's reason");
    setup();
    await submittedProfile();
    adapter.setTrustProductStatus(trustSid(), "twilio-rejected");
    const second = await check();
    expect(second.detail).toContain("trust_product_rejected");
    expect(store.state).toBe("exception");
  });
  it("a read failure stops cleanly: retry later, no state change", async () => {
    await submittedProfile();
    const state = store.state;
    adapter.failNext("getCustomerProfile", { kind: "transient" });
    const result = await check();
    expect(result.outcome).toBe("retry_later");
    expect(store.state).toBe(state);
    expect(store.leaseOwner).toBeNull();
  });
  it("with a brand it follows the brand as before and lists what it saw about the profile and the trust product", async () => {
    await run();
    adapter.setProfileStatus(profileSid(), "twilio-approved");
    adapter.setTrustProductStatus(trustSid(), "twilio-approved");
    const result = await check();
    expect(result.outcome).toBe("brand_in_review");
    expect(result.detail).toBe("profile=twilio-approved;trust_product=twilio-approved");
    adapter.setBrandStatus([...adapter.brands.keys()][0], "APPROVED");
    expect((await check()).outcome).toBe("brand_approved");
  });
  it("only read methods are ever called by a status check", async () => {
    await run();
    const callsBefore = adapter.calls.length;
    await check();
    const used = new Set(adapter.calls.slice(callsBefore).map((call) => call.method));
    expect([...used].every((method) => ["getCustomerProfile", "getTrustProductStatus", "getBrandStatus"].includes(method))).toBe(true);
  });
});
