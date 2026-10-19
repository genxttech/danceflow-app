import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptEin } from "@/lib/sms/onboarding/ein";
import { MAX_TOKEN_TTL_MS, RedactedSecret, SubaccountTokenProvider } from "../account";
import type { IsvConfig } from "../config";
import type { BeginSubaccountResult, EntityStore, EntitySummary } from "../entityStore";
import { FakeIsvAdapter, FakeIsvParent } from "../fake";
import type { RunnerInputs } from "../payloads";
import { checkRegistrationStatus, refreshBrandStatus, runBrandSubmission } from "../runner";
import { describeOutcome } from "../outcomes";
import { RunnerStoreError } from "../store";
import { provisionSubaccount, subaccountFriendlyName } from "../subaccount";
import { IsvApiError } from "../types";
import { MemoryRunnerStore } from "./memoryStore";

/**
 * TW-4F-3a (D2): subaccount per studio legal entity. Synthetic adapters only: nothing here can reach Twilio.
 */

const STUDIO = "a5700000-0000-4000-8000-00000000000a";
const ADMIN = "a5700000-0000-4000-8000-000000000401";
const ENTITY = "e0000000-0000-4000-8000-0000000000e1";
const PRIMARY = `BU${"e".repeat(32)}`;
const PRIMARY_POLICY = `RN${"4".repeat(32)}`;
const SUB_A = `AC${"a".repeat(32)}`;
const SUB_B = `AC${"b".repeat(32)}`;
const PARENT_SID = `AC${"1".repeat(32)}`;
const TOKEN = "0123456789abcdef0123456789abcdef";

describe("RedactedSecret and SubaccountTokenProvider", () => {
  it("never reveals the value through string, template, JSON or inspect output", () => {
    const secret = new RedactedSecret(TOKEN);
    const all = [String(secret), `${secret}`, JSON.stringify({ secret }), inspect(secret), inspect({ nested: { secret } }, { depth: 5 }), JSON.stringify([secret])];
    for (const text of all) expect(text).not.toContain(TOKEN);
    expect(String(secret)).toBe("[redacted]");
    expect(secret.reveal()).toBe(TOKEN);
  });

  it("caches per account for a short time, then fetches again; one account's entry never serves another", async () => {
    let now = 1_000;
    const fetched: string[] = [];
    const provider = new SubaccountTokenProvider({ getSubaccountToken: async (sid) => { fetched.push(sid); return `${sid.slice(2, 4)}${TOKEN}`.slice(0, 32); } }, { ttlMs: 60_000, now: () => now });
    const a1 = await provider.tokenFor(SUB_A);
    const a2 = await provider.tokenFor(SUB_A);
    const b1 = await provider.tokenFor(SUB_B);
    expect(fetched).toEqual([SUB_A, SUB_B]);
    expect(a1).toBe(a2);
    expect(b1.reveal()).not.toBe(a1.reveal());
    now += 60_001;
    await provider.tokenFor(SUB_A);
    expect(fetched).toEqual([SUB_A, SUB_B, SUB_A]);
    provider.invalidate(SUB_A);
    await provider.tokenFor(SUB_A);
    expect(fetched.filter((sid) => sid === SUB_A)).toHaveLength(3);
    provider.invalidate();
    expect(provider.cachedAccounts).toBe(0);
  });

  it("clamps the lifetime to five minutes and caches nothing when the lifetime is zero", async () => {
    let now = 0;
    let calls = 0;
    const clamped = new SubaccountTokenProvider({ getSubaccountToken: async () => { calls += 1; return TOKEN; } }, { ttlMs: 24 * 3_600_000, now: () => now });
    await clamped.tokenFor(SUB_A);
    now = MAX_TOKEN_TTL_MS + 1;
    await clamped.tokenFor(SUB_A);
    expect(calls).toBe(2);
    const none = new SubaccountTokenProvider({ getSubaccountToken: async () => { calls += 1; return TOKEN; } }, { ttlMs: 0 });
    await none.tokenFor(SUB_A);
    await none.tokenFor(SUB_A);
    expect(calls).toBe(4);
    expect(none.cachedAccounts).toBe(0);
  });

  it("fails closed: a malformed sid never reaches the parent, a failing or empty reply yields an error without the underlying text, and nothing is cached", async () => {
    let calls = 0;
    const leaky = new SubaccountTokenProvider({ getSubaccountToken: async () => { calls += 1; throw new IsvApiError("validation", 401, "20003", `bad credential ${TOKEN}`); } });
    await expect(leaky.tokenFor("not-a-sid")).rejects.toThrow("not a subaccount sid");
    await expect(leaky.tokenFor(`AC${"z".repeat(32)}`)).rejects.toThrow("not a subaccount sid");
    expect(calls).toBe(0);
    const error = await leaky.tokenFor(SUB_A).catch((e) => e as IsvApiError);
    expect(error).toBeInstanceOf(IsvApiError);
    expect(String((error as Error).message) + JSON.stringify(error)).not.toContain(TOKEN);
    expect(leaky.cachedAccounts).toBe(0);
    const empty = new SubaccountTokenProvider({ getSubaccountToken: async () => "" });
    await expect(empty.tokenFor(SUB_A)).rejects.toThrow("credential unavailable");
    const transient = new SubaccountTokenProvider({ getSubaccountToken: async () => { throw new IsvApiError("transient", 503, null, "x"); } });
    await expect(transient.tokenFor(SUB_A)).rejects.toMatchObject({ kind: "transient" });
  });
});

