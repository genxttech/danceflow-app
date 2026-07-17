import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess } from "@/lib/studentAccess";
import {
  checkInForLesson,
  loadLessonCheckinStatus,
  type LessonCheckinStatus
} from "@/lib/lessonCheckin";
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
  return (
    process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL ?? "https://idanceflow.com"
  ).replace(/\/$/, "");
}

function dateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function DetailRow({
  icon,
  label,
  value
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailIcon}>
        <Ionicons color={colors.primary} name={icon} size={18} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText style={styles.detailLabel}>{label}</AppText>
        <AppText style={styles.detailValue}>{value}</AppText>
      </View>
    </View>
  );
}

export default function AppointmentDetailScreen() {
  const { id, action } = useLocalSearchParams<{
    id: string;
    action?: string;
  }>();
  const appointmentId = routeId(id);
  const selectedAction = routeId(action);
  const { session } = useAuth();
  const router = useRouter();
  const [appointment, setAppointment] =
    useState<StudentScheduleItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [checkinStatus, setCheckinStatus] =
    useState<LessonCheckinStatus | null>(null);
  const [checkinMessage, setCheckinMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    if (!userId || !appointmentId) {
      setError("We could not find that schedule item.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    getStudentAccess(userId)
      .then((access) =>
        loadStudentScheduleOverview(access.linkedStudios)
      )
      .then((overview) => {
        if (!mounted) return;

        const match =
          overview.upcoming.find((item) => item.id === appointmentId) ??
          overview.recent.find((item) => item.id === appointmentId) ??
          null;

        setAppointment(match);

        if (!match) {
          setError("This schedule item is not available in your app yet.");
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
        setError("We could not load these details yet. Please try again.");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [appointmentId, session?.user.id]);

  const requestTitle = useMemo(() => {
    if (selectedAction === "reschedule") return "Reschedule requested";
    if (selectedAction === "cancel") return "Cancellation requested";
    return "Manage this lesson";
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
        nextError instanceof Error
          ? nextError.message
          : "Check-in could not be completed."
      );
    } finally {
      setCheckingIn(false);
    }
  }

  return (
    <Screen>
      <Pressable
        accessibilityLabel="Back to schedule"
        onPress={() => router.back()}
        style={({ pressed }) => [
          styles.backButton,
          pressed && styles.pressed
        ]}
      >
        <Ionicons color="#334155" name="chevron-back" size={20} />
        <AppText style={styles.backText}>Schedule</AppText>
      </Pressable>

      {loading ? (
        <FeatureCard
          title="Loading schedule details"
          detail="Getting the latest information from your studio."
        />
      ) : null}

      {error ? <FeatureCard title="Details unavailable" detail={error} /> : null}

      {appointment ? (
        <>
          <View style={styles.hero}>
            <View style={styles.heroBadge}>
              <AppText style={styles.heroBadgeText}>
                {statusLabel(appointment.status)}
              </AppText>
            </View>

            <AppText style={styles.heroTitle}>{appointment.title}</AppText>
            <AppText style={styles.heroStudio}>
              {appointment.studioName}
            </AppText>

            <View style={styles.heroTimeCard}>
              <View style={styles.heroCalendarIcon}>
                <Ionicons color="#FFFFFF" name="calendar-outline" size={22} />
              </View>
              <View style={{ flex: 1 }}>
                <AppText style={styles.heroDate}>
                  {dateLabel(appointment.startsAt)}
                </AppText>
                <AppText style={styles.heroTime}>
                  {formatScheduleTimeRange(
                    appointment.startsAt,
                    appointment.endsAt,
                    appointment.timeZone
                  )}
                </AppText>
              </View>
            </View>
          </View>

          <View style={styles.detailsCard}>
            <AppText style={styles.sectionEyebrow}>Lesson details</AppText>
            <DetailRow
              icon="business-outline"
              label="Studio"
              value={appointment.studioName}
            />
            <DetailRow
              icon="person-outline"
              label="Instructor / room"
              value={appointment.subtitle || "Details coming from your studio"}
            />
            <DetailRow
              icon="shield-checkmark-outline"
              label="Status"
              value={statusLabel(appointment.status)}
            />
          </View>

          {checkinStatus ? (
            <View
              style={[
                styles.checkinCard,
                checkinStatus.checkedIn && styles.checkinCardComplete
              ]}
            >
              <View style={styles.checkinHeader}>
                <View
                  style={[
                    styles.checkinIcon,
                    checkinStatus.checkedIn && styles.checkinIconComplete
                  ]}
                >
                  <Ionicons
                    color={checkinStatus.checkedIn ? "#047857" : colors.primary}
                    name={
                      checkinStatus.checkedIn
                        ? "checkmark-circle-outline"
                        : "location-outline"
                    }
                    size={22}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <AppText style={styles.checkinTitle}>
                    {checkinStatus.checkedIn
                      ? "You are checked in"
                      : "Lesson check-in"}
                  </AppText>
                  <AppText style={styles.checkinDetail}>
                    {checkinStatus.checkedIn
                      ? `Checked in ${new Date(
                          checkinStatus.checkedInAt ?? ""
                        ).toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit"
                        })}`
                      : checkinStatus.canCheckIn
                        ? "Let your instructor know you have arrived."
                        : "Check-in becomes available shortly before your lesson."}
                  </AppText>
                </View>
              </View>

              {!checkinStatus.checkedIn && checkinStatus.canCheckIn ? (
                <AppButton
                  label="Check in now"
                  loading={checkingIn}
                  onPress={checkIn}
                />
              ) : null}

              {checkinMessage ? (
                <AppText style={styles.checkinMessage}>
                  {checkinMessage}
                </AppText>
              ) : null}
            </View>
          ) : null}

          <View style={styles.manageCard}>
            <AppText style={styles.sectionEyebrow}>{requestTitle}</AppText>
            <AppText style={styles.manageTitle}>
              Need to make a change?
            </AppText>
            <AppText style={styles.manageDetail}>
              Your studio may need to approve changes based on its cancellation
              and rescheduling policy.
            </AppText>

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

            <AppText style={styles.portalNote}>
              Requests open in your secure studio portal with the full lesson
              details attached.
            </AppText>
          </View>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actionRow: {
    gap: 10,
    marginTop: 18
  },
  backButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  backText: {
    color: "#334155",
    fontSize: 14,
    fontWeight: "800"
  },
  checkinCard: {
    backgroundColor: "#F5F3FF",
    borderColor: "#DDD6FE",
    borderRadius: 22,
    borderWidth: 1,
    gap: 14,
    padding: 18
  },
  checkinCardComplete: {
    backgroundColor: "#ECFDF5",
    borderColor: "#A7F3D0"
  },
  checkinDetail: {
    color: "#64748B",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 3
  },
  checkinHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12
  },
  checkinIcon: {
    alignItems: "center",
    backgroundColor: "#EDE9FE",
    borderRadius: 999,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  checkinIconComplete: {
    backgroundColor: "#D1FAE5"
  },
  checkinMessage: {
    color: "#334155",
    fontSize: 13,
    fontWeight: "700"
  },
  checkinTitle: {
    color: "#0F172A",
    fontSize: 17,
    fontWeight: "900"
  },
  detailIcon: {
    alignItems: "center",
    backgroundColor: "#F5F3FF",
    borderRadius: 12,
    height: 38,
    justifyContent: "center",
    width: 38
  },
  detailLabel: {
    color: "#94A3B8",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase"
  },
  detailRow: {
    alignItems: "center",
    borderBottomColor: "#F1F5F9",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingVertical: 13
  },
  detailValue: {
    color: "#0F172A",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
    marginTop: 3
  },
  detailsCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 22,
    borderWidth: 1,
    padding: 18
  },
  hero: {
    backgroundColor: "#17112B",
    borderRadius: 28,
    padding: 20
  },
  heroBadge: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6
  },
  heroBadgeText: {
    color: "#DDD6FE",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.8,
    textTransform: "uppercase"
  },
  heroCalendarIcon: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 14,
    height: 46,
    justifyContent: "center",
    width: 46
  },
  heroDate: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "900"
  },
  heroStudio: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 14,
    marginTop: 7
  },
  heroTime: {
    color: "rgba(255,255,255,0.68)",
    fontSize: 13,
    marginTop: 4
  },
  heroTimeCard: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 18,
    flexDirection: "row",
    gap: 12,
    marginTop: 20,
    padding: 14
  },
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 28,
    fontWeight: "900",
    lineHeight: 34,
    marginTop: 16
  },
  manageCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E2E8F0",
    borderRadius: 22,
    borderWidth: 1,
    padding: 18
  },
  manageDetail: {
    color: "#64748B",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 7
  },
  manageTitle: {
    color: "#0F172A",
    fontSize: 20,
    fontWeight: "900",
    marginTop: 6
  },
  portalNote: {
    color: "#94A3B8",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
    textAlign: "center"
  },
  pressed: {
    opacity: 0.75
  },
  sectionEyebrow: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 1.1,
    textTransform: "uppercase"
  }
});
