/** Row shape of my_competition_judging_assignments() (E1). */
export type JudgingAssignmentRow = {
  event_id: string;
  event_name: string;
  event_start_date: string | null;
  official_id: string;
  official_role: string;
  round_id: string | null;
  round_name: string | null;
  round_type: string | null;
  round_status: string | null;
  division_name: string | null;
  judge_letter: string | null;
};

export type JudgingEvent = {
  eventId: string;
  eventName: string;
  eventStartDate: string | null;
  officialRole: string;
  rounds: Array<{ roundId: string; roundName: string; roundStatus: string; divisionName: string | null; judgeLetter: string | null }>;
};

/** Groups the flat RPC rows by event; an event with no assignment still appears with no rounds. */
export function groupJudgingAssignments(rows: JudgingAssignmentRow[]): JudgingEvent[] {
  const byEvent = new Map<string, JudgingEvent>();
  for (const row of rows) {
    let event = byEvent.get(row.event_id);
    if (!event) {
      event = { eventId: row.event_id, eventName: row.event_name, eventStartDate: row.event_start_date, officialRole: row.official_role, rounds: [] };
      byEvent.set(row.event_id, event);
    }
    if (row.round_id && row.round_name) {
      event.rounds.push({
        roundId: row.round_id,
        roundName: row.round_name,
        roundStatus: row.round_status ?? "draft",
        divisionName: row.division_name,
        judgeLetter: row.judge_letter,
      });
    }
  }
  return Array.from(byEvent.values());
}
