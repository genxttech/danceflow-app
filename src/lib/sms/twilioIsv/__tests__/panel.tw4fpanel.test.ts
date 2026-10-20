import { describe, expect, it, beforeEach } from "vitest";
import type { BeginSubaccountResult, EntityStore, EntitySummary } from "../entityStore";
import { FakeIsvParent } from "../fake";
import {
  buildStudioPanels, canConfirmSubaccount, creatingIsStale, deriveStudioPanel, looksLikeEin, nameKey, panelErrorMessage, parsePanelOverview, CONFIDANCE_NAME_KEY,
  type PanelEntity, type PanelOnboarding, type PanelOverview, type PanelStore,
} from "../panel";
import * as commands from "../panelCommands";
import { RunnerStoreError } from "../store";

/** TW-4F platform-admin panel: read model, stages and commands. Synthetic stores and the in-memory fake Twilio parent only. */

const ADMIN = "a6000000-0000-4000-8000-000000000401";
const STUDIO = "a6000000-0000-4000-8000-00000000000a";
const STUDIO_B = "a6000000-0000-4000-8000-00000000000b";
const ENTITY = "e6000000-0000-4000-8000-0000000000e1";
const REQUEST = "f6000000-0000-4000-8000-0000000000f1";
const KEY = "c6000000-0000-4000-8000-0000000000c1";
const SPEND = "d6000000-0000-4000-8000-0000000000d1";
const PRIMARY = `BU${"e".repeat(32)}`;

const entity = (over: Partial<PanelEntity> = {}): PanelEntity => ({
  id: ENTITY, legalName: "Synthetic Dance LLC", einLast4: "1234", spendCapCents: 15000, committedCents: 0, createdAt: "2026-10-20T00:00:00Z",
  account: null, openConfirmation: false, pilot: null, credit: null,
  studios: [{ studioId: STUDIO, name: "Studio A", linkKind: "founding", linkedAt: "2026-10-20T00:00:00Z", verificationNote: "registry checked", checks: {} }],
  spend: [], ...over,
});
const onboarding = (over: Partial<PanelOnboarding> = {}): PanelOnboarding => ({
  studioId: STUDIO, studioName: "Studio A", onboardingId: "b6000000-0000-4000-8000-0000000000b1", state: "submitted_for_checks", tier: null,
  legalName: "Synthetic Dance LLC", einLast4: "1234", submittedAt: "2026-10-20T00:00:00Z", legalEntityId: ENTITY, b1Status: null, brandStatus: null,
  registrationStatus: null, tierDecisions: [], ...over,
});
const none = { requests: [], prices: {} };
const studio = { id: STUDIO, name: "Studio A" };
const states = (p: ReturnType<typeof deriveStudioPanel>) => Object.fromEntries(p.stages.map((s) => [s.key, s.state]));

describe("parsePanelOverview", () => {
  it("drops malformed rows and never invents values", () => {
    const parsed = parsePanelOverview({
      entities: [{ id: "not-a-uuid" }, { id: ENTITY, legal_name: "X LLC", ein_last4: "1234", spend_cap_cents: "15000", account: { status: "weird" }, studios: [{ studio_id: "bad" }] }],
      requests: [{ id: REQUEST, studio_id: STUDIO, status: "pending", candidate_entity_id: "nope" }],
      onboardings: [{ studio_id: STUDIO, onboarding_id: "x" }],
      prices: { brand: 4600, number: -1, campaign_vetting: "1500" },
    });
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0]).toMatchObject({ spendCapCents: 15000, account: null, studios: [] });
    expect(parsed.requests[0].candidateEntityId).toBeNull();
    expect(parsed.onboardings).toHaveLength(0);
    expect(parsed.prices).toEqual({ brand: 4600 });
    expect(parsePanelOverview(null)).toEqual({ entities: [], requests: [], onboardings: [], audit: [], prices: {} });
  });
});

