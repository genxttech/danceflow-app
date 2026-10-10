import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedRolesForFormat,
  buildEntryParticipants,
  defaultLeadChoice,
  describeParticipantRole,
  leadChoicesFor,
  participantShapeErrors,
  participantSlotsFor,
} from "@/lib/competition/participantRoles";
import { allowedRolesForFormat as reExported } from "@/lib/competition/registrationPricing";
import { buildCompetitionCredentialTargets } from "@/lib/competition/checkin";
import { STUDIO_SIMPLE_V1_DEFAULTS } from "@/lib/competition/simple/studioSimpleV1";

const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const MIGRATION = read("src/lib/supabase/migrations/20261110090000_phase10c4_participant_role_integrity.sql");

describe("10C.4 relationship roles are separate from lead/follow", () => {
  it("no format accepts leader/follower as a relationship role any more", () => {
    for (const format of ["solo", "couple", "pro_am", "pro_pro", "mixed_amateur", "professional", "team", "random_partner", "custom"]) {
      expect(allowedRolesForFormat(format)).not.toContain("leader");
      expect(allowedRolesForFormat(format)).not.toContain("follower");
    }
    expect(allowedRolesForFormat("pro_am")).toEqual(["student", "professional"]);
    expect(allowedRolesForFormat("pro_pro")).toEqual(["instructor", "professional"]);
    expect(allowedRolesForFormat("couple")).toEqual(["dancer"]);
    expect(allowedRolesForFormat("professional")).toEqual(["professional"]);
    expect(allowedRolesForFormat("random_partner")).toEqual(["dancer"]);
    expect(allowedRolesForFormat("team")).toEqual(["team_member"]);
    expect(reExported).toBe(allowedRolesForFormat);
  });

  it("mirrors the SQL role sets and shape rules (same values and messages in the migration)", () => {
    expect(MIGRATION).toContain("when p_entry_format = 'pro_pro' then array['instructor', 'professional']");
    expect(MIGRATION).toContain("when p_entry_format in ('couple', 'mixed_amateur', 'random_partner') then array['dancer']");
    for (const message of [
      "choose Lead or Follow for each participant.",
      "this entry needs exactly two people.",
      "a ProAm entry needs one student and one professional.",
      "a ProPro entry needs one instructing professional and one competing professional.",
      "choose one leader and one follower.",
      "enter exactly one person; partners are paired during the competition.",
      "select Leader or Follower for this entry.",
      "team entries do not use lead or follow.",
    ]) {
      expect(MIGRATION).toContain(`'${message}'`);
    }
  });
});

