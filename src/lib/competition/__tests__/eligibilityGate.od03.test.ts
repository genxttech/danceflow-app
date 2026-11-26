import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGE_VERIFICATION_DISCLOSURE,
  ELIGIBILITY_REASON_CODES,
  evaluateEntryOperationalGate,
  isAgeRestrictedDivision,
  validateEligibilityDecision,
} from "../eligibilityGate";
import { loadEntryOperationalGates } from "../eligibilityGateServer";
import { isSchedulableEntry } from "../floorPlanner";

const NOW = new Date("2026-11-23T12:00:00Z");
const ADULT = "1990-01-01";
const MINOR = "2012-01-01";
const base = { status: "confirmed", eligibilityStatus: "eligible", clearance: "cleared" as const, participantDobs: [ADULT, ADULT] };

describe("OD-03 age-restricted division detection", () => {
  it.each([["Senior I", true], ["Junior", true], ["Masters", true], ["mystery label", true], ["", false], [null, false], ["Open", false], ["All Ages", false]])(
    "%j restricted=%s",
    (label, expected) => expect(isAgeRestrictedDivision(label as string | null)).toBe(expected),
  );
});

describe("OD-03 entry operational gate", () => {
  it("clears an adult entry only when the database reports it cleared", () => {
    expect(evaluateEntryOperationalGate(base, NOW)).toEqual({ ready: true, reasons: [] });
    expect(evaluateEntryOperationalGate({ ...base, eligibilityStatus: "waived" }, NOW).ready).toBe(true);
    expect(evaluateEntryOperationalGate({ ...base, clearance: "provisional" }, NOW).reasons).toEqual(["clearance_not_recorded"]);
    expect(evaluateEntryOperationalGate({ ...base, clearance: "blocked" }, NOW).reasons).toEqual(["clearance_not_recorded"]);
    expect(evaluateEntryOperationalGate({ ...base, clearance: "unavailable" }, NOW).reasons).toEqual(["clearance_unavailable"]);
  });
  it("a status alone never clears an entry: eligible or waived without a database clearance is not ready", () => {
    for (const eligibilityStatus of ["eligible", "waived"]) {
      expect(evaluateEntryOperationalGate({ ...base, eligibilityStatus, clearance: "provisional" }, NOW).ready).toBe(false);
    }
  });
  it("OD-02 stays absolute: a minor, a missing DOB or no participants blocks even when the database says cleared", () => {
    for (const dobs of [[ADULT, MINOR], [ADULT, null], [], ["garbage"]]) {
      expect(evaluateEntryOperationalGate({ ...base, participantDobs: dobs }, NOW).reasons).toContain("adult_not_verified");
      expect(evaluateEntryOperationalGate({ ...base, eligibilityStatus: "waived", participantDobs: dobs }, NOW).ready).toBe(false);
    }
  });
  it("unconfirmed, ineligible and undecided entries are not ready", () => {
    expect(evaluateEntryOperationalGate({ ...base, status: "pending" }, NOW).reasons).toContain("not_confirmed");
    expect(evaluateEntryOperationalGate({ ...base, eligibilityStatus: "ineligible" }, NOW).reasons).toEqual(["ineligible"]);
    expect(evaluateEntryOperationalGate({ ...base, eligibilityStatus: "needs_review" }, NOW).reasons).toContain("eligibility_not_decided");
    expect(evaluateEntryOperationalGate({ ...base, eligibilityStatus: "unverified" }, NOW).reasons).toContain("eligibility_not_decided");
  });
});