describe("stages: configured, approved, submitted, active", () => {
  it("no setup yet: everything not started, one plain next action", () => {
    const p = deriveStudioPanel(null, null, none, studio);
    expect(states(p)).toMatchObject({ entity: "not_started", budget: "not_started", subaccount: "not_started" });
    expect(p.nextAction).toMatch(/owner to submit/);
  });

  it("submitted setup without a legal business: configured, create it next", () => {
    const p = deriveStudioPanel(onboarding({ legalEntityId: null }), null, none, studio);
    expect(states(p).entity).toBe("configured");
    expect(p.nextAction).toMatch(/Create the legal business/);
  });

  it("a pending owner attestation comes first", () => {
    const p = deriveStudioPanel(null, null, { requests: [{ id: REQUEST, studioId: STUDIO, studioName: "A", claimedLegalName: "Synthetic Dance LLC", claimedEinLast4: "1234", status: "pending", attestedAt: "", decidedAt: null, decisionNote: null, legalEntityId: null, candidateEntityId: ENTITY }], prices: {} }, studio);
    expect(states(p).entity).toBe("submitted");
    expect(p.nextAction).toMatch(/location request/);
  });

  it("budget 0 blocks the subaccount; then the subaccount is next; active once created", () => {
    expect(deriveStudioPanel(onboarding(), entity({ spendCapCents: 0 }), none, studio).nextAction).toMatch(/setup budget/);
    expect(deriveStudioPanel(onboarding(), entity(), none, studio).nextAction).toMatch(/Create the Twilio subaccount/);
    const active = deriveStudioPanel(onboarding(), entity({ account: { status: "active", accountSid: `AC${"a".repeat(32)}`, updatedAt: null } }), none, studio);
    expect(states(active).subaccount).toBe("active");
    expect(active.stages.find((s) => s.key === "subaccount")!.summary).not.toContain("a".repeat(32)); // the SID is shortened
    expect(active.nextAction).toMatch(/runner/);
  });

  it("a creating row: in progress while recent (no Create form), interrupted and recoverable once stale", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    const recent = entity({ account: { status: "creating", accountSid: null, updatedAt: "2026-10-20T11:55:00Z" } });
    const stale = entity({ account: { status: "creating", accountSid: null, updatedAt: "2026-10-20T11:40:00Z" } });
    expect(creatingIsStale("2026-10-20T11:55:00Z", now)).toBe(false);
    expect(canConfirmSubaccount(recent, now)).toBe(false);
    expect(canConfirmSubaccount(stale, now)).toBe(true);
    expect(states(deriveStudioPanel(onboarding(), recent, none, studio, now)).subaccount).toBe("submitted");
    const p = deriveStudioPanel(onboarding(), stale, none, studio, now);
    expect(states(p).subaccount).toBe("attention");
    expect(p.nextAction).toMatch(/interrupted/);
    for (const status of ["active", "suspended", "closed"] as const) expect(canConfirmSubaccount(entity({ account: { status, accountSid: "AC1", updatedAt: null } }), now)).toBe(false);
    expect(canConfirmSubaccount(entity({ spendCapCents: 0 }), now)).toBe(false);
  });

  it("an unclear or suspended subaccount needs attention", () => {
    expect(states(deriveStudioPanel(onboarding(), entity({ account: { status: "unknown", accountSid: null, updatedAt: null } }), none, studio)).subaccount).toBe("attention");
    expect(states(deriveStudioPanel(onboarding(), entity({ account: { status: "suspended", accountSid: "AC1", updatedAt: null } }), none, studio)).subaccount).toBe("attention");
  });

  it("an owner fee approval shows as approved; a brand attempt as submitted; Twilio approval as approved; sending approved as active", () => {
    const withAuth = entity({ account: { status: "active", accountSid: "AC1", updatedAt: null }, spend: [{ id: SPEND, kind: "brand", amountCents: 4600, status: "authorized", funding: "credit", studioId: STUDIO, approvalRef: "Owner email 2026-10-20", authorizedAt: "", reservationStatus: null }] });
    expect(states(deriveStudioPanel(onboarding(), withAuth, none, studio)).budget).toBe("approved");
    expect(states(deriveStudioPanel(onboarding({ b1Status: "succeeded", state: "brand_pending" }), withAuth, none, studio)).registration).toBe("submitted");
    expect(states(deriveStudioPanel(onboarding({ b1Status: "succeeded", brandStatus: "approved" }), withAuth, none, studio)).registration).toBe("approved");
    const live = deriveStudioPanel(onboarding({ b1Status: "succeeded", brandStatus: "approved", registrationStatus: "approved" }), withAuth, none, studio);
    expect(states(live)).toMatchObject({ registration: "active", tier: "active" });
    expect(live.nextAction).toMatch(/can send/);
  });

  it("Low-Volume Standard: blocked for the paid brand with a plain reason; eligibility is never presented as approval", () => {
    const p = deriveStudioPanel(onboarding({ tier: "low_volume_standard" }), entity({ account: { status: "active", accountSid: "AC1", updatedAt: null } }), none, studio);
    expect(p.blockers.join(" ")).toMatch(/no published brand price/);
    expect(p.stages.find((s) => s.key === "tier")!.summary).toMatch(/Twilio reviews and decides/);
    expect(states(p).tier).toBe("configured");
  });

  it("the ConfiDance pilot is recognised only by its verified legal name AND the recorded exception", () => {
    expect(nameKey("ConfiDance Unlimited, LLC")).toBe(CONFIDANCE_NAME_KEY);
    const pilot = { ceilingCents: 15000, usedCents: 4600, authorizedCents: 0 };
    expect(deriveStudioPanel(onboarding(), entity({ legalName: "ConfiDance Unlimited, LLC", pilot }), none, studio).pilot).toBe(true);
    expect(deriveStudioPanel(onboarding(), entity({ legalName: "ConfiDance Unlimited, LLC" }), none, studio).pilot).toBe(false);
    expect(deriveStudioPanel(onboarding(), entity({ legalName: "Other LLC", pilot }), none, studio).pilot).toBe(false);
    expect(deriveStudioPanel(onboarding(), entity({ legalName: "ConfiDance Unlimited, LLC", pilot }), none, studio).stages.find((s) => s.key === "budget")!.summary).toMatch(/\$46\.00 used of \$150\.00/);
  });

  it("one card per studio, entity data never leaks to a studio outside the entity", () => {
    const overview: PanelOverview = { entities: [entity()], requests: [], onboardings: [onboarding(), onboarding({ studioId: STUDIO_B, studioName: "Studio B", legalEntityId: null })], audit: [], prices: {} };
    const panels = buildStudioPanels(overview);
    expect(panels.map((p) => p.studioName)).toEqual(["Studio A", "Studio B"]);
    expect(panels[1].entity).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
// commands
// ------------------------------------------------------------------------------------------------------------------------------------

/** One synthetic legal business with database-like rules (admin check, one-time request keys, approval refs, subaccount lifecycle). */
class Memory implements PanelStore {
  admins = new Set([ADMIN]);
  writes: string[] = [];
  keys = new Map<string, string>();
  confirmations: { consumed: boolean }[] = [];
  status: EntitySummary["account_status"] = null;
  sid: string | null = null;
  approvals = new Set<string>();
  fail: Record<string, string> = {};
  private gate(name: string, actor: string) {
    if (!this.admins.has(actor)) throw new RunnerStoreError("42501");
    if (this.fail[name]) throw new RunnerStoreError(this.fail[name]);
    this.writes.push(name);
  }
  async overview(): Promise<PanelOverview> { return { entities: [], requests: [], onboardings: [], audit: [], prices: {} }; }
  async createEntity(_s: string, a: string) { this.gate("createEntity", a); return ENTITY; }
  async decideLink(_r: string, _e: string, a: string, approve: boolean) { this.gate("decideLink", a); return approve ? "approved" : "rejected"; }
  async setSpendCap(_e: string, _c: number, a: string) { this.gate("setSpendCap", a); }
  async authorizeSpend(i: { approvalRef: string; actorId: string }) {
    this.gate("authorizeSpend", i.actorId);
    const ref = i.approvalRef.toLowerCase();
    if (this.approvals.has(ref)) throw new RunnerStoreError("23505");
    this.approvals.add(ref);
    return SPEND;
  }
  async withdrawSpend(_id: string, a: string) { this.gate("withdrawSpend", a); }
  async createPilotException(_e: string, _c: number, _r: string, a: string) { this.gate("createPilotException", a); return { replayed: false }; }
  /** studio -> legal business, as studio_sms_entity_studios */
  links = new Map([[STUDIO, ENTITY]]);
  creatingStale = false;
  async confirmSubaccount(key: string, studioId: string, a: string) {
    this.gate("confirmSubaccount", a);
    const entity = this.links.get(studioId);
    if (!entity) throw new RunnerStoreError("22023");
    if (this.keys.has(key)) {
      if (this.keys.get(key) !== entity) throw new RunnerStoreError("22023");
      return { replayed: true, reused: false, legalEntityId: entity };
    }
    if (this.status === "active" || this.status === "suspended" || this.status === "closed") throw new RunnerStoreError("55000");
    if (this.status === "creating" && !this.creatingStale) throw new RunnerStoreError("TW006");
    this.keys.set(key, entity);
    if (this.confirmations.some((c) => !c.consumed)) return { replayed: false, reused: true, legalEntityId: entity };
    this.confirmations.push({ consumed: false });
    return { replayed: false, reused: false, legalEntityId: entity };
  }
  async decideTier(_s: string, a: string) { this.gate("decideTier", a); return { changed: true }; }
  // EntityStore (what provisionSubaccount uses)
  async entityForStudio(_s: string, a: string): Promise<EntitySummary> {
    if (!this.admins.has(a)) throw new RunnerStoreError("42501");
    return { legal_entity_id: ENTITY, spend_cap_cents: 15000, committed_cents: 0, account_status: this.status, account_sid: this.sid };
  }
  async beginSubaccount(): Promise<BeginSubaccountResult> {
    if (this.status === "active") return { action: "skip", account_sid: this.sid };
    if (this.status === "creating" && !this.creatingStale) throw new RunnerStoreError("TW006");
    const c = this.confirmations.find((x) => !x.consumed);
    if (!c) throw new RunnerStoreError("TW003");
    c.consumed = true;
    const action = this.status === "unknown" || this.status === "creating" ? "reconcile" : "execute";
    this.status = "creating";
    return { action };
  }
  finishFails = false;
  async finishSubaccount(_e: string, _a: string, status: "active" | "failed" | "unknown", sid: string | null) {
    if (this.finishFails) throw new RunnerStoreError("08006");
    this.status = status;
    if (status === "active") this.sid = sid;
  }
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("panel commands", () => {
  let db: Memory;
  let parent: FakeIsvParent;
  // the EntityStore view provisionSubaccount uses (it never records confirmations: the panel does, through the keyed PanelStore method)
  const deps = () => ({ entities: { entityForStudio: db.entityForStudio.bind(db), beginSubaccount: db.beginSubaccount.bind(db), finishSubaccount: db.finishSubaccount.bind(db) } as unknown as EntityStore, parent, envName: "test" as const });
  // provisionSubaccount never calls EntityStore.confirmSubaccount: the panel records the confirmation through the keyed PanelStore method
  beforeEach(() => {
    db = new Memory();
    parent = new FakeIsvParent(PRIMARY);
  });

  it("every write is refused for a non-admin by the store (the database re-check), and the message says so", async () => {
    const r = await commands.setSpendCap(db, "someone-else", form({ entityId: ENTITY, capDollars: "150", confirmCap: "150" }));
    expect(r).toEqual({ ok: false, message: "Only a platform admin can do this." });
    expect(db.writes).toHaveLength(0);
  });

  it("creating a legal business needs a verification note, the checkbox, and never an EIN in the note", async () => {
    expect((await commands.createEntity(db, ADMIN, form({ studioId: STUDIO, verificationNote: "short" }))).ok).toBe(false);
    expect((await commands.createEntity(db, ADMIN, form({ studioId: STUDIO, verificationNote: "Registry entry checked today" }))).ok).toBe(false);
    expect((await commands.createEntity(db, ADMIN, form({ studioId: STUDIO, verificationNote: "EIN 12-3456789 checked", verified: "on" }))).message).toMatch(/Do not type an EIN/);
    expect(db.writes).toHaveLength(0);
    expect((await commands.createEntity(db, ADMIN, form({ studioId: STUDIO, verificationNote: "Registry entry checked today", verified: "on" }))).ok).toBe(true);
  });

  it("invalid legal-entity linking: approval needs the entity, a note and the verification checkbox; database refusals are explained", async () => {
    expect((await commands.decideLink(db, ADMIN, form({ requestId: REQUEST, decision: "approve", note: "registry checked ok" , verified: "on" }))).message).toMatch(/legal business/);
    expect((await commands.decideLink(db, ADMIN, form({ requestId: REQUEST, entityId: ENTITY, decision: "approve", note: "registry checked ok" }))).message).toMatch(/verified the association/);
    expect(db.writes).toHaveLength(0);
    db.fail.decideLink = "22023";
    expect((await commands.decideLink(db, ADMIN, form({ requestId: REQUEST, entityId: ENTITY, decision: "approve", note: "registry checked ok", verified: "on" }))).message).toMatch(/checks do not agree/);
    delete db.fail.decideLink;
    expect((await commands.decideLink(db, ADMIN, form({ requestId: REQUEST, decision: "reject", note: "not ours" }))).message).toMatch(/rejected/);
  });

  it("the setup budget needs the amount typed twice", async () => {
    expect((await commands.setSpendCap(db, ADMIN, form({ entityId: ENTITY, capDollars: "150", confirmCap: "1500" }))).ok).toBe(false);
    expect((await commands.setSpendCap(db, ADMIN, form({ entityId: ENTITY, capDollars: "abc", confirmCap: "abc" }))).ok).toBe(false);
    expect(db.writes).toHaveLength(0);
    expect((await commands.setSpendCap(db, ADMIN, form({ entityId: ENTITY, capDollars: "150", confirmCap: "150" }))).message).toMatch(/\$150\.00/);
  });

  describe("owner fee approvals", () => {
    const fee = (over: Record<string, string> = {}) => form({ entityId: ENTITY, studioId: STUDIO, kind: "brand", funding: "pilot", amountCents: "4600", approvalRef: "Owner email 2026-10-20 approving brand $46", ownerApproved: "on", ...over });

    it("needs the written approval reference and the owner-approved confirmation", async () => {
      expect((await commands.authorizeFee(db, ADMIN, fee({ approvalRef: "ok" }), { studioTier: null })).ok).toBe(false);
      expect((await commands.authorizeFee(db, ADMIN, fee({ ownerApproved: "" }), { studioTier: null })).message).toMatch(/Nothing was authorized/);
      expect((await commands.authorizeFee(db, ADMIN, fee({ kind: "sms_usage" }), { studioTier: null })).ok).toBe(false);
      expect((await commands.authorizeFee(db, ADMIN, fee({ amountCents: "" }), { studioTier: null })).ok).toBe(false);
      expect(db.writes).toHaveLength(0);
    });

    it("one approval authorizes one operation: a double submit or replay of the same approval is refused", async () => {
      expect((await commands.authorizeFee(db, ADMIN, fee(), { studioTier: "standard" })).ok).toBe(true);
      const again = await commands.authorizeFee(db, ADMIN, fee(), { studioTier: "standard" });
      expect(again).toEqual({ ok: false, message: expect.stringMatching(/each owner approval authorizes one operation/) });
    });

    it("a brand fee for a location whose onboarding could not be read is refused (fail closed); other fees are unaffected", async () => {
      expect((await commands.authorizeFee(db, ADMIN, fee(), { studioTier: null, onboardingFound: false })).message).toMatch(/could not be read/);
      expect(db.writes).toHaveLength(0);
      expect((await commands.authorizeFee(db, ADMIN, fee({ kind: "number", amountCents: "150" }), { studioTier: null, onboardingFound: false })).ok).toBe(true);
    });

    it("a Low-Volume Standard location cannot get a brand approval at the Standard price (other fees are unaffected)", async () => {
      expect((await commands.authorizeFee(db, ADMIN, fee(), { studioTier: "low_volume_standard" })).message).toMatch(/Low-Volume Standard/);
      expect(db.writes).toHaveLength(0);
      expect((await commands.authorizeFee(db, ADMIN, fee({ kind: "number", amountCents: "150", approvalRef: "Owner email 2026-10-20 approving number" }), { studioTier: "low_volume_standard" })).ok).toBe(true);
    });

    it("database refusals (price changed, budget exceeded, pilot rules) read plainly", async () => {
      for (const [code, text] of [["TW008", /published price/], ["TW004", /setup budget/], ["22023", /pilot-funded/]] as const) {
        db.fail.authorizeSpend = code;
        expect((await commands.authorizeFee(db, ADMIN, fee({ approvalRef: `Owner email ${code} approving` }), { studioTier: null })).message).toMatch(text);
      }
    });
  });

  it("the pilot ceiling is at most $150 and needs the founder approval and the acknowledgement", async () => {
    expect((await commands.createPilotException(db, ADMIN, form({ entityId: ENTITY, ceilingDollars: "150.01", approvalRef: "Founder email 2026-10-20", understood: "on" }))).ok).toBe(false);
    expect((await commands.createPilotException(db, ADMIN, form({ entityId: ENTITY, ceilingDollars: "150", approvalRef: "Founder email 2026-10-20" }))).ok).toBe(false);
    expect(db.writes).toHaveLength(0);
    expect((await commands.createPilotException(db, ADMIN, form({ entityId: ENTITY, ceilingDollars: "150", approvalRef: "Founder email 2026-10-20", understood: "on" }))).ok).toBe(true);
  });

  describe("Create subaccount (separately confirmed)", () => {
    const create = (over: Record<string, string> = {}) => form({ studioId: STUDIO, requestKey: KEY, phrase: commands.CREATE_PHRASE, ...over });

    it("without the exact phrase, a valid request key, or a runtime that can create: nothing is confirmed and Twilio is not called", async () => {
      expect((await commands.createSubaccount(db, ADMIN, create({ phrase: "create subaccount" }), deps())).ok).toBe(false);
      expect((await commands.createSubaccount(db, ADMIN, create({ requestKey: "x" }), deps())).message).toMatch(/expired/);
      expect((await commands.createSubaccount(db, ADMIN, create(), { refused: "Twilio registration calls are switched off." })).message).toMatch(/switched off\. Nothing was created/);
      expect(db.confirmations).toHaveLength(0);
      expect(parent.calls).toHaveLength(0);
    });

    it("creates exactly one subaccount; a double click / replay of the same form creates nothing more and leaves no spare confirmation", async () => {
      const first = await commands.createSubaccount(db, ADMIN, create(), deps());
      expect(first).toMatchObject({ ok: true, message: expect.stringMatching(/created/) });
      const replay = await commands.createSubaccount(db, ADMIN, create(), deps());
      expect(replay).toMatchObject({ ok: true, message: expect.stringMatching(/already exists/) });
      expect(parent.count("createSubaccount")).toBe(1);
      expect(db.confirmations.filter((c) => !c.consumed)).toHaveLength(0);
      // a NEW form once the account is active: the database refuses to record a confirmation nothing would consume
      const fresh = await commands.createSubaccount(db, ADMIN, create({ requestKey: "c6000000-0000-4000-8000-0000000000c2" }), deps());
      expect(fresh.message).toMatch(/already active/);
    });

    it("the legal business comes from the studio, never from the form: a studio without one is refused before anything is recorded", async () => {
      const r = await commands.createSubaccount(db, ADMIN, create({ studioId: STUDIO_B, entityId: ENTITY }), deps());
      expect(r.message).toMatch(/no legal business/);
      expect(db.confirmations).toHaveLength(0);
      expect(parent.calls).toHaveLength(0);
    });

    it("two tabs (two request keys) never leave two open confirmations", async () => {
      db.status = "unknown"; // an unclear earlier attempt: a confirmation can be recorded
      parent.failNext("findSubaccount", { kind: "transient" });
      await commands.createSubaccount(db, ADMIN, create(), deps());
      expect(db.confirmations.filter((c) => !c.consumed)).toHaveLength(0);
      db.confirmations.push({ consumed: false }); // a confirmation recorded by another tab that has not run yet
      await db.confirmSubaccount("c6000000-0000-4000-8000-0000000000c9", STUDIO, ADMIN);
      expect(db.confirmations.filter((c) => !c.consumed)).toHaveLength(1);
    });

    it("an interrupted creation (row stuck at creating): refused while recent, recoverable once stale, and found by lookup, not created twice", async () => {
      db.finishFails = true;
      parent.failNext("createSubaccount", { kind: "transient", lostResponse: true });
      const first = await commands.createSubaccount(db, ADMIN, create(), deps());
      expect(first.ok).toBe(false);
      expect(first.message).toMatch(/finish_failed/); // reported truthfully: the outcome could not even be recorded
      expect(db.status).toBe("creating");
      db.finishFails = false;
      const recent = await commands.createSubaccount(db, ADMIN, create({ requestKey: "c6000000-0000-4000-8000-0000000000c4" }), deps());
      expect(recent.message).toMatch(/less than 10 minutes/);
      db.creatingStale = true;
      const later = await commands.createSubaccount(db, ADMIN, create({ requestKey: "c6000000-0000-4000-8000-0000000000c5" }), deps());
      expect(later.ok).toBe(true);
      expect(parent.count("createSubaccount")).toBe(1);
      expect(parent.accounts.size).toBe(1);
    });

    it("provider failure: a lost response is recorded as unclear and the next confirmed attempt finds the account instead of creating another", async () => {
      parent.failNext("createSubaccount", { kind: "transient", lostResponse: true });
      const first = await commands.createSubaccount(db, ADMIN, create(), deps());
      expect(first.ok).toBe(false);
      expect(first.message).toMatch(/never created twice/);
      expect(db.status).toBe("unknown");
      const second = await commands.createSubaccount(db, ADMIN, create({ requestKey: "c6000000-0000-4000-8000-0000000000c3" }), deps());
      expect(second.ok).toBe(true);
      expect(parent.count("createSubaccount")).toBe(1);
      expect(parent.accounts.size).toBe(1);
    });

    it("a definite provider refusal is reported, not hidden", async () => {
      parent.failNext("createSubaccount", { kind: "validation" });
      const r = await commands.createSubaccount(db, ADMIN, create(), deps());
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/human/);
      expect(r.message).toMatch(/validation/);
    });
  });

  it("the tier decision: Low-Volume Standard needs every checklist item and a documented reason", async () => {
    expect((await commands.decideTier(db, ADMIN, form({ studioId: STUDIO, tier: "low_volume_standard", reason: "EIN business, low volume" }))).message).toMatch(/every eligibility check/);
    const all = Object.fromEntries(["ein_registered", "not_sole_proprietor", "low_volume_expected", "owner_informed_limits", "owner_informed_review"].map((k) => [`elig_${k}`, "on"]));
    expect((await commands.decideTier(db, ADMIN, form({ studioId: STUDIO, tier: "low_volume_standard", reason: "short", ...all }))).ok).toBe(false);
    expect((await commands.decideTier(db, ADMIN, form({ studioId: STUDIO, tier: "sole_proprietor", reason: "EIN business, low volume" }))).ok).toBe(false);
    expect(db.writes).toHaveLength(0);
    expect((await commands.decideTier(db, ADMIN, form({ studioId: STUDIO, tier: "low_volume_standard", reason: "EIN business, low volume", ...all }))).message).toMatch(/Twilio still reviews/);
  });

  it("no free-text field may carry a full EIN, in any spelling", async () => {
    for (const ein of ["98-7654321", "98 7654321", "98\u20137654321", "987654321", "EIN98-7654321", "12-345-6789", "12 345 6789", "12.3456789", "12/3456789"]) expect(looksLikeEin(ein)).toBe(true);
    for (const fine of ["Owner email 2026-10-20 approving brand $46", "EIN last four 4321", "Oregon SOS #2026-10", "call 5551234567", "+15551234567", "(503) 555-0123", "2026-10-20 29647095", "ticket 1234567890", "$1,234.56"]) expect(looksLikeEin(fine)).toBe(false);
    const fee = form({ entityId: ENTITY, studioId: STUDIO, kind: "number", funding: "credit", amountCents: "150", approvalRef: "Owner approved, EIN 98 7654321", ownerApproved: "on" });
    expect((await commands.authorizeFee(db, ADMIN, fee, { studioTier: null })).message).toMatch(/Do not type an EIN/);
    expect((await commands.decideTier(db, ADMIN, form({ studioId: STUDIO, tier: "standard", reason: "EIN 987654321 checked ok" }))).message).toMatch(/Do not type an EIN/);
    expect((await commands.decideLink(db, ADMIN, form({ requestId: REQUEST, decision: "reject", note: "98-7654321 mismatch" }))).message).toMatch(/Do not type an EIN/);
    expect(db.writes).toHaveLength(0);
  });

  it("unknown database codes never leak database text", () => {
    expect(panelErrorMessage("spend", new RunnerStoreError("XX000"))).toBe("The change could not be saved. Nothing was changed.");
    expect(panelErrorMessage("spend", new Error("relation secret_table does not exist"))).toBe("The change could not be saved. Nothing was changed.");
  });
});
