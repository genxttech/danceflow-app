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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where an assigned official goes from /app/judging. A panel judge (has a letter) opens the ballot; the chair and the scorer
 * open the desk. These are navigation only: the ballot and desk pages authorize through their round-keyed RPCs and 404 anyone
 * else, so a link never grants access.
 */
export function judgingRoundLinks(
  eventId: string,
  round: { roundId: string; judgeLetter: string | null },
  officialRole: string,
): { ballot: string | null; desk: string | null } {
  if (!UUID.test(eventId) || !UUID.test(round.roundId)) return { ballot: null, desk: null };
  const base = `/app/judging/${eventId}/rounds/${round.roundId}/ballot`;
  const known = officialRole === "judge" || officialRole === "chair" || officialRole === "scorer";
  return {
    ballot: known && round.judgeLetter ? base : null,
    desk: officialRole === "chair" || officialRole === "scorer" ? `${base}/desk` : null,
  };
}
