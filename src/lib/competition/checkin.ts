export type CheckinEntry = { id: string; division_id: string; display_name: string };
export type CheckinDivision = { id: string; contest_id: string | null };
export type CheckinRule = { contest_id: string; number_assignment_mode: string; number_holder_role: string | null };
export type CheckinEntryParticipant = { entry_id: string; registration_attendee_id: string | null; participant_role: string; display_name: string };

export type CredentialTarget = {
  key: string;
  holderType: "participant" | "entry";
  registrationAttendeeId: string | null;
  entryId: string | null;
  displayName: string;
  credentialType: "competitor_number" | "team_number";
};

export function buildCompetitionCredentialTargets(input: {
  entries: CheckinEntry[];
  divisions: CheckinDivision[];
  rules: CheckinRule[];
  participants: CheckinEntryParticipant[];
}) {
  const targets = new Map<string, CredentialTarget>();
  for (const entry of input.entries) {
    const division = input.divisions.find((item) => item.id === entry.division_id);
    const rule = input.rules.find((item) => item.contest_id === division?.contest_id);
    if (!rule || rule.number_assignment_mode === "none") continue;
    const participants = input.participants.filter((item) => item.entry_id === entry.id);
    if (["team", "per_entry"].includes(rule.number_assignment_mode)) {
      const key = `entry:${entry.id}`;
      targets.set(key, { key, holderType: "entry", registrationAttendeeId: null, entryId: entry.id, displayName: entry.display_name, credentialType: "team_number" });
      continue;
    }
    const holders = rule.number_assignment_mode === "per_participant"
      ? participants
      : [participants.find((item) => item.participant_role === rule.number_holder_role) ?? participants[0]].filter(Boolean) as CheckinEntryParticipant[];
    for (const holder of holders) {
      if (!holder.registration_attendee_id) continue;
      const key = `participant:${holder.registration_attendee_id}`;
      targets.set(key, { key, holderType: "participant", registrationAttendeeId: holder.registration_attendee_id, entryId: null, displayName: holder.display_name, credentialType: "competitor_number" });
    }
  }
  return [...targets.values()];
}
