import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptEin } from "@/lib/sms/onboarding/ein";
import type { IsvConfig } from "../config";
import { FakeIsvAdapter } from "../fake";
import type { RunnerInputs } from "../payloads";
import { classifyEvaluation, refreshBrandStatus, runBrandSubmission, safeFieldNames, STEPS } from "../runner";
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

const run = (over: { confirmFee?: boolean; maxSteps?: number; config?: IsvConfig; studioId?: string; actorId?: string } = {}) =>
  runBrandSubmission({ store, adapter, config: over.config ?? config, studioId: over.studioId ?? STUDIO, actorId: over.actorId ?? ADMIN, confirmFee: over.confirmFee ?? true, maxSteps: over.maxSteps });

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
    const result = await run({ maxSteps: 11 });
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
    expect(adapter.count("evaluateCustomerProfile")).toBe(1);
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
    const first = await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: false, stopAfter: "T5" });
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