describe("10C.4 participant combinations", () => {
  const shape = participantShapeErrors;

  it("ProAm: one student + one professional, opposite lead/follow, either way round", () => {
    expect(shape("pro_am", "single_dance", ["student", "professional"], ["leader", "follower"])).toEqual([]);
    expect(shape("pro_am", "single_dance", ["student", "professional"], ["follower", "leader"])).toEqual([]);
    expect(shape("pro_am", "single_dance", ["student", "student"], ["leader", "follower"])).toContain("a ProAm entry needs one student and one professional.");
    expect(shape("pro_am", "single_dance", ["professional", "professional"], ["leader", "follower"])).toContain("a ProAm entry needs one student and one professional.");
    expect(shape("pro_am", "single_dance", ["student", "professional"], ["leader", "leader"])).toContain("choose one leader and one follower.");
    expect(shape("pro_am", "single_dance", ["student", "professional"], ["", ""])).toContain("choose one leader and one follower.");
    expect(shape("pro_am", "single_dance", ["student", "professional", "student"], ["leader", "follower", ""])).toContain("this entry needs exactly two people.");
  });

  it("ProPro: one instructing + one competing professional, opposite lead/follow", () => {
    expect(shape("pro_pro", "multi_dance", ["instructor", "professional"], ["leader", "follower"])).toEqual([]);
    expect(shape("pro_pro", "multi_dance", ["instructor", "professional"], ["follower", "leader"])).toEqual([]);
    const pro = "a ProPro entry needs one instructing professional and one competing professional.";
    expect(shape("pro_pro", "multi_dance", ["professional", "professional"], ["leader", "follower"])).toContain(pro);
    expect(shape("pro_pro", "multi_dance", ["instructor", "instructor"], ["leader", "follower"])).toContain(pro);
    expect(shape("pro_pro", "multi_dance", ["instructor", "professional"], ["follower", "follower"])).toContain("choose one leader and one follower.");
    expect(shape("pro_pro", "multi_dance", ["instructor", "professional"], ["leader", ""])).toContain("choose one leader and one follower.");
    expect(shape("pro_pro", "multi_dance", ["instructor", "professional", "professional"], ["leader", "follower", ""])).toContain("this entry needs exactly two people.");
  });

  it("couple-style formats need exactly one leader and one follower", () => {
    for (const format of ["couple", "mixed_amateur", "professional"]) {
      const role = format === "professional" ? "professional" : "dancer";
      expect(shape(format, "single_dance", [role, role], ["leader", "follower"])).toEqual([]);
      expect(shape(format, "single_dance", [role, role], ["leader", "leader"])).toEqual(["choose one leader and one follower."]);
      expect(shape(format, "single_dance", [role, role], ["follower", "follower"])).toEqual(["choose one leader and one follower."]);
      expect(shape(format, "single_dance", [role], ["leader"])).toContain("this entry needs exactly two people.");
      expect(shape(format, "single_dance", [role, role, role], ["leader", "follower", ""])).toContain("this entry needs exactly two people.");
    }
  });

  it("Jack & Jill stays a one-person registration with a lead/follow role (no stored couple)", () => {
    expect(shape("random_partner", "jack_and_jill", ["dancer"], ["leader"])).toEqual([]);
    expect(shape("random_partner", "jack_and_jill", ["dancer"], ["follower"])).toEqual([]);
    expect(shape("random_partner", "jack_and_jill", ["dancer", "dancer"], ["leader", "follower"])).toEqual(["enter exactly one person; partners are paired during the competition."]);
    expect(shape("random_partner", "jack_and_jill", ["dancer"], [""])).toEqual(["select Leader or Follower for this entry."]);
    expect(participantSlotsFor("random_partner")).toHaveLength(1);
  });

  it("solo, custom and team keep their flexibility; team never takes lead/follow", () => {
    expect(shape("solo", "single_dance", ["dancer"], [""])).toEqual([]);
    expect(shape("solo", "single_dance", ["dancer"], ["follower"])).toEqual([]);
    expect(shape("custom", "showdance", ["dancer", "dancer"], ["", ""])).toEqual([]);
    expect(shape("custom", "showdance", ["dancer", "dancer"], ["leader", "leader"])).toEqual([]);
    expect(shape("team", "team", ["team_member", "team_member", "team_member"], ["", "", ""])).toEqual([]);
    expect(shape("team", "team", ["team_member", "team_member"], ["leader", ""])).toEqual(["team entries do not use lead or follow."]);
  });

  it("line dance partnerships may omit lead/follow entirely, but not half of it", () => {
    expect(shape("pro_am", "line_dance", ["student", "professional"], ["", ""])).toEqual([]);
    expect(shape("pro_am", "line_dance", ["student", "professional"], ["follower", "leader"])).toEqual([]);
    expect(shape("pro_am", "line_dance", ["student", "professional"], ["leader", ""])).toEqual(["choose one leader and one follower."]);
    expect(shape("pro_am", "single_dance", ["student", "professional"], ["", ""])).toEqual(["choose one leader and one follower."]);
  });

  it("checks each relationship count on its own, not only through the two-person rule", () => {
    expect(shape("pro_am", "single_dance", ["student", "professional", "student"], ["leader", "follower", ""])).toEqual([
      "this entry needs exactly two people.",
      "a ProAm entry needs one student and one professional.",
    ]);
    expect(shape("pro_pro", "multi_dance", ["professional", "dancer"], ["leader", "follower"])).toEqual([
      "a ProPro entry needs one instructing professional and one competing professional.",
    ]);
    expect(shape("pro_am", "single_dance", ["student", "dancer"], ["leader", "follower"])).toEqual(["a ProAm entry needs one student and one professional."]);
  });

  it("rejects unknown lead/follow values", () => {
    expect(shape("couple", "single_dance", ["dancer", "dancer"], ["lead", "follower"])).toContain("choose Lead or Follow for each participant.");
  });
});