/** Mirrors the SQL functions the provisioning flow uses (one confirmation per creation attempt, spend cap first). */
class MemoryEntityStore implements EntityStore {
  entityId: string | null = ENTITY;
  capCents = 15_000;
  status: EntitySummary["account_status"] = null;
  sid: string | null = null;
  confirmations: { by: string; consumed: boolean }[] = [];
  finished: { status: string; sid: string | null }[] = [];
  admins = new Set([ADMIN]);
  /** a creation attempt (status creating) is still running unless a test says it went stale */
  creatingIsStale = false;

  async entityForStudio(_studio: string, actor: string): Promise<EntitySummary> {
    if (!this.admins.has(actor)) throw new RunnerStoreError("42501");
    return this.entityId ? { legal_entity_id: this.entityId, spend_cap_cents: this.capCents, committed_cents: 0, account_status: this.status, account_sid: this.sid } : { legal_entity_id: null };
  }
  async createEntityForStudio() { return ENTITY; }
  async decideLink() {}
  async setSpendCap(_e: string, cents: number) { this.capCents = cents; }
  async authorizeSpend() { return "spend-1"; }
  async confirmSubaccount(_e: string, actor: string) {
    if (!this.admins.has(actor)) throw new RunnerStoreError("42501");
    if (this.capCents <= 0) throw new RunnerStoreError("TW004");
    this.confirmations.push({ by: actor, consumed: false });
  }
  async beginSubaccount(_e: string, actor: string): Promise<BeginSubaccountResult> {
    if (!this.admins.has(actor)) throw new RunnerStoreError("42501");
    if (this.status === "active" || this.status === "suspended" || this.status === "closed") return { action: "skip", account_sid: this.sid, status: this.status };
    if (this.status === "creating" && !this.creatingIsStale) throw new RunnerStoreError("TW006");
    const c = this.confirmations.filter((x) => !x.consumed && x.by === actor).at(-1);
    if (!c) throw new RunnerStoreError("TW003");
    c.consumed = true;
    const action = this.status === "creating" || this.status === "unknown" ? "reconcile" : "execute";
    this.status = "creating";
    return { action };
  }
  async finishSubaccount(_e: string, _a: string, status: "active" | "failed" | "unknown", sid: string | null) {
    if (this.status !== "creating") throw new RunnerStoreError("22023");
    this.status = status;
    if (status === "active") this.sid = sid;
    this.finished.push({ status, sid });
  }
}

