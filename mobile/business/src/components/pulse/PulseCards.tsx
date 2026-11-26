import type React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { AppText } from "@/components/AppText";
import { appointmentTypeLabel, formatShortDay, formatTime } from "@/lib/format";
import { needsYouItems, waitingLabel, type CardUnavailable, type PulseCards } from "@/lib/pulseCards";
import { colors, radius, space, tabularNums } from "@/theme";

/*
  The Pulse command-center cards (read only), in the order of what needs a person first: needs-you summary, lesson requests, unconfirmed appointments, new leads, ARIA suggestions, exceptions, then studio health (a number to glance at, not a task). Hidden cards (null) draw nothing; an unavailable card says so in words and leaves the rest alone. Every number is shown once, with its
  label, as one accessible element. Nothing here starts an action: the only taps open a lead's client record or an appointment.
*/

type Props = {
  cards: PulseCards;
  now: Date;
  onOpenLead?: (clientId: string) => void;
  onOpenAppointment?: (appointmentId: string) => void;
  /** The studio's zone: appointment times are always shown in it. */
  timeZone?: string;
  /** The viewer's scope from the Pulse response: names the health card even when it could not load. */
  scope?: "studio" | "own";
};

function Card({ title, testID, children }: { title: string; testID: string; children: React.ReactNode }) {
  return (
    <View style={styles.card} testID={testID}>
      <AppText variant="label" tone="muted" accessibilityRole="header">
        {title}
      </AppText>
      {children}
    </View>
  );
}

function Unavailable({ title, testID }: { title: string; testID: string }) {
  return (
    <Card title={title} testID={testID}>
      <AppText tone="muted">This could not be loaded just now. Pull down to refresh.</AppText>
    </Card>
  );
}

