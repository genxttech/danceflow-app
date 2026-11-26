import type { StudioAppointment } from "@/lib/staffApi";

/*
  "Next up" for the front desk's studio day: the one obvious thing to do next. Pure, so the rule is testable without a screen.

  - A lesson or class is OPEN until it has a result: scheduled, confirmed or rescheduled. attended, no_show and cancelled are done (a recorded result is final in the app).
  - The target is the earliest open lesson or class that has not ended yet (in progress counts). Nothing is picked for rentals or other types: they have no check-in here.
  - If nothing is left to do ahead, the target is the oldest open lesson or class that has already ended, because its result is still missing.
  - `behind` counts the ended open ones, so the screen can say how many results are missing.
  - A kind is offered only when its write or attendance capability is on in this build AND the caller's studio role may mark attendance (the screen checks the role): the same two
    conditions the appointment screen needs for its controls.
*/

const OPEN = ["scheduled", "confirmed", "rescheduled"];
const ONE_TO_ONE = ["private_lesson", "intro_lesson", "coaching"];

export type NextUpKind = "check_in" | "take_attendance" | "record_result";

export type NextUp = {
  appointment: StudioAppointment;
  kind: NextUpKind;
  /** Open lessons and classes that have already ended and still have no result (not counting the target when it is one of them). */
  behind: number;
};

export type NextUpCapabilities = { oneToOne: boolean; classes: boolean };

export function nextUp(appointments: readonly StudioAppointment[], nowMs: number, can: NextUpCapabilities): NextUp | null {
  const open = appointments
    .filter((a) => OPEN.includes(a.status) && ((can.oneToOne && ONE_TO_ONE.includes(a.appointmentType)) || (can.classes && a.appointmentType === "group_class")))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));

  // an unreadable end time falls back to the start time, so a bad row can never hold the card "ahead" forever
  const ended = (a: StudioAppointment) => {
    const end = Date.parse(a.endsAt);
    return (Number.isFinite(end) ? end : Date.parse(a.startsAt)) <= nowMs;
  };
  const ahead = open.filter((a) => !ended(a));
  const behind = open.filter(ended);

  if (ahead.length > 0) {
    const target = ahead[0];
    return { appointment: target, kind: target.appointmentType === "group_class" ? "take_attendance" : "check_in", behind: behind.length };
  }
  if (behind.length > 0) {
    return { appointment: behind[0], kind: "record_result", behind: behind.length - 1 };
  }
  return null;
}

/** What the card's button says. */
export function nextUpLabel(kind: NextUpKind, who: string) {
  if (kind === "take_attendance") return "Take attendance";
  if (kind === "record_result") return `Record the result for ${who}`;
  return `Check in ${who}`;
}

/** "2026-11-24": the calendar date of an instant in a time zone. Used to tell whether the day on screen is today without relying on how the screen got there. */
export function dateInZone(nowMs: number, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs));
  } catch {
    return null;
  }
}