describe("10C.4 registration builder", () => {
  it("ProPro asks for the instructing and the competing professional, never 'Professional 1/2'", () => {
    const labels = participantSlotsFor("pro_pro").map((slot) => slot.label);
    expect(labels).toEqual(["Competing professional", "Instructing professional"]);
    expect(labels.join(" ")).not.toMatch(/Professional [12]/);
    expect(participantSlotsFor("pro_pro").map((slot) => slot.role).sort()).toEqual(["instructor", "professional"]);
  });

  it("ProAm and ProPro offer a 'who leads' choice; line dance can opt out", () => {
    expect(leadChoicesFor("pro_am", "single_dance").map((choice) => choice.label)).toEqual(["Student leads", "Professional leads"]);
    expect(leadChoicesFor("pro_pro", "multi_dance").map((choice) => choice.label)).toEqual(["Competing professional leads", "Instructing professional leads"]);
    expect(defaultLeadChoice("pro_am", "line_dance")).toBe("");
    expect(leadChoicesFor("couple", "single_dance")).toEqual([]);
    expect(leadChoicesFor("random_partner", "jack_and_jill")).toEqual([]);
  });

  it("builds drafts the database accepts for every format", () => {
    const proAm = buildEntryParticipants({ entryFormat: "pro_am", slotPeople: { student: "s", professional: "p" }, teamPeople: [], leadSlot: "professional", randomPartnerRole: "leader" });
    expect(proAm).toEqual({ participantIds: ["s", "p"], participantRoles: { s: "student", p: "professional" }, participantDanceRoles: { s: "follower", p: "leader" } });

    const proPro = buildEntryParticipants({ entryFormat: "pro_pro", slotPeople: { professional: "c", instructor: "i" }, teamPeople: [], leadSlot: "instructor", randomPartnerRole: "leader" });
    expect(proPro.participantRoles).toEqual({ c: "professional", i: "instructor" });
    expect(proPro.participantDanceRoles).toEqual({ c: "follower", i: "leader" });

    const couple = buildEntryParticipants({ entryFormat: "couple", slotPeople: { leader: "l", follower: "f" }, teamPeople: [], leadSlot: "", randomPartnerRole: "leader" });
    expect(couple).toEqual({ participantIds: ["l", "f"], participantRoles: { l: "dancer", f: "dancer" }, participantDanceRoles: { l: "leader", f: "follower" } });

    const pro = buildEntryParticipants({ entryFormat: "professional", slotPeople: { leader: "l", follower: "f" }, teamPeople: [], leadSlot: "", randomPartnerRole: "leader" });
    expect(pro.participantRoles).toEqual({ l: "professional", f: "professional" });

    const jj = buildEntryParticipants({ entryFormat: "random_partner", slotPeople: { dancer: "d" }, teamPeople: [], leadSlot: "", randomPartnerRole: "follower" });
    expect(jj).toEqual({ participantIds: ["d"], participantRoles: { d: "dancer" }, participantDanceRoles: { d: "follower" } });

    const team = buildEntryParticipants({ entryFormat: "team", slotPeople: {}, teamPeople: ["a", "b", "c"], leadSlot: "", randomPartnerRole: "leader" });
    expect(team).toEqual({ participantIds: ["a", "b", "c"], participantRoles: { a: "team_member", b: "team_member", c: "team_member" }, participantDanceRoles: {} });

    const line = buildEntryParticipants({ entryFormat: "pro_am", slotPeople: { student: "s", professional: "p" }, teamPeople: [], leadSlot: "", randomPartnerRole: "leader" });
    expect(line.participantDanceRoles).toEqual({});

    for (const [format, contestType, built] of [["pro_am", "single_dance", proAm], ["pro_pro", "multi_dance", proPro], ["couple", "single_dance", couple], ["professional", "single_dance", pro], ["random_partner", "jack_and_jill", jj], ["team", "team", team], ["pro_am", "line_dance", line]] as const) {
      const ids = built.participantIds;
      const danceRoles = built.participantDanceRoles as Record<string, string>;
      expect(participantShapeErrors(format, contestType, ids.map((id) => built.participantRoles[id]), ids.map((id) => danceRoles[id] ?? ""))).toEqual([]);
    }
  });

  it("the public builder uses the shared slots and sends participantDanceRoles", () => {
    const builder = read("src/app/events/[slug]/competition/register/CompetitionRegistrationBuilder.tsx");
    expect(builder).toContain("buildEntryParticipants(");
    expect(builder).toContain("participantDanceRoles,");
    expect(builder).toContain("Who leads?");
    expect(builder).not.toContain("Professional 1");
  });
});

