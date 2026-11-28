import { describe, expect, it } from "vitest";
import {
  AGE_NOT_ESTABLISHED_MESSAGE,
  MINORS_NOT_PERMITTED_MESSAGE,
  classifyDateOfBirth,
  conservativeReferenceDate,
  evaluateCompetitionAdultGate,
} from "../minorsGate";

// Fixed "now": 2026-11-23 12:00 UTC. The conservative reference date is the UTC-12 date: still 2026-11-23.
const NOW = new Date("2026-11-23T12:00:00Z");

function person(clientId: string, dateOfBirth?: string) {
  return { clientId, firstName: "A", lastName: "B", personType: "dancer", ...(dateOfBirth === undefined ? {} : { dateOfBirth }) };
}
function entry(participantIds: string[], clientId = "e1") {
  return { clientId, participantIds };
}

describe("OD-02 classifyDateOfBirth", () => {
  it("is an adult exactly on the 18th birthday and a minor the day before", () => {
    expect(classifyDateOfBirth("2008-11-23", NOW)).toBe("adult");
    expect(classifyDateOfBirth("2008-11-24", NOW)).toBe("minor");
  });
  it("uses the UTC-12 date so nobody is an adult early (00:30 UTC is still the previous day somewhere)", () => {
    const earlyUtc = new Date("2026-11-24T00:30:00Z");
    expect(conservativeReferenceDate(earlyUtc)).toEqual({ y: 2026, m: 11, d: 23 });
    expect(classifyDateOfBirth("2008-11-24", earlyUtc)).toBe("minor");
    expect(classifyDateOfBirth("2008-11-24", new Date("2026-11-24T12:00:00Z"))).toBe("adult");
  });
  it("a Feb 29 birthday becomes adult on Mar 1 of a non-leap 18th year, never earlier", () => {
    expect(classifyDateOfBirth("2008-02-29", new Date("2026-02-28T20:00:00Z"))).toBe("minor");
    expect(classifyDateOfBirth("2008-02-29", new Date("2026-03-01T12:00:00Z"))).toBe("adult");
  });
  it.each([undefined, null, "", "2008/11/23", "11-23-2008", "2008-13-01", "2008-02-30", "not a date", 20081123, "1899-12-31", "2099-01-01", "2026-11-24"])(
    "treats %j as unknown (fail closed)",
    (value) => expect(classifyDateOfBirth(value, NOW)).toBe("unknown"),
  );
});

