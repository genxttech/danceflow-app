import { toPulseCards } from "@/lib/pulseCards";

/* Wire-shape card bodies for the Pulse screen tests (a11y audit, reading order), one per role the server serves. */

const requests = {
  state: "ok",
  bookingRequests: 1,
  selfService: 1,
  total: 2,
  oldestCreatedAt: "2026-11-08T15:00:00.000Z",
  truncated: false,
  recent: [
    { id: "r1", source: "self_service", kind: "reschedule", createdAt: "2026-11-10T09:00:00.000Z", requestedStartsAt: null, clientName: "Maya Chen" },
    { id: "r2", source: "booking_request", kind: "book", createdAt: "2026-11-08T15:00:00.000Z", requestedStartsAt: null, clientName: "Priya Nair" },
  ],
};
const leads = {
  state: "ok",
  newLast7Days: 2,
  uncontacted: 1,
  followUpsOverdue: 1,
  truncated: false,
  recent: [
    { id: "l1", name: "Priya Nair", createdAt: "2026-11-09T10:00:00.000Z", sourceLabel: "Website", uncontacted: true, followUpDueAt: null },
    { id: "l2", name: "Marcus Webb", createdAt: "2026-11-07T10:00:00.000Z", sourceLabel: "Instagram", uncontacted: false, followUpDueAt: "2026-11-08T10:00:00.000Z" },
  ],
};
const aria = { state: "ok", open: 1, truncated: false, recent: [{ id: "x1", title: "Reach out to Maya Chen, who has not booked in 6 weeks", priority: "high", createdAt: "2026-11-09T00:00:00.000Z" }] };
const confirmations = {
  state: "ok",
  windowHours: 48,
  total: 2,
  truncated: false,
  upcoming: [
    { id: "c1", startsAt: "2026-11-10T20:00:00.000Z", appointmentType: "private_lesson", clientName: "Maya Chen" },
    { id: "c2", startsAt: "2026-11-11T15:00:00.000Z", appointmentType: "intro_lesson", clientName: "Priya Nair" },
  ],
};

export const OWNER_CARDS = toPulseCards({
  requests,
  confirmations,
  leads,
  aria,
  exceptions: { state: "ok", cancelledToday: 1, lowPackages: 2, truncated: false },
  health: { state: "ok", scope: "studio", sessionsToday: 5, sessionsDone: 1, sessionsAhead: 4, truncated: false },
});

/** Front desk: everything but ARIA. */
export const FRONT_DESK_CARDS = toPulseCards({
  requests,
  confirmations,
  leads,
  aria: null,
  exceptions: { state: "ok", cancelledToday: 1, lowPackages: 2, truncated: false },
  health: { state: "ok", scope: "studio", sessionsToday: 5, sessionsDone: 1, sessionsAhead: 4, truncated: false },
});

/** Instructor: own requests and unconfirmed appointments without names, exceptions without packages, own sessions; no leads or ARIA. */
export const INSTRUCTOR_CARDS = toPulseCards({
  requests: { ...requests, total: 1, bookingRequests: 1, selfService: 0, recent: [{ id: "r2", source: "booking_request", kind: "book", createdAt: "2026-11-08T15:00:00.000Z", requestedStartsAt: null, clientName: null }] },
  confirmations: { ...confirmations, total: 1, upcoming: [{ ...confirmations.upcoming[0], clientName: null }] },
  leads: null,
  aria: null,
  exceptions: { state: "ok", cancelledToday: 0, lowPackages: null, truncated: false },
  health: { state: "ok", scope: "own", sessionsToday: 2, sessionsDone: 1, sessionsAhead: 1, truncated: false },
});

export const UNAVAILABLE_CARDS = toPulseCards({
  requests: { state: "unavailable" },
  leads: { state: "unavailable" },
  aria: { state: "unavailable" },
  exceptions: { state: "unavailable" },
  health: { state: "unavailable" },
  confirmations: { state: "unavailable" },
});
