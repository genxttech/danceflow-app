import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
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

export default function ScheduleRequestScreen() {
  const { session } = useAuth();
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

      setSlots(response.slots ?? []);
      setInstructors(response.instructors ?? []);
      setDecision(response.bookingDecision);

      const firstDate = response.slots?.[0]?.date ?? "";
      setMonthKey((current) => current || firstDate.slice(0, 7));
      if (selectedDate && !response.slots.some((slot) => slot.date === selectedDate)) {
        setSelectedDate("");
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
  const resolvedMonthKey = monthKey || Array.from(availableDates)[0]?.slice(0, 7) || new Date().toISOString().slice(0, 7);
  const cells = calendarCells(resolvedMonthKey, availableDates);
  const visibleSlots = selectedDate ? slots.filter((slot) => slot.date === selectedDate) : [];

  return (
    <Screen>
      <AppText variant="eyebrow">Schedule</AppText>
      <AppText variant="title">Book a private lesson</AppText>
      <AppText variant="caption">
        Choose your studio, instructor, day, and available time.
      </AppText>

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
            {instructors.map((instructor) => (
              <AppButton
                key={instructor.id}
                label={instructor.name}
                onPress={() => {
                  setSelectedInstructorId(instructor.id);
                  setSelectedDate("");
                  setMonthKey("");
                }}
                variant={selectedInstructorId === instructor.id ? "primary" : "secondary"}
              />
            ))}
          </View>
        </View>
      ) : null}

      {loading ? <FeatureCard title="Loading calendar" detail="Checking available lesson times." /> : null}

      {decision?.allowed === false ? (
        <FeatureCard title="Booking unavailable" detail={decision.reason ?? "This studio is not accepting self-service bookings."} />
      ) : null}

      {selectedInstructorId && !loading ? (
        <View style={styles.section}>
          <AppText variant="subtitle">3. Choose a day</AppText>
          <AppText variant="caption">{monthLabel(`${resolvedMonthKey}-01`)}</AppText>

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
                  onPress={() => setSelectedDate(cell.key)}
                  style={[
                    styles.dayCell,
                    cell.available && styles.dayAvailable,
                    selectedDate === cell.key && styles.daySelected,
                  ]}
                >
                  <AppText style={selectedDate === cell.key ? styles.daySelectedText : styles.dayText}>
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
          <AppText variant="caption">{dayLabel(selectedDate)}</AppText>
          {visibleSlots.map((slot) => {
            const slotKey = `${slot.startsAt}|${slot.endsAt}`;
            return (
              <View key={slotKey} style={styles.slotCard}>
                <AppText variant="subtitle">{formatScheduleDateTime(slot.startsAt)}</AppText>
                <AppButton
                  label={decision?.mode === "instant" ? "Book this time" : "Request this time"}
                  loading={submittingSlotKey === slotKey}
                  onPress={() => submitSlot(slot)}
                />
              </View>
            );
          })}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
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
  pillList: {
    gap: 8,
  },
  section: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 16,
  },
  slotCard: {
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
    padding: 14,
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
