import { useEffect, useMemo, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess } from "@/lib/studentAccess";
import { checkInForLesson, loadLessonCheckinStatus, type LessonCheckinStatus } from "@/lib/lessonCheckin";
import {
  formatScheduleTimeRange,
  loadStudentScheduleOverview,
  statusLabel,
  type StudentScheduleItem
} from "@/lib/studentSchedule";

function routeId(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function webBaseUrl() {
  return (process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL ?? "https://idanceflow.com").replace(/\/$/, "");
}

export default function AppointmentDetailScreen() {
  const { id, action } = useLocalSearchParams<{ id: string; action?: string }>();
  const appointmentId = routeId(id);
  const selectedAction = routeId(action);
  const { session } = useAuth();
  const router = useRouter();
  const [appointment, setAppointment] = useState<StudentScheduleItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [checkinStatus, setCheckinStatus] = useState<LessonCheckinStatus | null>(null);
  const [checkinMessage, setCheckinMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    if (!userId || !appointmentId) {
      setError("We could not find that lesson.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    getStudentAccess(userId)
      .then((access) => loadStudentScheduleOverview(access.linkedStudios))
      .then((overview) => {
        if (!mounted) return;
        const match =
          overview.upcoming.find((item) => item.id === appointmentId) ??
          overview.recent.find((item) => item.id === appointmentId) ??
          null;

        setAppointment(match);
        if (!match) {
          setError("This lesson is not available in your app yet.");
          return;
        }

        loadLessonCheckinStatus(match.id)
          .then((status) => {
            if (mounted) setCheckinStatus(status);
          })
          .catch(() => {
            if (mounted) setCheckinStatus(null);
          });
      })
      .catch(() => {
        if (!mounted) return;
        setError("We could not load this lesson yet. Please try again.");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [appointmentId, session?.user.id]);

  const requestTitle = useMemo(() => {
    if (selectedAction === "reschedule") return "Request a reschedule";
    if (selectedAction === "cancel") return "Request a cancellation";
    return "Lesson options";
  }, [selectedAction]);

  async function openPortal(actionType?: "reschedule" | "cancel") {
    if (!appointment) return;
    setOpening(true);

    const suffix = actionType ? `?request=${actionType}` : "";
    const url = `${webBaseUrl()}/portal/${appointment.studioSlug}/appointments/${appointment.id}${suffix}`;

    try {
      await Linking.openURL(url);
    } finally {
      setOpening(false);
    }
  }

  async function checkIn() {
    if (!appointment) return;

    setCheckingIn(true);
    setCheckinMessage(null);

    try {
      const status = await checkInForLesson(appointment.id);
      setCheckinStatus(status);
      setCheckinMessage(
        status.instructorNotified
          ? "You are checked in. Your instructor has been notified."
          : "You are checked in."
      );
    } catch (nextError) {
      setCheckinMessage(
        nextError instanceof Error ? nextError.message : "Check-in could not be completed."
      );
    } finally {
      setCheckingIn(false);
    }
  }

  return (
    <Screen>
      <AppButton label="Back" onPress={() => router.back()} variant="secondary" />

      {loading ? <FeatureCard title="Loading lesson" detail="Getting your lesson details." /> : null}
      {error ? <FeatureCard title="Lesson unavailable" detail={error} /> : null}

      {appointment ? (
        <>
          <FeatureCard
            label={statusLabel(appointment.status)}
            title={appointment.title}
            detail={`${appointment.studioName} · ${formatScheduleTimeRange(
              appointment.startsAt,
              appointment.endsAt,
              appointment.timeZone
            )}`}
          />

          <View style={styles.details}>
            <FeatureCard title="Instructor / room" detail={appointment.subtitle} />
            <FeatureCard
              title={requestTitle}
              detail="Your studio may need to approve changes based on its cancellation and rescheduling policy."
            />
          </View>

          {checkinStatus ? (
            <View style={styles.checkinCard}>
              <AppText variant="subtitle">
                {checkinStatus.checkedIn ? "Checked in" : "Lesson check-in"}
              </AppText>
              <AppText variant="caption">
                {checkinStatus.checkedIn
                  ? `Checked in ${new Date(checkinStatus.checkedInAt ?? "").toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                  : checkinStatus.canCheckIn
                    ? "Let your instructor know you have arrived."
                    : "Check-in becomes available shortly before your lesson."}
              </AppText>
              {!checkinStatus.checkedIn && checkinStatus.canCheckIn ? (
                <AppButton label="Check in" loading={checkingIn} onPress={checkIn} />
              ) : null}
              {checkinMessage ? <AppText variant="caption">{checkinMessage}</AppText> : null}
            </View>
          ) : null}

          <View style={styles.actionRow}>
            <AppButton
              label="Request reschedule"
              loading={opening}
              onPress={() => openPortal("reschedule")}
            />
            <AppButton
              label="Request cancellation"
              loading={opening}
              onPress={() => openPortal("cancel")}
              variant="secondary"
            />
          </View>

          <AppText variant="caption">
            Requests open in your studio portal so the studio has the full lesson details.
          </AppText>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  checkinCard: {
    backgroundColor: colors.surface,
    borderColor: colors.primary,
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 16
  },
  actionRow: {
    gap: 10
  },
  details: {
    gap: 12
  }
});
