/*
  10C.4: competition participant roles.

  Two separate dimensions per participant of an entry:
    - relationship role (participant_role): student, professional, instructor (the instructing pro
      in ProPro), dancer, team_member, alternate, other;
    - dance role (dance_role): leader | follower | none, for THIS entry.

  allowedRolesForFormat and participantShapeErrors mirror public._comp10c_allowed_roles and
  public._comp10c4_participant_shape_errors line for line. The database is authoritative; this module
  gives the builder the same answers before submit.
*/

export type DanceRole = "leader" | "follower";

export const RELATIONSHIP_ROLES = ["dancer", "student", "professional", "instructor", "team_member", "alternate", "other"] as const;

const PAIR_FORMATS = ["pro_am", "pro_pro", "couple", "mixed_amateur", "professional"];

/** Relationship roles each entry format accepts (mirrors public._comp10c_allowed_roles). */
export function allowedRolesForFormat(entryFormat: string): string[] {
  if (entryFormat === "pro_am") return ["student", "professional"];
  if (entryFormat === "pro_pro") return ["instructor", "professional"];
  if (["couple", "mixed_amateur", "random_partner"].includes(entryFormat)) return ["dancer"];
  if (entryFormat === "professional") return ["professional"];
  if (entryFormat === "team") return ["team_member"];
  return ["dancer", "student", "professional", "instructor", "alternate", "other"];
}

/**
 * The participant combination errors for one entry (mirrors public._comp10c4_participant_shape_errors).
 * roles and danceRoles hold one value per participant; a dance role of "" means none.
 */
export function participantShapeErrors(entryFormat: string, contestType: string | null | undefined, roles: string[], danceRoles: string[]): string[] {
  const errors: string[] = [];
  const n = roles.length;
  const leaders = danceRoles.filter((role) => role === "leader").length;
  const followers = danceRoles.filter((role) => role === "follower").length;
  const invalid = danceRoles.filter((role) => !["", "leader", "follower"].includes(role ?? "")).length;
  const withDance = leaders + followers;
  const count = (value: string) => roles.filter((role) => role === value).length;
  if (invalid > 0) errors.push("choose Lead or Follow for each participant.");

  if (PAIR_FORMATS.includes(entryFormat)) {
    if (n !== 2) errors.push("this entry needs exactly two people.");
    if (entryFormat === "pro_am" && (count("student") !== 1 || count("professional") !== 1)) {
      errors.push("a ProAm entry needs one student and one professional.");
    }
    if (entryFormat === "pro_pro" && (count("instructor") !== 1 || count("professional") !== 1)) {
      errors.push("a ProPro entry needs one instructing professional and one competing professional.");
    }
    // Line dance partnerships (e.g. ProAm Line) have no lead/follow; if given it must still be a pair.
    if (!((contestType ?? "") === "line_dance" && withDance === 0) && (leaders !== 1 || followers !== 1)) {
      errors.push("choose one leader and one follower.");
    }
  } else if (entryFormat === "random_partner") {
    // Jack & Jill: one person registers in one role; partners are paired in the rounds.
    if (n !== 1) errors.push("enter exactly one person; partners are paired during the competition.");
    else if (withDance !== 1) errors.push("select Leader or Follower for this entry.");
  } else if (entryFormat === "team") {
    if (withDance > 0) errors.push("team entries do not use lead or follow.");
  }
  return errors;
}

/* ---------------------------------------------------------------- registration builder */

export type ParticipantSlot = { key: string; label: string; role: string; danceRole?: DanceRole };

/** Who-leads choice offered for a two-person partnership with distinct relationship roles. */
export type LeadChoice = { value: string; label: string };

