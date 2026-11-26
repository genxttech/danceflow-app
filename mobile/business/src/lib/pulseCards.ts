/*
  The Pulse command-center cards (GET /pulse?include=cards), normalised for the screen.

  Each card has three possible wire states and the app treats them differently:
    - absent or null  -> hidden (the viewer's role may not see it, or the server predates the cards): nothing is drawn, no error;
    - { state: "unavailable" } or a shape this app cannot read -> that card shows a short "could not load" line, the rest of the screen is unaffected;
    - { state: "ok", ... } -> the numbers, every one clamped to a non-negative integer so a bad value is 0, never NaN on screen.
  Nothing here triggers an action: the cards are read only.
*/

export type CardUnavailable = { state: "unavailable" };

export type PulseRequestItem = {
  id: string;
  source: "booking_request" | "self_service";
  kind: "book" | "reschedule" | "cancel" | null;
  createdAt: string;
  requestedStartsAt: string | null;
  clientName: string | null;
};
export type RequestsCard = {
  state: "ok";
  bookingRequests: number;
  selfService: number;
  total: number;
  oldestCreatedAt: string | null;
  recent: PulseRequestItem[];
  truncated: boolean;
};
export type PulseLeadItem = { id: string; name: string; createdAt: string; sourceLabel: string; uncontacted: boolean; followUpDueAt: string | null };
export type LeadsCard = { state: "ok"; newLast7Days: number; uncontacted: number; followUpsOverdue: number; recent: PulseLeadItem[]; truncated: boolean };
export type PulseAriaItem = { id: string; title: string; priority: string | null; createdAt: string };
export type AriaCard = { state: "ok"; open: number; recent: PulseAriaItem[]; truncated: boolean };
export type ExceptionsCard = { state: "ok"; cancelledToday: number; lowPackages: number | null; truncated: boolean };
export type HealthCard = { state: "ok"; scope: "studio" | "own"; sessionsToday: number; sessionsDone: number; sessionsAhead: number; truncated: boolean };

export type PulseConfirmationItem = { id: string; startsAt: string; appointmentType: string; clientName: string | null };
/** Appointments starting within the server's window (48 hours) that the dancer has not confirmed. */
export type ConfirmationsCard = { state: "ok"; windowHours: number; total: number; upcoming: PulseConfirmationItem[]; truncated: boolean };

export type PulseCards = {
  requests: RequestsCard | CardUnavailable | null;
  leads: LeadsCard | CardUnavailable | null;
  aria: AriaCard | CardUnavailable | null;
  exceptions: ExceptionsCard | CardUnavailable | null;
  health: HealthCard | CardUnavailable | null;
  /** null also when the server predates the card. */
  confirmations: ConfirmationsCard | CardUnavailable | null;
};

const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const obj = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const unavailable: CardUnavailable = { state: "unavailable" };

/** Wraps one card parser: null stays hidden, "unavailable" and anything unreadable become the unavailable state. */
function card<T>(raw: unknown, parse: (r: Record<string, unknown>) => T | null): T | CardUnavailable | null {
  if (raw === null || raw === undefined) return null;
  const r = obj(raw);
  if (!r || r.state !== "ok") return unavailable;
  try {
    return parse(r) ?? unavailable;
  } catch {
    return unavailable;
  }
}

