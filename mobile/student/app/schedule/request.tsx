import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, useColorScheme, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { danceflowApiFetch } from "@/lib/danceflowApi";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import { formatScheduleDateTime } from "@/lib/studentSchedule";

type SelfServiceSlot = {
  date: string;
  startsAt: string;
  endsAt: string;
  instructorId: string | null;
  roomId: string | null;
};

type SelfServiceInstructor = { id: string; name: string };

type SelfServiceSlotsResponse = {
  studio?: { id: string; slug: string; name: string };
  slots: SelfServiceSlot[];
  instructors?: SelfServiceInstructor[];
  bookingDecision?: {
    allowed: boolean;
    mode: "request_only" | "approval_required" | "instant" | null;
    reason: string | null;
  };
};

function dateParts(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return { year, month, day };
}

function monthLabel(dateKey: string) {
  const { year, month } = dateParts(dateKey);
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

function dayLabel(dateKey: string) {
  const { year, month, day } = dateParts(dateKey);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

function calendarCells(monthKey: string, availableDates: Set<string>) {
  const { year, month } = dateParts(`${monthKey}-01`);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: Array<{ key: string; day: number; available: boolean } | null> = [];

  for (let index = 0; index < firstWeekday; index += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    cells.push({ key, day, available: availableDates.has(key) });
  }

  return cells;
}

function shiftMonth(monthKey: string, offset: number) {
  const { year, month } = dateParts(`${monthKey}-01`);
  const next = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function ScheduleRequestScreen() {
  const { session } = useAuth();
  const colors = colorsForScheme(useColorScheme());
  const styles = createStyles(colors);
  const [studios, setStudios] = useState<LinkedStudioAccess[]>([]);
  const [selectedStudioSlug, setSelectedStudioSlug] = useState("");
  const [slots, setSlots] = useState<SelfServiceSlot[]>([]);
  const [instructors, setInstructors] = useState<SelfServiceInstructor[]>([]);
  const [selectedInstructorId, setSelectedInstructorId] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [monthKey, setMonthKey] = useState("");
  const [decision, setDecision] = useState<SelfServiceSlotsResponse["bookingDecision"]>();
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [submittingSlotKey, setSubmittingSlotKey] = useState<string | null>(null);
  const [selectedSlotKey, setSelectedSlotKey] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.user.id) return;

    getStudentAccess(session.user.id)
      .then((access) => {
        setStudios(access.linkedStudios);
        setSelectedStudioSlug((current) => current || access.linkedStudios[0]?.studioSlug || "");
      })
      .catch(() => setMessage("Connected studios could not be loaded."));
  }, [session?.user.id]);

  async function loadSlots() {
    if (!selectedStudioSlug) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const response = await danceflowApiFetch<SelfServiceSlotsResponse>(
        "/api/student/self-service/slots",
        {
          params: {
            studioSlug: selectedStudioSlug,
            lessonType: "private_lesson",
            instructorId: selectedInstructorId || null,
          },
        },
      );

      const nextSlots = response.slots ?? [];
      const nextInstructors = response.instructors ?? [];
      const availableMonths = Array.from(
        new Set(nextSlots.map((slot) => slot.date.slice(0, 7))),
      ).sort();

      setSlots(nextSlots);
      setInstructors(nextInstructors);
      setDecision(response.bookingDecision);

      if (!selectedInstructorId && nextInstructors.length === 1) {
        setSelectedInstructorId(nextInstructors[0].id);
      }

      setMonthKey((current) =>
        current && availableMonths.includes(current)
          ? current
          : availableMonths[0] ?? new Date().toISOString().slice(0, 7),
      );

      if (selectedDate && !nextSlots.some((slot) => slot.date === selectedDate)) {
        setSelectedDate("");
        setSelectedSlotKey(null);
      } else if (
        selectedSlotKey &&
        !nextSlots.some(
          (slot) => `${slot.startsAt}|${slot.endsAt}` === selectedSlotKey,
        )
      ) {
        setSelectedSlotKey(null);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Lesson times could not be loaded.");
      setSlots([]);
      setInstructors([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSlots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStudioSlug, selectedInstructorId]);

  async function submitSlot(slot: SelfServiceSlot) {
    const slotKey = `${slot.startsAt}|${slot.endsAt}`;
    setSubmittingSlotKey(slotKey);
    setMessage(null);

    try {
      const response = await danceflowApiFetch<{ bookingDecision?: { mode: string | null } }>(
        "/api/student/self-service/actions",
        {
          method: "POST",
          body: JSON.stringify({
            studioSlug: selectedStudioSlug,
            actionType: "book",
            lessonType: "private_lesson",
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            instructorId: slot.instructorId,
            roomId: slot.roomId,
          }),
        },
      );

      setMessage(response.bookingDecision?.mode === "instant" ? "Lesson booked." : "Request sent to the studio.");
      await loadSlots();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not submit the request.");
    } finally {
      setSubmittingSlotKey(null);
    }
  }

  const availableDates = useMemo(() => new Set(slots.map((slot) => slot.date)), [slots]);
  const availableMonths = useMemo(
    () => Array.from(new Set(slots.map((slot) => slot.date.slice(0, 7)))).sort(),
    [slots],
  );
  const resolvedMonthKey =
    monthKey || availableMonths[0] || new Date().toISOString().slice(0, 7);
  const currentMonthIndex = availableMonths.indexOf(resolvedMonthKey);
  const canGoPrevious = currentMonthIndex > 0;
  const canGoNext =
    currentMonthIndex >= 0 && currentMonthIndex < availableMonths.length - 1;
  const cells = calendarCells(resolvedMonthKey, availableDates);
  const visibleSlots = selectedDate
    ? slots.filter((slot) => slot.date === selectedDate)
    : [];
  const instructorResolved = Boolean(selectedInstructorId) || instructors.length === 1;
  const selectedSlot =
    visibleSlots.find(
      (slot) => `${slot.startsAt}|${slot.endsAt}` === selectedSlotKey,
    ) ?? null;

  return (
    <Screen>
      <View style={styles.bookingHero}>
        <View style={styles.bookingHeroIcon}>
          <AppText style={styles.bookingHeroIconText}>+</AppText>
        </View>
        <View style={{ flex: 1 }}>
          <AppText style={styles.bookingHeroEyebrow}>Private lessons</AppText>
          <AppText style={styles.bookingHeroTitle}>Book your next lesson</AppText>
          <AppText style={styles.bookingHeroDetail}>
            Choose a studio, instructor, day, and available time.
          </AppText>
        </View>
      </View>

      {message ? <FeatureCard title="Booking update" detail={message} /> : null}

      <View style={styles.section}>
        <AppText variant="subtitle">1. Choose a studio</AppText>
        <View style={styles.pillList}>
          {studios.map((studio) => (
            <AppButton
              key={studio.studioId}
              label={studio.studioPublicName || studio.studioName || "Studio"}
              onPress={() => {
                setSelectedStudioSlug(studio.studioSlug);
                setSelectedInstructorId("");
                setSelectedDate("");
                setSelectedSlotKey(null);
                setMonthKey("");
              }}
              variant={selectedStudioSlug === studio.studioSlug ? "primary" : "secondary"}
            />
          ))}
        </View>
      </View>

      {selectedStudioSlug ? (
        <View style={styles.section}>
          <AppText variant="subtitle">2. Choose an instructor</AppText>
          <View style={styles.pillList}>
            {instructors.map((instructor) => {
              const selected = selectedInstructorId === instructor.id;

              return (
                <Pressable
                  key={instructor.id}
                  onPress={() => {
                    setSelectedInstructorId(instructor.id);
                    setSelectedDate("");
                    setSelectedSlotKey(null);
                    setMonthKey("");
                  }}
                  style={({ pressed }) => [
                    styles.instructorPill,
                    selected && styles.instructorPillSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <AppText
                    style={[
                      styles.instructorPillText,
                      selected && styles.instructorPillTextSelected,
                    ]}
                  >
                    {instructor.name}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {selectedStudioSlug && instructors.length > 1 && !selectedInstructorId && !loading ? (
        <FeatureCard
          title="Choose an instructor"
          detail="Select an instructor to see their available lesson times."
        />
      ) : null}

      {selectedStudioSlug && instructors.length === 0 && !loading && decision?.allowed !== false ? (
        <FeatureCard
          title="No instructors available"
          detail="This studio has not made an instructor available for online booking yet."
        />
      ) : null}

      {loading ? <FeatureCard title="Loading calendar" detail="Checking available lesson times." /> : null}

      {decision?.allowed === false ? (
        <FeatureCard title="Booking unavailable" detail={decision.reason ?? "This studio is not accepting self-service bookings."} />
      ) : null}

      {instructorResolved && !loading && decision?.allowed !== false ? (
        <View style={styles.section}>
          <AppText variant="subtitle">3. Choose a day</AppText>
          <View style={styles.monthNavigation}>
            <Pressable
              accessibilityRole="button"
              disabled={!canGoPrevious}
              onPress={() => {
                setMonthKey(shiftMonth(resolvedMonthKey, -1));
                setSelectedDate("");
                setSelectedSlotKey(null);
              }}
              style={({ pressed }) => [
                styles.monthButton,
                !canGoPrevious && styles.monthButtonDisabled,
                pressed && canGoPrevious && styles.pressed,
              ]}
            >
              <AppText style={styles.monthButtonText}>Previous</AppText>
            </Pressable>
            <AppText variant="caption">{monthLabel(`${resolvedMonthKey}-01`)}</AppText>
            <Pressable
              accessibilityRole="button"
              disabled={!canGoNext}
              onPress={() => {
                setMonthKey(shiftMonth(resolvedMonthKey, 1));
                setSelectedDate("");
                setSelectedSlotKey(null);
              }}
              style={({ pressed }) => [
                styles.monthButton,
                !canGoNext && styles.monthButtonDisabled,
                pressed && canGoNext && styles.pressed,
              ]}
            >
              <AppText style={styles.monthButtonText}>Next</AppText>
            </Pressable>
          </View>

          {slots.length === 0 ? (
            <FeatureCard
              title="No lesson times available"
              detail="Try another instructor or check again later."
            />
          ) : null}

          <View style={styles.weekRow}>
            {["S", "M", "T", "W", "T", "F", "S"].map((label, index) => (
              <AppText key={`${label}-${index}`} style={styles.weekLabel}>{label}</AppText>
            ))}
          </View>

          <View style={styles.calendarGrid}>
            {cells.map((cell, index) =>
              cell ? (
                <Pressable
                  key={cell.key}
                  disabled={!cell.available}
                  onPress={() => {
                    if (!cell.available) return;
                    setSelectedDate(cell.key);
                    setSelectedSlotKey(null);
                  }}
                  style={({ pressed }) => [
                    styles.dayCell,
                    cell.available ? styles.dayAvailable : styles.dayUnavailable,
                    selectedDate === cell.key && styles.daySelected,
                    pressed && cell.available && styles.pressed,
                  ]}
                >
                  <AppText
                    style={[
                      styles.dayText,
                      !cell.available && styles.dayUnavailableText,
                      selectedDate === cell.key && styles.daySelectedText,
                    ]}
                  >
                    {cell.day}
                  </AppText>
                  {cell.available ? <View style={styles.dot} /> : null}
                </Pressable>
              ) : (
                <View key={`blank-${index}`} style={styles.dayCell} />
              ),
            )}
          </View>
        </View>
      ) : null}

      {selectedDate ? (
        <View style={styles.section}>
          <AppText variant="subtitle">4. Choose a time</AppText>
          <AppText variant="caption">
            {dayLabel(selectedDate)} · {selectedDate}
          </AppText>

          {visibleSlots.length > 0 ? (
            <>
              <ScrollView
                horizontal
                contentContainerStyle={styles.timeSlotRow}
                showsHorizontalScrollIndicator={false}
              >
                {visibleSlots.map((slot) => {
                  const slotKey = `${slot.startsAt}|${slot.endsAt}`;
                  const selected = selectedSlotKey === slotKey;

                  return (
                    <Pressable
                      key={slotKey}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => setSelectedSlotKey(slotKey)}
                      style={({ pressed }) => [
                        styles.timeSlotPill,
                        selected && styles.timeSlotPillSelected,
                        pressed && styles.pressed,
                      ]}
                    >
                      <AppText
                        style={[
                          styles.timeSlotText,
                          selected && styles.timeSlotTextSelected,
                        ]}
                      >
                        {new Intl.DateTimeFormat("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                        }).format(new Date(slot.startsAt))}
                      </AppText>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {selectedSlot ? (
                <View style={styles.selectedTimeCard}>
                  <View>
                    <AppText style={styles.selectedTimeLabel}>
                      Selected time
                    </AppText>
                    <AppText style={styles.selectedTimeValue}>
                      {formatScheduleDateTime(selectedSlot.startsAt)}
                    </AppText>
                  </View>

                  <AppButton
                    label={
                      decision?.mode === "instant"
                        ? "Book selected time"
                        : "Request selected time"
                    }
                    loading={
                      submittingSlotKey ===
                      `${selectedSlot.startsAt}|${selectedSlot.endsAt}`
                    }
                    onPress={() => submitSlot(selectedSlot)}
                  />
                </View>
              ) : (
                <AppText variant="caption">
                  Swipe horizontally and tap a time to continue.
                </AppText>
              )}
            </>
          ) : (
            <FeatureCard
              title="No times on this day"
              detail="Choose another available date."
            />
          )}
        </View>
      ) : null}
    </Screen>
  );
}

function createStyles(colors: ReturnType<typeof colorsForScheme>) {
  return StyleSheet.create({
  bookingHero: {
    alignItems: "center",
    backgroundColor: "#17112B",
    borderRadius: 26,
    flexDirection: "row",
    gap: 14,
    padding: 20,
  },
  bookingHeroDetail: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
  },
  bookingHeroEyebrow: {
    color: "#C4B5FD",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  bookingHeroIcon: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 18,
    height: 52,
    justifyContent: "center",
    width: 52,
  },
  bookingHeroIconText: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "500",
    lineHeight: 30,
  },
  bookingHeroTitle: {
    color: "#fff",
    fontSize: 23,
    fontWeight: "900",
    marginTop: 3,
  },
  dayUnavailable: {
    opacity: 0.32,
  },
  dayUnavailableText: {
    color: colors.muted,
  },
  instructorPill: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  instructorPillSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  instructorPillText: {
    color: colors.text,
    fontWeight: "800",
  },
  instructorPillTextSelected: {
    color: "#fff",
  },
  pressed: {
    opacity: 0.72,
  },
  calendarGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  dayAvailable: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.primary,
  },
  dayCell: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: 12,
    borderWidth: 1,
    height: 48,
    justifyContent: "center",
    width: "14.2857%",
  },
  daySelected: {
    backgroundColor: colors.primary,
  },
  daySelectedText: {
    color: "#fff",
    fontWeight: "900",
  },
  dayText: {
    color: colors.text,
    fontWeight: "700",
  },
  dot: {
    backgroundColor: colors.primary,
    borderRadius: 999,
    height: 4,
    marginTop: 3,
    width: 4,
  },
  monthButton: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  monthButtonDisabled: {
    opacity: 0.35,
  },
  monthButtonText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "800",
  },
  monthNavigation: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
  },
  pillList: {
    gap: 8,
  },
  section: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 22,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  selectedTimeCard: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  selectedTimeLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  selectedTimeValue: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "900",
    marginTop: 4,
  },
  timeSlotPill: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    minWidth: 92,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  timeSlotPillSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  timeSlotRow: {
    gap: 10,
    paddingRight: 12,
  },
  timeSlotText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "900",
    textAlign: "center",
  },
  timeSlotTextSelected: {
    color: "#fff",
  },
  weekLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "800",
    textAlign: "center",
    width: "14.2857%",
  },
  weekRow: {
    flexDirection: "row",
  },
  });
}