/** The people an entry of this format needs, in display order. */
export function participantSlotsFor(entryFormat: string): ParticipantSlot[] {
  if (entryFormat === "pro_am") return [{ key: "student", label: "Student", role: "student" }, { key: "professional", label: "Professional", role: "professional" }];
  if (entryFormat === "pro_pro") {
    return [
      { key: "professional", label: "Competing professional", role: "professional" },
      { key: "instructor", label: "Instructing professional", role: "instructor" },
    ];
  }
  if (["couple", "mixed_amateur", "professional"].includes(entryFormat)) {
    const role = entryFormat === "professional" ? "professional" : "dancer";
    return [{ key: "leader", label: "Leader", role, danceRole: "leader" }, { key: "follower", label: "Follower", role, danceRole: "follower" }];
  }
  return [{ key: "dancer", label: "Dancer", role: "dancer" }];
}

/** The "who leads" options for ProAm / ProPro ("" = not applicable, offered only for line dance). */
export function leadChoicesFor(entryFormat: string, contestType: string | null | undefined): LeadChoice[] {
  const slots = participantSlotsFor(entryFormat);
  if (!["pro_am", "pro_pro"].includes(entryFormat)) return [];
  const choices = slots.map((slot) => ({ value: slot.key, label: `${slot.label} leads` }));
  return (contestType ?? "") === "line_dance" ? [{ value: "", label: "No lead/follow (line dance)" }, ...choices] : choices;
}

export function defaultLeadChoice(entryFormat: string, contestType: string | null | undefined) {
  return leadChoicesFor(entryFormat, contestType)[0]?.value ?? "";
}

/**
 * Builds the draft participant maps for one entry from the builder's selections.
 * slotPeople maps slot key -> roster person id; leadSlot names the slot whose person leads
 * (ProAm / ProPro); randomPartnerRole is the Jack & Jill role.
 */
export function buildEntryParticipants(input: {
  entryFormat: string;
  slotPeople: Record<string, string>;
  teamPeople: string[];
  leadSlot: string;
  randomPartnerRole: DanceRole;
}) {
  const participantRoles: Record<string, string> = {};
  const participantDanceRoles: Record<string, DanceRole> = {};
  if (input.entryFormat === "team") {
    for (const personId of input.teamPeople) participantRoles[personId] = "team_member";
    return { participantIds: [...input.teamPeople], participantRoles, participantDanceRoles };
  }
  const slots = participantSlotsFor(input.entryFormat);
  const participantIds: string[] = [];
  for (const slot of slots) {
    const personId = input.slotPeople[slot.key];
    if (!personId) continue;
    participantIds.push(personId);
    participantRoles[personId] = slot.role;
    if (slot.danceRole) participantDanceRoles[personId] = slot.danceRole;
  }
  if (["pro_am", "pro_pro"].includes(input.entryFormat) && input.leadSlot) {
    for (const slot of slots) {
      const personId = input.slotPeople[slot.key];
      if (personId) participantDanceRoles[personId] = slot.key === input.leadSlot ? "leader" : "follower";
    }
  }
  if (input.entryFormat === "random_partner" && participantIds[0]) participantDanceRoles[participantIds[0]] = input.randomPartnerRole;
  return { participantIds, participantRoles, participantDanceRoles };
}

/* ---------------------------------------------------------------- organizer labels */

const RELATIONSHIP_LABELS: Record<string, string> = {
  student: "Student",
  professional: "Professional",
  instructor: "Instructing professional",
  dancer: "Dancer",
  team_member: "Team member",
  alternate: "Alternate",
  other: "Other",
  // Pre-10C.4 rows stored lead/follow here.
  leader: "Leader",
  follower: "Follower",
};

/** "Student · Leads", "Dancer · Follows", "Team member" -- for organizer lists and check-in. */
export function describeParticipantRole(participantRole: string | null | undefined, danceRole: string | null | undefined) {
  const relationship = RELATIONSHIP_LABELS[participantRole ?? ""] ?? "Participant";
  const lead = danceRole === "leader" ? "Leads" : danceRole === "follower" ? "Follows" : "";
  if (!lead) return relationship;
  return relationship === "Dancer" ? (danceRole === "leader" ? "Leader" : "Follower") : `${relationship} · ${lead}`;
}