describe("provisionSubaccount", () => {
  let parent: FakeIsvParent;
  let entities: MemoryEntityStore;
  const provision = () => provisionSubaccount({ entities, parent, studioId: STUDIO, actorId: ADMIN, envName: "test" });
  beforeEach(() => {
    parent = new FakeIsvParent(PRIMARY, { primaryPolicySid: PRIMARY_POLICY });
    entities = new MemoryEntityStore();
  });

  it("a studio without a legal entity gets nothing: no confirmation consumed, no Twilio call", async () => {
    entities.entityId = null;
    expect(await provision()).toEqual({ outcome: "no_legal_entity" });
    expect(parent.calls).toHaveLength(0);
  });

  it("without a fresh typed confirmation nothing is called and nothing is written", async () => {
    expect(await provision()).toEqual({ outcome: "waiting_subaccount_confirmation" });
    expect(parent.calls).toHaveLength(0);
    expect(entities.status).toBeNull();
  });

  it("the spend cap must be set before a confirmation can be recorded", async () => {
    entities.capCents = 0;
    await expect(entities.confirmSubaccount(ENTITY, ADMIN)).rejects.toMatchObject({ code: "TW004" });
  });

  it("creates the subaccount once (lookup first, deterministic name), consumes the confirmation, and never creates a second", async () => {
    await entities.confirmSubaccount(ENTITY, ADMIN);
    const first = await provision();
    expect(first.outcome).toBe("subaccount_created");
    expect(first.accountSid).toMatch(/^AC[0-9a-f]{32}$/);
    expect(parent.calls.map((c) => c.method)).toEqual(["findSubaccount", "createSubaccount"]);
    expect(parent.calls[1].input).toEqual({ friendlyName: subaccountFriendlyName("test", ENTITY) });
    expect(entities.confirmations.every((c) => c.consumed)).toBe(true);
    // a second run (even with a fresh confirmation) is a no-op: the account exists
    await entities.confirmSubaccount(ENTITY, ADMIN);
    const second = await provision();
    expect(second).toEqual({ outcome: "subaccount_exists", accountSid: first.accountSid });
    expect(parent.count("createSubaccount")).toBe(1);
    expect(entities.confirmations.filter((c) => !c.consumed)).toHaveLength(1); // not consumed by the no-op
  });

  it("it never continues into registration: the parent surface has no registration methods and only find/create were called", async () => {
    await entities.confirmSubaccount(ENTITY, ADMIN);
    await provision();
    expect(new Set(parent.calls.map((c) => c.method))).toEqual(new Set(["findSubaccount", "createSubaccount"]));
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(parent)).filter((n) => /Profile|Brand|Trust|EndUser|Address/.test(n))).toEqual([]);
    expect(parent.adapterFor(SUB_A).count("createCustomerProfile")).toBe(0);
  });

  it("a lost response is recorded as unknown; the next confirmed run finds the account by name and creates nothing", async () => {
    parent.failNext("createSubaccount", { kind: "transient", lostResponse: true });
    await entities.confirmSubaccount(ENTITY, ADMIN);
    const first = await provision();
    expect(first.outcome).toBe("retry_later");
    expect(entities.status).toBe("unknown");
    expect(parent.accounts.size).toBe(1); // it was created inside "Twilio"
    // a run without a new confirmation changes nothing
    expect((await provision()).outcome).toBe("waiting_subaccount_confirmation");
    await entities.confirmSubaccount(ENTITY, ADMIN);
    const second = await provision();
    expect(second.outcome).toBe("subaccount_exists");
    expect(parent.count("createSubaccount")).toBe(1);
    expect(entities.status).toBe("active");
  });

  it("a definite refusal is a failure for a human; a later confirmed run may try again", async () => {
    parent.failNext("createSubaccount", { kind: "account" });
    await entities.confirmSubaccount(ENTITY, ADMIN);
    expect((await provision()).outcome).toBe("exception");
    expect(entities.status).toBe("failed");
    await entities.confirmSubaccount(ENTITY, ADMIN);
    expect((await provision()).outcome).toBe("subaccount_created");
  });

  it("a failing lookup never creates; several matches are never guessed between", async () => {
    parent.failNext("findSubaccount", { kind: "transient" });
    await entities.confirmSubaccount(ENTITY, ADMIN);
    expect((await provision()).outcome).toBe("retry_later");
    expect(parent.count("createSubaccount")).toBe(0);
    parent.seedAccount(SUB_A, subaccountFriendlyName("test", ENTITY));
    parent.seedAccount(SUB_B, subaccountFriendlyName("test", ENTITY));
    await entities.confirmSubaccount(ENTITY, ADMIN);
    expect(await provision()).toEqual({ outcome: "exception", detail: "ambiguous_match" });
    expect(parent.count("createSubaccount")).toBe(0);
  });

  it("an adopted account has the studio's deterministic name, and a different entity's account is never adopted", async () => {
    parent.seedAccount(SUB_B, subaccountFriendlyName("test", "e0000000-0000-4000-8000-0000000000e2"));
    await entities.confirmSubaccount(ENTITY, ADMIN);
    const result = await provision();
    expect(result.outcome).toBe("subaccount_created");
    expect(result.accountSid).not.toBe(SUB_B);
  });

  it("a creation that is still running blocks a second one: nothing is called and no confirmation is consumed", async () => {
    entities.status = "creating";
    await entities.confirmSubaccount(ENTITY, ADMIN);
    expect(await provision()).toEqual({ outcome: "retry_later", detail: "creation_in_progress" });
    expect(parent.calls).toHaveLength(0);
    expect(entities.confirmations.filter((c) => !c.consumed)).toHaveLength(1);
    entities.creatingIsStale = true; // a crashed attempt: after the staleness window it is reconciled by lookup
    parent.seedAccount(SUB_A, subaccountFriendlyName("test", ENTITY));
    expect(await provision()).toEqual({ outcome: "subaccount_exists", accountSid: SUB_A });
    expect(parent.count("createSubaccount")).toBe(0);
  });

  it("only a platform admin can provision", async () => {
    await entities.confirmSubaccount(ENTITY, ADMIN);
    const outcome = await provisionSubaccount({ entities, parent, studioId: STUDIO, actorId: "someone-else", envName: "test" });
    expect(outcome.outcome).toBe("exception");
    expect(parent.calls).toHaveLength(0);
  });
});