export function toPulseCards(raw: unknown): PulseCards | null {
  const r = obj(raw);
  if (!r) return null;
  return {
    requests: card(r.requests, (c): RequestsCard => ({
      state: "ok",
      bookingRequests: num(c.bookingRequests),
      selfService: num(c.selfService),
      total: num(c.total),
      oldestCreatedAt: str(c.oldestCreatedAt),
      truncated: c.truncated === true,
      recent: list(c.recent).flatMap((item): PulseRequestItem[] => {
        const i = obj(item);
        const id = i ? str(i.id) : null;
        const createdAt = i ? str(i.createdAt) : null;
        if (!i || !id || !createdAt) return [];
        return [
          {
            id,
            source: i.source === "self_service" ? "self_service" : "booking_request",
            kind: i.kind === "reschedule" || i.kind === "cancel" || i.kind === "book" ? i.kind : null,
            createdAt,
            requestedStartsAt: str(i.requestedStartsAt),
            clientName: str(i.clientName),
          },
        ];
      }),
    })),
    leads: card(r.leads, (c): LeadsCard => ({
      state: "ok",
      newLast7Days: num(c.newLast7Days),
      uncontacted: num(c.uncontacted),
      followUpsOverdue: num(c.followUpsOverdue),
      truncated: c.truncated === true,
      recent: list(c.recent).flatMap((item): PulseLeadItem[] => {
        const i = obj(item);
        const id = i ? str(i.id) : null;
        const createdAt = i ? str(i.createdAt) : null;
        if (!i || !id || !createdAt) return [];
        return [{ id, name: str(i.name) ?? "Unnamed lead", createdAt, sourceLabel: str(i.sourceLabel) ?? "Studio", uncontacted: i.uncontacted === true, followUpDueAt: str(i.followUpDueAt) }];
      }),
    })),
    aria: card(r.aria, (c): AriaCard => ({
      state: "ok",
      open: num(c.open),
      truncated: c.truncated === true,
      recent: list(c.recent).flatMap((item): PulseAriaItem[] => {
        const i = obj(item);
        const id = i ? str(i.id) : null;
        const createdAt = i ? str(i.createdAt) : null;
        if (!i || !id || !createdAt) return [];
        return [{ id, title: str(i.title) ?? "Suggestion", priority: str(i.priority), createdAt }];
      }),
    })),
    confirmations: card(r.confirmations, (c): ConfirmationsCard => ({
      state: "ok",
      windowHours: num(c.windowHours) || 48,
      total: num(c.total),
      truncated: c.truncated === true,
      upcoming: list(c.upcoming).flatMap((item): PulseConfirmationItem[] => {
        const i = obj(item);
        const id = i ? str(i.id) : null;
        const startsAt = i ? str(i.startsAt) : null;
        // an unreadable time would break the date formatting, so the row is dropped (the total still counts it)
        if (!i || !id || !startsAt || !Number.isFinite(Date.parse(startsAt))) return [];
        return [{ id, startsAt, appointmentType: str(i.appointmentType) ?? "appointment", clientName: str(i.clientName) }];
      }),
    })),
    exceptions: card(r.exceptions, (c): ExceptionsCard => ({
      state: "ok",
      cancelledToday: num(c.cancelledToday),
      lowPackages: c.lowPackages === null || c.lowPackages === undefined ? null : num(c.lowPackages),
      truncated: c.truncated === true,
    })),
    health: card(r.health, (c): HealthCard => ({
      state: "ok",
      scope: c.scope === "studio" ? "studio" : "own",
      sessionsToday: num(c.sessionsToday),
      sessionsDone: num(c.sessionsDone),
      sessionsAhead: num(c.sessionsAhead),
      truncated: c.truncated === true,
    })),
  };
}

export type NeedsYouItem = { key: "requests" | "confirmations" | "leadsUncontacted" | "leadsOverdue" | "aria"; label: string; count: number };

/** The "Needs you" lines: open requests, unconfirmed appointments, uncontacted leads, overdue lead follow-ups, open ARIA suggestions. Separate lines for leads so one lead is never counted twice. Pure, shared by the screen and the tests. */
export function needsYouItems(cards: PulseCards): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  if (cards.requests?.state === "ok" && cards.requests.total > 0) {
    items.push({ key: "requests", count: cards.requests.total, label: plural(cards.requests.total, "lesson request waiting", "lesson requests waiting") });
  }
  if (cards.confirmations?.state === "ok" && cards.confirmations.total > 0) {
    const within = `in the next ${cards.confirmations.windowHours} hours`;
    items.push({ key: "confirmations", count: cards.confirmations.total, label: plural(cards.confirmations.total, `appointment not confirmed ${within}`, `appointments not confirmed ${within}`) });
  }
  if (cards.leads?.state === "ok") {
    if (cards.leads.followUpsOverdue > 0) items.push({ key: "leadsOverdue", count: cards.leads.followUpsOverdue, label: plural(cards.leads.followUpsOverdue, "lead follow-up overdue", "lead follow-ups overdue") });
    if (cards.leads.uncontacted > 0) items.push({ key: "leadsUncontacted", count: cards.leads.uncontacted, label: plural(cards.leads.uncontacted, "lead not contacted yet", "leads not contacted yet") });
  }
  if (cards.aria?.state === "ok" && cards.aria.open > 0) {
    items.push({ key: "aria", count: cards.aria.open, label: plural(cards.aria.open, "ARIA suggestion to review", "ARIA suggestions to review") });
  }
  return items;
}

/** How long something has been waiting, in words ("2 days", "5 hours", "under an hour"); a bad or future time is "just now". */
export function waitingLabel(createdAtIso: string, now: Date): string {
  const created = new Date(createdAtIso).getTime();
  if (!Number.isFinite(created)) return "just now";
  const minutes = Math.floor((now.getTime() - created) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return "under an hour";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}
