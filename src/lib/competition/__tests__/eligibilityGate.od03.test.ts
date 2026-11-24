import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGE_VERIFICATION_DISCLOSURE,
  buildEligibilityDetermination,
  evaluateEntryOperationalGate,
  isAgeRestrictedDivision,
  parseEligibilityDetermination,
  validateEligibilityDecision,
} from "../eligibilityGate";
import { loadEntryOperationalGates } from "../eligibilityGateServer";
import { isSchedulableEntry } from "../floorPlanner";

const NOW = new Date("2026-11-23T12:00:00Z");
const ADULT = "1990-01-01";
const MINOR = "2012-01-01";
const good = buildEligibilityDetermination({ by: "user-1", role: "organizer_admin", outcome: "eligible", reasonCode: "criteria_verified_by_organizer", criteria: ["age_division"], now: NOW });
// An age-restricted division with no level label and no pro/am participants: only the age criterion applies.
const base = { status: "confirmed", eligibilityStatus: "eligible", ageLabel: "Senior I", skillLabel: null, participantRoles: ["dancer", "dancer"], metadata: { eligibility_determination: good }, participantDobs: [ADULT, ADULT] };
const waiverDetermination = buildEligibilityDetermination({ by: "user-1", role: "organizer_admin", outcome: "waived", reasonCode: "waiver_event_policy_fee", criteria: [], now: NOW });

describe("OD-03 age-restricted division detection", () => {
  it.each([["Senior I", true], ["Junior", true], ["Masters", true], ["mystery label", true], ["", false], [null, false], ["Open", false], ["All Ages", false]])(
    "%j restricted=%s",
    (label, expected) => expect(isAgeRestrictedDivision(label as string | null)).toBe(expected),
  );
});

describe("OD-03 entry operational gate", () => {
  it("clears an adult entry in an age-restricted division only with an eligible status AND an organizer determination", () => {
    expect(evaluateEntryOperationalGate(base, NOW)).toEqual({ ready: true, reasons: [] });
    expect(evaluateEntryOperationalGate({ ...base, metadata: {} }, NOW).reasons).toContain("criteria_determination_missing");
    expect(evaluateEntryOperationalGate({ ...base, metadata: { eligibility_determination: { ...good, by: "" } } }, NOW).ready).toBe(false);
    expect(evaluateEntryOperationalGate({ ...base, metadata: { eligibility_determination: { ...good, reasonCode: "other_organizer_review" } } }, NOW).ready).toBe(false);
  });
  it("a waiver never clears an age-restricted entry", () => {
    const result = evaluateEntryOperationalGate({ ...base, eligibilityStatus: "waived", metadata: { eligibility_determination: waiverDetermination } }, NOW);
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("waiver_not_allowed_for_classified_division");
  });
  it("OD-02 stays absolute: a minor, a missing DOB or no participants blocks even with eligible + determination, and with a waiver on an open division", () => {
    for (const dobs of [[ADULT, MINOR], [ADULT, null], [], ["garbage"]]) {
      expect(evaluateEntryOperationalGate({ ...base, participantDobs: dobs }, NOW).reasons).toContain("adult_not_verified");
      expect(evaluateEntryOperationalGate({ ...base, ageLabel: null, eligibilityStatus: "waived", metadata: { eligibility_determination: waiverDetermination }, participantDobs: dobs }, NOW).ready).toBe(false);
    }
  });
  it("open (non-classified) divisions: a categorised waiver or eligible clears; an undecided entry does not", () => {
    expect(evaluateEntryOperationalGate({ ...base, ageLabel: "Open", metadata: { eligibility_determination: waiverDetermination }, eligibilityStatus: "waived" }, NOW).ready).toBe(true);
    expect(evaluateEntryOperationalGate({ ...base, ageLabel: null, metadata: {}, eligibilityStatus: "eligible" }, NOW).ready).toBe(true);
    expect(evaluateEntryOperationalGate({ ...base, ageLabel: null, metadata: {}, eligibilityStatus: "unverified" }, NOW).reasons).toContain("eligibility_not_decided");
  });
  it("unconfirmed, ineligible and undecided entries are not ready", () => {
    expect(evaluateEntryOperationalGate({ ...base, status: "pending" }, NOW).reasons).toContain("not_confirmed");
    expect(evaluateEntryOperationalGate({ ...base, eligibilityStatus: "ineligible" }, NOW).reasons).toContain("ineligible");
    expect(evaluateEntryOperationalGate({ ...base, eligibilityStatus: "needs_review" }, NOW).reasons).toContain("eligibility_not_decided");
  });
  it("determination parsing rejects malformed records and carries no birthdate or age", () => {
    expect(parseEligibilityDetermination(null)).toBeNull();
    expect(parseEligibilityDetermination({ eligibility_determination: { ...good, at: "nope" } })).toBeNull();
    expect(parseEligibilityDetermination({ eligibility_determination: { ...good, criteria: ["bogus"] } })).toBeNull();
    expect(Object.keys(good).sort()).toEqual(["at", "by", "criteria", "outcome", "reasonCode", "role"]);
    expect(JSON.stringify(good)).not.toMatch(/birth/i);
  });
});