describe("the runner runs only in the studio's own subaccount", () => {
  const config: IsvConfig = {
    accountSid: PARENT_SID, authToken: "t".repeat(32), primaryProfileSid: PRIMARY, primaryProfilePolicySid: PRIMARY_POLICY,
    secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms-compliance@isv.example", envName: "test", mockBrand: false,
  };
  const inputs: RunnerInputs = {
    studio_id: STUDIO, submission_seq: 1, state: "submitted_for_checks", studio_name: "E2E Studio", studio_slug: "confidance-studio", studio_public_name: null,
    legal_name: "ConfiDance Test LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: null,
    address_line1: "12 Harbor Way", address_line2: null, city: "Portland", region: "OR", postal_code: "97201", country: "US",
    rep_first_name: "Pat", rep_last_name: "Morgan", rep_title: "Owner", rep_position: "ceo", rep_email: "pat@confidance.example", rep_phone: "+15035550123",
    preferred_area_code: "503", ein_last4: "4321", missing: [],
  };
  let store: MemoryRunnerStore;
  let adapter: FakeIsvAdapter;

  beforeEach(() => {
    process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    delete process.env.SMS_EIN_ENCRYPTION_KEY_ID;
    adapter = new FakeIsvAdapter(PRIMARY, { primaryPolicySid: PRIMARY_POLICY, accountSid: SUB_A });
    store = new MemoryRunnerStore(inputs, encryptEin(STUDIO, { digits: "987654321", last4: "4321" }).ciphertext);
    store.platformAdmins.add(ADMIN);
    store.account = { legalEntityId: ENTITY, accountSid: SUB_A, status: "active" };
  });
  const run = (over: { adapter?: FakeIsvAdapter; confirmFee?: boolean } = {}) =>
    runBrandSubmission({ store, adapter: over.adapter ?? adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: over.confirmFee ?? false });

  it("a studio with no legal entity or no active subaccount is stopped before the first Twilio call or ledger write", async () => {
    for (const account of [{ legalEntityId: null, accountSid: null, status: null }, { legalEntityId: ENTITY, accountSid: null, status: "creating" }]) {
      store.account = account;
      const result = await run();
      expect(result.outcome).toBe("needs_subaccount");
      expect(adapter.calls).toHaveLength(0);
      expect(store.ledger).toHaveLength(0);
      expect(store.leaseOwner).toBeNull();
    }
  });

  it("an adapter built for another account (the parent, or another studio's subaccount) is refused before any call", async () => {
    for (const sid of [PARENT_SID, SUB_B]) {
      const other = new FakeIsvAdapter(PRIMARY, { primaryPolicySid: PRIMARY_POLICY, accountSid: sid });
      const result = await run({ adapter: other });
      expect(result.outcome).toBe("account_mismatch");
      expect(other.calls).toHaveLength(0);
      expect(store.ledger).toHaveLength(0);
    }
  });

  it("the status check and the brand refresh are bound to the same account", async () => {
    const other = new FakeIsvAdapter(PRIMARY, { accountSid: SUB_B });
    expect((await checkRegistrationStatus({ store, adapter: other, studioId: STUDIO, actorId: ADMIN })).outcome).toBe("account_mismatch");
    expect((await refreshBrandStatus({ store, adapter: other, studioId: STUDIO, actorId: ADMIN })).outcome).toBe("account_mismatch");
    store.account = { legalEntityId: null, accountSid: null, status: null };
    expect((await checkRegistrationStatus({ store, adapter, studioId: STUDIO, actorId: ADMIN })).outcome).toBe("needs_subaccount");
    expect(other.calls).toHaveLength(0);
    expect(adapter.calls).toHaveLength(0);
  });

  it("a failing account lookup stops the run", async () => {
    store.getAccount = async () => { throw new RunnerStoreError("57014"); };
    const result = await run();
    expect(result.outcome).toBe("exception");
    expect(result.detail).toBe("account:57014");
    expect(adapter.calls).toHaveLength(0);
  });

  it("the outcomes read plainly for the admin", () => {
    expect(describeOutcome("needs_subaccount", "no_subaccount")).toMatch(/no Twilio subaccount yet/);
    expect(describeOutcome("account_mismatch")).toMatch(/not the studio's own subaccount/);
    expect(describeOutcome("spend_blocked")).toMatch(/spend cap/);
  });
});

describe("the fee step needs owner-approved spend within the cap", () => {
  const baseInputs: RunnerInputs = {
    studio_id: STUDIO, submission_seq: 1, state: "submitted_for_checks", studio_name: "E2E Studio", studio_slug: "confidance-studio", studio_public_name: null,
    legal_name: "ConfiDance Test LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: null,
    address_line1: "12 Harbor Way", address_line2: null, city: "Portland", region: "OR", postal_code: "97201", country: "US",
    rep_first_name: "Pat", rep_last_name: "Morgan", rep_title: "Owner", rep_position: "ceo", rep_email: "pat@confidance.example", rep_phone: "+15035550123",
    preferred_area_code: "503", ein_last4: "4321", missing: [],
  };
  const config: IsvConfig = {
    accountSid: PARENT_SID, authToken: "t".repeat(32), primaryProfileSid: PRIMARY, primaryProfilePolicySid: PRIMARY_POLICY,
    secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms-compliance@isv.example", envName: "test", mockBrand: false,
  };
  let store: MemoryRunnerStore;
  let adapter: FakeIsvAdapter;
  beforeEach(() => {
    process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    delete process.env.SMS_EIN_ENCRYPTION_KEY_ID;
    adapter = new FakeIsvAdapter(PRIMARY, { primaryPolicySid: PRIMARY_POLICY, accountSid: SUB_A });
    store = new MemoryRunnerStore(baseInputs, encryptEin(STUDIO, { digits: "987654321", last4: "4321" }).ciphertext);
    store.platformAdmins.add(ADMIN);
    store.account = { legalEntityId: ENTITY, accountSid: SUB_A, status: "active" };
  });
  // plays the admin: re-runs with every confirmation after each "review" stop, up to the brand step
  const journey = async (confirmFee: boolean) => {
    let result;
    for (let pass = 0; pass < 5; pass++) {
      result = await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee, confirmSubmit: ["S11", "T6"] });
      if (result.outcome !== "waiting_submission_confirmation" || !String(result.detail).endsWith(":review")) break;
    }
    return result!;
  };

  it("with no authorized spend the run stops at the brand: no brand call, no brand ledger row, no reservation", async () => {
    store.spendAuthorized = false;
    const result = await journey(true);
    expect(result.outcome).toBe("spend_blocked");
    expect(result.detail).toBe("B1:no_authorized_spend");
    expect(adapter.count("createBrand")).toBe(0);
    expect(store.ledger.some((row) => row.step_key === "B1")).toBe(false);
    expect(store.spendReservations).toHaveLength(0);
  });

  it("a Twilio MOCK brand is a free dry run: it consumes no authorization", async () => {
    store.spendAuthorized = false;
    const mockConfig = { ...config, mockBrand: true };
    let result;
    for (let pass = 0; pass < 5; pass++) {
      result = await runBrandSubmission({ store, adapter, config: mockConfig, studioId: STUDIO, actorId: ADMIN, confirmFee: true, confirmSubmit: ["S11", "T6"] });
      if (result.outcome !== "waiting_submission_confirmation" || !String(result.detail).endsWith(":review")) break;
    }
    expect(result!.outcome).not.toBe("spend_blocked");
    expect(store.spendReservations).toHaveLength(0);
  });

  it("the fee confirmation alone is not enough, and the authorization alone is not enough", async () => {
    const withoutFee = await journey(false);
    expect(withoutFee.outcome).toBe("waiting_fee_confirmation");
    expect(store.spendReservations).toHaveLength(0); // nothing reserved before the admin's fee confirmation
    expect(adapter.count("createBrand")).toBe(0);
  });

  it("with authorization and confirmation the brand is created once and the spend is reserved once for this generation", async () => {
    const result = await journey(true);
    expect(result.outcome).toBe("brand_submitted");
    expect(adapter.count("createBrand")).toBe(1);
    expect(store.spendReservations).toEqual(["1:brand"]);
    await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: true, confirmSubmit: ["S11", "T6"] });
    expect(adapter.count("createBrand")).toBe(1);
    expect(store.spendReservations).toEqual(["1:brand"]);
  });
});