describe("OD-03 eligibility decision validation (organizer action)", () => {
  const ok = { outcome: "eligible", reasonCode: "criteria_verified_by_organizer", ageLabel: "Masters", participantsAdult: true };
  it("accepts the verified-by-organizer decision", () => expect(validateEligibilityDecision(ok)).toBeNull());
  it("refuses eligible or waived when stored data does not show every competitor is an adult (waiver cannot bypass OD-02)", () => {
    expect(validateEligibilityDecision({ ...ok, participantsAdult: false })).toMatch(/18 or older/);
    expect(validateEligibilityDecision({ ...ok, outcome: "waived", reasonCode: "waiver_event_policy_fee", ageLabel: null, participantsAdult: false })).toMatch(/18 or older/);
  });
  it("refuses a waiver on an age-restricted division, a wrong reason, and a missing reason", () => {
    expect(validateEligibilityDecision({ ...ok, outcome: "waived", reasonCode: "waiver_event_policy_fee" })).toMatch(/age-restricted/);
    expect(validateEligibilityDecision({ ...ok, reasonCode: "other_organizer_review" })).toMatch(/requires the reason/);
    expect(validateEligibilityDecision({ ...ok, outcome: "waived", reasonCode: "other_organizer_review", ageLabel: "Open" })).toMatch(/event-policy/);
    expect(validateEligibilityDecision({ ...ok, outcome: "ineligible" })).toMatch(/reason/);
    expect(validateEligibilityDecision({ ...ok, reasonCode: "" })).toMatch(/reason/);
    expect(validateEligibilityDecision({ ...ok, outcome: "bogus" })).toMatch(/valid eligibility/);
  });
  it("allows an event-policy waiver on an open division and marking an entry ineligible", () => {
    expect(validateEligibilityDecision({ outcome: "waived", reasonCode: "waiver_event_policy_documents", ageLabel: "Open", participantsAdult: true })).toBeNull();
    expect(validateEligibilityDecision({ outcome: "ineligible", reasonCode: "age_division_not_met", ageLabel: "Junior", participantsAdult: false })).toBeNull();
  });
  it("offers only reason codes the database function accepts", () => {
    const sql = [...ELIGIBILITY_REASON_CODES].sort();
    expect(sql).toEqual(["age_division_not_met", "age_not_established", "criteria_verified_by_organizer", "documents_pending", "level_not_met", "other_organizer_review", "status_not_established", "waiver_event_policy_documents", "waiver_event_policy_fee", "waiver_event_policy_scheduling", "whose_age_rule_unresolved"]);
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
  it("loader fails closed on a load error, clears only what the database clears, and treats a missing function as not ready", async () => {
    const table = (data: unknown[], error: unknown = null) => ({ select: () => ({ eq: async () => ({ data, error }) }) });
    const client = (tables: Record<string, ReturnType<typeof table>>, answer: { data: unknown; error: unknown } = { data: "cleared", error: null }) =>
      ({ from: (name: string) => tables[name], rpc: async () => answer }) as never;
    const entries = [{ id: "e1", status: "confirmed", eligibility_status: "eligible" }];
    const tables = {
      event_competition_entries: table(entries),
      event_competition_entry_participants: table([{ entry_id: "e1", competitor_id: "c1" }]),
      event_competition_competitors: table([{ id: "c1", date_of_birth: ADULT }]),
    };
    const ready = async (c: never) => (await loadEntryOperationalGates(c, "ev", NOW)).get("e1")?.ready;
    expect(await ready(client(tables))).toBe(true);
    expect(await ready(client(tables, { data: "provisional", error: null }))).toBe(false);
    expect(await ready(client(tables, { data: null, error: { code: "PGRST202" } }))).toBe(false);
    expect(await ready(client({ ...tables, event_competition_entry_participants: table([]) }))).toBe(false);
    await expect(loadEntryOperationalGates(client(tables, { data: null, error: { code: "57014", message: "timeout" } }), "ev", NOW)).rejects.toThrow();
    await expect(loadEntryOperationalGates(client({ ...tables, event_competition_competitors: table([], { message: "x" }) }), "ev", NOW)).rejects.toThrow();
  });
  it("the organizer action, heat generation and planner loader call the gate (source wiring)", () => {
    const root = join(__dirname, "..", "..", "..");
    const actions = readFileSync(join(root, "app/app/events/[id]/competition/registrations/actions.ts"), "utf8");
    expect(actions).toContain("validateEligibilityDecision");
    expect(actions).toContain("entryParticipantsAdultVerified");
    expect(actions).toContain("recordEligibilityDecision");
    expect(actions).not.toContain("eligibility_status:");
    expect(actions).not.toContain("eligibility_determination");
    expect(readFileSync(join(root, "app/app/events/[id]/competition/readiness/actions.ts"), "utf8")).toContain("loadEntryOperationalGates");
    expect(readFileSync(join(root, "lib/competition/floorScheduleServer.ts"), "utf8")).toContain("age_gate_ok");
  });
});
