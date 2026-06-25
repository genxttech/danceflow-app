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
        if (!match) setError("This lesson is not available in your app yet.");
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
  actionRow: {
    gap: 10
  },
  details: {
    gap: 12
  }
});
