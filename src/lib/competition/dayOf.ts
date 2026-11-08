/*
  O1: day-of floor console -- pure helpers (no I/O). The database functions (schedule_competition_round,
  start_competition_round, cancel_competition_round, advance_competition_floor_heat) stay the only authority;
  everything here only decides what to show and which button to offer.
*/

import { withRetryOnce, type RpcCall, type RpcResult } from "@/lib/competition/results/advancement";
import { hasResultMessage, isRetryableText, resultErrorMessage } from "@/lib/competition/results/messages";

export type HeatRunState = "scheduled" | "staging" | "active" | "complete" | "mixed";

export type DayOfHeatInput = {
  id: string;
  floorHeatId: string;
  roundId: string;
  status: string;
  lockState: string;
};

export type DayOfFloorHeat = {
  id: string;
  number: number;
  state: HeatRunState;
  /** Scoring heat statuses of the floor heat, de-duplicated. */
  statuses: string[];
  roundIds: string[];
  locked: boolean;
};

export type RoundStatus =
  | "draft" | "scheduled" | "active" | "ballots_locked" | "calculated" | "approved" | "published" | "complete" | "cancelled";

/** Order of the day-of heat statuses. */
const HEAT_STEPS = ["scheduled", "staging", "active", "complete"] as const;

export function floorHeatState(statuses: string[]): HeatRunState {
  const unique = Array.from(new Set(statuses));
  if (unique.length === 1 && (HEAT_STEPS as readonly string[]).includes(unique[0])) return unique[0] as HeatRunState;
  return "mixed";
}

export function buildDayOfFloorHeats(
  floorHeats: Array<{ id: string; heat_number: number }>,
  scoringHeats: DayOfHeatInput[],
): DayOfFloorHeat[] {
  return [...floorHeats]
    .sort((left, right) => left.heat_number - right.heat_number)
    .map((floorHeat) => {
      const heats = scoringHeats.filter((heat) => heat.floorHeatId === floorHeat.id);
      const statuses = Array.from(new Set(heats.map((heat) => heat.status)));
      return {
        id: floorHeat.id,
        number: floorHeat.heat_number,
        state: heats.length === 0 ? "mixed" : floorHeatState(statuses),
        statuses,
        roundIds: Array.from(new Set(heats.map((heat) => heat.roundId))),
        locked: heats.some((heat) => heat.lockState !== "open"),
      };
    });
}

export type HeatAction = { to: "staging" | "active" | "complete"; label: string };

export function nextHeatAction(state: HeatRunState): HeatAction | null {
  if (state === "scheduled") return { to: "staging", label: "Call to floor" };
  if (state === "staging") return { to: "active", label: "Start heat" };
  if (state === "active") return { to: "complete", label: "Complete heat" };
  return null;
}

export type FloorPosition = { current: DayOfFloorHeat | null; next: DayOfFloorHeat | null };

/** Current = the heat on the floor (active, else staging, lowest number); next = the first unfinished heat after it. */
export function floorPosition(floorHeats: DayOfFloorHeat[]): FloorPosition {
  const ordered = [...floorHeats].sort((left, right) => left.number - right.number);
  const current = ordered.find((heat) => heat.state === "active") ?? ordered.find((heat) => heat.state === "staging") ?? null;
  const next = ordered.find((heat) => heat.state === "scheduled" && (!current || heat.number > current.number)) ?? null;
  return { current, next };
}

export function canOfferHeatAction(heat: DayOfFloorHeat, roundStatusById: Map<string, string>): { allowed: boolean; reason?: string } {
  const action = nextHeatAction(heat.state);
  if (!action) return { allowed: false };
  if (heat.locked) return { allowed: false, reason: "A scoring heat in this heat is locked." };
  const inactive = heat.roundIds.filter((roundId) => roundStatusById.get(roundId) !== "active");
  if (inactive.length > 0) return { allowed: false, reason: "Start the round first." };
  return { allowed: true };
}

export type RoundAction = { kind: "schedule" | "start"; label: string };

export function nextRoundAction(status: string): RoundAction | null {
  if (status === "draft") return { kind: "schedule", label: "Schedule round" };
  if (status === "scheduled") return { kind: "start", label: "Start round" };
  return null;
}

const NON_CANCELLABLE = new Set(["published", "complete", "cancelled"]);
export function canCancelRound(status: string) {
  return !NON_CANCELLABLE.has(status);
}

const ROUND_LABELS: Record<string, string> = {
  draft: "Not scheduled",
  scheduled: "Scheduled",
  active: "Running",
  ballots_locked: "Ballots locked",
  calculated: "Calculated",
  approved: "Approved",
  published: "Published",
  complete: "Complete",
  cancelled: "Cancelled",
};
export function roundStatusLabel(status: string) {
  return ROUND_LABELS[status] ?? status;
}

const HEAT_LABELS: Record<HeatRunState, string> = {
  scheduled: "Waiting",
  staging: "On deck",
  active: "On the floor",
  complete: "Done",
  mixed: "Check heat",
};
export function heatStateLabel(state: HeatRunState) {
  return HEAT_LABELS[state];
}

/** Plain-language message for staff; never a raw database error. */
export function friendlyDayOfError(error: { message?: string; code?: string | null } | null | undefined) {
  const message = error?.message ?? "";
  const match = message.match(/COMPO1_[A-Z_]+:\s*([\s\S]+?)(?:\n|$)/);
  if (match) return match[1].replace(/\s+/g, " ").trim();
  if (/COMP10D_SCHEDULE_PUBLISHED|COMPO1_RUN_IN_PROGRESS/.test(message)) return "The running order cannot change once heats have started.";
  // CF1: Final start refusals (COMP_ADVANCEMENT_*, COMP_ROSTER_*, COMP_CALLBACK_TARGET_BELOW_MINIMUM) and "try again" database answers.
  const raw = `${error?.code ?? ""} ${message}`;
  if (hasResultMessage(raw) || isRetryableText(raw)) return resultErrorMessage(raw);
  return "That change could not be saved. Refresh and try again.";
}

/**
 * Starts a round. Final start can meet a deadlock (40P01), a lock wait (55P03) or a statement timeout (57014); the call is repeated
 * once with the same request id, so a lost answer is replayed by the database instead of applied twice. Other errors are returned as is.
 */
export function startCompetitionRound(rpc: RpcCall, roundId: string, requestId: string): PromiseLike<RpcResult> {
  return withRetryOnce(rpc)("start_competition_round", { p_round_id: roundId, p_request_id: requestId });
}

/** SC1 owns scratching; the console only links to it. */
export function scratchHref(eventId: string, entryId: string) {
  return `/app/events/${eventId}/competition/registrations/scratch/${entryId}`;
}

export function dayOfHref(eventId: string) {
  return `/app/events/${eventId}/competition/day-of`;
}
