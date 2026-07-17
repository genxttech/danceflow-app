import { Link, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  formatScheduleTimeRange,
  loadStudentScheduleOverview,
  statusLabel,
  type StudentScheduleItem,
  type StudentScheduleOverview
} from "@/lib/studentSchedule";
import {
  displayScheduleSubtitle,
  displayScheduleTitle,
  isClassScheduleItem,
  isLessonScheduleItem
} from "@/lib/studentScheduleSections";
import { loadStudentWallet, type StudentWallet } from "@/lib/studentWallet";

type CalendarEntry = {
  id: string;
  kind: "lesson" | "class";
  item: StudentScheduleItem;
  dateKey: string;
};

function localDateKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromKey(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

function dateKeyFromDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDate(dateKey: string, days: number) {
  const date = dateFromKey(dateKey);
  date.setDate(date.getDate() + days);
  return dateKeyFromDate(date);
}

function startOfWeek(dateKey: string) {
  const date = dateFromKey(dateKey);
  date.setDate(date.getDate() - date.getDay());
  return dateKeyFromDate(date);
}

function shortWeekday(dateKey: string) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(
    dateFromKey(dateKey)
  );
}

function shortMonthDay(dateKey: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric"
  }).format(dateFromKey(dateKey));
}

function fullDateLabel(dateKey: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(dateFromKey(dateKey));
}

function dayNumber(dateKey: string) {
  return dateFromKey(dateKey).getDate();
}

function entryTone(kind: CalendarEntry["kind"]) {
  return kind === "lesson"
    ? {
        icon: "person-outline" as const,
        accent: "#6D28D9",
        soft: "#F5F3FF",
        border: "#DDD6FE",
        label: "Private lesson"
      }
    : {
        icon: "people-outline" as const,
        accent: "#0F766E",
        soft: "#F0FDFA",
        border: "#99F6E4",
        label: "Class"
      };
}