describe("account isolation in the fake (a SID from one account is unknown in another)", () => {
  it("a profile created in one subaccount cannot be found, read or assigned from another", async () => {
    const parent = new FakeIsvParent(PRIMARY, { primaryPolicySid: PRIMARY_POLICY });
    const a = parent.adapterFor(SUB_A);
    const b = parent.adapterFor(SUB_B);
    const profile = await a.createCustomerProfile({ friendlyName: "df:test:s:S1:1", email: "x@y.example" });
    expect(await a.findCustomerProfile("df:test:s:S1:1")).toEqual([profile]);
    expect(await b.findCustomerProfile("df:test:s:S1:1")).toEqual([]);
    expect((await b.getCustomerProfile(profile)).status).toBe("unknown");
    await expect(b.assignToCustomerProfile(profile, "IT0")).rejects.toMatchObject({ httpStatus: 404 });
    expect(parent.adapterFor(SUB_A)).toBe(a);
    expect(a.accountSid).toBe(SUB_A);
    expect(b.accountSid).toBe(SUB_B);
  });
  it("the parent only hands a subaccount's token to a caller that names that subaccount", async () => {
    const parent = new FakeIsvParent(PRIMARY);
    const sid = await parent.createSubaccount("df:test:x");
    expect(await parent.getSubaccountToken(sid)).toMatch(/^fake-token-/);
    await expect(parent.getSubaccountToken(SUB_B)).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("TW-4F-3b-0: prepaid credit around the fee step", () => {
  const baseInputs: RunnerInputs = {
    studio_id: STUDIO, submission_seq: 1, state: "submitted_for_checks", studio_name: "E2E Studio", studio_slug: "confidance-studio", studio_public_name: null,
    legal_name: "ConfiDance Test LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: null,
    address_line1: "12 Harbor Way", address_line2: null, city: "Portland", region: "OR", postal_code: "97201", country: "US",
    rep_first_name: "Pat", rep_last_name: "Morgan", rep_title: "Owner", rep_position: "ceo", rep_email: "pat@confidance.example", rep_phone: "+15035550123",
    preferred_area_code: "503", ein_last4: "4321", missing: [],
  };
  const config: IsvConfig = {
    accountSid: PARENT_SID, authToken: "t".repeat(32), primaryProfileSid: PRIMARY, primaryProfilePolicySid: PRIMARY_POLICY,
    secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms-compliance@isv.example", envName: "test", mockBrand: false,
  };
  let store: MemoryRunnerStore;
  let adapter: FakeIsvAdapter;
  beforeEach(() => {
    process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    delete process.env.SMS_EIN_ENCRYPTION_KEY_ID;
    adapter = new FakeIsvAdapter(PRIMARY, { primaryPolicySid: PRIMARY_POLICY, accountSid: SUB_A });
    store = new MemoryRunnerStore(baseInputs, encryptEin(STUDIO, { digits: "987654321", last4: "4321" }).ciphertext);
    store.platformAdmins.add(ADMIN);
    store.account = { legalEntityId: ENTITY, accountSid: SUB_A, status: "active" };
  });
  const journey = async () => {
    let result;
    for (let pass = 0; pass < 6; pass++) {
      result = await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: true, confirmSubmit: ["S11", "T6"] });
      if (result.outcome !== "waiting_submission_confirmation" || !String(result.detail).endsWith(":review")) break;
    }
    return result!;
  };

  it("insufficient settled credit stops before the brand: no Twilio call, no ledger row for the brand, nothing settled", async () => {
    store.insufficientCredit = true;
    const result = await journey();
    expect(result.outcome).toBe("insufficient_credit");
    expect(adapter.count("createBrand")).toBe(0);
    expect(store.ledger.some((row) => row.step_key === "B1")).toBe(false);
    expect(store.settlements).toHaveLength(0);
    expect(describeOutcome("insufficient_credit")).toMatch(/settled prepaid SMS credit/);
  });

  it("a brand that was created is CAPTURED exactly once, even when the run is repeated", async () => {
    expect((await journey()).outcome).toBe("brand_submitted");
    expect(store.settlements).toEqual(["1:brand:captured"]);
    await journey();
    expect(store.settlements).toEqual(["1:brand:captured"]);
    expect(adapter.count("createBrand")).toBe(1);
  });

  it("a definite refusal by Twilio RELEASES the reservation; an unknown outcome leaves it held", async () => {
    adapter.failNext("createBrand", { kind: "validation" });
    expect((await journey()).outcome).toBe("exception");
    expect(store.settlements).toEqual(["1:brand:released"]);
  });

  it("a lost response (the brand may exist) is neither captured nor released", async () => {
    adapter.failNext("createBrand", { kind: "transient", lostResponse: true });
    const result = await journey();
    expect(result.outcome).toBe("retry_later");
    expect(store.settlements).toHaveLength(0);
  });

  it("a settlement that cannot be recorded stops the run for a human (the paid brand exists, the reservation stays held)", async () => {
    store.failSettlement = true;
    const result = await journey();
    expect(result.outcome).toBe("settlement_failed");
    expect(adapter.count("createBrand")).toBe(1);
    expect(describeOutcome("settlement_failed")).toMatch(/reservation stays held/);
  });

  it("a fee step that already succeeded is captured by the next run even if the earlier settlement was lost", async () => {
    expect((await journey()).outcome).toBe("brand_submitted");
    store.settlements.length = 0; // the earlier run died after Twilio accepted the brand, before its settlement was recorded
    await journey();
    expect(store.settlements).toEqual(["1:brand:captured"]);
    expect(adapter.count("createBrand")).toBe(1);
  });

  it("a reservation made before a refused begin is released: closed window and an already existing brand", async () => {
    store.failBegin = { step: "B1", code: "TW001" };
    expect((await journey()).outcome).toBe("runner_closed");
    expect(store.settlements).toEqual(["1:brand:released"]);
    store.settlements.length = 0;
    store.failBegin = { step: "B1", code: "55000" };
    const exists = await journey();
    expect(exists.outcome).toBe("exception");
    expect(exists.detail).toBe("B1:brand_exists");
    expect(store.settlements).toEqual(["1:brand:released"]);
    expect(adapter.count("createBrand")).toBe(0);
  });

  it("a free Twilio mock brand reserves and settles nothing", async () => {
    const mock = { ...config, mockBrand: true };
    for (let pass = 0; pass < 6; pass++) {
      const result = await runBrandSubmission({ store, adapter, config: mock, studioId: STUDIO, actorId: ADMIN, confirmFee: true, confirmSubmit: ["S11", "T6"] });
      if (result.outcome !== "waiting_submission_confirmation" || !String(result.detail).endsWith(":review")) break;
    }
    expect(store.settlements).toHaveLength(0);
    expect(store.spendReservations).toHaveLength(0);
  });
});