describe("OD-02 evaluateCompetitionAdultGate", () => {
  it("accepts an all-adult draft", () => {
    const result = evaluateCompetitionAdultGate({ people: [person("a", "1990-01-01"), person("b", "1985-05-05")], entries: [entry(["a", "b"])] }, NOW);
    expect(result).toEqual({ ok: true });
  });

  it("refuses an under-18 competitor, including in Studio/Custom style drafts (no event-type exemption)", () => {
    const result = evaluateCompetitionAdultGate({ registrationMode: "studio", people: [person("a", "1990-01-01"), person("kid", "2010-06-01")], entries: [entry(["a", "kid"])] }, NOW);
    expect(result).toMatchObject({ ok: false, code: "minors_not_permitted", blocked: [{ personClientId: "kid", reason: "under_minimum_age" }] });
  });

  it("judges each competitor, never the purchaser: an adult buyer cannot vouch for a minor and a minor buyer field is ignored", () => {
    const adultBuyer = evaluateCompetitionAdultGate({ buyerName: "Parent", buyerDateOfBirth: "1980-01-01", people: [person("kid", "2012-01-01")], entries: [entry(["kid"])] }, NOW);
    expect(adultBuyer.ok).toBe(false);
    const minorBuyerField = evaluateCompetitionAdultGate({ buyerDateOfBirth: "2012-01-01", people: [person("a", "1990-01-01")], entries: [entry(["a"])] }, NOW);
    expect(minorBuyerField.ok).toBe(true);
  });

  it("fails closed when a competitor has no, malformed or impossible date of birth", () => {
    for (const dob of [undefined, "", "garbage", "2000-02-31"]) {
      const result = evaluateCompetitionAdultGate({ people: [person("a", dob)], entries: [entry(["a"])] }, NOW);
      expect(result).toMatchObject({ ok: false, code: "age_not_established", blocked: [{ personClientId: "a", reason: "age_not_established" }] });
    }
  });

  it("checks every member of a team and both halves of a couple; one minor refuses the whole draft", () => {
    const team = [1, 2, 3, 4, 5, 6].map((n) => person(`t${n}`, n === 5 ? "2009-12-01" : "1992-03-03"));
    const result = evaluateCompetitionAdultGate({ people: team, entries: [entry(team.map((p) => p.clientId))] }, NOW);
    expect(result).toMatchObject({ ok: false, code: "minors_not_permitted" });
    expect(result.ok === false && result.blocked.map((b) => b.personClientId)).toEqual(["t5"]);
    const couple = evaluateCompetitionAdultGate({ people: [person("a", "1990-01-01"), person("b", "2011-01-01")], entries: [entry(["a", "b"])] }, NOW);
    expect(couple.ok).toBe(false);
  });

  it("checks a minor attached only to a later entry (edit / additional entry cannot bypass)", () => {
    const adults = [person("a", "1990-01-01"), person("b", "1991-01-01")];
    const people = [...adults, person("kid", "2012-01-01")];
    const first = evaluateCompetitionAdultGate({ people: adults, entries: [entry(["a", "b"], "e1")] }, NOW);
    expect(first.ok).toBe(true);
    const second = evaluateCompetitionAdultGate({ people, entries: [entry(["a", "b"], "e1"), entry(["a", "kid"], "e2")] }, NOW);
    expect(second.ok).toBe(false);
  });

  it("refuses a roster person who supplied an under-18 date of birth even when not in any entry", () => {
    const result = evaluateCompetitionAdultGate({ people: [person("a", "1990-01-01"), person("kid", "2012-01-01")], entries: [entry(["a"])] }, NOW);
    expect(result).toMatchObject({ ok: false, code: "minors_not_permitted" });
  });

  it("does not demand a date of birth from a roster person who is in no entry (data minimisation)", () => {
    const result = evaluateCompetitionAdultGate({ people: [person("a", "1990-01-01"), person("spectator")], entries: [entry(["a"])] }, NOW);
    expect(result).toEqual({ ok: true });
  });

  it("fails closed when an entry references a participant id that is not on the roster", () => {
    const result = evaluateCompetitionAdultGate({ people: [person("a", "1990-01-01")], entries: [entry(["a", "ghost"])] }, NOW);
    expect(result).toMatchObject({ ok: false, code: "age_not_established", blocked: [{ personClientId: "ghost", reason: "age_not_established" }] });
  });

  it("minors_not_permitted wins over age_not_established when both occur", () => {
    const result = evaluateCompetitionAdultGate({ people: [person("a"), person("kid", "2012-01-01")], entries: [entry(["a", "kid"])] }, NOW);
    expect(result).toMatchObject({ ok: false, code: "minors_not_permitted" });
  });

  it.each([null, undefined, 5, "x", [], {}, { people: "no", entries: 7 }, { people: [null, 5, "x"], entries: [null, { participantIds: "no" }] }])(
    "does not throw on junk input %j",
    (junk) => {
      expect(() => evaluateCompetitionAdultGate(junk, NOW)).not.toThrow();
    },
  );

  it("is not fooled by junk participant ids or a person without a clientId inside an entry", () => {
    const result = evaluateCompetitionAdultGate({ people: [{ firstName: "x", dateOfBirth: "2012-01-01" }], entries: [{ participantIds: [""] }] }, NOW);
    expect(result.ok).toBe(false);
  });

  it("never returns a birthdate or an age: results carry only ids and reason codes", () => {
    const result = evaluateCompetitionAdultGate({ people: [person("kid", "2012-01-01")], entries: [entry(["kid"])] }, NOW);
    const serialized = JSON.stringify(result) + MINORS_NOT_PERMITTED_MESSAGE + AGE_NOT_ESTABLISHED_MESSAGE;
    expect(serialized).not.toMatch(/2012/);
    expect(serialized).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(Object.keys((result as { blocked: Array<object> }).blocked[0]).sort()).toEqual(["personClientId", "reason"]);
  });
});
