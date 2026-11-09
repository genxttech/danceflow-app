import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colorsForScheme, type ThemeColors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess } from "@/lib/studentAccess";
import {
  checkInForLesson,
  loadLessonCheckinStatus,
  type LessonCheckinStatus
} from "@/lib/lessonCheckin";
import { confirmStudentAppointment } from "@/lib/lessonConfirmation";
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
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
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
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
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
  const [confirming, setConfirming] = useState(false);
  const [confirmationMessage, setConfirmationMessage] = useState<string | null>(null);
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

        // GC-1.4A: class self-check-in is now real -- always load status,
        // passing clientId (required for a class, ignored for a lesson).
        loadLessonCheckinStatus(match.id, match.clientId)
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
  // GC-1.3B: appointment.status is class lifecycle only for a group_class
  // row -- there is no per-student confirm/check-in concept for a shared
  // class in this slice.
  const isGroupClass = appointment?.appointmentType === "group_class";

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

  async function confirmAppointment() {
    if (!appointment) return;

    setConfirming(true);
    setConfirmationMessage(null);

    try {
      await confirmStudentAppointment(appointment.id);
      setAppointment((current) =>
        current ? { ...current, status: "confirmed" } : current
      );
      setConfirmationMessage("Your appointment is confirmed.");
    } catch (nextError) {
      setConfirmationMessage(
        nextError instanceof Error
          ? nextError.message
          : "Appointment confirmation could not be completed."
      );
    } finally {
      setConfirming(false);
    }
  }

  async function checkIn() {
    if (!appointment) return;

    setCheckingIn(true);
    setCheckinMessage(null);

    try {
      const status = await checkInForLesson(appointment.id, appointment.clientId);
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
        <Ionicons color={colors.text} name="chevron-back" size={20} />
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
                <Ionicons color={colors.onPrimary} name="calendar-outline" size={22} />
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
            {appointment.attendanceStatus ? (
              <DetailRow
                icon="checkmark-done-outline"
                label="Your attendance"
                value={statusLabel(appointment.attendanceStatus)}
              />
            ) : null}
          </View>

          {!isGroupClass && ["scheduled", "rescheduled"].includes(appointment.status) ? (
            <View style={styles.confirmationCard}>
              <View style={styles.checkinHeader}>
                <View style={styles.confirmationIcon}>
                  <Ionicons color={colors.accent} name="checkmark-circle-outline" size={22} />
                </View>
                <View style={{ flex: 1 }}>
                  <AppText style={styles.checkinTitle}>Confirm attendance</AppText>
                  <AppText style={styles.checkinDetail}>
                    Let the studio know you plan to attend this appointment.
                  </AppText>
                </View>
              </View>
              <AppButton
                label="Confirm appointment"
                loading={confirming}
                onPress={confirmAppointment}
              />
              {confirmationMessage ? (
                <AppText style={styles.checkinMessage}>{confirmationMessage}</AppText>
              ) : null}
            </View>
          ) : !isGroupClass && appointment.status === "confirmed" ? (
            <View style={styles.confirmationCompleteCard}>
              <View style={styles.checkinHeader}>
                <View style={styles.confirmationCompleteIcon}>
                  <Ionicons color={colors.accent} name="checkmark-circle" size={24} />
                </View>
                <View style={{ flex: 1 }}>
                  <AppText style={styles.checkinTitle}>Appointment confirmed</AppText>
                  <AppText style={styles.checkinDetail}>
                    Your studio has received your confirmation.
                  </AppText>
                </View>
              </View>
            </View>
          ) : null}

          {checkinStatus && checkinStatus.eligible !== false ? (
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
                    color={checkinStatus.checkedIn ? colors.success : colors.primary}
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
                      : isGroupClass
                        ? "Class check-in"
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
                        : `Check-in becomes available shortly before your ${isGroupClass ? "class" : "lesson"}.`}
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

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    actionRow: {
      gap: 10,
      marginTop: 18
    },
    backButton: {
      alignItems: "center",
      alignSelf: "flex-start",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 9
    },
    backText: {
      color: colors.text,
      fontSize: 14,
      fontWeight: "800"
    },
    checkinCard: {
      backgroundColor: colors.surfaceAlt,
      borderColor: colors.border,
      borderRadius: 22,
      borderWidth: 1,
      gap: 14,
      padding: 18
    },
    checkinCardComplete: {
      backgroundColor: colors.surfaceAlt,
      borderColor: colors.border
    },
    checkinDetail: {
      color: colors.muted,
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
      backgroundColor: colors.surfaceAlt,
      borderRadius: 999,
      height: 44,
      justifyContent: "center",
      width: 44
    },
    checkinIconComplete: {
      backgroundColor: colors.surfaceAlt
    },
    checkinMessage: {
      color: colors.text,
      fontSize: 13,
      fontWeight: "700"
    },
    checkinTitle: {
      color: colors.text,
      fontSize: 17,
      fontWeight: "900"
    },
    confirmationCard: {
      backgroundColor: colors.surfaceAlt,
      borderColor: colors.border,
      borderRadius: 22,
      borderWidth: 1,
      gap: 14,
      padding: 18
    },
    confirmationCompleteCard: {
      backgroundColor: colors.surfaceAlt,
      borderColor: colors.border,
      borderRadius: 22,
      borderWidth: 1,
      padding: 18
    },
    confirmationIcon: {
      alignItems: "center",
      backgroundColor: colors.surfaceAlt,
      borderRadius: 999,
      height: 44,
      justifyContent: "center",
      width: 44
    },
    confirmationCompleteIcon: {
      alignItems: "center",
      backgroundColor: colors.surfaceAlt,
      borderRadius: 999,
      height: 44,
      justifyContent: "center",
      width: 44
    },
    detailIcon: {
      alignItems: "center",
      backgroundColor: colors.surfaceAlt,
      borderRadius: 12,
      height: 38,
      justifyContent: "center",
      width: 38
    },
    detailLabel: {
      color: colors.muted,
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 0.8,
      textTransform: "uppercase"
    },
    detailRow: {
      alignItems: "center",
      borderBottomColor: colors.border,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 12,
      paddingVertical: 13
    },
    detailValue: {
      color: colors.text,
      fontSize: 14,
      fontWeight: "700",
      lineHeight: 20,
      marginTop: 3
    },
    detailsCard: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 22,
      borderWidth: 1,
      padding: 18
    },
    hero: {
      backgroundColor: colors.primaryDark,
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
      color: "rgba(255,255,255,0.78)",
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
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 22,
      borderWidth: 1,
      padding: 18
    },
    manageDetail: {
      color: colors.muted,
      fontSize: 14,
      lineHeight: 21,
      marginTop: 7
    },
    manageTitle: {
      color: colors.text,
      fontSize: 20,
      fontWeight: "900",
      marginTop: 6
    },
    portalNote: {
      color: colors.muted,
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
}