describe("10C.4 organizer display and downstream readers", () => {
  it("labels both dimensions in human words", () => {
    expect(describeParticipantRole("student", "leader")).toBe("Student · Leads");
    expect(describeParticipantRole("instructor", "follower")).toBe("Instructing professional · Follows");
    expect(describeParticipantRole("professional", "leader")).toBe("Professional · Leads");
    expect(describeParticipantRole("dancer", "follower")).toBe("Follower");
    expect(describeParticipantRole("team_member", null)).toBe("Team member");
    expect(describeParticipantRole("leader", null)).toBe("Leader");
    for (const path of ["src/app/app/events/[id]/competition/registrations/page.tsx", "src/app/app/events/[id]/competition/checkin/[sessionId]/page.tsx"]) {
      const source = read(path);
      expect(source).toContain("describeParticipantRole(");
      expect(source).toContain("dance_role");
    }
  });

  it("couple competitor numbers still go to the leader (number_holder_role now matches dance_role)", () => {
    const targets = buildCompetitionCredentialTargets({
      entries: [{ id: "e1", division_id: "d1", display_name: "Lee / Fay" }],
      divisions: [{ id: "d1", contest_id: "c1" }],
      rules: [{ contest_id: "c1", number_assignment_mode: "primary_participant", number_holder_role: "leader" }],
      participants: [
        { entry_id: "e1", registration_attendee_id: "att-f", participant_role: "dancer", dance_role: "follower", display_name: "Fay" },
        { entry_id: "e1", registration_attendee_id: "att-l", participant_role: "dancer", dance_role: "leader", display_name: "Lee" },
      ],
    } as Parameters<typeof buildCompetitionCredentialTargets>[0]);
    expect([...targets.values()].map((target) => target.registrationAttendeeId)).toEqual(["att-l"]);
  });

  it("heat conflict detection still treats couple dancers as partners", () => {
    const planner = read("src/lib/competition/heatPlanner.ts");
    expect(planner).toContain(`(row.participant_role === "dancer" && row.dance_role)`);
    expect(read("src/app/app/events/[id]/competition/readiness/actions.ts")).toContain("participant_role, dance_role, display_name");
  });
});

describe("10C.4 Studio Simple stays simple", () => {
  it("exposes exactly ProAm, Couples, Solo, Showcase, Jack & Jill and Team (no ProPro)", () => {
    const categories = (STUDIO_SIMPLE_V1_DEFAULTS as unknown as { categoryTypes: Record<string, { entry_format: string }> }).categoryTypes;
    expect(Object.keys(categories)).toEqual(["pro_am", "couples", "solo", "showcase", "jack_and_jill", "team"]);
    expect(Object.values(categories).map((category) => category.entry_format)).not.toContain("pro_pro");
  });
});