describe("OD-03 eligibility decision validation (organizer action)", () => {
  const ok = { outcome: "eligible", reasonCode: "criteria_verified_by_organizer", required: ["age_division"] as Array<"age_division">, verifiedCriteria: ["age_division"], participantsAdult: true };
  it("accepts the verified-by-organizer decision", () => expect(validateEligibilityDecision(ok)).toBeNull());
  it("refuses eligible or waived when stored data does not show every competitor is an adult (waiver cannot bypass OD-02)", () => {
    expect(validateEligibilityDecision({ ...ok, participantsAdult: false })).toMatch(/18 or older/);
    expect(validateEligibilityDecision({ ...ok, outcome: "waived", reasonCode: "waiver_event_policy_fee", required: [], participantsAdult: false })).toMatch(/18 or older/);
  });
  it("refuses a waiver on an age-restricted division, a wrong reason, and a missing reason", () => {
    expect(validateEligibilityDecision({ ...ok, outcome: "waived", reasonCode: "waiver_event_policy_fee" })).toMatch(/age, status or level requirements/);
    expect(validateEligibilityDecision({ ...ok, reasonCode: "other_organizer_review" })).toMatch(/requires the reason/);
    expect(validateEligibilityDecision({ ...ok, reasonCode: "" })).toMatch(/reason/);
    expect(validateEligibilityDecision({ ...ok, outcome: "bogus" })).toMatch(/valid eligibility/);
  });
  it("allows an event-policy waiver on an open division and marking an entry ineligible without extra conditions", () => {
    expect(validateEligibilityDecision({ outcome: "waived", reasonCode: "waiver_event_policy_documents", required: [], verifiedCriteria: [], participantsAdult: true })).toBeNull();
    expect(validateEligibilityDecision({ outcome: "ineligible", reasonCode: "age_division_not_met", required: ["age_division"], verifiedCriteria: [], participantsAdult: false })).toBeNull();
  });
});

describe("OD-03 scheduling and copy", () => {
  it("floor planner treats age_gate_ok=false as unschedulable and leaves legacy callers unchanged", () => {
    expect(isSchedulableEntry({ status: "confirmed", eligibility_status: "eligible", age_gate_ok: false })).toBe(false);
    expect(isSchedulableEntry({ status: "confirmed", eligibility_status: "eligible", age_gate_ok: true })).toBe(true);
    expect(isSchedulableEntry({ status: "confirmed", eligibility_status: "unverified" })).toBe(true);
  });
  it("disclosure says DanceFlow does not yet automatically verify age divisions and never claims it enforces them", () => {
    expect(AGE_VERIFICATION_DISCLOSURE).toMatch(/does not yet automatically verify/);
    expect(AGE_VERIFICATION_DISCLOSURE).not.toMatch(/enforces age|checks age/i);
  });
  it("loader fails closed on a load error and clears nothing for entries without participants", async () => {
    const table = (data: unknown[], error: unknown = null) => ({ select: () => ({ eq: async () => ({ data, error }) }) });
    const client = (tables: Record<string, ReturnType<typeof table>>) => ({ from: (name: string) => tables[name] }) as never;
    const entries = [{ id: "e1", division_id: "d1", status: "confirmed", eligibility_status: "eligible", metadata: { eligibility_determination: good } }];
    const tables = {
      event_competition_entries: table(entries),
      event_competition_divisions: table([{ id: "d1", age_label: "Senior I", skill_label: null }]),
      event_competition_entry_participants: table([]),
      event_competition_competitors: table([]),
    };
    expect((await loadEntryOperationalGates(client(tables), "ev", NOW)).get("e1")?.ready).toBe(false);
    await expect(loadEntryOperationalGates(client({ ...tables, event_competition_competitors: table([], { message: "x" }) }), "ev", NOW)).rejects.toThrow();
    const withPeople = { ...tables, event_competition_entry_participants: table([{ entry_id: "e1", competitor_id: "c1", participant_role: "dancer" }]), event_competition_competitors: table([{ id: "c1", date_of_birth: ADULT }]) };
    expect((await loadEntryOperationalGates(client(withPeople), "ev", NOW)).get("e1")?.ready).toBe(true);
  });
  it("the organizer action, heat generation and planner loader call the gate (source wiring)", () => {
    const root = join(__dirname, "..", "..", "..");
    const actions = readFileSync(join(root, "app/app/events/[id]/competition/registrations/actions.ts"), "utf8");
    expect(actions).toContain("validateEligibilityDecision");
    expect(actions).toContain("entryParticipantsAdultVerified");
    expect(actions).toContain("eligibility_determination");
    expect(readFileSync(join(root, "app/app/events/[id]/competition/readiness/actions.ts"), "utf8")).toContain("loadEntryOperationalGates");
    expect(readFileSync(join(root, "lib/competition/floorScheduleServer.ts"), "utf8")).toContain("age_gate_ok");
  });
});