function CalendarEntryCard({ entry }: { entry: CalendarEntry }) {
  const router = useRouter();
  const tone = entryTone(entry.kind);
  const subtitle = displayScheduleSubtitle(entry.item);

  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: "/appointments/[id]",
          params: { id: entry.item.id }
        })
      }
      style={({ pressed }) => [
        styles.entryCard,
        { borderColor: tone.border },
        pressed && styles.pressed
      ]}
    >
      <View style={[styles.entryAccent, { backgroundColor: tone.accent }]} />

      <View style={styles.entryBody}>
        <View style={styles.entryTopRow}>
          <View style={[styles.entryIcon, { backgroundColor: tone.soft }]}>
            <Ionicons color={tone.accent} name={tone.icon} size={18} />
          </View>

          <View style={styles.entryHeading}>
            <AppText style={[styles.entryType, { color: tone.accent }]}>
              {tone.label}
            </AppText>
            <AppText style={styles.entryStatus}>
              {statusLabel(entry.item.status)}
            </AppText>
          </View>

          <Ionicons color="#94A3B8" name="chevron-forward" size={18} />
        </View>

        <AppText style={styles.entryTitle}>
          {displayScheduleTitle(entry.item)}
        </AppText>

        <View style={styles.metaRow}>
          <Ionicons color="#64748B" name="time-outline" size={15} />
          <AppText style={styles.metaText}>
            {formatScheduleTimeRange(
              entry.item.startsAt,
              entry.item.endsAt,
              entry.item.timeZone
            )}
          </AppText>
        </View>

        <View style={styles.metaRow}>
          <Ionicons color="#64748B" name="business-outline" size={15} />
          <AppText style={styles.metaText}>{entry.item.studioName}</AppText>
        </View>

        {subtitle ? (
          <View style={styles.metaRow}>
            <Ionicons color="#64748B" name="location-outline" size={15} />
            <AppText style={styles.metaText}>{subtitle}</AppText>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function SummaryPill({
  icon,
  label,
  value
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: number;
}) {
  return (
    <View style={styles.summaryPill}>
      <Ionicons color={colors.primary} name={icon} size={16} />
      <AppText style={styles.summaryValue}>{value}</AppText>
      <AppText style={styles.summaryLabel}>{label}</AppText>
    </View>
  );
}

export default function ScheduleScreen() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [overview, setOverview] = useState<StudentScheduleOverview | null>(null);
  const [wallet, setWallet] = useState<StudentWallet | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(() =>
    dateKeyFromDate(new Date())
  );

  async function loadSchedule() {
    const userId = session?.user.id;

    if (!userId) {
      setLinkedStudios([]);
      setOverview(null);
      setWallet(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const access = await getStudentAccess(userId);
      setLinkedStudios(access.linkedStudios);

      const [nextOverview, nextWallet] = await Promise.all([
        access.linkedStudios.length
          ? loadStudentScheduleOverview(access.linkedStudios)
          : Promise.resolve(null),
        loadStudentWallet(
          access.linkedStudios,
          session?.user.email ?? null
        )
      ]);

      setOverview(nextOverview);
      setWallet(nextWallet);
    } catch {
      setErrorMessage(
        "Your schedule could not be loaded. Pull back in a moment and try again."
      );
      setOverview(null);
      setWallet(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSchedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.email, session?.user.id]);

  const entries = useMemo<CalendarEntry[]>(() => {
    return (overview?.upcoming ?? [])
      .filter(
        (item) => isLessonScheduleItem(item) || isClassScheduleItem(item)
      )
      .map<CalendarEntry>((item) => ({
        id: item.id,
        kind: isLessonScheduleItem(item) ? "lesson" : "class",
        item,
        dateKey: localDateKey(item.startsAt)
      }))
      .filter((entry) => Boolean(entry.dateKey))
      .sort(
        (a, b) =>
          new Date(a.item.startsAt).getTime() -
          new Date(b.item.startsAt).getTime()
      );
  }, [overview]);

  const lessonCount = entries.filter((entry) => entry.kind === "lesson").length;
  const classCount = entries.filter((entry) => entry.kind === "class").length;

  const eventCount = useMemo(() => {
    const registrationIds = new Set(
      (wallet?.registrations ?? []).map((registration) => registration.id)
    );
    const ticketOnlyCount = (wallet?.tickets ?? []).filter(
      (ticket) => !registrationIds.has(ticket.registrationId)
    ).length;
    return registrationIds.size + ticketOnlyCount;
  }, [wallet]);

  const weekStart = startOfWeek(selectedDate);
  const visibleWeek = Array.from({ length: 7 }, (_, index) =>
    shiftDate(weekStart, index)
  );

  const entriesForSelectedDate = entries.filter(
    (entry) => entry.dateKey === selectedDate
  );

  const datesWithEntries = useMemo(
    () => new Set(entries.map((entry) => entry.dateKey)),
    [entries]
  );

  const nextEntry = entries[0] ?? null;
  const signedIn = Boolean(session);

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={styles.heroTopRow}>
          <View>
            <AppText style={styles.heroEyebrow}>My Schedule</AppText>
            <AppText style={styles.heroTitle}>Plan your dance week</AppText>
          </View>

          {signedIn ? (
            <Pressable
              accessibilityLabel="Refresh schedule"
              onPress={loadSchedule}
              style={({ pressed }) => [
                styles.refreshButton,
                pressed && styles.pressed
              ]}
            >
              <Ionicons color="#FFFFFF" name="refresh-outline" size={20} />
            </Pressable>
          ) : null}
        </View>

        <AppText style={styles.heroDetail}>
          Lessons, classes, and event activity organized around the days that
          matter.
        </AppText>

        <View style={styles.summaryRow}>
          <SummaryPill icon="person-outline" label="Lessons" value={lessonCount} />
          <SummaryPill icon="people-outline" label="Classes" value={classCount} />
          <SummaryPill icon="ticket-outline" label="Events" value={eventCount} />
        </View>
      </View>

      {loading ? (
        <FeatureCard
          title="Loading your calendar"
          detail="Checking connected studios, lessons, classes, and event activity."
        />
      ) : null}

      {!loading && errorMessage ? (
        <FeatureCard title="Schedule unavailable" detail={errorMessage} />
      ) : null}

      {!loading && !signedIn ? (
        <View style={styles.guestCard}>
          <View style={styles.guestIcon}>
            <Ionicons color={colors.primary} name="calendar-outline" size={24} />
          </View>
          <AppText style={styles.guestTitle}>
            Your schedule will live here
          </AppText>
          <AppText style={styles.guestDetail}>
            Sign in to see connected studio lessons, classes, and event
            activity in one polished calendar.
          </AppText>
          <Link href="/(auth)/sign-in" asChild>
            <AppButton label="Sign in to DanceFlow" />
          </Link>
        </View>
      ) : null}

      {!loading && signedIn ? (
        <>
          <View style={styles.calendarCard}>
            <View style={styles.calendarHeader}>
              <Pressable
                accessibilityLabel="Previous week"
                onPress={() => setSelectedDate(shiftDate(selectedDate, -7))}
                style={({ pressed }) => [
                  styles.calendarArrow,
                  pressed && styles.pressed
                ]}
              >
                <Ionicons color="#334155" name="chevron-back" size={20} />
              </Pressable>

              <View style={styles.calendarHeading}>
                <AppText style={styles.calendarMonth}>
                  {new Intl.DateTimeFormat("en-US", {
                    month: "long",
                    year: "numeric"
                  }).format(dateFromKey(selectedDate))}
                </AppText>
                <Pressable
                  onPress={() => setSelectedDate(dateKeyFromDate(new Date()))}
                >
                  <AppText style={styles.todayLink}>Today</AppText>
                </Pressable>
              </View>

              <Pressable
                accessibilityLabel="Next week"
                onPress={() => setSelectedDate(shiftDate(selectedDate, 7))}
                style={({ pressed }) => [
                  styles.calendarArrow,
                  pressed && styles.pressed
                ]}
              >
                <Ionicons color="#334155" name="chevron-forward" size={20} />
              </Pressable>
            </View>

            <View style={styles.weekRow}>
              {visibleWeek.map((dateKey) => {
                const selected = dateKey === selectedDate;
                const today = dateKey === dateKeyFromDate(new Date());
                const hasEntries = datesWithEntries.has(dateKey);

                return (
                  <Pressable
                    key={dateKey}
                    onPress={() => setSelectedDate(dateKey)}
                    style={({ pressed }) => [
                      styles.dayButton,
                      selected && styles.dayButtonSelected,
                      pressed && styles.pressed
                    ]}
                  >
                    <AppText
                      style={[
                        styles.dayName,
                        selected && styles.dayNameSelected
                      ]}
                    >
                      {shortWeekday(dateKey).slice(0, 2)}
                    </AppText>
                    <AppText
                      style={[
                        styles.dayNumber,
                        selected && styles.dayNumberSelected,
                        today && !selected && styles.dayNumberToday
                      ]}
                    >
                      {dayNumber(dateKey)}
                    </AppText>
                    <View
                      style={[
                        styles.dayDot,
                        hasEntries && styles.dayDotActive,
                        selected && hasEntries && styles.dayDotSelected
                      ]}
                    />
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={styles.agendaHeader}>
            <View>
              <AppText style={styles.agendaEyebrow}>Selected day</AppText>
              <AppText style={styles.agendaTitle}>
                {fullDateLabel(selectedDate)}
              </AppText>
            </View>
            <AppText style={styles.agendaCount}>
              {entriesForSelectedDate.length}{" "}
              {entriesForSelectedDate.length === 1 ? "item" : "items"}
            </AppText>
          </View>

          {entriesForSelectedDate.length > 0 ? (
            <View style={styles.agendaList}>
              {entriesForSelectedDate.map((entry) => (
                <CalendarEntryCard key={entry.id} entry={entry} />
              ))}
            </View>
          ) : (
            <View style={styles.emptyDayCard}>
              <View style={styles.emptyDayIcon}>
                <Ionicons
                  color="#64748B"
                  name="sparkles-outline"
                  size={22}
                />
              </View>
              <AppText style={styles.emptyDayTitle}>No plans this day</AppText>
              <AppText style={styles.emptyDayDetail}>
                Choose another day, request a private lesson, or browse upcoming
                events.
              </AppText>
              <View style={styles.emptyActions}>
                <Link href="/schedule/request" asChild>
                  <AppButton label="Book a lesson" />
                </Link>
                <Link href="/schedule/events" asChild>
                  <AppButton label="View events" variant="secondary" />
                </Link>
              </View>
            </View>
          )}

          {nextEntry ? (
            <View style={styles.nextCard}>
              <View style={styles.nextIcon}>
                <Ionicons
                  color="#FFFFFF"
                  name="arrow-forward-outline"
                  size={18}
                />
              </View>
              <View style={{ flex: 1 }}>
                <AppText style={styles.nextLabel}>Next on your calendar</AppText>
                <AppText style={styles.nextTitle}>
                  {displayScheduleTitle(nextEntry.item)}
                </AppText>
                <AppText style={styles.nextDetail}>
                  {shortMonthDay(nextEntry.dateKey)} ·{" "}
                  {formatScheduleTimeRange(
                    nextEntry.item.startsAt,
                    nextEntry.item.endsAt,
                    nextEntry.item.timeZone
                  )}
                </AppText>
              </View>
            </View>
          ) : linkedStudios.length === 0 && eventCount === 0 ? (
            <FeatureCard
              title="Connect with your studio"
              detail="Ask your studio to connect your DanceFlow account so lessons and classes can appear automatically."
            />
          ) : null}

          <View style={styles.secondaryLinks}>
            <Link href="/schedule/lessons" asChild>
              <Pressable style={styles.secondaryLink}>
                <Ionicons color="#6D28D9" name="person-outline" size={18} />
                <AppText style={styles.secondaryLinkText}>All lessons</AppText>
              </Pressable>
            </Link>
            <Link href="/schedule/classes" asChild>
              <Pressable style={styles.secondaryLink}>
                <Ionicons color="#0F766E" name="people-outline" size={18} />
                <AppText style={styles.secondaryLinkText}>All classes</AppText>
              </Pressable>
            </Link>
            <Link href="/schedule/events" asChild>
              <Pressable style={styles.secondaryLink}>
                <Ionicons color="#C2410C" name="ticket-outline" size={18} />
                <AppText style={styles.secondaryLinkText}>All events</AppText>
              </Pressable>
            </Link>
          </View>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  agendaCount: {
    color: "#64748B",
    fontSize: 13,
    fontWeight: "700"
  },
  agendaEyebrow: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1.2,
    textTransform: "uppercase"
  },
  agendaHeader: {
    alignItems: "flex-end",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  agendaList: {
    gap: 12
  },
  agendaTitle: {
    color: "#0F172A",
    fontSize: 22,
    fontWeight: "900",
    marginTop: 4
  },
  calendarArrow: {
    alignItems: "center",
    backgroundColor: "#F8FAFC",
    borderColor: "#E2E8F0",
    borderRadius: 14,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    width: 42
  },
  calendarCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 24,
    borderWidth: 1,
    elevation: 2,
    padding: 16,
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.05,
    shadowRadius: 22
  },
  calendarHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  calendarHeading: {
    alignItems: "center"
  },
  calendarMonth: {
    color: "#0F172A",
    fontSize: 18,
    fontWeight: "900"
  },
  dayButton: {
    alignItems: "center",
    borderRadius: 16,
    flex: 1,
    gap: 5,
    paddingVertical: 10
  },
  dayButtonSelected: {
    backgroundColor: colors.primary
  },
  dayDot: {
    backgroundColor: "transparent",
    borderRadius: 999,
    height: 4,
    width: 4
  },
  dayDotActive: {
    backgroundColor: colors.primary
  },
  dayDotSelected: {
    backgroundColor: "#FFFFFF"
  },
  dayName: {
    color: "#94A3B8",
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  dayNameSelected: {
    color: "rgba(255,255,255,0.78)"
  },
  dayNumber: {
    color: "#334155",
    fontSize: 17,
    fontWeight: "900"
  },
  dayNumberSelected: {
    color: "#FFFFFF"
  },
  dayNumberToday: {
    color: colors.primary
  },
  emptyActions: {
    gap: 10,
    marginTop: 8,
    width: "100%"
  },
  emptyDayCard: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#CBD5E1",
    borderRadius: 24,
    borderStyle: "dashed",
    borderWidth: 1,
    padding: 24
  },
  emptyDayDetail: {
    color: "#64748B",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 6,
    textAlign: "center"
  },
  emptyDayIcon: {
    alignItems: "center",
    backgroundColor: "#F1F5F9",
    borderRadius: 999,
    height: 48,
    justifyContent: "center",
    width: 48
  },
  emptyDayTitle: {
    color: "#0F172A",
    fontSize: 18,
    fontWeight: "900",
    marginTop: 14
  },
  entryAccent: {
    alignSelf: "stretch",
    borderBottomLeftRadius: 22,
    borderTopLeftRadius: 22,
    width: 5
  },
  entryBody: {
    flex: 1,
    gap: 8,
    padding: 16
  },
  entryCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    borderWidth: 1,
    elevation: 1,
    flexDirection: "row",
    overflow: "hidden"
  },
  entryHeading: {
    flex: 1
  },
  entryIcon: {
    alignItems: "center",
    borderRadius: 12,
    height: 36,
    justifyContent: "center",
    width: 36
  },
  entryStatus: {
    color: "#64748B",
    fontSize: 11,
    fontWeight: "700",
    marginTop: 2
  },
  entryTitle: {
    color: "#0F172A",
    fontSize: 18,
    fontWeight: "900"
  },
  entryTopRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10
  },
  entryType: {
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.4,
    textTransform: "uppercase"
  },
  guestCard: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 24,
    borderWidth: 1,
    padding: 24
  },
  guestDetail: {
    color: "#64748B",
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 18,
    marginTop: 6,
    textAlign: "center"
  },
  guestIcon: {
    alignItems: "center",
    backgroundColor: "#F5F3FF",
    borderRadius: 999,
    height: 54,
    justifyContent: "center",
    width: 54
  },
  guestTitle: {
    color: "#0F172A",
    fontSize: 20,
    fontWeight: "900",
    marginTop: 14
  },
  hero: {
    backgroundColor: "#17112B",
    borderRadius: 28,
    padding: 20
  },
  heroDetail: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 10
  },
  heroEyebrow: {
    color: "#C4B5FD",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1.4,
    textTransform: "uppercase"
  },
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 28,
    fontWeight: "900",
    marginTop: 5
  },
  heroTopRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  metaRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7
  },
  metaText: {
    color: "#64748B",
    flex: 1,
    fontSize: 13,
    lineHeight: 19
  },
  nextCard: {
    alignItems: "center",
    backgroundColor: "#17112B",
    borderRadius: 22,
    flexDirection: "row",
    gap: 12,
    padding: 16
  },
  nextDetail: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 12,
    marginTop: 3
  },
  nextIcon: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 999,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  nextLabel: {
    color: "#C4B5FD",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.8,
    textTransform: "uppercase"
  },
  nextTitle: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "900",
    marginTop: 3
  },
  pressed: {
    opacity: 0.75
  },
  refreshButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 14,
    height: 42,
    justifyContent: "center",
    width: 42
  },
  secondaryLink: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    gap: 7,
    minWidth: 96,
    paddingHorizontal: 10,
    paddingVertical: 14
  },
  secondaryLinkText: {
    color: "#334155",
    fontSize: 12,
    fontWeight: "800",
    textAlign: "center"
  },
  secondaryLinks: {
    flexDirection: "row",
    gap: 10
  },
  summaryLabel: {
    color: "rgba(255,255,255,0.64)",
    fontSize: 10,
    fontWeight: "700"
  },
  summaryPill: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 16,
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 11
  },
  summaryRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 18
  },
  summaryValue: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "900",
    marginTop: 4
  },
  todayLink: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "900",
    marginTop: 3
  },
  weekRow: {
    flexDirection: "row",
    gap: 3,
    marginTop: 16
  }
});