function Stat({ label, value, testID }: { label: string; value: number; testID: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`} testID={testID}>
      <AppText variant="heading" style={tabularNums}>
        {String(value)}
      </AppText>
      <AppText tone="muted">{label}</AppText>
    </View>
  );
}

const isOverdue = (iso: string | null, now: Date) => iso !== null && new Date(iso).getTime() <= now.getTime();
const isUnavailable = (card: unknown): card is CardUnavailable => (card as CardUnavailable | null)?.state === "unavailable";

export function PulseCardsView({ cards, now, onOpenLead, onOpenAppointment, scope, timeZone }: Props) {
  const needs = needsYouItems(cards);
  const needsSources = [cards.requests, cards.confirmations, cards.leads, cards.aria];
  // "Nothing is waiting" is only true when every card it speaks for answered; with one unavailable the card is shown only if there is something to list.
  const anyNeedsCard = needs.length > 0 || (needsSources.some((card) => card !== null) && !needsSources.some((card) => isUnavailable(card)));
  const { requests, confirmations, leads, aria, exceptions, health } = cards;

  return (
    <>
      {anyNeedsCard ? (
        <Card title="Needs you" testID="pulse-needs-you">
          {needs.length === 0 ? (
            <AppText testID="pulse-needs-you-clear">Nothing is waiting on you right now.</AppText>
          ) : (
            needs.map((item) => (
              <View key={item.key} style={styles.needsRow} accessible accessibilityLabel={`${item.count} ${item.label}`} testID={`pulse-needs-${item.key}`}>
                <AppText variant="title" style={tabularNums}>
                  {String(item.count)}
                </AppText>
                <AppText style={styles.needsLabel}>{item.label}</AppText>
              </View>
            ))
          )}
        </Card>
      ) : null}

      {requests && !isUnavailable(requests) ? (
        <Card title="Lesson requests" testID="pulse-requests">
          {requests.total === 0 ? (
            <AppText testID="pulse-requests-empty">No lesson requests are waiting.</AppText>
          ) : (
            <>
              <Stat label={requests.total === 1 ? "request waiting" : "requests waiting"} value={requests.total} testID="pulse-requests-total" />
              {requests.oldestCreatedAt ? (
                <AppText tone="muted" testID="pulse-requests-oldest">
                  Oldest has waited {waitingLabel(requests.oldestCreatedAt, now)}.
                </AppText>
              ) : null}
              {requests.recent.map((item) => (
                <AppText key={`${item.source}-${item.id}`} testID={`pulse-request-${item.id}`}>
                  {requestLine(item)}
                </AppText>
              ))}
              {requests.truncated ? (
                <AppText variant="caption" tone="muted">
                  Showing the first 200 of each queue.
                </AppText>
              ) : null}
            </>
          )}
        </Card>
      ) : isUnavailable(requests) ? (
        <Unavailable title="Lesson requests" testID="pulse-requests-unavailable" />
      ) : null}

      {confirmations && !isUnavailable(confirmations) ? (
        <Card title="Not confirmed yet" testID="pulse-confirmations">
          {confirmations.total === 0 ? (
            <AppText testID="pulse-confirmations-empty">No appointments in the next {confirmations.windowHours} hours are waiting for a confirmation.</AppText>
          ) : (
            <>
              <Stat label={`in the next ${confirmations.windowHours} hours`} value={confirmations.total} testID="pulse-confirmations-total" />
              {confirmations.upcoming.map((item) => {
                const when = `${formatShortDay(item.startsAt, timeZone)}, ${formatTime(item.startsAt, timeZone)}`;
                const what = [appointmentTypeLabel(item.appointmentType), item.clientName].filter(Boolean).join(" · ");
                return (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${when}, ${[appointmentTypeLabel(item.appointmentType), item.clientName].filter(Boolean).join(", ")}, not confirmed`}
                    accessibilityHint="Opens the appointment"
                    onPress={() => onOpenAppointment?.(item.id)}
                    style={({ pressed }) => [styles.leadRow, pressed && styles.pressed]}
                    testID={`pulse-confirmation-${item.id}`}
                  >
                    <AppText variant="lead">{when}</AppText>
                    <AppText tone="muted">{what}</AppText>
                  </Pressable>
                );
              })}
              {confirmations.truncated ? (
                <AppText variant="caption" tone="muted">
                  Showing the soonest {confirmations.upcoming.length} of {confirmations.total}.
                </AppText>
              ) : null}
              <AppText variant="caption" tone="muted">
                Dancers can confirm in the app. Reminder emails with a confirm link go out about a day before, so later appointments may not have had one yet.
              </AppText>
            </>
          )}
        </Card>
      ) : isUnavailable(confirmations) ? (
        <Unavailable title="Not confirmed yet" testID="pulse-confirmations-unavailable" />
      ) : null}

      {leads && !isUnavailable(leads) ? (
        <Card title="New leads" testID="pulse-leads">
          <View style={styles.stats}>
            <Stat label={leads.newLast7Days === 1 ? "new lead in 7 days" : "new leads in 7 days"} value={leads.newLast7Days} testID="pulse-leads-new" />
            <Stat label="not contacted" value={leads.uncontacted} testID="pulse-leads-uncontacted" />
            <Stat label="follow-ups overdue" value={leads.followUpsOverdue} testID="pulse-leads-overdue" />
          </View>
          {leads.recent.length === 0 ? <AppText testID="pulse-leads-empty">No open leads.</AppText> : null}
          {leads.recent.map((lead) => (
            <Pressable
              key={lead.id}
              accessibilityRole="button"
              accessibilityLabel={`${lead.name}, ${lead.sourceLabel}${lead.uncontacted ? ", not contacted" : ""}${isOverdue(lead.followUpDueAt, now) ? ", follow-up overdue" : ""}`}
              accessibilityHint="Opens the client"
              onPress={() => onOpenLead?.(lead.id)}
              style={({ pressed }) => [styles.leadRow, pressed && styles.pressed]}
              testID={`pulse-lead-${lead.id}`}
            >
              <AppText variant="lead">{lead.name}</AppText>
              <AppText tone="muted">
                {lead.sourceLabel}
                {lead.uncontacted ? " · not contacted" : ""}
                {isOverdue(lead.followUpDueAt, now) ? " · follow-up overdue" : ""}
              </AppText>
            </Pressable>
          ))}
        </Card>
      ) : isUnavailable(leads) ? (
        <Unavailable title="New leads" testID="pulse-leads-unavailable" />
      ) : null}

      {aria && !isUnavailable(aria) ? (
        <Card title="ARIA suggestions" testID="pulse-aria">
          {aria.open === 0 ? (
            <AppText testID="pulse-aria-empty">No suggestions to review.</AppText>
          ) : (
            <>
              <Stat label={aria.open === 1 ? "suggestion to review" : "suggestions to review"} value={aria.open} testID="pulse-aria-open" />
              {aria.recent.map((item) => (
                <AppText key={item.id} testID={`pulse-aria-${item.id}`}>
                  {item.priority ? `${item.title} · ${item.priority} priority` : item.title}
                </AppText>
              ))}
              <AppText variant="caption" tone="muted">
                Review and approve these in the web app.
              </AppText>
            </>
          )}
        </Card>
      ) : isUnavailable(aria) ? (
        <Unavailable title="ARIA suggestions" testID="pulse-aria-unavailable" />
      ) : null}

      {exceptions && !isUnavailable(exceptions) ? (
        <Card title="Worth a look" testID="pulse-exceptions">
          {exceptions.cancelledToday === 0 && !exceptions.lowPackages ? (
            <AppText testID="pulse-exceptions-clear">Nothing unusual today.</AppText>
          ) : (
            <View style={styles.stats}>
              {exceptions.cancelledToday > 0 ? <Stat label="cancelled today" value={exceptions.cancelledToday} testID="pulse-exceptions-cancelled" /> : null}
              {exceptions.lowPackages ? <Stat label={exceptions.lowPackages === 1 ? "package running low" : "packages running low"} value={exceptions.lowPackages} testID="pulse-exceptions-low" /> : null}
            </View>
          )}
        </Card>
      ) : isUnavailable(exceptions) ? (
        <Unavailable title="Worth a look" testID="pulse-exceptions-unavailable" />
      ) : null}

      {health && !isUnavailable(health) ? (
        <Card title={health.scope === "studio" ? "Studio health" : "Your sessions"} testID="pulse-health">
          <View style={styles.stats}>
            <Stat label={health.sessionsToday === 1 ? "session today" : "sessions today"} value={health.sessionsToday} testID="pulse-health-today" />
            <Stat label="started" value={health.sessionsDone} testID="pulse-health-done" />
            <Stat label="still ahead" value={health.sessionsAhead} testID="pulse-health-ahead" />
          </View>
          {health.truncated ? (
            <AppText variant="caption" tone="muted">
              Counts cover the first 500 appointments of the day.
            </AppText>
          ) : null}
        </Card>
      ) : isUnavailable(health) ? (
        <Unavailable title={scope === "own" ? "Your sessions" : "Studio health"} testID="pulse-health-unavailable" />
      ) : null}
    </>
  );
}

const KIND_WORDS = { book: "Booking request", reschedule: "Reschedule request", cancel: "Cancellation request" } as const;

function requestLine(item: { kind: "book" | "reschedule" | "cancel" | null; clientName: string | null }) {
  const what = item.kind ? KIND_WORDS[item.kind] : "Request";
  return item.clientName ? `${what} from ${item.clientName}` : what;
}

const styles = StyleSheet.create({
  card: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: space.lg, columnGap: space.xl },
  stat: { gap: 2 },
  needsRow: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44 },
  needsLabel: { flex: 1 },
  leadRow: {
    minHeight: 44,
    gap: 2,
    padding: space.md,
    borderRadius: radius.row,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pressed: { backgroundColor: colors.tint },
});
